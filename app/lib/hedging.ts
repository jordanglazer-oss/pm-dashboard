/**
 * Shared SPY hedging cost fetcher used by both the /api/hedging route
 * (which powers the Hedging tab) and the /api/morning-brief route (which
 * injects live put costs into the Hedging Window analysis prompt).
 *
 * All data is pulled from CBOE delayed quotes (15-min delay, no auth).
 */

import { getRedis } from "@/app/lib/redis";

export type CboeOption = {
  option: string;
  bid?: number;
  ask?: number;
  last_trade_price?: number;
};

type CboeResponse = {
  data?: {
    current_price?: number;
    options?: CboeOption[];
  };
};

export type HedgingQuote = {
  expiry: string;
  expiryLabel: string;
  daysToExpiry: number;
  atmStrike: number;
  atmPremium: number | null;
  atmPctOfSpot: number | null;
  otm5Strike: number;
  otm5Premium: number | null;
  otm5PctOfSpot: number | null;
  otm10Strike: number;
  otm10Premium: number | null;
  otm10PctOfSpot: number | null;
};

export type CustomStrikeQuote = {
  expiry: string;
  premium: number | null;
  pctOfSpot: number | null;
};

export type CustomStrikeRow = {
  strike: number;
  quotes: CustomStrikeQuote[];
};

