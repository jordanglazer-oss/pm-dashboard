import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { bookStocks, MAX_SCORE, SCORE_GROUPS } from "@/app/lib/types";
import type { Stock, MarketData, ScoreKey } from "@/app/lib/types";
import { computeScores, isScoreable, ownershipTrendsApplies, isDataGapExplanation, marketEdgeApplies, boostedAiApplies, siaApplies } from "@/app/lib/scoring";
import { RATING_BANDS, LEGACY_41_BANDS, ratingLabelFor, type RatingBands, type RatingLabel } from "@/app/lib/rating-bands";
import type { ScoreHistoryStore } from "@/app/api/kv/score-history/route";

/**
 * GET /api/admin/rubric-v3-calibration            (plain-text tables)
 * GET /api/admin/rubric-v3-calibration?json=1     (same data as JSON)
 *
 * READ-ONLY. Reads pm:stocks, pm:market and pm:score-history; writes nothing.
 *
 * Rubric v3 pulled the four technical categories (charting / SIA / BoostedAI /
 * MarketEdge) and researchCoverage OUT of the composite into a separate setup
 * layer and added returnsMargins, so the conviction score is 33 pts. The
 * Buy/Hold/Sell cutoffs were RECALIBRATED from where the names landed, not
 * scaled by ratio (this route produced that evidence pre-cutover). It stays
 * useful after cutover: re-run it once returnsMargins has been scored across
 * the book to check the live cutoffs still preserve the intended distribution.
 * "41" below is the LEGACY composite reconstructed from stored scores. Three
 * questions on live data:
 *
 *   1. TODAY — every scoreable book name's legacy (41-pt) rating beside its
 *      live 33-pt conviction score, regime multiplier applied identically.
 *   2. BANDS — the LIVE cutoffs (rating-bands.ts) and a quantile-matched
 *      proposal (keeps the legacy COUNT of Strong Buys / Moderate Buys /
 *      Holds / Underweights), each with the share of labels unchanged.
 *   3. HISTORY — across consecutive legacy-era score-history entries, how
 *      much of each score move came from the technical categories, and how
 *      many label changes would not have happened on the v3 subtotal.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const TECH_KEYS: ScoreKey[] = ["charting", "relativeStrength", "aiRating", "marketEdge"];
const DROPPED_KEYS: ScoreKey[] = [...TECH_KEYS, "researchCoverage"];

// LIVE composite (rubric v3, 33 pts) — straight from SCORE_GROUPS.
const V3_KEYS: ScoreKey[] = SCORE_GROUPS.flatMap((g) => g.categories.map((c) => c.key as ScoreKey));
const V3_MAX = MAX_SCORE;

// LEGACY composite (rubric ≤ 5, 41 pts) reconstructed from the stored
// category scores: v3 keys minus returnsMargins, plus technicals + coverage.
const LEGACY_MAX_BY_KEY: Record<string, number> = {
  brand: 2, secular: 2, researchCoverage: 1, analystConsensus: 3, researchMentions: 3,
  charting: 3, relativeStrength: 2, aiRating: 2, marketEdge: 2,
  growth: 3, relativeValuation: 3, historicalValuation: 2, leverageCoverage: 2, cashFlowQuality: 1,
  competitiveMoat: 2, turnaround: 2, catalysts: 3, trackRecord: 1, ownershipTrends: 2,
};
const LEGACY_KEYS = Object.keys(LEGACY_MAX_BY_KEY) as ScoreKey[];
const LEGACY_MAX = 41;
const LEGACY_GAP_KEYS: ScoreKey[] = ["secular", "researchCoverage", "growth", "relativeValuation", "historicalValuation", "leverageCoverage", "cashFlowQuality", "competitiveMoat", "catalysts", "trackRecord", "ownershipTrends"];

/**
 * The pre-v3 41-pt raw, with the SAME numerator/denominator rules the old
 * computeScores applied: MarketEdge / BoostedAI / SIA / ownershipTrends N/A
 * drops and DATA GAP categories removed from both sides, renormalized to 41.
 */
