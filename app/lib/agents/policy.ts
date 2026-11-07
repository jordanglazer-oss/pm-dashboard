/**
 * The investment policy — the PM's rules in one place, written once and
 * shared by every watcher (and, from Step 7, the morning brief's hedging
 * call). Two halves:
 *
 *   POLICY_TEXT   plain-language rules, sent verbatim in watcher prompts so
 *                 every agent judges against the same policy.
 *   hedgeSentimentGate()
 *                 the deterministic part of the hedge rule: the window stays
 *                 CLOSED if any one sentiment test fails. Code, not a model,
 *                 decides this — a watcher may explain the result but can
 *                 never override it.
 *
 * Pure module: no Redis, no network. Changing a threshold below is a policy
 * change — note it in the commit message.
 */

export const POLICY_VERSION = "2026-11-07";

export const POLICY_TEXT = `INVESTMENT POLICY (version ${POLICY_VERSION})

1. Core. Broad exposure through S&P 500 and Nasdaq index ETFs. Core is never sold to reduce risk.

2. Protecting the book. Declines are sidestepped by HEDGING, not by selling.
   - Hedge only when protection is cheap AND sentiment is not already overly negative.
   - Never hedge reactively after a spike: once fear is high, protection is expensive and the moment has usually passed.
   - The hedge check runs once a day, after the close.

3. Thematic funds. Held for managers who can outperform. The question is always the manager and their record, not the theme's latest month.

4. Individual stocks (Alpha). Held only on a rock-solid long-term thesis. A stock is sold when its thesis weakens — not because the price fell, the market fell, or the stock looks expensive for a while.

5. What watchers may do. Watchers monitor, flag and suggest. They never trade, change model weights or change scores. Every suggestion goes to the PM, who decides.`;

/** Sentiment levels at which the hedge window is CLOSED (any one is enough).
 *  Proposed to the PM in Nov 2026; adjust here if the PM changes them. */
export const HEDGE_SENTIMENT_LIMITS = {
  /** CNN Fear & Greed below this = fear already high. */
  fearGreedBelow: 25,
  /** VIX up more than this % on the day = a spike in progress. */
  vixDayChangeAbovePct: 15,
  /** AAII bull-minus-bear spread below this = bears exceed bulls by >20 pts. */
  aaiiSpreadBelow: -20,
  /** CBOE total put/call above this = crowd already buying protection. */
  putCallAbove: 1.1,
  /** Put skew at or above this percentile = tails already bid. */
  skewPercentileAtOrAbove: 80,
} as const;

export type HedgeSentimentInputs = {
  fearGreed: number | null;
  /** VIX close vs prior close, in percent (e.g. 18 = +18%). */
  vixDayChangePct: number | null;
  /** AAII bullish % minus bearish %. */
  aaiiSpread: number | null;
  putCall: number | null;
  /** Mid-tenor (2-4M) put skew percentile from the premium ledger. */
  skewPercentile: number | null;
};

export type HedgeSentimentTest = {
  id: keyof HedgeSentimentInputs;
  label: string;
  /** Short name of the reading, for the closed-window reason. */
  name: string;
  /** true = calm enough; false = closes the window; null = no data. */
  pass: boolean | null;
  value: number | null;
  limit: string;
};

export type HedgeSentimentResult = {
  /** "open" only when every test with data passes and at least 3 of 5 have data. */
  window: "open" | "closed" | "unknown";
  tests: HedgeSentimentTest[];
  /** Plain-language reasons the window is closed (empty when open). */
  reasons: string[];
  missing: string[];
};

/** Fewest tests that must have data before "open" can be returned. */
const MIN_TESTS_WITH_DATA = 3;

/** Finite number rounded to 2 decimals (readings like a VIX % change arrive
 *  with long tails), else null. */
const fin = (n: number | null | undefined): number | null =>
  typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) / 100 : null;

/**
 * The sentiment half of the hedge rule. Closed if ANY test fails. A missing
 * reading never fails a test, but too many missing readings return
 * "unknown" — never "open" on thin data.
 */
