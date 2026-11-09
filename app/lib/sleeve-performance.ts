import { getRedis } from "./redis";
import { createLogger } from "./logger";
import { yahooClassShare } from "./yahoo-symbol";
import { bucketTests } from "./sleeve-targets";
import type { PimModelData, PimHolding } from "./pim-types";
import { SLEEVES, type SleeveId, type SleeveSeries, type SleevePerformance } from "./sleeve-performance-shared";
export * from "./sleeve-performance-shared";

/**
 * Weights-based sleeve tracking (Nov 2026) — Core, Thematic, Stocks (the
 * Alpha stock sleeve) and Stocks + Thematic, each tracked FORWARD from the
 * PIM model's own weights. No units, no positions: the units-based Alpha
 * book never held the Thematic funds (their units were never entered), so
 * its "Alpha" line only ever tracked the stocks. This is the replacement
 * measure; the existing pm:pim-performance series are untouched.
 *
 * Method (buy-and-hold between model changes, like a real sleeve):
 *   - Each sleeve's holdings = the PIM model's equity holdings in that
 *     bucket, weights renormalised to 100% within the sleeve.
 *   - Each trading day: sleeve return = Σ wᵢ·rᵢ (rᵢ in CAD: USD holdings
 *     include the USD/CAD move; Yahoo adjusted closes, so dividends count;
 *     FUNDSERV funds use their NAV). Then the weights DRIFT with prices:
 *     wᵢ ← wᵢ(1+rᵢ)/(1+R).
 *   - When the model's sleeve changes (a name added / removed or a target
 *     weight edited), that sleeve's weights reset to the new targets at
 *     that day's close, and the change is logged in `events`.
 *   - A FUNDSERV fund whose NAV hasn't posted holds the day back (up to 3
 *     days, then counts 0% for it and says so) so a late NAV never skews it.
 *
 * Store `pm:sleeve-performance` (APPEND-ONLY history; single writer
 * `updateSleevePerformance`, called by the weekday daily-value cron and by
 * POST /api/sleeve-performance). Past entries are never rewritten. Starts at
 * 100 on the first run. BACKED UP. Reads pm:pim-models / pm:stocks READ-ONLY.
 */

const log = createLogger("Sleeve-perf");
export const SLEEVE_PERF_KEY = "pm:sleeve-performance";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const FUNDSERV_WAIT_DAYS = 3;

// ── Prices ──────────────────────────────────────────────────────────────────

const isFundserv = (s: string) => /^[A-Z]{2,4}\d{2,5}$/i.test(s);

function toYahoo(symbol: string): string {
  if (symbol.endsWith("-T")) return yahooClassShare(symbol.replace(/-T$/, ".TO"));
  if (symbol.endsWith(".U")) return yahooClassShare(symbol.replace(/\.U$/, "-U.TO"));
  return yahooClassShare(symbol);
}

async function yahooCloses(symbol: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const res = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`, { cache: "no-store", headers: { "User-Agent": UA } });
    if (!res.ok) return out;
    const r = (await res.json())?.chart?.result?.[0];
    const ts: number[] = r?.timestamp ?? [];
    const adj: (number | null)[] = r?.indicators?.adjclose?.[0]?.adjclose ?? [];
    const cl: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
    const tz = r?.meta?.exchangeTimezoneName || "America/New_York";
    for (let i = 0; i < ts.length; i++) {
      const p = adj[i] ?? cl[i];
      if (p == null || !Number.isFinite(p)) continue;
      const d = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts[i] * 1000));
      out.set(d, p);
    }
  } catch { /* empty */ }
  return out;
}

async function fundservCloses(ticker: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const url = `https://globeandmail.pl.barchart.com/proxies/timeseries/queryeod.ashx?symbol=${encodeURIComponent(`${ticker}.CF`)}&data=daily&maxrecords=25&volume=contract&order=desc&dividends=false&backadjust=false`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA, Referer: "https://www.theglobeandmail.com/" } });
    if (!res.ok) return out;
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
      if (iso && Number.isFinite(close)) out.set(iso, close);
    }
  } catch { /* empty */ }
  return out;
}

function nyNow(): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, minutes: parseInt(g("hour"), 10) * 60 + parseInt(g("minute"), 10) };
}

const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86_400_000);

// ── Sleeves from the model ──────────────────────────────────────────────────

