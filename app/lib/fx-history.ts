/**
 * Daily USD/CAD closes from Yahoo (USDCAD=X), dated on the exchange's own
 * clock (gmtoffset) so the bars line up with index / price bars. Read-only
 * fetch; [] on any failure.
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

export async function fetchUsdCad(range: "1y" | "2y" | "5y" | "10y" = "10y"): Promise<{ date: string; value: number }[]> {
  try {
    const res = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/USDCAD%3DX?range=${range}&interval=1d`, { cache: "no-store", headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const r = (await res.json())?.chart?.result?.[0];
    const off: number = typeof r?.meta?.gmtoffset === "number" ? r.meta.gmtoffset : 0;
    const ts: number[] = r?.timestamp ?? [];
    const cl: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
    const m = new Map<string, number>();
    for (let i = 0; i < ts.length; i++) {
      const c = cl[i];
      if (typeof c === "number" && c > 0) m.set(new Date((ts[i] + off) * 1000).toISOString().slice(0, 10), c);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, value }));
  } catch {
    return [];
  }
}