export type HedgingLiveData = {
  fetchedAt: string;
  spotPrice: number;
  quotes: HedgingQuote[];
  customRows: CustomStrikeRow[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function roundToNearest5(v: number): number {
  return Math.round(v / 5) * 5;
}

function parseOptionSymbol(sym: string): { expiry: string; type: "C" | "P"; strike: number } | null {
  const m = /^([A-Z]+)(\d{6})([CP])(\d{8})$/.exec(sym);
  if (!m) return null;
  const dateStr = m[2];
  const year = 2000 + parseInt(dateStr.slice(0, 2), 10);
  const month = parseInt(dateStr.slice(2, 4), 10);
  const day = parseInt(dateStr.slice(4, 6), 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const expiry = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { expiry, type: m[3] as "C" | "P", strike: parseInt(m[4], 10) / 1000 };
}

function thirdFridayIso(year: number, month: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const firstFri = ((5 - first + 7) % 7) + 1;
  const thirdFri = firstFri + 14;
  return `${year}-${String(month).padStart(2, "0")}-${String(thirdFri).padStart(2, "0")}`;
}

function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.abs((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
}

function isoToShortLabel(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${String(d).padStart(2, "0")}-${MONTHS[m - 1]}`;
}

function daysUntil(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d);
  const now = Date.now();
  return Math.max(0, Math.round((target - now) / 86400000));
}

function midPrice(bid: number | undefined, ask: number | undefined, last: number | undefined): number | null {
  if (bid != null && ask != null && bid > 0 && ask > 0) {
    return parseFloat(((bid + ask) / 2).toFixed(2));
  }
  if (last != null && last > 0) return parseFloat(last.toFixed(2));
  return null;
}

/**
 * Fetch live SPY put premiums at ATM / ~5% OTM / ~10% OTM across the next
 * 9 calendar months, plus any user-supplied custom strikes.
 *
 * @param extraStrikes  Optional list of custom strikes to price at each expiry
 */
export async function fetchLiveHedgingCosts(extraStrikes: number[] = []): Promise<HedgingLiveData> {
  const res = await fetch("https://cdn.cboe.com/api/global/delayed_quotes/options/SPY.json", {
    headers: { "User-Agent": "Mozilla/5.0" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`CBOE returned ${res.status}`);
  const body = (await res.json()) as CboeResponse;
  const spot = body?.data?.current_price;
  const rawOptions = body?.data?.options || [];
  if (!spot || rawOptions.length === 0) {
    throw new Error("Could not parse SPY quote or options");
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const putsByExpiry = new Map<string, Map<number, CboeOption>>();
  for (const opt of rawOptions) {
    const parsed = parseOptionSymbol(opt.option);
    if (!parsed || parsed.type !== "P") continue;
    if (parsed.expiry <= todayIso) continue;
    if (!putsByExpiry.has(parsed.expiry)) putsByExpiry.set(parsed.expiry, new Map());
    putsByExpiry.get(parsed.expiry)!.set(parsed.strike, opt);
  }

  // Pick best available expiry per calendar month for next 9 months
  const allExpiries = [...putsByExpiry.keys()].sort();
  const now = new Date();
  const monthlyExpiries: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < 9; i++) {
    const probe = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const y = probe.getUTCFullYear();
    const m = probe.getUTCMonth() + 1;
    const prefix = `${y}-${String(m).padStart(2, "0")}-`;
    const target = thirdFridayIso(y, m);
    const candidates = allExpiries.filter((e) => e.startsWith(prefix) && e > todayIso);
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => dayDiff(a, target) - dayDiff(b, target));
    const pick = candidates[0];
    if (!seen.has(pick)) {
      seen.add(pick);
      monthlyExpiries.push(pick);
    }
  }
  monthlyExpiries.sort();

  if (monthlyExpiries.length === 0) throw new Error("No monthly expiries in option chain");

  const atmStrike = roundToNearest5(spot);
  const otm5Strike = roundToNearest5(spot * 0.95);
  const otm10Strike = roundToNearest5(spot * 0.9);

  const quotes: HedgingQuote[] = monthlyExpiries.map((expiry) => {
    const strikeMap = putsByExpiry.get(expiry)!;
    const atm = strikeMap.get(atmStrike);
    const otm5 = strikeMap.get(otm5Strike);
    const otm10 = strikeMap.get(otm10Strike);
    const atmPremium = midPrice(atm?.bid, atm?.ask, atm?.last_trade_price);
    const otm5Premium = midPrice(otm5?.bid, otm5?.ask, otm5?.last_trade_price);
    const otm10Premium = midPrice(otm10?.bid, otm10?.ask, otm10?.last_trade_price);
    return {
      expiry,
      expiryLabel: isoToShortLabel(expiry),
      daysToExpiry: daysUntil(expiry),
      atmStrike,
      atmPremium,
      atmPctOfSpot: atmPremium != null ? parseFloat(((atmPremium / spot) * 100).toFixed(2)) : null,
      otm5Strike,
      otm5Premium,
      otm5PctOfSpot: otm5Premium != null ? parseFloat(((otm5Premium / spot) * 100).toFixed(2)) : null,
      otm10Strike,
      otm10Premium,
      otm10PctOfSpot: otm10Premium != null ? parseFloat(((otm10Premium / spot) * 100).toFixed(2)) : null,
    };
  });

  const customRows: CustomStrikeRow[] = extraStrikes.map((strike) => ({
    strike,
    quotes: monthlyExpiries.map((expiry) => {
      const strikeMap = putsByExpiry.get(expiry)!;
      const opt = strikeMap.get(strike);
      const premium = opt ? midPrice(opt.bid, opt.ask, opt.last_trade_price) : null;
      return {
        expiry,
        premium,
        pctOfSpot: premium != null ? parseFloat(((premium / spot) * 100).toFixed(2)) : null,
      };
    }),
  }));

  return {
    fetchedAt: new Date().toISOString(),
    spotPrice: parseFloat(spot.toFixed(2)),
    quotes,
    customRows,
  };
}

// ---- Hedging history snapshot helpers (shared with /api/kv/hedging-history) ----

type SnapshotQuote = {
  expiry: string;
  atmStrike: number;
  atmPremium: number | null;
  otm5Strike: number;
  otm5Premium: number | null;
  otm10Strike: number;
  otm10Premium: number | null;
};

type HedgingSnapshotShape = {
  date: string;
  spotPrice: number;
  quotes: SnapshotQuote[];
};

/** Read the full snapshot ledger from Redis. Empty array on error. */
export async function loadHedgingHistory(): Promise<HedgingSnapshotShape[]> {
  try {
    const redis = await getRedis();
    const raw = await redis.get("pm:hedging-history");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.snapshots) ? parsed.snapshots : [];
  } catch {
    return [];
  }
}

/**
 * Fetch live SPY hedging costs and append them to the `pm:hedging-history`
 * ledger as today's snapshot — the same shape the Hedging tab writes on
 * refresh. Meant to be called from the daily cron so the ledger builds
 * density even on days the user never opens the tab (which is why
 * week-over-week comparisons were coming up empty). Read-modify-write:
 * replaces today's entry if present, else appends; never touches prior days.
 *
 * Best-effort — throws are the caller's to swallow so the cron's primary job
 * (the nightly backup) is never jeopardised.
 */
export async function captureLiveHedgingSnapshot(): Promise<{ date: string; totalSnapshots: number }> {
  const redis = await getRedis();

  // Include any custom strikes the user tracks so their WoW/MoM rows fill too.
  let extraStrikes: number[] = [];
  try {
    const rawCs = await redis.get("pm:hedging-custom-strikes");
    if (rawCs) {
      const parsed = JSON.parse(rawCs);
      const list = Array.isArray(parsed?.strikes) ? parsed.strikes : [];
      extraStrikes = list.filter((n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0);
    }
  } catch {
    extraStrikes = [];
  }

  const live = await fetchLiveHedgingCosts(extraStrikes);
  if (!live.quotes.length) throw new Error("No quotes in live hedging data — refusing to write empty snapshot");

  const date = new Date().toISOString().slice(0, 10);
  const snapshot = {
    date,
    fetchedAt: live.fetchedAt,
    spotPrice: live.spotPrice,
    quotes: live.quotes.map((q) => ({
      expiry: q.expiry,
      atmStrike: q.atmStrike,
      atmPremium: q.atmPremium,
      otm5Strike: q.otm5Strike,
      otm5Premium: q.otm5Premium,
      otm10Strike: q.otm10Strike,
      otm10Premium: q.otm10Premium,
    })),
    customRows: (live.customRows || []).map((r) => ({
      strike: r.strike,
      quotes: r.quotes.map((q) => ({ expiry: q.expiry, premium: q.premium })),
    })),
  };

  // Read-modify-write: preserve every prior day; replace only today's entry.
  const raw = await redis.get("pm:hedging-history");
  const history = raw ? JSON.parse(raw) : { snapshots: [], lastUpdated: null };
  const snapshots: Array<{ date: string }> = Array.isArray(history.snapshots) ? history.snapshots : [];
  const idx = snapshots.findIndex((s) => s.date === date);
  if (idx >= 0) {
    snapshots[idx] = snapshot;
  } else {
    snapshots.push(snapshot);
    snapshots.sort((a, b) => a.date.localeCompare(b.date));
  }
  const next = { ...history, snapshots, lastUpdated: new Date().toISOString() };
  await redis.set("pm:hedging-history", JSON.stringify(next));

  return { date, totalSnapshots: snapshots.length };
}

/** Closest snapshot within ±tolerance days of daysAgo, else null. */
export function findSnapshotDaysAgo(
  history: HedgingSnapshotShape[],
  daysAgo: number,
  toleranceDays: number,
): HedgingSnapshotShape | null {
  if (history.length === 0) return null;
  const target = new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
  let best: HedgingSnapshotShape | null = null;
  let bestDiff = Infinity;
  for (const s of history) {
    const diff = dayDiff(s.date, target);
    if (diff <= toleranceDays && diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  return best;
}

// ---- Premium context: percentiles vs the ledger's own history ----------------

/** Tenor buckets used to compare like-for-like across snapshots (a "3M" put
 *  today must be ranked against ~3M puts historically, not the whole surface). */
const TENOR_BUCKETS = [
  { key: "near", label: "≤45d", min: 0, max: 45 },
  { key: "mid", label: "2-4M", min: 46, max: 135 },
  { key: "far", label: "5-9M", min: 136, max: 400 },
] as const;

export type PremiumBucketContext = {
  bucket: string;          // label
  daysToExpiry: number;    // today's anchor tenor
  otm5Pct: number | null;      // % of spot today
  otm5Percentile: number | null;   // 0-100 within trailing history
  otm10Pct: number | null;
  otm10Percentile: number | null;
  skewRatio: number | null;        // 10% OTM premium ÷ ATM premium (steepness proxy)
  skewPercentile: number | null;
};

export type PremiumContext = {
  sessions: number; // distinct history dates contributing
  windowDays: number;
  buckets: PremiumBucketContext[];
  vvix: number | null;
};

/** Percentile (0-100) of `value` within `dist` (share of observations ≤ value). */
function percentileOf(value: number, dist: number[]): number | null {
  if (dist.length < 20) return null; // too thin to rank honestly
  const below = dist.filter((x) => x <= value).length;
  return Math.round((below / dist.length) * 100);
}

/** Latest ^VVIX close from Yahoo (vol-of-vol — cheapness context for options).
 *  Null on any failure; never throws. */
export async function fetchVvix(): Promise<number | null> {
  try {
    const res = await fetch(
      "https://query2.finance.yahoo.com/v8/finance/chart/%5EVVIX?range=5d&interval=1d",
      { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000) },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { chart?: { result?: Array<{ indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> } };
    const closes = (j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(
      (c): c is number => typeof c === "number" && isFinite(c),
    );
    return closes.length ? Math.round(closes[closes.length - 1] * 10) / 10 : null;
  } catch {
    return null;
  }
}

/**
 * Rank today's anchor premiums (and skew) against the ledger's trailing
 * ~6 months, per tenor bucket. Pure math over data we already collect —
 * this is what turns "premiums are reasonable" from a vibe into a measured
 * percentile. Null percentiles when the ledger is too thin (<20 sessions).
 */
export function computePremiumContext(
  live: HedgingLiveData,
  history: HedgingSnapshotShape[],
  windowDays = 185,
): Omit<PremiumContext, "vvix"> {
  const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);
  const recent = history.filter((s) => s.date >= cutoff && s.spotPrice > 0);

  // Distributions per bucket: pct-of-spot for 5%/10% OTM + skew ratio. One
  // observation per (snapshot, bucket): the quote closest to the bucket's
  // tenor midpoint.
  const dist: Record<string, { otm5: number[]; otm10: number[]; skew: number[] }> = {};
  for (const b of TENOR_BUCKETS) dist[b.key] = { otm5: [], otm10: [], skew: [] };
  for (const snap of recent) {
    for (const b of TENOR_BUCKETS) {
      const mid = (b.min + b.max) / 2;
      let best: SnapshotQuote | null = null;
      let bestDist = Infinity;
      for (const qt of snap.quotes) {
        const tenor = dayDiff(qt.expiry, snap.date);
        if (tenor < b.min || tenor > b.max) continue;
        const d = Math.abs(tenor - mid);
        if (d < bestDist) { bestDist = d; best = qt; }
      }
      if (!best) continue;
      if (best.otm5Premium != null) dist[b.key].otm5.push((best.otm5Premium / snap.spotPrice) * 100);
      if (best.otm10Premium != null) dist[b.key].otm10.push((best.otm10Premium / snap.spotPrice) * 100);
      if (best.otm10Premium != null && best.atmPremium != null && best.atmPremium > 0) {
        dist[b.key].skew.push(best.otm10Premium / best.atmPremium);
      }
    }
  }

  const buckets: PremiumBucketContext[] = [];
  for (const b of TENOR_BUCKETS) {
    // Today's anchor for this bucket: quote closest to the bucket midpoint.
    const mid = (b.min + b.max) / 2;
    let anchor: HedgingQuote | null = null;
    let bestDist = Infinity;
    for (const qt of live.quotes) {
      if (qt.daysToExpiry < b.min || qt.daysToExpiry > b.max) continue;
      const d = Math.abs(qt.daysToExpiry - mid);
      if (d < bestDist) { bestDist = d; anchor = qt; }
    }
    if (!anchor) continue;
    const skewRatio =
      anchor.otm10Premium != null && anchor.atmPremium != null && anchor.atmPremium > 0
        ? Math.round((anchor.otm10Premium / anchor.atmPremium) * 1000) / 1000
        : null;
    buckets.push({
      bucket: b.label,
      daysToExpiry: anchor.daysToExpiry,
      otm5Pct: anchor.otm5PctOfSpot,
      otm5Percentile: anchor.otm5PctOfSpot != null ? percentileOf(anchor.otm5PctOfSpot, dist[b.key].otm5) : null,
      otm10Pct: anchor.otm10PctOfSpot,
      otm10Percentile: anchor.otm10PctOfSpot != null ? percentileOf(anchor.otm10PctOfSpot, dist[b.key].otm10) : null,
      skewRatio,
      skewPercentile: skewRatio != null ? percentileOf(skewRatio, dist[b.key].skew) : null,
    });
  }

  return { sessions: recent.length, windowDays, buckets };
}

/** Inputs for the deterministic hedge-entry checklist. All nullable — a null
 *  renders as "?" (data unavailable) rather than a fabricated verdict. */
export type HedgeChecklistInputs = {
  consolidatedRegime: string;
  transitionLeaning: string | null;    // e.g. "toward Risk-Off"
  transitionLikelihood: string | null; // "Low" | "Watch" | "Elevated" | "High"
  riskOffSignalCount: number | null;
  ctx: PremiumContext | null;
  fearGreed: number | null;
  oscillator: number | null;
  vix: number | null;
  termStructure: string;
};

/** One scored checklist condition. `ok: null` = data unavailable ("?"). */
export type HedgeChecklistItem = {
  path: "risk-off" | "cheap";
  label: string;
  ok: boolean | null;
};

/** Structured checklist + the headline numbers the UI surfaces beside it. */
export type HedgeChecklist = {
  items: HedgeChecklistItem[];
  /** Mid (2-4M) bucket headline stats — the default tenor the prompt cites. */
  midOtm5Percentile: number | null;
  midOtm10Percentile: number | null;
  midSkewPercentile: number | null;
  vvix: number | null;
  sessions: number | null; // ledger depth behind the percentiles
};

/**
 * Deterministic hedge-entry checklist — scores each condition of the two ADD
 * paths from computed data so the hedging call is grounded and consistent.
 * EVIDENCE, not the verdict: the model judges and may override with stated
 * reasons. Shared by the morning brief AND the standalone hedging-refresh
 * endpoint so both always score identically; the STRUCTURED form is returned
 * to the client so the Hedging tile can show the receipts behind the call.
 */
export function computeHedgeChecklist(p: HedgeChecklistInputs): HedgeChecklist {
  const midB = p.ctx?.buckets.find((b) => b.bucket === "2-4M") ?? p.ctx?.buckets[0] ?? null;

  const items: HedgeChecklistItem[] = [
    {
      path: "risk-off",
      ok: p.consolidatedRegime === "Risk-Off",
      label: `Consolidated regime is Risk-Off (currently: ${p.consolidatedRegime})`,
    },
    {
      path: "risk-off",
      ok:
        p.transitionLeaning != null && p.transitionLikelihood != null
          ? p.transitionLeaning === "toward Risk-Off" && (p.transitionLikelihood === "Elevated" || p.transitionLikelihood === "High")
          : null,
      label: `Transition gauge leaning Risk-Off at Elevated/High likelihood${p.transitionLeaning ? ` (currently: ${p.transitionLeaning}, ${p.transitionLikelihood})` : " (gauge unavailable)"}`,
    },
    {
      path: "risk-off",
      ok: p.riskOffSignalCount != null ? p.riskOffSignalCount >= 3 : null,
      label: `≥3 composite signals Risk-Off${p.riskOffSignalCount != null ? ` (currently: ${p.riskOffSignalCount})` : " (composite unavailable)"}`,
    },
    {
      path: "cheap",
      ok: midB?.otm5Percentile != null ? midB.otm5Percentile <= 35 : null,
      label: `2-4M 5%OTM premium ≤35th percentile${midB?.otm5Percentile != null ? ` (currently: ${midB.otm5Percentile}th)` : " (unranked)"}`,
    },
    {
      path: "cheap",
      ok: midB?.otm10Percentile != null ? midB.otm10Percentile <= 35 : null,
      label: `2-4M 10%OTM premium ≤35th percentile${midB?.otm10Percentile != null ? ` (currently: ${midB.otm10Percentile}th)` : " (unranked)"}`,
    },
    {
      path: "cheap",
      ok: p.ctx?.vvix != null ? p.ctx.vvix <= 100 : null,
      label: `VVIX ≤100${p.ctx?.vvix != null ? ` (currently: ${p.ctx.vvix})` : " (unavailable)"}`,
    },
    {
      path: "cheap",
      ok: midB?.skewPercentile != null ? midB.skewPercentile <= 50 : null,
      label: `Skew ≤50th percentile — tails not already bid${midB?.skewPercentile != null ? ` (currently: ${midB.skewPercentile}th)` : " (unranked)"}`,
    },
    {
      path: "cheap",
      ok: p.fearGreed != null ? p.fearGreed >= 60 : null,
      label: `Late-cycle: F&G ≥60${p.fearGreed != null ? ` (currently: ${p.fearGreed})` : ""}`,
    },
    {
      path: "cheap",
      ok: p.oscillator != null ? p.oscillator >= 2.5 : null,
      label: `Late-cycle: S&P Oscillator ≥ +2.5%${p.oscillator != null ? ` (currently: ${p.oscillator >= 0 ? "+" : ""}${p.oscillator}%)` : ""}`,
    },
    {
      path: "cheap",
      ok: p.vix != null ? p.vix <= 16 : null,
      label: `Late-cycle: VIX ≤16 complacency${p.vix != null ? ` (currently: ${p.vix})` : ""}${p.termStructure ? ` — term structure ${p.termStructure}` : ""}`,
    },
  ];

  return {
    items,
    midOtm5Percentile: midB?.otm5Percentile ?? null,
    midOtm10Percentile: midB?.otm10Percentile ?? null,
    midSkewPercentile: midB?.skewPercentile ?? null,
    vvix: p.ctx?.vvix ?? null,
    sessions: p.ctx?.sessions ?? null,
  };
}

/** Prompt rendering of the same checklist (delegates to computeHedgeChecklist
 *  so prompt and UI can never disagree). */
export function buildHedgeChecklistBlock(p: HedgeChecklistInputs): string {
  const cl = computeHedgeChecklist(p);
  const line = (i: HedgeChecklistItem): string => `  ${i.ok == null ? "?" : i.ok ? "✓" : "✗"} ${i.label}`;
  return [
    "",
    "",
    "HEDGE-ENTRY CHECKLIST (computed from live data — evidence for hedgingAnalysis/hedgingCall, NOT the verdict; you may override any line with an explicitly stated reason):",
    "Path 1 · Classic Risk-Off:",
    ...cl.items.filter((i) => i.path === "risk-off").map(line),
    "Path 2 · Cheap insurance (premium conditions) + late-cycle warning (need ≥1):",
    ...cl.items.filter((i) => i.path === "cheap").map(line),
    "Reading it: Path 1 substantially met (≥2 of 3) OR Path 2 with at least one premium condition ✓, VVIX/skew not contradicting, and ≥1 late-cycle sign → ADD is defensible. Otherwise the default is SKIP (or HOLD if protection is already on). Cite the specific ✓/✗ lines that drove your call — especially the premium percentile — and name any line you're overriding and why.",
  ].join("\n");
}

/** Plain-English cheapness label for a premium percentile. */
export function percentileLabel(p: number | null): string {
  if (p == null) return "no rank (ledger too thin)";
  if (p <= 25) return "CHEAP";
  if (p <= 45) return "below average";
  if (p <= 60) return "average";
  if (p <= 80) return "above average";
  return "RICH";
}

/**
 * Render a compact text block summarizing live SPY put costs + WoW trend +
 * percentile context, suitable for injection into a Claude prompt. Returns
 * { text: "", ctx: null } on error so the brief still generates. `ctx` is the
 * structured premium context, shared with the hedge-entry checklist and the
 * hedge-timing score so every consumer ranks cheapness identically.
 */
export async function buildHedgingCostsBlock(): Promise<{ text: string; ctx: PremiumContext | null }> {
  try {
    const live = await fetchLiveHedgingCosts();
    const history = await loadHedgingHistory();
    const wow = findSnapshotDaysAgo(history, 7, 2);
    const mom = findSnapshotDaysAgo(history, 30, 5);
    const [premiumCtx, vvix] = await Promise.all([
      Promise.resolve(computePremiumContext(live, history)),
      fetchVvix(),
    ]);

    // Pick 3 anchor expiries: nearest ≤45d, mid 60–120d, and longest-dated
    const q = live.quotes;
    const pickAnchor = (predicate: (d: number) => boolean) => q.find((x) => predicate(x.daysToExpiry));
    const near = pickAnchor((d) => d <= 45) || q[0];
    const mid = pickAnchor((d) => d >= 60 && d <= 120) || q[Math.floor(q.length / 2)];
    const far = q[q.length - 1];
    const anchors = Array.from(new Set([near, mid, far].filter(Boolean))) as HedgingQuote[];

    const lines: string[] = [];
    lines.push(`Live SPY Hedging Costs (CBOE delayed 15 min, fetched ${new Date(live.fetchedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}):`);
    lines.push(`- SPY Spot: $${live.spotPrice.toFixed(2)}`);
    lines.push(`- Strike ladder: ATM $${anchors[0].atmStrike} / ~5% OTM $${anchors[0].otm5Strike} / ~10% OTM $${anchors[0].otm10Strike}`);
    lines.push("");
    lines.push("Put premiums (mid price, % of spot):");
    for (const a of anchors) {
      const fmt = (p: number | null, pct: number | null) =>
        p != null && pct != null ? `$${p.toFixed(2)} (${pct.toFixed(2)}%)` : "—";
      lines.push(
        `- ${a.expiryLabel} (${a.daysToExpiry}d): ATM ${fmt(a.atmPremium, a.atmPctOfSpot)} | 5%OTM ${fmt(a.otm5Premium, a.otm5PctOfSpot)} | 10%OTM ${fmt(a.otm10Premium, a.otm10PctOfSpot)}`,
      );
    }

    // WoW / MoM trend on the 5% OTM and 10% OTM premiums for the anchor
    // expiries. These are the strikes the morning-brief hedgingAnalysis
    // prompt cites by default (5–10% OTM tail protection), so the trend
    // signal needs to follow the same strikes — tracking ATM here would
    // force the model to extrapolate from a different point on the
    // skew curve. ATM is omitted entirely.
    const trendBlock = (label: string, snap: HedgingSnapshotShape | null, daysAgoLabel: string): string[] => {
      if (!snap) return [`${label}: no snapshot ~${daysAgoLabel} ago in ledger yet`];
      const rows: string[] = [`${label} (vs ${snap.date}, SPY $${snap.spotPrice.toFixed(2)}):`];
      for (const a of anchors) {
        const priorRow = snap.quotes.find((s) => s.expiry === a.expiry);
        const fmtDelta = (label: string, prior: number | null | undefined, curr: number | null) => {
          if (prior == null || curr == null || prior === 0) return `${label} —`;
          const dPct = ((curr - prior) / prior) * 100;
          const sign = dPct >= 0 ? "+" : "";
          return `${label} $${prior.toFixed(2)} → $${curr.toFixed(2)} (${sign}${dPct.toFixed(1)}%)`;
        };
        const otm5 = fmtDelta("5%OTM", priorRow?.otm5Premium, a.otm5Premium);
        const otm10 = fmtDelta("10%OTM", priorRow?.otm10Premium, a.otm10Premium);
        rows.push(`- ${a.expiryLabel}: ${otm5} | ${otm10}`);
      }
      return rows;
    };

    lines.push("");
    lines.push(...trendBlock("Week-over-week", wow, "7 days"));
    lines.push("");
    lines.push(...trendBlock("Month-over-month", mom, "30 days"));

    // ── Percentile context: is "reasonable premium" actually true today? ──
    lines.push("");
    if (premiumCtx.buckets.length > 0 && premiumCtx.sessions >= 20) {
      lines.push(
        `Premium percentile context (each tenor ranked against its own trailing ${premiumCtx.windowDays}-day ledger, ${premiumCtx.sessions} sessions — LOW percentile = historically cheap):`,
      );
      for (const b of premiumCtx.buckets) {
        const p5 = b.otm5Percentile != null ? `${b.otm5Percentile}th pct (${percentileLabel(b.otm5Percentile)})` : "unranked";
        const p10 = b.otm10Percentile != null ? `${b.otm10Percentile}th pct (${percentileLabel(b.otm10Percentile)})` : "unranked";
        const sk = b.skewRatio != null
          ? `skew (10%OTM/ATM) ${b.skewRatio.toFixed(2)}${b.skewPercentile != null ? ` = ${b.skewPercentile}th pct` : ""}`
          : "skew —";
        lines.push(`- ${b.bucket} (${b.daysToExpiry}d): 5%OTM ${b.otm5Pct?.toFixed(2) ?? "—"}% of spot → ${p5} | 10%OTM ${b.otm10Pct?.toFixed(2) ?? "—"}% → ${p10} | ${sk}`);
      }
    } else {
      lines.push(
        `Premium percentile context: ledger too thin to rank (${premiumCtx.sessions} sessions in window) — judge cheapness from the WoW/MoM trend and VIX/VVIX levels instead, and say you are doing so.`,
      );
    }
    lines.push(
      vvix != null
        ? `VVIX (vol-of-vol): ${vvix} — <90 low (options cheap to gamma), 90-110 normal, >110 elevated (protection demand bid).`
        : "VVIX: unavailable this run.",
    );

    return { text: lines.join("\n"), ctx: { ...premiumCtx, vvix } };
  } catch (e) {
    console.error("buildHedgingCostsBlock failed:", e);
    return { text: "", ctx: null };
  }
}