type StockLite = { ticker: string; designation?: "core" | "alpha" | "thematic"; instrumentType?: string };

export function sleeveTargets(models: PimModelData, stocks: StockLite[]): Record<SleeveId, { weights: Record<string, number>; currency: Record<string, string> }> {
  const pim = models.groups.find((g) => g.id === "pim");
  const eq = (pim?.holdings ?? []).filter((h) => h.assetClass === "equity" && (h.weightInClass || 0) > 0);
  const b = bucketTests(stocks, models);
  const pick = (f: (h: PimHolding) => boolean) => {
    const sel = eq.filter(f);
    const total = sel.reduce((s, h) => s + h.weightInClass, 0);
    const weights: Record<string, number> = {};
    const currency: Record<string, string> = {};
    for (const h of sel) {
      weights[h.symbol] = total > 0 ? h.weightInClass / total : 0;
      currency[h.symbol] = h.currency;
    }
    return { weights, currency };
  };
  return {
    core: pick((h) => b.isCore(h.symbol)),
    thematic: pick((h) => b.isThematic(h.symbol)),
    stocks: pick((h) => !b.isCore(h.symbol) && !b.isThematic(h.symbol)),
    nonCore: pick((h) => !b.isCore(h.symbol)),
  };
}

const targetsKeyOf = (w: Record<string, number>) =>
  Object.entries(w)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([s, v]) => `${s}:${v.toFixed(5)}`)
    .join("|");

// ── The update ──────────────────────────────────────────────────────────────

export async function readSleevePerformance(): Promise<SleevePerformance | null> {
  try {
    const raw = await (await getRedis()).get(SLEEVE_PERF_KEY);
    return raw ? (JSON.parse(raw) as SleevePerformance) : null;
  } catch {
    return null;
  }
}

export type SleeveUpdateResult = { ok: boolean; added: number; lastDate?: string; started?: boolean; waiting?: string; error?: string };

