import { yahooClassShare } from "./yahoo-symbol";
import type { SplitTable } from "./sia-holdings";

/**
 * Split history for the names in the SIA transaction log, from Yahoo's chart
 * events. Looked up ONCE when the log is loaded and stored beside it, so every
 * later read is fast and gives the same answer. A symbol Yahoo does not know
 * (delisted, a mutual fund) simply has no entry. Never throws.
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const isFund = (s: string) => /^[A-Z]{2,4}\d{2,5}[A-Z]?$/i.test(s);
const toYahoo = (s: string) => yahooClassShare(s.endsWith("-T") ? s.replace(/-T$/, ".TO") : s.endsWith(".U") ? s.replace(/\.U$/, "-U.TO") : s);

async function splitsFor(symbol: string, sinceIso: string): Promise<{ date: string; factor: number }[] | null> {
  try {
    const p1 = Math.floor(new Date(sinceIso).getTime() / 1000) - 5 * 86_400;
    const url = "https://query2.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(toYahoo(symbol)) + "?period1=" + p1 + "&period2=" + Math.floor(Date.now() / 1000) + "&interval=1mo&events=splits";
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const r = (await res.json())?.chart?.result?.[0];
    if (!r) return null;
    const raw = Object.values(r.events?.splits ?? {}) as { date?: number; numerator?: number; denominator?: number }[];
    const out: { date: string; factor: number }[] = [];
    for (const x of raw) {
      if (typeof x.date !== "number" || !(x.numerator! > 0) || !(x.denominator! > 0)) continue;
      const factor = x.numerator! / x.denominator!;
      if (factor !== 1) out.push({ date: new Date(x.date * 1000).toISOString().slice(0, 10), factor });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return null;
  }
}

/** `firstTrade` maps each (dashboard-form) symbol to its first trade date in the log. */
export async function fetchSiaSplits(firstTrade: Map<string, string>, concurrency = 8): Promise<{ splits: SplitTable; noData: string[]; checked: number }> {
  const symbols = [...firstTrade.keys()].filter((s) => !isFund(s));
  const splits: SplitTable = {};
  const noData: string[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const i = next++;
        if (i >= symbols.length) return;
        const sym = symbols[i];
        const got = await splitsFor(sym, firstTrade.get(sym)!);
        if (got == null) noData.push(sym);
        else if (got.length) splits[sym] = got;
      }
    }),
  );
  return { splits, noData: noData.sort(), checked: symbols.length };
}
