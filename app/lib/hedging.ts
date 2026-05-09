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

/**
 * Render a compact text block summarizing live SPY put costs + WoW trend,
 * suitable for injection into a Claude prompt. Returns empty string on error
 * so the brief still generates.
 */
export async function buildHedgingCostsBlock(): Promise<string> {
  try {
    const live = await fetchLiveHedgingCosts();
    const history = await loadHedgingHistory();
    const wow = findSnapshotDaysAgo(history, 7, 2);
    const mom = findSnapshotDaysAgo(history, 30, 5);

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

    return lines.join("\n");
  } catch (e) {
    console.error("buildHedgingCostsBlock failed:", e);
    return "";
  }
}
