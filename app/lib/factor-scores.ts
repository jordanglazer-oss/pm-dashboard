import { getRedis } from "./redis";
import { createLogger } from "./logger";
import { crossSectional, factsetConfigured, type FactsetValue } from "./factset";
import { resolveFactsetId } from "./factset-symbols";
import { readUniverse, deriveMetrics, RAW_FORMULAS } from "./factor-universe";
import { computeFactorScore } from "./factors";
import { isScoreable } from "./scoring";
import type { ScoreKey, Stock } from "./types";

/**
 * Nightly shadow scoring (Phase A4). For every Portfolio + Watchlist name,
 * compute three read-outs and store them BESIDE — never touching — the 41-pt
 * score:
 *   • quant percentile   — the factor lens (factors.ts, vs pm:factor-universe)
 *   • judgment overlay    — a READ-ONLY projection of the 41-pt system's
 *                           qualitative categories (brand/moat/turnaround/
 *                           catalysts/charting/track-record), 0–100
 *   • blended candidates  — the integration candidates (70/30 and
 *                           overlay-as-±15 modifier) Phase C will race
 *
 * Writes:
 *   pm:factor-scores  — latest per-ticker read-out (regenerable cache)
 *   pm:factor-history — append-only, date-guarded per-ticker log (BACKED UP;
 *                       point-in-time history is what Phase C validates against)
 * Reads pm:stocks READ-ONLY. Zero Anthropic. ~2 batched FactSet calls (book).
 */

const log = createLogger("FactorScores");

export const FACTOR_SCORES_KEY = "pm:factor-scores";
export const FACTOR_HISTORY_KEY = "pm:factor-history";

/** The 41-pt system's qualitative categories — the part no factor replicates.
 *  Their normalized sum is the "judgment overlay" lens. */
const JUDGMENT_CATS: { key: ScoreKey; max: number }[] = [
  { key: "brand", max: 2 },
  { key: "competitiveMoat", max: 2 },
  { key: "turnaround", max: 2 },
  { key: "catalysts", max: 3 },
  { key: "charting", max: 3 },
  { key: "trackRecord", max: 1 },
];
const JUDGMENT_MAX = JUDGMENT_CATS.reduce((a, c) => a + c.max, 0); // 13

/** 0–100 overlay from stored judgment category scores. Null when the name has
 *  no judgment assessment yet (all zero) — absent ≠ weak, so the blends fall
 *  back to quant-only rather than dragging a fresh add to the floor. */
function judgmentOverlay(scores: Partial<Record<ScoreKey, number>> | undefined): number | null {
  if (!scores) return null;
  const sum = JUDGMENT_CATS.reduce((a, c) => a + (scores[c.key] || 0), 0);
  if (sum <= 0) return null;
  return Math.round((sum / JUDGMENT_MAX) * 100);
}

const clamp01 = (x: number) => Math.max(0, Math.min(100, Math.round(x)));

export type FactorScoreEntry = {
  ticker: string;
  sector: string;
  quant: number | null;       // 0–100 percentile
  confidence: number | null;
  overlay: number | null;     // 0–100 judgment
  blend70: number | null;     // 0.7·quant + 0.3·overlay
  blendMod: number | null;    // quant shifted ±15 by overlay
  groups: Record<string, number>;
};

type StoredStock = Stock & { scores?: Partial<Record<ScoreKey, number>> };

function parse<T>(raw: string | null, fb: T): T {
  if (!raw) return fb;
  try { return JSON.parse(raw) as T; } catch { return fb; }
}

export type FactorScoreStatus = {
  ran: boolean;
  scored: number;
  quantScored: number;
  error?: string;
};