export function hedgeSentimentGate(raw: HedgeSentimentInputs): HedgeSentimentResult {
  const L = HEDGE_SENTIMENT_LIMITS;
  const v = {
    fearGreed: fin(raw.fearGreed),
    vixDayChangePct: fin(raw.vixDayChangePct),
    aaiiSpread: fin(raw.aaiiSpread),
    putCall: fin(raw.putCall),
    skewPercentile: fin(raw.skewPercentile),
  };
  const tests: HedgeSentimentTest[] = [
    {
      id: "fearGreed",
      name: "Fear & Greed",
      label: "Fear & Greed not in extreme fear",
      value: v.fearGreed,
      limit: `closes below ${L.fearGreedBelow}`,
      pass: v.fearGreed == null ? null : v.fearGreed >= L.fearGreedBelow,
    },
    {
      id: "vixDayChangePct",
      name: "VIX day change %",
      label: "VIX not spiking today",
      value: v.vixDayChangePct,
      limit: `closes above +${L.vixDayChangeAbovePct}% on the day`,
      pass: v.vixDayChangePct == null ? null : v.vixDayChangePct <= L.vixDayChangeAbovePct,
    },
    {
      id: "aaiiSpread",
      name: "AAII bull-bear spread",
      label: "AAII bears not swamping bulls",
      value: v.aaiiSpread,
      limit: `closes when bears lead by more than ${-L.aaiiSpreadBelow} pts`,
      pass: v.aaiiSpread == null ? null : v.aaiiSpread >= L.aaiiSpreadBelow,
    },
    {
      id: "putCall",
      name: "Put/call",
      label: "Put/call not already elevated",
      value: v.putCall,
      limit: `closes above ${L.putCallAbove}`,
      pass: v.putCall == null ? null : v.putCall <= L.putCallAbove,
    },
    {
      id: "skewPercentile",
      name: "Put skew percentile",
      label: "Put skew not already bid",
      value: v.skewPercentile,
      limit: `closes at or above the ${L.skewPercentileAtOrAbove}th percentile`,
      pass: v.skewPercentile == null ? null : v.skewPercentile < L.skewPercentileAtOrAbove,
    },
  ];

  const failed = tests.filter((t) => t.pass === false);
  const missing = tests.filter((t) => t.pass === null).map((t) => t.label);
  const reasons = failed.map((t) => `${t.name} ${t.value} (${t.limit})`);
  const withData = tests.length - missing.length;

  const window = failed.length > 0 ? "closed" : withData < MIN_TESTS_WITH_DATA ? "unknown" : "open";
  return { window, tests, reasons, missing };
}

/** One-paragraph rendering for prompts and the Monitor page. */
export function describeSentimentGate(r: HedgeSentimentResult): string {
  if (r.window === "closed") return `Hedge window CLOSED by sentiment — ${r.reasons.join("; ")}.`;
  if (r.window === "unknown") return `Hedge window UNKNOWN — too little sentiment data (missing: ${r.missing.join(", ")}).`;
  const gap = r.missing.length ? ` (no data: ${r.missing.join(", ")})` : "";
  return `Sentiment does not block a hedge — every test passes${gap}.`;
}

/** A hedging call as the brief / refresh routes produce it. */
export type HedgeCallLike = { action?: string; strike?: unknown; tenor?: unknown; reason?: string };

/**
 * Deterministic backstop for the policy: an ADD while the sentiment window is
 * not OPEN becomes SKIP. The prompt states the rule; this catches the miss.
 * Returns the call unchanged when nothing needs correcting.
 */
export function enforceHedgeSentiment<T extends HedgeCallLike>(call: T, gate: HedgeSentimentResult): { call: T; changed: boolean } {
  if (call.action !== "ADD" || gate.window === "open") return { call, changed: false };
  const why =
    gate.window === "closed"
      ? `Sentiment already fearful — policy says don't hedge into it (${gate.reasons.join("; ")}).`
      : `Too little sentiment data to confirm the hedge window is open (missing: ${gate.missing.join(", ")}).`;
  const orig = call.reason ? ` (was ADD: ${call.reason})` : "";
  return { call: { ...call, action: "SKIP", strike: undefined, tenor: undefined, reason: `${why}${orig}` }, changed: true };
}
