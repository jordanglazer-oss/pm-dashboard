import { NextResponse } from "next/server";

/**
 * Live SPY protective put hedging cost table.
 *
 * Pulls SPY spot + full option chain from CBOE delayed quotes (no auth required),
 * picks the next ~6 standard monthly expiries (3rd-Friday contracts — most
 * liquid), and for each expiry returns put premiums at 3 strikes: ATM, ~5% OTM,
 * ~10% OTM (rounded to nearest $5).
 *
 * No Redis writes — this is a pure read-through endpoint. Snapshots are
 * persisted separately via POST to /api/kv/hedging-history.
 */

type CboeOption = {
  option: string; // e.g. "SPY260620P00685000"
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
  expiry: string; // YYYY-MM-DD
  expiryLabel: string; // e.g. "20-Jun"
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

export type HedgingLiveData = {
  fetchedAt: string;
  spotPrice: number;
  quotes: HedgingQuote[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Round to nearest $5 */
function roundToNearest5(v: number): number {
  return Math.round(v / 5) * 5;
}

/**
 * Parse CBOE option symbol: SPY{YYMMDD}{C|P}{strike*1000 padded to 8}
 * Returns { expiry: "YYYY-MM-DD", type: "C"|"P", strike: number } or null.
 */
function parseOptionSymbol(sym: string): { expiry: string; type: "C" | "P"; strike: number } | null {
  // SPY symbols are 3 chars + 6 (date) + 1 (type) + 8 (strike) = 18 chars
  const m = /^([A-Z]+)(\d{6})([CP])(\d{8})$/.exec(sym);
  if (!m) return null;
  const dateStr = m[2];
  const year = 2000 + parseInt(dateStr.slice(0, 2), 10);
  const month = parseInt(dateStr.slice(2, 4), 10);
  const day = parseInt(dateStr.slice(4, 6), 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const expiry = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return {
    expiry,
    type: m[3] as "C" | "P",
    strike: parseInt(m[4], 10) / 1000,
  };
}

/** ISO date of the 3rd Friday of (year, month) — the standard monthly expiry. */
function thirdFridayIso(year: number, month: number): string {
  // Day-of-week of the 1st of the month (0=Sun..6=Sat)
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  // First Friday: offset from day 1 to first Friday (5 = Fri)
  const firstFri = ((5 - first + 7) % 7) + 1;
  const thirdFri = firstFri + 14;
  return `${year}-${String(month).padStart(2, "0")}-${String(thirdFri).padStart(2, "0")}`;
}

/** Absolute day difference between two YYYY-MM-DD strings. */
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

/** Best-effort mid price from bid/ask; fallback to last_trade_price */
function midPrice(bid: number | undefined, ask: number | undefined, last: number | undefined): number | null {
  if (bid != null && ask != null && bid > 0 && ask > 0) {
    return parseFloat(((bid + ask) / 2).toFixed(2));
  }
  if (last != null && last > 0) return parseFloat(last.toFixed(2));
  return null;
}

export async function GET() {
  try {
    const res = await fetch("https://cdn.cboe.com/api/global/delayed_quotes/options/SPY.json", {
      headers: { "User-Agent": "Mozilla/5.0" },
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json({ error: `CBOE returned ${res.status}` }, { status: 502 });
    }
    const body = (await res.json()) as CboeResponse;
    const spot = body?.data?.current_price;
    const rawOptions = body?.data?.options || [];
    if (!spot || rawOptions.length === 0) {
      return NextResponse.json({ error: "Could not parse SPY quote or options" }, { status: 502 });
    }

    // Bucket puts by expiry
    const todayIso = new Date().toISOString().slice(0, 10);
    const putsByExpiry = new Map<string, Map<number, CboeOption>>();
    for (const opt of rawOptions) {
      const parsed = parseOptionSymbol(opt.option);
      if (!parsed || parsed.type !== "P") continue;
      if (parsed.expiry <= todayIso) continue; // skip expired
      if (!putsByExpiry.has(parsed.expiry)) putsByExpiry.set(parsed.expiry, new Map());
      putsByExpiry.get(parsed.expiry)!.set(parsed.strike, opt);
    }

    // For each of the next 9 calendar months, pick the best available expiry
    // from the option chain — preferring the standard 3rd-Friday monthly, but
    // falling back to whichever expiry in that month sits closest to it (some
    // months CBOE lists EOM/quarterly expiries instead of the 3rd Friday).
    const allExpiries = [...putsByExpiry.keys()].sort();
    const now = new Date();
    const monthlyExpiries: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < 9; i++) {
      const probe = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      const y = probe.getUTCFullYear();
      const m = probe.getUTCMonth() + 1;
      const monthPrefix = `${y}-${String(m).padStart(2, "0")}-`;
      const target = thirdFridayIso(y, m);
      // Candidates = any expiry in this calendar month that hasn't expired
      const candidates = allExpiries.filter((e) => e.startsWith(monthPrefix) && e > todayIso);
      if (candidates.length === 0) continue;
      // Prefer the expiry closest to the 3rd Friday
      candidates.sort((a, b) => dayDiff(a, target) - dayDiff(b, target));
      const pick = candidates[0];
      if (!seen.has(pick)) {
        seen.add(pick);
        monthlyExpiries.push(pick);
      }
    }
    monthlyExpiries.sort();

    if (monthlyExpiries.length === 0) {
      return NextResponse.json({ error: "No monthly expiries in option chain" }, { status: 502 });
    }

    // Compute target strikes
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

    const data: HedgingLiveData = {
      fetchedAt: new Date().toISOString(),
      spotPrice: parseFloat(spot.toFixed(2)),
      quotes,
    };

    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
