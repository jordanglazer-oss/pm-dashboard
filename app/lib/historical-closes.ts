import { yahooClassShare } from "./yahoo-symbol";
/* ─── Daily closes for a past date (server-side) ───
 *
 * Used by the back-dated staged rebalance: the desk sizes trades off the close
 * BEFORE the trade day, and mutual funds execute at the trade day's NAV.
 *   Yahoo chart closes for stocks / ETFs (-T → .TO, .U → -U.TO, unadjusted
 *   close — the price that actually printed), Barchart EOD for FUNDSERV codes,
 *   USDCAD=X for FX. Read-only; no caching, no Redis. */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

export function isFundservSymbol(symbol: string): boolean {
  return /^[A-Z]{2,4}\d{2,5}$/i.test(symbol.replace(/-T$/i, ""));
}

function toYahoo(symbol: string): string {
  if (symbol.endsWith(".U")) return symbol.replace(/\.U$/, "-U.TO");
  if (symbol.endsWith("-T")) return yahooClassShare(symbol.replace(/-T$/, ".TO"));
  return yahooClassShare(symbol);
}

/** date (YYYY-MM-DD) → close, last ~6 weeks. null when the source fails. */
export async function dailyCloses(symbol: string): Promise<Map<string, number> | null> {
  try {
    if (isFundservSymbol(symbol)) {
      const code = symbol.replace(/-T$/i, "");
      const url = `https://globeandmail.pl.barchart.com/proxies/timeseries/queryeod.ashx?symbol=${encodeURIComponent(`${code}.CF`)}&data=daily&maxrecords=30&volume=contract&order=desc&dividends=false&backadjust=false`;
      const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA, Referer: "https://www.theglobeandmail.com/" } });
      if (!res.ok) return null;
      const out = new Map<string, number>();
      for (const line of (await res.text()).trim().split("\n")) {
        const parts = line.split(",");
        if (parts.length < 6) continue;
        const close = parseFloat(parts[5]);
        const raw = parts[1]?.trim() ?? "";
        let iso = "";
        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) iso = raw;
        else if (raw.includes("/")) {
          const [m, d, y] = raw.split("/");
          if (y) iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
        }
        if (iso && isFinite(close) && close > 0) out.set(iso, close);
      }
      return out.size ? out : null;
    }
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(toYahoo(symbol))}?range=3mo&interval=1d`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const data = await res.json();
    const r = data?.chart?.result?.[0];
    const ts: number[] = r?.timestamp ?? [];
    const closes: Array<number | null> = r?.indicators?.quote?.[0]?.close ?? [];
    const out = new Map<string, number>();
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (typeof c === "number" && isFinite(c) && c > 0) out.set(new Date(ts[i] * 1000).toISOString().slice(0, 10), c);
    }
    return out.size ? out : null;
  } catch {
    return null;
  }
}

/** Close ON `date` exactly, or null (a missing print must not be guessed). */
export function closeOn(closes: Map<string, number> | null, date: string): number | null {
  return closes?.get(date) ?? null;
}

/** The last close strictly BEFORE `date` (the prior trading day), with its date. */
export function closeBefore(closes: Map<string, number> | null, date: string): { date: string; price: number } | null {
  if (!closes) return null;
  const d = [...closes.keys()].filter((k) => k < date).sort().pop();
  return d ? { date: d, price: closes.get(d)! } : null;
}

/** The close ON `date`, else the latest one before it (FX: Yahoo's USDCAD=X
 *  series skips some sessions). */
export function closeOnOrBefore(closes: Map<string, number> | null, date: string): number | null {
  return closeOn(closes, date) ?? closeBefore(closes, date)?.price ?? null;
}
