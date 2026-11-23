import { FAVOUR_RULES, type FavourRead } from "./favour";
import type { AnalystTrend } from "./analyst-history";

/**
 * Contrarian setup (Nov 2026) — a read-out shown BESIDE the score.
 *
 * The composite penalises an out-of-favour stock almost by construction
 * (weak relative strength, cautious analysts, falling targets), so a real
 * contrarian candidate scores badly. This reads four independent tests from
 * data already on file and says, in plain words, whether the positive side
 * of a contrarian case is there.
 *
 * It NEVER feeds the composite, the setup grade, the rating bands or any
 * stored score, and nothing here is saved. Pure — no Redis, no fetch.
 * A test with no data reads "no data": it is never counted as a pass or a
 * fail.
 */

export const CONTRARIAN_RULES = {
  /** (a) Cheap: the multiple sits at least this far below its own 5-year average. */
  cheapDiscountPct: 15,
  /** (a) A valuation reading older than this is not used. */
  maxValuationAgeDays: 200,
  /** (b) Fewer analysts than this is too thin a panel to read revisions from. */
  minPanel: 4,
  /** (b) Net revisions (up − down) ÷ analysts must be at or above this. */
  minNetRevisionShare: 0,
  /** (b) The mean target must not have fallen more than this over 30 days. */
  maxTargetCut30dPct: 3,
  /** (c) Open-market purchases must total at least this (US$). */
  minInsiderBuyUsd: 100_000,
  /** (d) Out of favour — the same lines the favour monitor uses. */
  fromHighPct: FAVOUR_RULES.outFromHigh,
  rel6Pts: FAVOUR_RULES.outRel6,
  rel12Pts: FAVOUR_RULES.outRel12,
};

export const CONTRARIAN_CAUTION =
  "Cheap and out of favour can stay that way. This is a prompt to look closer, not a buy signal, and it is not part of the score.";

export type ContrarianStatus = "met" | "not-met" | "no-data";
export type ContrarianTestId = "cheap" | "estimates" | "insiders" | "washedOut";
export type ContrarianTest = {
  id: ContrarianTestId;
  title: string;
  status: ContrarianStatus;
  /** One plain sentence: what was found. */
  summary: string;
  /** The figures behind it. */
  numbers: { label: string; value: string }[];
};
export type ContrarianLabel = "Contrarian setup" | "Partial" | "Not a contrarian setup" | "Not enough data";
export type ContrarianRead = {
  /** Tests met, 0–4. */
  score: number;
  /** Tests that had data to read. */
  of: number;
  tests: ContrarianTest[];
  label: ContrarianLabel;
  /** Why the label is what it is, one sentence. */
  why: string;
  caution: string;
};

export type ValuationInput = { ntmPe?: number; ntmPeFiveYrAvg?: number; evEbitda?: number; evEbitdaFiveYrAvg?: number; asOf?: string; source?: string } | null;
export type RevisionsInput = { revUp?: number; revDown?: number; analystCount?: number } | null;
export type InsidersInput = { buyCount: number; sellCount: number; totalBuyValue: number; totalSellValue: number; windowDays: number; asOf?: string } | null;
export type ThesisInput = { brokenPillars: string[]; trippedBreakers: string[] } | null;
export type ContrarianInput = {
  today: string; // YYYY-MM-DD
  valuation: ValuationInput;
  revisions: RevisionsInput;
  /** From pm:analyst-history; null when the name has no log. */
  trend: AnalystTrend | null;
  /** False for a name the SEC Form 4 feed does not cover (Canadian listings). */
  usFiler: boolean;
  insiders: InsidersInput;
  favour: FavourRead | null;
  /** Null when the name has no signed thesis. */
  thesis: ThesisInput;
};