function legacyRaw(stock: Stock): number {
  let sum = LEGACY_KEYS.reduce((s, k) => s + (stock.scores[k] || 0), 0);
  let effMax = LEGACY_MAX;
  const me = stock.marketEdge;
  const meCounts = marketEdgeApplies(stock) && ((me && (me.powerRating != null || me.opinion != null || me.opinionScore != null)) || (stock.scores.marketEdge || 0) !== 0);
  if (!meCounts) { sum -= stock.scores.marketEdge || 0; effMax -= 2; }
  if (!boostedAiApplies(stock)) { sum -= stock.scores.aiRating || 0; effMax -= 2; }
  if (!siaApplies(stock)) { sum -= stock.scores.relativeStrength || 0; effMax -= 2; }
  if (!ownershipTrendsApplies(stock)) { sum -= stock.scores.ownershipTrends || 0; effMax -= 2; }
  for (const k of LEGACY_GAP_KEYS) {
    if (k === "ownershipTrends" && !ownershipTrendsApplies(stock)) continue;
    if (isDataGapExplanation(stock.explanations?.[k])) {
      sum -= stock.scores[k] || 0;
      effMax -= LEGACY_MAX_BY_KEY[k] ?? 0;
    }
  }
  const norm = effMax > 0 ? sum * (LEGACY_MAX / effMax) : sum;
  return Math.round(norm * 10) / 10;
}

type Row = {
  ticker: string;
  bucket: string;
  sector: string;
  raw41: number;
  adjusted41: number;
  label41: RatingLabel;
  tech: number;
  coverage: number;
  raw31: number;
  adjusted31: number;
  multiplier: number;
};

const LABELS: RatingLabel[] = ["Strong Buy", "Moderate Buy", "Hold", "Underweight", "Sell"];

function roundHalf(x: number): number {
  return Math.round(x * 2) / 2;
}

function agreement(rows: Row[], bands: RatingBands): { pct: number; moved: string[] } {
  const moved: string[] = [];
  for (const r of rows) {
    const l31 = ratingLabelFor(r.adjusted31, bands);
    if (l31 !== r.label41) moved.push(`${r.ticker} ${r.label41}→${l31}`);
  }
  return { pct: rows.length ? Math.round(((rows.length - moved.length) / rows.length) * 1000) / 10 : 0, moved };
}

/** Cutoffs that keep today's count of names in each label, on the new scale. */
function quantileBands(rows: Row[]): RatingBands {
  const sorted = [...rows].sort((a, b) => b.adjusted31 - a.adjusted31);
  const cutoffFor = (label41Count: number): number => {
    if (label41Count <= 0) return Infinity;
    if (label41Count >= sorted.length) return -Infinity;
    // Midpoint between the last name that keeps the label and the first that doesn't.
    return roundHalf((sorted[label41Count - 1].adjusted31 + sorted[label41Count].adjusted31) / 2);
  };
  const countAtOrAbove = (label: RatingLabel) => {
    const idx = LABELS.indexOf(label);
    return rows.filter((r) => LABELS.indexOf(r.label41) <= idx).length;
  };
  const sb = cutoffFor(countAtOrAbove("Strong Buy"));
  const mb = cutoffFor(countAtOrAbove("Moderate Buy"));
  const ho = cutoffFor(countAtOrAbove("Hold"));
  const uw = cutoffFor(countAtOrAbove("Underweight"));
  const fin = (x: number, fallback: number) => (Number.isFinite(x) ? x : fallback);
  return {
    strongBuy: fin(sb, RATING_BANDS.strongBuy),
    moderateBuy: fin(mb, RATING_BANDS.moderateBuy),
    hold: fin(ho, RATING_BANDS.hold),
    underweight: fin(uw, RATING_BANDS.underweight),
  };
}

function pad(s: string | number, n: number, right = false): string {
  const t = String(s);
  return right ? t.padStart(n) : t.padEnd(n);
}

