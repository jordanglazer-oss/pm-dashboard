import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { bookStocks, type Stock, type MarketData } from "@/app/lib/types";
import { computeScores, isDataGapExplanation, ownershipTrendsApplies } from "@/app/lib/scoring";
import { computeAnalystConsensus, getSnapshotForTicker, type AnalystSnapshots } from "@/app/lib/analyst-snapshots";
import { SOURCES as MENTION_LISTS, type MentionSource } from "@/app/lib/research-mentions";
import { canonicalTicker, sameCompanyLoose } from "@/app/lib/ticker";
import { crossSectional, factsetConfigured, relayRetry, type FactsetValue } from "@/app/lib/factset";
import { resolveFactsetId } from "@/app/lib/factset-symbols";
import { normalizeFactsetSector } from "@/app/lib/factset-fundamentals";
import { pickPlaybook } from "@/app/lib/sector-playbook";
import {
  computeQualityScore, QUALITY_BANDS_KEY, QUALITY_DETAIL_KEY, QUALITY_SOURCE_FIELDS, QUALITY_CUTS, QUALITY_WEIGHTS, QUALITY_TOP_MARK_FLOOR_PCT, QUALITY_GROUP_RULES,
  type QualityBands, type QualityDetail, type QualityWorking, type RawQualityRow,
} from "@/app/lib/quality-score";
import {
  compositeFrom, currentRevisionContribution, LIST_COUNTRY, REVISION_MIN_PANEL, REVISION_SHARE, RUBRIC_KEYS, shadowAnalystConsensus, shadowResearchMentions,
  SIZE_BUCKETS, sizeBucket, summarise,
} from "@/app/lib/scoring-shadow";

