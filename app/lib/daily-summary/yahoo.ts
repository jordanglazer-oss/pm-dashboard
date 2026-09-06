import type { ValuePoint } from "./periods";
import { normalizeSeries } from "./periods";

/** Daily closes for a Yahoo symbol via the public chart endpoint (no crumb
 *  needed). Empty array on any failure — callers treat that as "unavailable". */
export async function fetchYahooDaily(symbol: string, range: string = "1y"): Promise<ValuePoint[]> {
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const ts: number[] = result?.timestamp ?? [];
    const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close ?? [];
    const pts: { date: string; value: number }[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null || !isFinite(c)) continue;
      pts.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), value: c });
    }
    return normalizeSeries(pts);
  } catch {
    return [];
  }
}
