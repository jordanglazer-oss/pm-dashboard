import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { bookStocks, MAX_SCORE, SCORE_GROUPS } from "@/app/lib/types";
import type { Stock, MarketData, ScoreKey } from "@/app/lib/types";
import { computeScores, isScoreable, ownershipTrendsApplies, isDataGapExplanation } from "@/app/lib/scoring";
import { RATING_BANDS, ratingLabelFor, type RatingBands, type RatingLabel } from "@/app/lib/rating-bands";
import type { ScoreHistoryStore } from "@/app/api/kv/score-history/route";

/**
 * GET /api/admin/rubric-v3-calibration            (plain-text tables)
 * GET /api/admin/rubric-v3-calibration?json=1     (same data as JSON)
 *
 * READ-ONLY. Reads pm:stocks, pm:market and pm:score-history; writes nothing.
 *
 * Rubric v3 pulls the four technical categories (charting / SIA / BoostedAI /
 * MarketEdge) and researchCoverage OUT of the composite into a separate setup
 * layer, so the conviction score's max drops from 41 to 31 today (33 once the
 * new Returns & margins category exists). The Buy/Hold/Sell cutoffs must be
 * RECALIBRATED from where today's names actually land, not scaled by ratio.
 * This route answers three questions on live data:
 *
 *   1. TODAY — every scoreable book name's current adjusted (41-pt) rating
 *      beside its v3-comparable conviction subtotal (31-pt), regime
 *      multiplier applied identically.
 *   2. BANDS — two candidate cutoff sets on the 31 scale: ratio-scaled
 *      (30·31/41 …) and quantile-matched (keeps today's COUNT of Strong
 *      Buys / Moderate Buys / Holds / Underweights), each with the share of
 *      names whose label is unchanged.
 *   3. HISTORY — across consecutive score-history entries, how much of each
 *      score move came from the technical categories, and how many
 *      label changes would not have happened on the v3 subtotal.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const TECH_KEYS: ScoreKey[] = ["charting", "relativeStrength", "aiRating", "marketEdge"];
const DROPPED_KEYS: ScoreKey[] = [...TECH_KEYS, "researchCoverage"];

const CATEGORY_MAX: Record<string, number> = Object.fromEntries(
  SCORE_GROUPS.flatMap((g) => g.categories.map((c) => [c.key, c.max])),
);
const V3_KEYS: ScoreKey[] = SCORE_GROUPS.flatMap((g) => g.categories.map((c) => c.key as ScoreKey)).filter(
  (k) => !DROPPED_KEYS.includes(k),
);
const V3_MAX = V3_KEYS.reduce((s, k) => s + (CATEGORY_MAX[k] ?? 0), 0); // 31 today
// The AI/SEMI categories whose DATA GAP parking computeScores renormalizes away.
const V3_GAP_KEYS: ScoreKey[] = SCORE_GROUPS.flatMap((g) =>
  g.categories.filter((c) => c.inputType === "auto" || c.inputType === "semi").map((c) => c.key as ScoreKey),
).filter((k) => V3_KEYS.includes(k));

/**
 * The v3 conviction subtotal, computed with the SAME numerator/denominator
 * rules computeScores applies to the 41-pt composite (ownershipTrends N/A on
 * Canadian listings, DATA GAP categories dropped from both sides), then
 * renormalized to V3_MAX. Mirrors computeScores rather than calling it so
 * the live 41-pt path is untouched.
 */