const pos = (v: number | undefined | null): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const num = (v: number | undefined | null): v is number => typeof v === "number" && Number.isFinite(v);
const x = (v: number) => `${v.toFixed(1)}x`;
const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
const pts = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)} pts`;
const usd = (v: number) => (v >= 1_000_000 ? `US$${(v / 1_000_000).toFixed(1)}M` : `US$${Math.round(v / 1000)}K`);
const daysBetween = (a: string, b: string) => Math.floor((Date.parse(b) - Date.parse(a.slice(0, 10))) / 86_400_000);

/** (a) Cheap versus its own 5-year history. */
export function testCheap(v: ValuationInput, today: string): ContrarianTest {
  const base = { id: "cheap" as const, title: "Cheap versus its own history" };
  if (!v) return { ...base, status: "no-data", summary: "No valuation history on file (it comes from FactSet analyst round-ups).", numbers: [] };
  if (v.asOf && daysBetween(v.asOf, today) > CONTRARIAN_RULES.maxValuationAgeDays)
    return { ...base, status: "no-data", summary: `The last valuation reading on file is from ${v.asOf.slice(0, 10)} — too old to use.`, numbers: [] };
  const discounts: number[] = [];
  const numbers: ContrarianTest["numbers"] = [];
  if (pos(v.ntmPe) && pos(v.ntmPeFiveYrAvg)) {
    const d = (v.ntmPe / v.ntmPeFiveYrAvg - 1) * 100;
    discounts.push(d);
    numbers.push({ label: "Forward P/E vs 5-year average", value: `${x(v.ntmPe)} vs ${x(v.ntmPeFiveYrAvg)} (${pct(d)})` });
  }
  if (pos(v.evEbitda) && pos(v.evEbitdaFiveYrAvg)) {
    const d = (v.evEbitda / v.evEbitdaFiveYrAvg - 1) * 100;
    discounts.push(d);
    numbers.push({ label: "EV/EBITDA vs 5-year average", value: `${x(v.evEbitda)} vs ${x(v.evEbitdaFiveYrAvg)} (${pct(d)})` });
  }
  if (!discounts.length) return { ...base, status: "no-data", summary: "No multiple with its 5-year average on file.", numbers: [] };
  if (v.asOf) numbers.push({ label: "As of", value: `${v.asOf.slice(0, 10)}${v.source ? ` · ${v.source}` : ""}` });
  const avg = discounts.reduce((a, b) => a + b, 0) / discounts.length;
  const met = avg <= -CONTRARIAN_RULES.cheapDiscountPct;
  return {
    ...base,
    status: met ? "met" : "not-met",
    summary: met
      ? `Trades about ${Math.abs(avg).toFixed(0)}% below its own 5-year average multiple.`
      : avg < 0
        ? `Only about ${Math.abs(avg).toFixed(0)}% below its 5-year average — less than the ${CONTRARIAN_RULES.cheapDiscountPct}% line.`
        : `Trades about ${avg.toFixed(0)}% above its own 5-year average multiple.`,
    numbers,
  };
}

/** (b) Estimates have stopped falling. */
export function testEstimates(r: RevisionsInput, trend: AnalystTrend | null): ContrarianTest {
  const base = { id: "estimates" as const, title: "Estimates have stopped falling" };
  const R = CONTRARIAN_RULES;
  if (!r || (!num(r.revUp) && !num(r.revDown))) return { ...base, status: "no-data", summary: "No estimate revisions on file for this name.", numbers: [] };
  if (!pos(r.analystCount) || r.analystCount < R.minPanel)
    return { ...base, status: "no-data", summary: `Fewer than ${R.minPanel} analysts on file — too thin a panel to read revisions from.`, numbers: [{ label: "Analysts", value: String(r.analystCount ?? "—") }] };
  const up = r.revUp ?? 0;
  const down = r.revDown ?? 0;
  const share = (up - down) / r.analystCount;
  const numbers: ContrarianTest["numbers"] = [
    { label: "Earnings revisions, 30 days", value: `${up} up, ${down} down of ${r.analystCount} analysts` },
    { label: "Net as a share of analysts", value: pct(share * 100) },
  ];
  // The target leg only counts when the log is old enough to compare.
  const d30 = trend?.d30?.targetPct;
  const streak = trend?.targetStreak ?? null;
  let targetStillCut = false;
  if (num(d30)) {
    numbers.push({ label: "Average target, 30 days", value: pct(d30) });
    if (d30 < -R.maxTargetCut30dPct) targetStillCut = true;
  } else numbers.push({ label: "Average target trend", value: "not enough history yet" });
  if (streak && streak.changes >= 2) numbers.push({ label: "Target changes in a row", value: `${streak.changes} ${streak.direction === "down" ? "cuts" : "raises"}` });

  if (share < R.minNetRevisionShare) return { ...base, status: "not-met", summary: "More analysts are still cutting earnings estimates than raising them.", numbers };
  if (targetStillCut) return { ...base, status: "not-met", summary: `Revisions have turned, but the average target fell ${Math.abs(d30 as number).toFixed(1)}% in the last 30 days.`, numbers };
  return {
    ...base,
    status: "met",
    summary: num(d30) ? "Revisions are no longer net negative and the average target has held." : "Revisions are no longer net negative (target history is too short to confirm).",
    numbers,
  };
}

/** (c) Insiders buying on the open market. */
export function testInsiders(i: InsidersInput, usFiler: boolean): ContrarianTest {
  const base = { id: "insiders" as const, title: "Insiders buying" };
  if (!usFiler) return { ...base, status: "no-data", summary: "Insider filings on file cover US-listed companies only; Canadian insider data is not available here.", numbers: [] };
  if (!i) return { ...base, status: "no-data", summary: "No insider filings on file for this name yet (they load when the stock is scored).", numbers: [] };
  const numbers: ContrarianTest["numbers"] = [
    { label: `Open-market purchases, ${i.windowDays} days`, value: `${i.buyCount} · ${usd(i.totalBuyValue)}` },
    { label: `Open-market sales, ${i.windowDays} days`, value: `${i.sellCount} · ${usd(i.totalSellValue)}` },
  ];
  if (i.asOf) numbers.push({ label: "As of", value: i.asOf.slice(0, 10) });
  if (i.buyCount === 0 && i.sellCount === 0) return { ...base, status: "not-met", summary: `No open-market insider trades in the last ${i.windowDays} days.`, numbers };
  const met = i.buyCount >= 1 && i.totalBuyValue >= CONTRARIAN_RULES.minInsiderBuyUsd && i.totalBuyValue > i.totalSellValue;
  return {
    ...base,
    status: met ? "met" : "not-met",
    summary: met
      ? `Insiders bought ${usd(i.totalBuyValue)} on the open market, more than they sold.`
      : i.buyCount === 0
        ? "Insiders have sold and none has bought on the open market."
        : i.totalBuyValue <= i.totalSellValue
          ? "Insider sales outweigh purchases."
          : `Insider purchases are under ${usd(CONTRARIAN_RULES.minInsiderBuyUsd)} — too small to read.`,
    numbers,
  };
}

/** True when the price read says the name is out of favour; null = cannot tell. */
export function isOutOfFavour(f: FavourRead | null): boolean | null {
  if (!f || f.state === "thin" || f.fromHighPct == null || f.rel.m6 == null) return null;
  const R = CONTRARIAN_RULES;
  return f.fromHighPct <= R.fromHighPct && (f.rel.m6 <= R.rel6Pts || (f.rel.m12 != null && f.rel.m12 <= R.rel12Pts));
}

/** (d) Washed-out price while the business is not broken. */
export function testWashedOut(f: FavourRead | null, thesis: ThesisInput): ContrarianTest {
  const base = { id: "washedOut" as const, title: "Out of favour, business not broken" };
  const out = isOutOfFavour(f);
  if (out == null || !f) return { ...base, status: "no-data", summary: "Not enough price history to tell whether it is out of favour.", numbers: [] };
  const numbers: ContrarianTest["numbers"] = [
    { label: "From its 52-week high", value: pct(f.fromHighPct as number) },
    { label: "Versus the S&P 500, 6 months", value: pts(f.rel.m6 as number) },
  ];
  if (f.rel.m12 != null) numbers.push({ label: "Versus the S&P 500, 12 months", value: pts(f.rel.m12) });
  if (!out) return { ...base, status: "not-met", summary: "Not out of favour: it is not both well off its high and lagging the market.", numbers };
  const broken = thesis?.brokenPillars ?? [];
  const tripped = thesis?.trippedBreakers ?? [];
  if (broken.length || tripped.length) {
    if (broken.length) numbers.push({ label: "Pillars marked broken", value: broken.join("; ") });
    if (tripped.length) numbers.push({ label: "Breakers tripped", value: tripped.join("; ") });
    return { ...base, status: "not-met", summary: "Out of favour, but our own thesis says something is broken — that is a damaged business, not a contrarian setup.", numbers };
  }
  numbers.push({ label: "Thesis check", value: thesis ? "no broken pillar, no tripped breaker" : "no signed thesis on file to check" });
  return {
    ...base,
    status: "met",
    summary: thesis ? "Well off its high and lagging the market, with no thesis pillar broken." : "Well off its high and lagging the market. There is no signed thesis to confirm the business is intact.",
    numbers,
  };
}

/**
 * The whole read. The label only says "Contrarian setup" when the name IS
 * out of favour (d) and at least two of the three supporting tests are met —
 * a strong stock near its high is not a contrarian candidate, not a failed one.
 */
export function readContrarian(input: ContrarianInput): ContrarianRead {
  const cheap = testCheap(input.valuation, input.today);
  const estimates = testEstimates(input.revisions, input.trend);
  const insiders = testInsiders(input.insiders, input.usFiler);
  const washed = testWashedOut(input.favour, input.thesis);
  const tests = [washed, cheap, estimates, insiders];
  const support = [cheap, estimates, insiders];
  const supportMet = support.filter((t) => t.status === "met").length;
  const supportWithData = support.filter((t) => t.status !== "no-data").length;
  const score = tests.filter((t) => t.status === "met").length;
  const of = tests.filter((t) => t.status !== "no-data").length;
  const impaired = !!(input.thesis && (input.thesis.brokenPillars.length || input.thesis.trippedBreakers.length));

  let label: ContrarianLabel;
  let why: string;
  if (washed.status === "no-data") {
    label = "Not enough data";
    why = "Without a price read we cannot tell whether it is out of favour.";
  } else if (washed.status === "not-met") {
    label = "Not a contrarian setup";
    why = impaired && isOutOfFavour(input.favour) ? "It is out of favour, but our own thesis flags the business as impaired." : "It is not out of favour, so there is nothing contrarian about owning it.";
  } else if (supportWithData === 0) {
    label = "Not enough data";
    why = "It is out of favour, but none of the supporting tests has data on file.";
  } else if (supportMet >= 2) {
    label = "Contrarian setup";
    why = `Out of favour with ${supportMet} of ${supportWithData} supporting signs in place.`;
  } else if (supportMet === 1) {
    label = "Partial";
    why = `Out of favour with 1 of ${supportWithData} supporting sign${supportWithData === 1 ? "" : "s"} in place.`;
  } else {
    label = "Not a contrarian setup";
    why = "Out of favour, and none of the supporting signs is in place yet.";
  }
  return { score, of, tests, label, why, caution: CONTRARIAN_CAUTION };
}

/** A Canadian listing (not covered by SEC Form 4). */
export function isCanadianListing(ticker: string): boolean {
  return /(-T|\.TO|-V|\.V|\.NE|-NE|\.CN)$/i.test(ticker.trim());
}
