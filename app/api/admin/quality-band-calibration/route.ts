import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { getRedis } from "@/app/lib/redis";
import { crossSectional, factsetConfigured, relayRetry, type FactsetValue } from "@/app/lib/factset";
import { resolveFactsetId } from "@/app/lib/factset-symbols";
import { normalizeFactsetSector } from "@/app/lib/factset-fundamentals";
import { universeTickers, LIST_VERSION } from "@/app/lib/factor-constituents";
import { pickPlaybook } from "@/app/lib/sector-playbook";
import { quantile } from "@/app/lib/growth-score";
import {
  buildQualityBands, deriveQualityInputs, QUALITY_BANDS_KEY, QUALITY_CUTS, QUALITY_DETAIL_KEY, QUALITY_GROUP_RULES, QUALITY_METRICS,
  QUALITY_SANITY, QUALITY_SOURCE_FIELDS, QUALITY_TOP_MARK_FLOOR_PCT, QUALITY_WEIGHTS, MIN_GROUP_SIZE,
  type QualityDetail, type QualityDetailRow, type QualityGroup, type RawQualityRow,
} from "@/app/lib/quality-score";

/**
 * GET /api/admin/quality-band-calibration            → DRY RUN (default)
 * GET /api/admin/quality-band-calibration?confirm=YES → store the bands
 * GET /api/admin/quality-band-calibration?view=1      → show the stored bands
 *
 * SHADOW ONLY: builds the peer-group distributions the computed QUALITY score
 * (app/lib/quality-score.ts) ranks against — returns on capital, their
 * two-year direction, operating margin and its two-year direction — for every
 * S&P 500 + TSX 60 constituent, grouped by sector playbook (and by GICS
 * sector, the fold-in target for small groups). Copied from the growth
 * calibration. Storing the bands changes NO live score: nothing in /api/score
 * reads them; only /api/scoring-shadow does.
 *
 * The DRY RUN is the audit: every constituent with its raw FactSet inputs,
 * derived measures and exclusion reasons, plus each group's size, cut points
 * and its US / Canadian and market-cap make-up, so any name can be checked
 * against a FactSet terminal before anything is stored.
 *
 * REDIS — two keys written together, ONLY with ?confirm=YES:
 * pm:quality-bands-detail (per-company inputs) and pm:quality-bands. The
 * previous value of each is stashed at `<key>.pre-<ts>` first, and a partial
 * pull is refused. Both are regenerable caches — safe to nuke. No other key
 * is read or written.
 */

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const log = createLogger("Quality-calibration");