export async function computeBookFactorScores(): Promise<FactorScoreStatus> {
  try {
    const universe = await readUniverse();
    if (!universe) return { ran: false, scored: 0, quantScored: 0, error: "no universe yet" };
    if (!factsetConfigured()) return { ran: false, scored: 0, quantScored: 0, error: "factset not configured" };

    const redis = await getRedis();
    const stocks = parse<StoredStock[]>(await redis.get("pm:stocks"), []);
    const book = stocks.filter(
      (s) => (s.bucket === "Portfolio" || s.bucket === "Watchlist") && s.ticker && isScoreable(s),
    );
    if (book.length === 0) return { ran: true, scored: 0, quantScored: 0 };

    // Resolve to FactSet ids and batch-fetch raw factor inputs for the book.
    const idToStock = new Map<string, StoredStock>();
    for (const s of book) {
      const r = resolveFactsetId(s.ticker);
      if (r.source === "factset" && !idToStock.has(r.id)) idToStock.set(r.id, s);
    }
    const ids = [...idToStock.keys()];
    const formulaList = Object.values(RAW_FORMULAS) as unknown as string[];
    const raw: Record<string, Record<string, FactsetValue>> = {};
    const CHUNK = 40;
    for (let i = 0; i < ids.length; i += CHUNK) {
      try {
        Object.assign(raw, await crossSectional(ids.slice(i, i + CHUNK), formulaList));
      } catch (e) {
        log.warn("book chunk failed:", e instanceof Error ? e.message : e);
      }
    }

    const entries: Record<string, FactorScoreEntry> = {};
    let quantScored = 0;
    for (const s of book) {
      const tk = s.ticker.toUpperCase();
      const r = resolveFactsetId(s.ticker);
      const row = r.source === "factset" ? raw[r.id] : undefined;

      // Quant lens.
      let quant: number | null = null;
      let confidence: number | null = null;
      let groups: Record<string, number> = {};
      let sector = "";
      if (row) {
        const rawRow: Record<string, number | string> = {};
        for (const [key, formula] of Object.entries(RAW_FORMULAS)) {
          const v = row[formula];
          if (key === "sector") { if (typeof v === "string" && v) rawRow.sector = v; }
          else if (typeof v === "number" && isFinite(v)) rawRow[key] = v;
        }
        sector = typeof rawRow.sector === "string" ? rawRow.sector : "";
        if (sector) {
          const fs = computeFactorScore(deriveMetrics(rawRow as never), sector, universe);
          if (fs) {
            quant = fs.percentile;
            confidence = fs.confidence;
            groups = fs.groups;
            quantScored++;
          }
        }
      }

      // Judgment lens + integration candidates.
      const overlay = judgmentOverlay(s.scores);
      const blend70 = quant == null ? null : overlay == null ? quant : clamp01(0.7 * quant + 0.3 * overlay);
      const blendMod = quant == null ? null : overlay == null ? quant : clamp01(quant + (overlay - 50) * 0.3);

      entries[tk] = { ticker: tk, sector, quant, confidence, overlay, blend70, blendMod, groups };
    }

    // Latest snapshot (cache).
    await redis.set(FACTOR_SCORES_KEY, JSON.stringify({ builtAt: new Date().toISOString(), entries }));

    // Append-only history — one entry per ticker per DAY, today only (mirrors
    // pm:score-history / pm:portfolio-snapshots date-guard). Never overwrites a
    // prior day; skips a ticker already logged today.
    const today = new Date().toISOString().slice(0, 10);
    const hist = parse<Record<string, Array<{ date: string } & Partial<FactorScoreEntry>>>>(
      await redis.get(FACTOR_HISTORY_KEY),
      {},
    );
    let appended = 0;
    for (const [tk, e] of Object.entries(entries)) {
      if (e.quant == null) continue; // only log real quant readings
      const arr = (hist[tk] ??= []);
      if (arr.some((x) => x.date === today)) continue;
      arr.push({ date: today, quant: e.quant, overlay: e.overlay, blend70: e.blend70, blendMod: e.blendMod, sector: e.sector, groups: e.groups });
      appended++;
    }
    if (appended > 0) await redis.set(FACTOR_HISTORY_KEY, JSON.stringify(hist));

    log.info(`scored ${Object.keys(entries).length} names (${quantScored} with quant), appended ${appended} history rows`);
    return { ran: true, scored: Object.keys(entries).length, quantScored };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("failed:", msg);
    return { ran: false, scored: 0, quantScored: 0, error: msg };
  }
}