/**
 * GET /api/scoring-shadow[?ticker=AAPL][&live=1] — the scoring-bias fixes
 * computed BESIDE the live score, for every individual stock in the book.
 *
 * READ-ONLY. Writes nothing, calls no model, and is not used by /api/score:
 * no stored score, score history entry or rating changes because of it.
 *
 * Reads pm:stocks, pm:market, pm:analyst-snapshots, pm:research,
 * pm:quality-bands and pm:quality-bands-detail. Per name it returns the
 * stored category scores, the composite today, and the composite with each
 * fix applied alone and all together:
 *   revisions   — estimate revisions as a share of the analyst panel
 *   mentions    — research mentions vs the lists the stock could be on
 *   noData      — a missing RBC / JPM rating or street target is no data
 *   quality     — returns & margins ranked against sector peers
 * plus a summary of the shift by size bucket and by US vs Canada.
 *
 * Quality needs the peer bands (run /api/admin/quality-band-calibration) and
 * the company's own FactSet inputs. Those are on file only for S&P 500 +
 * TSX 60 constituents; `&live=1` makes ONE read-only FactSet pull for the
 * other book names. Without it those names keep their current quality score
 * and are marked "not computed".
 *
 * The composites here are the RAW 33-point conviction score, before the
 * regime multiplier — the multiplier is the same in both columns.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const log = createLogger("Scoring-shadow");
const CANADIAN_RE = /(\.TO|\.V|\.NE|\.CN|-T)$/i;
const parse = <T,>(raw: string | null, fallback: T): T => { try { return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; } };
const r1 = (n: number) => Math.round(n * 10) / 10;

type QualityInput = { raw: RawQualityRow; group: string | null; sector: string | null; from: "calibration universe" | "live FactSet pull" };

export async function GET(req: NextRequest) {
  try {
    const q = new URL(req.url).searchParams;
    const want = q.get("ticker")?.trim().toUpperCase();
    const live = q.get("live") === "1";
    const redis = await getRedis();
    const [stocksRaw, marketRaw, snapsRaw, researchRaw, bandsRaw, detailRaw] = await Promise.all([
      redis.get("pm:stocks"), redis.get("pm:market"), redis.get("pm:analyst-snapshots"), redis.get("pm:research"), redis.get(QUALITY_BANDS_KEY), redis.get(QUALITY_DETAIL_KEY),
    ]);
    const stocksParsed = parse<unknown>(stocksRaw, []);
    const all = (Array.isArray(stocksParsed) ? stocksParsed : []) as Stock[];
    const stocks = bookStocks(all).filter((s) => (!s.instrumentType || s.instrumentType === "stock") && s.scores && (!want || canonicalTicker(s.ticker) === canonicalTicker(want)));
    const market = parse<MarketData>(marketRaw, { riskRegime: "Neutral" } as MarketData);
    const snaps = parse<AnalystSnapshots>(snapsRaw, {});
    const research = parse<Record<string, unknown>>(researchRaw, {});
    const bands = parse<QualityBands | null>(bandsRaw, null);
    const detail = parse<QualityDetail | null>(detailRaw, null);

    // ── quality inputs: the calibration universe first, then an optional live pull ──
    const qInputs = new Map<string, QualityInput>();
    if (bands && detail) {
      for (const s of stocks) {
        const row = detail.rows.find((r) => r.ticker.toUpperCase() === s.ticker.toUpperCase()) ?? detail.rows.find((r) => sameCompanyLoose(r.ticker, s.ticker) && CANADIAN_RE.test(r.ticker) === CANADIAN_RE.test(s.ticker));
        if (row) qInputs.set(s.ticker, { raw: row.raw, group: row.group, sector: row.sector, from: "calibration universe" });
      }
    }
    let liveNote: string | null = null;
    if (live && bands) {
      const missing = stocks.filter((s) => !qInputs.has(s.ticker));
      if (!factsetConfigured()) liveNote = "FactSet relay is not configured here — no live pull made.";
      else if (missing.length) {
        const idTo = new Map<string, string>();
        for (const s of missing) { const r = resolveFactsetId(s.ticker); if (r.source === "factset") idTo.set(r.id, s.ticker); }
        const formulas = [...QUALITY_SOURCE_FIELDS.map((f) => f.formula), "FG_GICS_SECTOR", "FG_GICS_INDUSTRY"];
        try {
          const ids = [...idTo.keys()];
          const rows: Record<string, Record<string, FactsetValue>> = {};
          for (let i = 0; i < ids.length; i += 40) Object.assign(rows, await relayRetry(() => crossSectional(ids.slice(i, i + 40), formulas, 60_000)));
          for (const [id, ticker] of idTo) {
            const row = rows[id];
            const gics = row && typeof row["FG_GICS_SECTOR"] === "string" ? (row["FG_GICS_SECTOR"] as string).trim() : null;
            if (!row || !gics) continue;
            const industry = typeof row["FG_GICS_INDUSTRY"] === "string" ? (row["FG_GICS_INDUSTRY"] as string).trim() : null;
            const sector = normalizeFactsetSector(gics) ?? gics;
            const raw: RawQualityRow = Object.fromEntries(QUALITY_SOURCE_FIELDS.map((f) => { const v = row[f.formula]; return [f.key, typeof v === "number" && isFinite(v) ? v : null]; }));
            qInputs.set(ticker, { raw, group: pickPlaybook(gics, industry, ticker)?.label ?? `${sector} (no playbook)`, sector, from: "live FactSet pull" });
          }
          liveNote = `Live FactSet pull for ${ids.length} name(s) outside the calibration universe.`;
        } catch (e) {
          liveNote = `Live FactSet pull failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    }

    const lists = MENTION_LISTS.map((l) => ({ source: l.source, direction: l.direction }));
    let compositeMismatches = 0;
    const rows = stocks.map((s) => {
      const canadian = CANADIAN_RE.test(s.ticker.trim());
      const scores = s.scores as unknown as Record<string, number>;
      // The live composite's exclusions: ownership on Canadian listings + gap-parked categories.
      const excluded = new Set<string>();
      if (!ownershipTrendsApplies(s)) excluded.add("ownershipTrends");
      const expl = (s.explanations ?? {}) as Record<string, unknown>;
      for (const k of RUBRIC_KEYS) if (isDataGapExplanation(expl[k])) excluded.add(k);
      const current = compositeFrom(scores, excluded).composite;
      // Cross-check against the function the app uses; a mismatch means this read-out has drifted from it.
      const liveRaw = computeScores(s, market).raw;
      const matchesLive = Math.abs(liveRaw - current) < 0.051;
      if (!matchesLive) compositeMismatches++;

      // (a) + (c) analyst consensus
      const snap = getSnapshotForTicker(snaps, s.ticker);
      const cons = shadowAnalystConsensus(snap, s.price);
      const curRev = cons.revisions ? currentRevisionContribution(cons.revisions.net) : 0;
      const storedCons = scores.analystConsensus || 0;
      // Fix (a) alone: swap only the revision contribution inside the stored score.
      const consRevOnly = cons.revisions ? Math.max(0, Math.min(3, Math.round((storedCons - curRev + cons.revisions.contribution) * 100) / 100)) : storedCons;
      // Fix (c) alone: the rescaled level with TODAY's revision rule.
      const consNoDataOnly = cons.score == null ? null : Math.max(0, Math.min(3, Math.round((cons.level!.rescaled + curRev + cons.morningstar) * 100) / 100));

      // (b) research mentions
      const onSources: MentionSource[] = [];
      for (const l of MENTION_LISTS) {
        const list = research[l.field];
        if (Array.isArray(list) && (list as { ticker?: unknown }[]).some((e) => typeof e?.ticker === "string" && e.ticker && sameCompanyLoose(e.ticker, canonicalTicker(s.ticker)))) onSources.push(l.source);
      }
      const ment = shadowResearchMentions(canadian ? "CA" : "US", onSources, lists);

      // (d) quality
      const qi = qInputs.get(s.ticker);
      let quality: QualityWorking | null = null;
      let qualityStatus: string;
      if (!bands) qualityStatus = "not computed — no peer bands stored (run the quality calibration)";
      else if (!qi) qualityStatus = "not computed — outside the S&P 500 / TSX 60 calibration universe (add &live=1 for a read-only FactSet pull)";
      else {
        quality = computeQualityScore({ raw: qi.raw, playbookGroup: qi.group, sector: qi.sector, bands });
        qualityStatus = quality.computedScore == null ? `DATA GAP — ${quality.gapReason}` : `computed (${qi.from})`;
      }

      const withFix = (over: Record<string, number | null>) => {
        const sc = { ...scores }, ex = new Set(excluded);
        for (const [k, v] of Object.entries(over)) { if (v == null) ex.add(k); else { sc[k] = v; ex.delete(k); } }
        return compositeFrom(sc, ex).composite;
      };
      const fixes = {
        revisions: withFix({ analystConsensus: consRevOnly }),
        noData: withFix({ analystConsensus: consNoDataOnly }),
        mentions: withFix({ researchMentions: ment.score }),
        // A computed quality score replaces the stored one; a DATA GAP drops the category; "not computed" leaves it as is.
        quality: quality ? withFix({ returnsMargins: quality.computedScore }) : current,
      };
      const allOver: Record<string, number | null> = { analystConsensus: cons.score, researchMentions: ment.score };
      if (quality) allOver.returnsMargins = quality.computedScore;
      const shadow = withFix(allOver);

      return {
        ticker: s.ticker, name: s.name, bucket: s.bucket, sector: s.sector,
        country: canadian ? "Canada" : "US", size: sizeBucket(s.healthData?.marketCap), marketCapM: s.healthData?.marketCap ?? null,
        current, shadow, shift: r1(shadow - current), matchesLive,
        byFix: { revisions: r1(fixes.revisions - current), noData: r1(fixes.noData - current), mentions: r1(fixes.mentions - current), quality: r1(fixes.quality - current) },
        analystConsensus: { stored: storedCons, todaysRuleRecomputedNow: computeAnalystConsensus(snap, s.price).score, shadow: cons.score, level: cons.level, revisions: cons.revisions ? { ...cons.revisions, currentRuleContribution: curRev } : null, morningstar: cons.morningstar },
        researchMentions: { stored: scores.researchMentions || 0, todaysRuleRecomputedNow: Math.max(0, Math.min(3, ment.bullishOn - ment.bearishOn)), shadow: ment.score, on: onSources, eligibleBullish: ment.eligibleBullish, referenceBullish: ment.referenceBullish, multiplier: ment.multiplier, bearishOn: ment.bearishOn },
        returnsMargins: { stored: scores.returnsMargins || 0, shadow: quality?.computedScore ?? null, status: qualityStatus, working: quality },
      };
    });

    if (compositeMismatches) log.warn(`${compositeMismatches} composite(s) do not match computeScores`);
    const forSummary = rows.map((r) => ({ ...r, current: r.current, shadow: r.shadow }));
    return NextResponse.json({
      mode: "SHADOW — read-only. No live score, rating or history entry is changed by this.",
      generatedAt: new Date().toISOString(),
      names: rows.length,
      qualityBands: bands ? { calibratedAt: bands.calibratedAt, universeSize: bands.universeSize, inSync: detail?.calibratedAt === bands.calibratedAt } : null,
      liveNote,
      compositeCheck: compositeMismatches === 0 ? "every 'current' composite matches the app's own calculation" : `${compositeMismatches} name(s) do NOT match the app's own calculation — treat their rows with caution`,
      summary: {
        byCountry: summarise(forSummary, (r) => r.country, ["US", "Canada"]),
        bySize: summarise(forSummary, (r) => r.size, SIZE_BUCKETS),
        byCountryAndSize: summarise(forSummary, (r) => `${r.country} · ${r.size}`),
        note: "Market cap is the figure stored on each stock record at its last data refresh (healthData.marketCap), in millions of its OWN trading currency — a Canadian name's bucket is in C$, so the buckets are approximate across the two markets.",
      },
      method: {
        revisions: { rule: "net up-minus-down revisions ÷ number of analysts", fullPointAtShare: REVISION_SHARE.full, halfPointAtShare: REVISION_SHARE.half, smallPanel: `a panel under ${REVISION_MIN_PANEL} analysts can move the score by at most ±0.5`, today: "|net| ≥ 4 → ±1, |net| ≥ 2 → ±0.5 (a raw count)" },
        mentions: { rule: "each bullish mention counts (lists in the best-covered market ÷ lists this stock could be on); bearish mentions count 1 each; held to 0–3", listMarket: LIST_COUNTRY, today: "bullish minus bearish, held to 0–3" },
        noData: { rule: "ratings and the street target that are on file are rescaled to the full 2.25-point level; with none on file the category leaves the composite", today: "a missing rating or target counts as zero" },
        quality: { weights: QUALITY_WEIGHTS, cuts: QUALITY_CUTS, topMarkFloorPct: QUALITY_TOP_MARK_FLOOR_PCT, groupRules: QUALITY_GROUP_RULES, today: "judged by the model against business-model norms" },
      },
      caution: "'Today' is the composite from the scores STORED at each name's last rescore. Analyst consensus and research mentions are recomputed here from what is on file NOW (today's price, today's lists), so part of a shift can be the stored score being out of date rather than the fix — each row's `todaysRuleRecomputedNow` shows the old rule on today's data, for comparison.",
      notComputed: {
        thinCoverage: "Fix (e), thin analyst coverage capping catalysts / relative valuation: there is no deterministic cap in the code to recompute. Both categories are judged by the model. Relative valuation uses a looser rule when fewer than 4 peers are supplied (scoring-prompt.ts, relativeValuation SCORE MAP); catalysts lean on FactSet alerts and filed reports, which exist mostly for well-covered names. Changing either needs a scoring-prompt change and a rescore, which this read-out deliberately does not do.",
      },
      rows: rows.sort((a, b) => b.shift - a.shift || a.ticker.localeCompare(b.ticker)),
    });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