const F = {
  ...(Object.fromEntries(QUALITY_SOURCE_FIELDS.map((f) => [f.key, f.formula])) as Record<(typeof QUALITY_SOURCE_FIELDS)[number]["key"], string>),
  sector: "FG_GICS_SECTOR",
  industry: "FG_GICS_INDUSTRY",
  mktVal: "FG_MKT_VALUE",
} as const;
const CHUNK = 40;
const PARALLEL = 3;
const CANADIAN_RE = /(\.TO|\.V|\.NE|\.CN|-T)$/i;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const redis = await getRedis();

  if (url.searchParams.get("view") === "1") {
    const raw = await redis.get(QUALITY_BANDS_KEY);
    return NextResponse.json(raw ? { stored: true, bands: JSON.parse(raw) } : { stored: false });
  }
  if (!factsetConfigured()) return NextResponse.json({ error: "FactSet relay is not configured in this environment." }, { status: 503 });
  const confirm = url.searchParams.get("confirm") === "YES";

  // ── Pull ────────────────────────────────────────────────────────────────
  const idToTicker = new Map<string, string>();
  for (const t of universeTickers()) {
    const r = resolveFactsetId(t);
    if (r.source === "factset") idToTicker.set(r.id, t);
  }
  const ids = [...idToTicker.keys()];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  const formulas = Object.values(F) as string[];
  const rows: Record<string, Record<string, FactsetValue>> = {};
  const failedChunks: number[] = [];
  for (let i = 0; i < chunks.length; i += PARALLEL) {
    await Promise.all(chunks.slice(i, i + PARALLEL).map(async (c, j) => {
      try { Object.assign(rows, await relayRetry(() => crossSectional(c, formulas, 60_000))); }
      catch (e) { failedChunks.push(i + j); log.warn(`chunk ${i + j} failed:`, e instanceof Error ? e.message : e); }
    }));
  }

  // ── Derive ──────────────────────────────────────────────────────────────
  const constituents: QualityDetailRow[] = [];
  const unclassified: string[] = [];
  const round = (v: number) => Math.round(v * 100) / 100;
  for (const [id, ticker] of idToTicker) {
    const row = rows[id];
    if (!row) continue;
    const n = (k: keyof typeof F): number | null => { const v = row[F[k]]; return typeof v === "number" && isFinite(v) ? v : null; };
    const str = (k: keyof typeof F): string | null => { const v = row[F[k]]; return typeof v === "string" && v.trim() ? v.trim() : null; };
    const gicsSector = str("sector"), industry = str("industry");
    // No GICS sector = FactSet no longer covers the name. Keep it out of the bands.
    if (!gicsSector) { unclassified.push(ticker); continue; }
    const sector = normalizeFactsetSector(gicsSector) ?? gicsSector;
    const group = pickPlaybook(gicsSector, industry, ticker)?.label ?? `${sector ?? "Unclassified"} (no playbook)`;
    const raw: RawQualityRow = Object.fromEntries(QUALITY_SOURCE_FIELDS.map((f) => [f.key, n(f.key)]));
    const { inputs, excluded, parked } = deriveQualityInputs(raw, group);
    constituents.push({
      ticker, sector, industry, group,
      country: CANADIAN_RE.test(ticker) ? "CA" : "US",
      marketCap: n("mktVal"),
      raw,
      values: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, round(v as number)])),
      excluded, parked,
    });
  }
  const bands = buildQualityBands(constituents, { calibratedAt: new Date().toISOString(), listVersion: LIST_VERSION });

  // ── Readable summary ────────────────────────────────────────────────────
  const cuts = (g: QualityGroup) => Object.fromEntries(QUALITY_METRICS.map((m) => {
    const s = g.metrics[m];
    return [m, s && s.length ? { n: s.length, p30: quantile(s, QUALITY_CUTS.one), median: quantile(s, 50), p70: quantile(s, QUALITY_CUTS.two), min: s[0], max: s[s.length - 1] } : null];
  }));
  const makeUp = (name: string, key: "group" | "sector") => {
    const cs = constituents.filter((c) => c[key] === name && !c.parked);
    const caps = cs.map((c) => c.marketCap).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
    return { us: cs.filter((c) => c.country === "US").length, canada: cs.filter((c) => c.country === "CA").length, medianMarketCapM: quantile(caps, 50), smallestMarketCapM: caps[0] ?? null };
  };
  const groupTable = Object.values(bands.groups).sort((a, b) => b.n - a.n).map((g) => ({
    group: g.group, names: g.n,
    rankedIn: g.n >= MIN_GROUP_SIZE ? "its own group" : QUALITY_GROUP_RULES[g.group] ? `NOT RANKED — under ${MIN_GROUP_SIZE} names and its measures differ from the sector's` : `folded into its GICS sector (under ${MIN_GROUP_SIZE} names)`,
    measureRule: QUALITY_GROUP_RULES[g.group]?.note ?? "ROIC level + direction, operating margin level + direction",
    makeUp: makeUp(g.group, "group"),
    cutPoints: cuts(g),
  }));
  const sectorTable = Object.values(bands.sectors).sort((a, b) => b.n - a.n).map((g) => ({ sector: g.group, names: g.n, note: "standard-measure companies only (financial groups with their own measures are left out)", makeUp: makeUp(g.group, "sector"), cutPoints: cuts(g) }));
  const parked = constituents.filter((c) => c.parked).map((c) => c.ticker);
  const outOfRange = constituents.filter((c) => c.excluded.some((e) => /believable range/.test(e.reason))).map((c) => ({ ticker: c.ticker, reasons: c.excluded.filter((e) => /believable range/.test(e.reason)).map((e) => e.reason) }));

  let stored = false, stashedTo: string | null = null;
  if (confirm) {
    if (constituents.length < 300 || failedChunks.length > 0) {
      return NextResponse.json({ error: `Refusing to store: only ${constituents.length} constituents priced and ${failedChunks.length} chunk(s) failed. Re-run when the relay is healthy.` }, { status: 409 });
    }
    const ts = Date.now();
    const prev = await redis.get(QUALITY_BANDS_KEY);
    if (prev) { stashedTo = `${QUALITY_BANDS_KEY}.pre-${ts}`; await redis.set(stashedTo, prev); }
    const prevDetail = await redis.get(QUALITY_DETAIL_KEY);
    if (prevDetail) await redis.set(`${QUALITY_DETAIL_KEY}.pre-${ts}`, prevDetail);
    await redis.set(QUALITY_BANDS_KEY, JSON.stringify(bands));
    const detail: QualityDetail = { calibratedAt: bands.calibratedAt, rows: constituents, droppedNoSector: unclassified };
    await redis.set(QUALITY_DETAIL_KEY, JSON.stringify(detail));
    stored = true;
    log.info(`stored quality bands: ${constituents.length} names, ${Object.keys(bands.groups).length} groups${stashedTo ? `, prior stashed at ${stashedTo}` : ""}`);
  }

  return NextResponse.json({
    mode: confirm ? "STORED (shadow only — no live score reads these bands)" : "DRY RUN — nothing written. Add ?confirm=YES to store these bands.",
    stored, stashedTo,
    calibratedAt: bands.calibratedAt,
    readThisFirst: [
      "The peer universe is the S&P 500 + TSX 60 — LARGE CAPS ONLY. A small or mid cap in the book is ranked against large-cap peers, which usually earn higher and steadier returns on capital; a smaller company will tend to rank LOWER on quality than it would against companies its own size. That is a known limit of this universe, not a property of the company.",
      "Every group MIXES US and Canadian constituents (see each group's makeUp). Canadian names are a small minority of most groups; a group is never split by country.",
      "The cut points, weights and the top-mark floor are STARTING VALUES. Check the distribution of scores this dry run implies before trusting them.",
      "FF_ROIC / FF_ROE / FF_ROA / FF_OPER_MGN are FactSet's own computed ratios. Spot-check a dozen names across groups against a FactSet terminal before storing.",
    ],
    universe: { requested: ids.length, priced: constituents.length, failedChunks, listVersion: LIST_VERSION, droppedNoSector: unclassified, us: constituents.filter((c) => c.country === "US").length, canada: constituents.filter((c) => c.country === "CA").length, notRanked: parked, valuesOutsideBelievableRange: outOfRange },
    method: { weights: QUALITY_WEIGHTS, blendedPercentileCuts: QUALITY_CUTS, topMarkFloorPct: QUALITY_TOP_MARK_FLOOR_PCT, minGroupSize: MIN_GROUP_SIZE, sanityRanges: QUALITY_SANITY, groupRules: QUALITY_GROUP_RULES, winsorised: "2nd / 98th percentile within each group", sources: QUALITY_SOURCE_FIELDS },
    groups: groupTable,
    sectors: sectorTable,
    constituents: constituents.sort((a, b) => a.group.localeCompare(b.group) || a.ticker.localeCompare(b.ticker)),
  });
}