export async function GET(req: NextRequest) {
  const wantJson = new URL(req.url).searchParams.get("json") === "1";
  try {
    const redis = await getRedis();
    const [stocksRaw, marketRaw, historyRaw] = await Promise.all([
      redis.get("pm:stocks"),
      redis.get("pm:market"),
      redis.get("pm:score-history"),
    ]);
    const stocks: Stock[] = stocksRaw ? bookStocks(JSON.parse(stocksRaw) as Stock[]) : [];
    const market: MarketData | null = marketRaw ? (JSON.parse(marketRaw) as MarketData) : null;
    const history: ScoreHistoryStore = historyRaw ? (JSON.parse(historyRaw) as ScoreHistoryStore) : {};
    if (!market) return NextResponse.json({ ok: false, error: "pm:market missing — cannot apply the regime multiplier" }, { status: 500 });

    // ── 1. TODAY ─────────────────────────────────────────────────────────
    const rows: Row[] = stocks
      .filter((s) => isScoreable(s) && s.scores)
      .map((s) => {
        const scored = computeScores(s, market); // LIVE v3 (33)
        const multiplier = scored.raw > 0 ? scored.adjusted / scored.raw : 1;
        const raw41 = legacyRaw(s);
        const adjusted41 = Math.round(raw41 * multiplier * 10) / 10;
        return {
          ticker: s.ticker,
          bucket: s.bucket,
          sector: s.sector,
          raw41,
          adjusted41,
          label41: ratingLabelFor(adjusted41, LEGACY_41_BANDS),
          tech: Math.round(TECH_KEYS.reduce((t, k) => t + (s.scores[k] || 0), 0) * 10) / 10,
          coverage: s.scores.researchCoverage || 0,
          raw31: scored.raw,
          adjusted31: scored.adjusted,
          multiplier: Math.round(multiplier * 1000) / 1000,
        };
      })
      .sort((a, b) => b.adjusted31 - a.adjusted31);

    // ── 2. BANDS ─────────────────────────────────────────────────────────
    // A = the cutoffs actually LIVE in rating-bands.ts; B = what quantile
    // matching against the legacy labels would propose today.
    const ratioBands: RatingBands = RATING_BANDS;
    const qBands = quantileBands(rows);
    const ratioAgree = agreement(rows, ratioBands);
    const qAgree = agreement(rows, qBands);
    const dist41 = Object.fromEntries(LABELS.map((l) => [l, rows.filter((r) => r.label41 === l).length]));
    const asFraction = (b: RatingBands) =>
      Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round((v / V3_MAX) * 1000) / 1000]));

    // ── 3. HISTORY ───────────────────────────────────────────────────────
    // Consecutive entry pairs per book ticker. `raw` in history is the
    // normalized 41-pt raw, so the per-category deltas are compared to the
    // RAW move (plain sums, no renormalization) — a close approximation
    // that is exact whenever no category was N/A or DATA GAP in either entry.
    let pairs = 0;
    let techDominant = 0; // technical categories account for > 50% of |raw move|
    let techOnly = 0; // non-technical categories did not move at all
    const shares: number[] = [];
    let flips41 = 0;
    let flipsAvoided = 0; // label changed on 41 but not on the v3 subtotal (ratio bands)
    const bookTickers = new Set(rows.map((r) => r.ticker.toUpperCase()));
    for (const [ticker, entries] of Object.entries(history)) {
      if (!bookTickers.has(ticker.toUpperCase()) || !Array.isArray(entries)) continue;
      const sorted = [...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const cur = sorted[i];
        if (!prev.scores || !cur.scores) continue;
        const dTech = TECH_KEYS.reduce((t, k) => t + ((cur.scores[k] || 0) - (prev.scores[k] || 0)), 0);
        const dCov = (cur.scores.researchCoverage || 0) - (prev.scores.researchCoverage || 0);
        const dV3 = V3_KEYS.reduce((t, k) => t + ((cur.scores[k] || 0) - (prev.scores[k] || 0)), 0);
        const denom = Math.abs(dTech) + Math.abs(dCov) + Math.abs(dV3);
        if (denom === 0) continue;
        pairs++;
        const share = (Math.abs(dTech) + Math.abs(dCov)) / denom;
        shares.push(share);
        if (share > 0.5) techDominant++;
        if (dV3 === 0) techOnly++;
        if ((prev.scaleMax ?? 41) !== 41 || (cur.scaleMax ?? 41) !== 41) continue; // legacy-era pairs only
        const l41Prev = ratingLabelFor(prev.adjusted, LEGACY_41_BANDS);
        const l41Cur = ratingLabelFor(cur.adjusted, LEGACY_41_BANDS);
        if (l41Prev !== l41Cur) {
          flips41++;
          const mPrev = prev.raw > 0 ? prev.adjusted / prev.raw : 1;
          const mCur = cur.raw > 0 ? cur.adjusted / cur.raw : 1;
          const v3Prev = V3_KEYS.reduce((t, k) => t + (prev.scores[k] || 0), 0) * mPrev;
          const v3Cur = V3_KEYS.reduce((t, k) => t + (cur.scores[k] || 0), 0) * mCur;
          if (ratingLabelFor(v3Prev, ratioBands) === ratingLabelFor(v3Cur, ratioBands)) flipsAvoided++;
        }
      }
    }
    shares.sort((a, b) => a - b);
    const medianShare = shares.length ? shares[Math.floor(shares.length / 2)] : null;

    const payload = {
      ok: true,
      readOnly: true,
      regime: market.riskRegime,
      max41: MAX_SCORE,
      max31: V3_MAX,
      droppedKeys: DROPPED_KEYS,
      today: rows,
      distribution41: dist41,
      bands: {
        legacy41: LEGACY_41_BANDS,
        live33: { cutoffs: ratioBands, fractionOfMax: asFraction(ratioBands), agreementPct: ratioAgree.pct, moved: ratioAgree.moved },
        quantile31: { cutoffs: qBands, fractionOfMax: asFraction(qBands), agreementPct: qAgree.pct, moved: qAgree.moved },
      },
      history: {
        pairs,
        techDominantPct: pairs ? Math.round((techDominant / pairs) * 1000) / 10 : null,
        techOnlyPct: pairs ? Math.round((techOnly / pairs) * 1000) / 10 : null,
        medianTechShare: medianShare != null ? Math.round(medianShare * 1000) / 10 : null,
        labelFlips41: flips41,
        flipsAvoidedOnV3: flipsAvoided,
      },
    };
    if (wantJson) return NextResponse.json(payload);

    // ── plain-text rendering ─────────────────────────────────────────────
    const out: string[] = [];
    out.push(`RUBRIC V3 CALIBRATION (read-only)   regime=${market.riskRegime}   names=${rows.length}   legacy max=${LEGACY_MAX}   live max=${V3_MAX}`);
    out.push(`legacy 41 is RECONSTRUCTED from stored scores (${DROPPED_KEYS.join(", ")} added back, returnsMargins removed); live ${V3_MAX} is computeScores.`);
    out.push("");
    out.push(`== 1. TODAY (sorted by live ${V3_MAX}-pt adjusted) ==`);
    out.push(`${pad("ticker", 10)}${pad("bkt", 5)}${pad("adj41", 7, true)}${pad("label41", 14)}${pad("tech", 6, true)}${pad("cov", 5, true)}${pad("raw31", 7, true)}${pad("adj31", 7, true)}${pad("mult", 7, true)}`);
    for (const r of rows) {
      out.push(
        `${pad(r.ticker, 10)}${pad(r.bucket === "Portfolio" ? "P" : "W", 5)}${pad(r.adjusted41.toFixed(1), 7, true)} ${pad(r.label41, 13)}${pad(r.tech.toFixed(1), 6, true)}${pad(r.coverage, 5, true)}${pad(r.raw31.toFixed(1), 7, true)}${pad(r.adjusted31.toFixed(1), 7, true)}${pad(r.multiplier.toFixed(3), 7, true)}`,
      );
    }
    out.push("");
    out.push("== 2. BANDS ==");
    out.push(`today's label counts (41): ${LABELS.map((l) => `${l}=${dist41[l]}`).join("  ")}`);
    const fmtBands = (b: RatingBands) => `SB≥${b.strongBuy}  MB≥${b.moderateBuy}  H≥${b.hold}  UW≥${b.underweight}`;
    out.push(`A. LIVE cutoffs on ${V3_MAX}:      ${fmtBands(ratioBands)}   labels unchanged vs legacy: ${ratioAgree.pct}%`);
    if (ratioAgree.moved.length) out.push(`   moved: ${ratioAgree.moved.join("; ")}`);
    out.push(`B. quantile-matched on ${V3_MAX}: ${fmtBands(qBands)}   labels unchanged vs legacy: ${qAgree.pct}%`);
    if (qAgree.moved.length) out.push(`   moved: ${qAgree.moved.join("; ")}`);
    out.push(`   as fraction of max: A=${JSON.stringify(asFraction(ratioBands))}  B=${JSON.stringify(asFraction(qBands))}`);
    out.push("");
    out.push("== 3. HISTORY (consecutive rescore pairs, book names) ==");
    out.push(`pairs with any category movement: ${pairs}`);
    out.push(`median share of the raw move from technicals+coverage: ${payload.history.medianTechShare ?? "n/a"}%`);
    out.push(`pairs where technicals+coverage were >50% of the move: ${payload.history.techDominantPct ?? "n/a"}%`);
    out.push(`pairs where NOTHING non-technical moved: ${payload.history.techOnlyPct ?? "n/a"}%`);
    out.push(`label changes on the legacy 41 scale: ${flips41}; of those, unchanged on the v3 subtotal (live bands): ${flipsAvoided}`);
    return new NextResponse(out.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