export async function updateSleevePerformance(): Promise<SleeveUpdateResult> {
  const redis = await getRedis();
  const [modelsRaw, stocksRaw, prevRaw] = await Promise.all([redis.get("pm:pim-models"), redis.get("pm:stocks"), redis.get(SLEEVE_PERF_KEY)]);
  let models: PimModelData;
  let stocks: StockLite[];
  let prev: SleevePerformance | null = null;
  try {
    models = JSON.parse(modelsRaw ?? "null");
    const s = stocksRaw ? JSON.parse(stocksRaw) : [];
    stocks = Array.isArray(s) ? s : [];
    if (!models?.groups) return { ok: false, added: 0, error: "no PIM model" };
    if (prevRaw) prev = JSON.parse(prevRaw) as SleevePerformance;
  } catch {
    return { ok: false, added: 0, error: "could not read the model or the sleeve history" }; // never overwrite an unreadable blob
  }

  const targets = sleeveTargets(models, stocks);
  const symbols = new Set<string>();
  const currency: Record<string, string> = {};
  for (const id of SLEEVES) for (const [s, c] of Object.entries(targets[id].currency)) {
    symbols.add(s);
    currency[s] = c;
  }
  // Held weights may include a name that just left the model — price it too.
  if (prev) for (const id of SLEEVES) for (const s of Object.keys(prev.series[id]?.weights ?? {})) symbols.add(s);

  const prices = new Map<string, Map<string, number>>();
  const list = [...symbols];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (;;) {
        const s = list.shift();
        if (!s) return;
        prices.set(s, isFundserv(s) ? await fundservCloses(s) : await yahooCloses(toYahoo(s)));
      }
    }),
  );
  const fx = await yahooCloses("USDCAD=X");

  // Trading dates = dates with a close for the US market reference (SPY),
  // up to today only once the session has closed.
  const spy = await yahooCloses("SPY");
  const now = nyNow();
  const cutoff = now.minutes >= 16 * 60 + 30 ? now.date : new Date(new Date(`${now.date}T12:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  const dates = [...spy.keys()].filter((d) => d <= cutoff).sort();
  if (!dates.length) return { ok: false, added: 0, error: "no market dates from Yahoo" };

  const at = new Date().toISOString();
  // First run: start every sleeve at 100 on the last closed session.
  if (!prev) {
    const start = dates[dates.length - 1];
    const series = Object.fromEntries(
      SLEEVES.map((id) => [id, { history: [{ date: start, value: 100, dailyReturn: 0 }], weights: targets[id].weights, targetsKey: targetsKeyOf(targets[id].weights) }]),
    ) as Record<SleeveId, SleeveSeries>;
    const state: SleevePerformance = { startedAt: start, lastDate: start, series, events: [], updatedAt: at };
    await redis.set(SLEEVE_PERF_KEY, JSON.stringify(state));
    return { ok: true, added: 0, started: true, lastDate: start };
  }

  const priceOn = (s: string, d: string) => prices.get(s)?.get(d);
  const priceBefore = (s: string, d: string): number | undefined => {
    const m = prices.get(s);
    if (!m) return undefined;
    let best: string | null = null;
    for (const k of m.keys()) if (k < d && (best == null || k > best)) best = k;
    return best ? m.get(best) : undefined;
  };
  const fxRet = (d: string): number => {
    const a = fx.get(d);
    let best: string | null = null;
    for (const k of fx.keys()) if (k < d && (best == null || k > best)) best = k;
    const b = best ? fx.get(best) : undefined;
    return a && b ? a / b - 1 : 0;
  };

  const next: SleevePerformance = { ...prev, series: { ...prev.series }, events: [...(prev.events ?? [])] };
  let added = 0;
  let waiting: string | undefined;
  for (const d of dates.filter((x) => x > prev.lastDate)) {
    // Hold the day back while a FUNDSERV NAV is missing (≤ FUNDSERV_WAIT_DAYS).
    const lateFund = [...symbols].find((s) => isFundserv(s) && priceOn(s, d) == null && SLEEVES.some((id) => (next.series[id].weights[s] ?? 0) > 0));
    if (lateFund && daysBetween(d, now.date) <= FUNDSERV_WAIT_DAYS) {
      waiting = `${lateFund} NAV for ${d} not posted yet`;
      break;
    }
    for (const id of SLEEVES) {
      const s = next.series[id];
      const w = { ...s.weights };
      let R = 0;
      const grown: Record<string, number> = {};
      for (const [sym, wi] of Object.entries(w)) {
        const p1 = priceOn(sym, d);
        const p0 = priceBefore(sym, d);
        let r = p1 != null && p0 != null && p0 > 0 ? p1 / p0 - 1 : 0; // no close that day (e.g. a Canadian holiday) → 0%
        if (currency[sym] === "USD") r = (1 + r) * (1 + fxRet(d)) - 1;
        R += wi * r;
        grown[sym] = wi * (1 + r);
      }
      const total = Object.values(grown).reduce((a, b) => a + b, 0);
      const drifted = total > 0 ? Object.fromEntries(Object.entries(grown).map(([k, v]) => [k, v / total])) : w;
      const last = s.history[s.history.length - 1];
      next.series[id] = { ...s, history: [...s.history, { date: d, value: +(last.value * (1 + R)).toFixed(6), dailyReturn: +(R * 100).toFixed(4) }], weights: drifted };
    }
    if (lateFund) next.events.push({ date: d, sleeve: "thematic", note: `${lateFund} NAV never posted for ${d}; counted as 0% that day` });
    next.lastDate = d;
    added++;
  }

  // Model changed → reset that sleeve to the new targets at the last close.
  for (const id of SLEEVES) {
    const key = targetsKeyOf(targets[id].weights);
    if (next.series[id].targetsKey !== key) {
      const before = new Set(Object.keys(next.series[id].weights));
      const after = new Set(Object.keys(targets[id].weights));
      const addedNames = [...after].filter((x) => !before.has(x));
      const removed = [...before].filter((x) => !after.has(x));
      next.series[id] = { ...next.series[id], weights: targets[id].weights, targetsKey: key };
      next.events.push({
        date: next.lastDate,
        sleeve: id,
        note: `Model change — reset to target weights${addedNames.length ? `; added ${addedNames.join(", ")}` : ""}${removed.length ? `; removed ${removed.join(", ")}` : ""}${!addedNames.length && !removed.length ? " (weights edited)" : ""}`,
      });
    }
  }
  next.events = next.events.slice(-300);
  next.updatedAt = at;
  await redis.set(SLEEVE_PERF_KEY, JSON.stringify(next));
  log.info(`added ${added} day(s) through ${next.lastDate}${waiting ? ` — waiting: ${waiting}` : ""}`);
  return { ok: true, added, lastDate: next.lastDate, ...(waiting ? { waiting } : {}) };
}