function v3Raw(stock: Stock): number {
  let sum = V3_KEYS.reduce((s, k) => s + (stock.scores[k] || 0), 0);
  let effMax = V3_MAX;
  if (!ownershipTrendsApplies(stock)) {
    sum -= stock.scores.ownershipTrends || 0;
    effMax -= CATEGORY_MAX.ownershipTrends;
  }
  for (const k of V3_GAP_KEYS) {
    if (k === "ownershipTrends" && !ownershipTrendsApplies(stock)) continue;
    if (isDataGapExplanation(stock.explanations?.[k])) {
      sum -= stock.scores[k] || 0;
      effMax -= CATEGORY_MAX[k] ?? 0;
    }
  }
  const norm = effMax > 0 ? sum * (V3_MAX / effMax) : sum;
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
    strongBuy: fin(sb, roundHalf((RATING_BANDS.strongBuy * V3_MAX) / MAX_SCORE)),
    moderateBuy: fin(mb, roundHalf((RATING_BANDS.moderateBuy * V3_MAX) / MAX_SCORE)),
    hold: fin(ho, roundHalf((RATING_BANDS.hold * V3_MAX) / MAX_SCORE)),
    underweight: fin(uw, roundHalf((RATING_BANDS.underweight * V3_MAX) / MAX_SCORE)),
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
        const scored = computeScores(s, market);
        const multiplier = scored.raw > 0 ? scored.adjusted / scored.raw : 1;
        const raw31 = v3Raw(s);
        return {
          ticker: s.ticker,
          bucket: s.bucket,
          sector: s.sector,
          raw41: scored.raw,
          adjusted41: scored.adjusted,
          label41: ratingLabelFor(scored.adjusted),
          tech: Math.round(TECH_KEYS.reduce((t, k) => t + (s.scores[k] || 0), 0) * 10) / 10,
          coverage: s.scores.researchCoverage || 0,
          raw31,
          adjusted31: Math.round(raw31 * multiplier * 10) / 10,
          multiplier: Math.round(multiplier * 1000) / 1000,
        };
      })
      .sort((a, b) => b.adjusted31 - a.adjusted31);

    // ── 2. BANDS ─────────────────────────────────────────────────────────
    const ratioBands: RatingBands = {
      strongBuy: roundHalf((RATING_BANDS.strongBuy * V3_MAX) / MAX_SCORE),
      moderateBuy: roundHalf((RATING_BANDS.moderateBuy * V3_MAX) / MAX_SCORE),
      hold: roundHalf((RATING_BANDS.hold * V3_MAX) / MAX_SCORE),
      underweight: roundHalf((RATING_BANDS.underweight * V3_MAX) / MAX_SCORE),
    };
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
        const l41Prev = ratingLabelFor(prev.adjusted);
        const l41Cur = ratingLabelFor(cur.adjusted);
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
        current41: RATING_BANDS,
        ratio31: { cutoffs: ratioBands, fractionOfMax: asFraction(ratioBands), agreementPct: ratioAgree.pct, moved: ratioAgree.moved },
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
    out.push(`RUBRIC V3 CALIBRATION (read-only)   regime=${market.riskRegime}   names=${rows.length}   41-pt max=${MAX_SCORE}   v3 max today=${V3_MAX}`);
    out.push(`dropped from composite: ${DROPPED_KEYS.join(", ")}`);
    out.push("");
    out.push("== 1. TODAY (sorted by v3 adjusted) ==");
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
    out.push(`A. ratio-scaled on ${V3_MAX}:     ${fmtBands(ratioBands)}   labels unchanged: ${ratioAgree.pct}%`);
    if (ratioAgree.moved.length) out.push(`   moved: ${ratioAgree.moved.join("; ")}`);
    out.push(`B. quantile-matched on ${V3_MAX}: ${fmtBands(qBands)}   labels unchanged: ${qAgree.pct}%`);
    if (qAgree.moved.length) out.push(`   moved: ${qAgree.moved.join("; ")}`);
    out.push(`   as fraction of max (carries to 33): A=${JSON.stringify(asFraction(ratioBands))}  B=${JSON.stringify(asFraction(qBands))}`);
    out.push("");
    out.push("== 3. HISTORY (consecutive rescore pairs, book names) ==");
    out.push(`pairs with any category movement: ${pairs}`);
    out.push(`median share of the raw move from technicals+coverage: ${payload.history.medianTechShare ?? "n/a"}%`);
    out.push(`pairs where technicals+coverage were >50% of the move: ${payload.history.techDominantPct ?? "n/a"}%`);
    out.push(`pairs where NOTHING non-technical moved: ${payload.history.techOnlyPct ?? "n/a"}%`);
    out.push(`label changes on the 41 scale: ${flips41}; of those, unchanged on the v3 subtotal (ratio bands): ${flipsAvoided}`);
    return new NextResponse(out.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
