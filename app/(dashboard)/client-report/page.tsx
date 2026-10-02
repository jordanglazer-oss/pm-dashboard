"use client";

/**
 * Client Report one-pager preview.
 *
 * Route contract: `/client-report?group=<groupId>&profile=<profile>`.
 * Alpha is excluded at the button level (the Positioning header never
 * links here with `profile=alpha`) but we also validate it here — the
 * report is only meaningful for full model profiles (balanced, growth,
 * allEquity) because those are the ones we present to clients.
 *
 * Everything on this page flows from `useReportData`, which hits live
 * endpoints with `cache: no-store`. No stale data sneaks in via a
 * cached client bundle or a snapshot JSON. If we're ever unable to
 * fetch fresh data, the preview shows an error state rather than
 * silently filling in defaults.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Playfair_Display } from "next/font/google";
import {
  useReportData,
  SLICE_COLORS,
  type ReportAllocationBreakdown,
  type ReportAllocationSlice,
  type ReportData,
  type ReportTrackerPerformance,
  type ReportXRayRow,
} from "@/app/lib/useReportData";
import { useStocks } from "@/app/lib/StockContext";
import { countryFor, isCoreEtf, SYMBOL_COUNTRY, type Country } from "@/app/lib/geography";
import type { PimProfileType } from "@/app/lib/pim-types";
import type { FundData, FundHolding, FundSectorWeight, Stock } from "@/app/lib/types";
import { colorForSector } from "@/app/lib/sectorColors";
import type { ClientReportAnalysis } from "@/app/api/client-report-analysis/route";
import type { ClientReportBullets } from "@/app/api/client-report-bullets/route";

// ───────── Client portfolio comparison types ─────────

type ClientInputMode = "units" | "weight";

/** Manual overrides for the Risk Profile strip. Each field is optional —
 *  when unset we fall back to the computed value. Keyed per (groupId,
 *  profile) so switching between Balanced/Growth/All-Equity doesn't
 *  clobber one profile's numbers with another's.
 *
 *  - stdDev / benchmarkStdDev are stored as FRACTIONS (e.g. 0.14 for 14%).
 *  - upsideCapture / downsideCapture are stored as PERCENTS (e.g. 95).
 *  This matches what `fmtPctFrac` and `fmtPct` expect at render time. */
type MetricsOverride = {
  stdDev?: number;
  benchmarkStdDev?: number;
  upsideCapture?: number;
  downsideCapture?: number;
};

type ClientPosition = {
  id: string; // unique key for React
  ticker: string;
  name: string;
  units: number;
  /** Portfolio weight (%) — used when inputMode is "weight". */
  weight: number;
  /** Optional MER (%) typed by the user for this holding. Feeds into
   *  the blended-MER comparison in the AI analysis. Overrides any
   *  Dashboard-side auto-fetch or manual override for the same ticker. */
  mer?: number;
  /** Instrument classification for the blended-MER / coverage calc.
   *  - "stock": direct equity, contributes 0% MER with full coverage.
   *  - "fund": ETF or mutual fund, must have an MER (typed here or
   *    auto-fetched via a Dashboard match) to count as covered.
   *  When undefined, the payload builder auto-detects: Dashboard-matched
   *  tickers inherit their Dashboard `instrumentType`; everything else
   *  defaults to "stock". Persisted so the PM's override sticks. */
  instrumentType?: "stock" | "fund";
};

/**
 * Per-fund URL override card. Lets the PM paste a holdings URL for a
 * fund the auto look-through couldn't resolve. POSTs the URL to
 * /api/fund-data which scrapes the page (Morningstar, iShares CSV,
 * issuer factsheet, etc.) and returns parsed top holdings. The
 * holdings then get PATCHed into pm:fund-data-cache, which the
 * look-through reads from on the next compute.
 */
function UnresolvedFundsPanel({
  funds,
  onCachedAndRecompute,
}: {
  funds: Array<{ symbol: string; name: string; weight: number; usedBalancedSplit: boolean }>;
  onCachedAndRecompute: () => Promise<void> | void;
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<Record<string, { ok?: string; err?: string }>>({});

  /**
   * Generate likely Morningstar URLs for a ticker. Morningstar's URL
   * routing depends on whether it's an ETF or mutual fund, and which
   * exchange. We can't always know up front, so we suggest the most
   * common patterns. The PM clicks the one that matches and the URL
   * pre-fills the input.
   *
   * Morningstar serves these pages to anonymous scrapers (no
   * Cloudflare bot wall) and renders the holdings table as plain
   * HTML, which the scraper picks up reliably.
   */
  const morningstarSuggestions = (symbol: string, name: string): Array<{ label: string; url: string }> => {
    const sym = symbol.toLowerCase();
    const isMorningstarId = /^0p[a-z0-9]{8}$/i.test(symbol);
    const isLikelyMutualFund =
      isMorningstarId ||
      /\b(FUND|ALLOCATION|LIFESTYLE|TARGET\s+(DATE|RETIREMENT))\b/i.test(name) ||
      /^[A-Z]{2,4}\d{2,5}$/.test(symbol); // FUNDSERV
    if (isLikelyMutualFund) {
      return [
        { label: "Morningstar US fund", url: `https://www.morningstar.com/funds/xnas/${sym}/portfolio` },
        { label: "Morningstar Canadian fund", url: `https://www.morningstar.ca/ca/funds/snapshot/snapshot.aspx?id=${symbol}` },
      ];
    }
    // Likely ETF.
    return [
      { label: "Morningstar (NYSE)", url: `https://www.morningstar.com/etfs/arcx/${sym}/portfolio` },
      { label: "Morningstar (NASDAQ)", url: `https://www.morningstar.com/etfs/xnas/${sym}/portfolio` },
    ];
  };

  /**
   * Force-retry the auto-resolution path via /api/fund-data?force=1.
   * Useful when an ETF (like SCHG) was negative-cached after a
   * transient Yahoo failure and the cache still says "no data" even
   * though Yahoo would now return it. Bypasses both the negative
   * cache and the in-app fund-data-cache positive cache.
   */
  const handleForceAutoResolve = async (symbol: string) => {
    setBusy((b) => ({ ...b, [symbol]: true }));
    setStatus((s) => ({ ...s, [symbol]: {} }));
    try {
      const res = await fetch(`/api/fund-data?ticker=${encodeURIComponent(symbol)}&force=1`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data?.fundData?.topHoldings?.length) {
        setStatus((s) => ({ ...s, [symbol]: { err: data?.error || "Auto-resolve still returned no holdings — try a URL above" } }));
        return;
      }
      // Persist to the cache so future computes skip the live fetch.
      await fetch("/api/kv/fund-data-cache", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: {
            [symbol.toUpperCase()]: {
              topHoldings: data.fundData.topHoldings,
              sectorWeightings: data.fundData.sectorWeightings || [],
              holdingsSource: data.fundData.holdingsSource || "Yahoo Finance",
              lastUpdated: new Date().toISOString(),
            },
          },
        }),
      });
      setStatus((s) => ({ ...s, [symbol]: { ok: `Auto-resolved ${data.fundData.topHoldings.length} holdings — recomputing...` } }));
      await onCachedAndRecompute();
    } catch (e) {
      setStatus((s) => ({ ...s, [symbol]: { err: e instanceof Error ? e.message : "Request failed" } }));
    } finally {
      setBusy((b) => ({ ...b, [symbol]: false }));
    }
  };

  const handleSave = async (symbol: string) => {
    const url = (urls[symbol] || "").trim();
    if (!url) return;
    setBusy((b) => ({ ...b, [symbol]: true }));
    setStatus((s) => ({ ...s, [symbol]: {} }));
    try {
      // 1. Scrape the URL via the existing /api/fund-data POST handler.
      const scrapeRes = await fetch("/api/fund-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, ticker: symbol }),
      });
      const scrapeData = await scrapeRes.json();
      if (!scrapeRes.ok) {
        setStatus((s) => ({ ...s, [symbol]: { err: scrapeData?.error || "Could not scrape this URL" } }));
        return;
      }
      const topHoldings = scrapeData?.topHoldings;
      if (!topHoldings?.length) {
        setStatus((s) => ({ ...s, [symbol]: { err: "Page parsed but no holdings table was found" } }));
        return;
      }
      // 2. Persist to pm:fund-data-cache so future look-throughs use it.
      const cacheRes = await fetch("/api/kv/fund-data-cache", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: {
            [symbol.toUpperCase()]: {
              topHoldings,
              sectorWeightings: scrapeData.sectorWeightings || [],
              holdingsSource: (() => {
                try { return new URL(url).hostname; } catch { return "User URL"; }
              })(),
              lastUpdated: new Date().toISOString(),
            },
          },
        }),
      });
      if (!cacheRes.ok) {
        setStatus((s) => ({ ...s, [symbol]: { err: "Scraped OK but failed to save to cache" } }));
        return;
      }
      setStatus((s) => ({ ...s, [symbol]: { ok: `Saved ${topHoldings.length} holdings — recomputing...` } }));
      await onCachedAndRecompute();
    } catch (e) {
      setStatus((s) => ({ ...s, [symbol]: { err: e instanceof Error ? e.message : "Request failed" } }));
    } finally {
      setBusy((b) => ({ ...b, [symbol]: false }));
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
      <div className="text-xs font-semibold text-amber-900 mb-1">
        ⚠ {funds.length} fund{funds.length === 1 ? "" : "s"} couldn&apos;t be auto-resolved
      </div>
      <div className="text-[11px] text-amber-800 mb-2.5">
        Yahoo Finance doesn&apos;t have holdings data for {funds.length === 1 ? "this fund" : "these funds"}. Provide a holdings URL (Morningstar, fund factsheet, iShares CSV, etc.) to enable proper look-through. Cached after the first scrape — won&apos;t need to re-enter.
        {funds.some((f) => f.usedBalancedSplit) && (
          <> A name-based default split is being used in the meantime so the asset allocation isn&apos;t wildly wrong.</>
        )}
      </div>
      <div className="space-y-2">
        {funds.map((f) => {
          const suggestions = morningstarSuggestions(f.symbol, f.name);
          return (
            <div key={f.symbol} className="rounded border border-amber-100 bg-white px-2.5 py-2">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <div className="text-xs font-medium text-slate-700 truncate">
                  <span className="font-mono font-bold">{f.symbol}</span>
                  {f.name && f.name !== f.symbol && <span className="text-slate-500"> · {f.name}</span>}
                </div>
                <span className="text-[10px] tabular-nums text-slate-500">{f.weight.toFixed(2)}% of portfolio</span>
              </div>

              {/* Quick-action row: try the auto-resolution path again
                  (bypasses negative cache via force=1) before resorting
                  to a manual URL. Useful for ETFs that were falsely
                  cached as missing. */}
              <div className="flex items-center gap-2 mb-1.5 flex-wrap text-[11px]">
                <button
                  onClick={() => { void handleForceAutoResolve(f.symbol); }}
                  disabled={busy[f.symbol]}
                  className="rounded border border-slate-300 bg-white px-2 py-0.5 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors"
                  title="Skip the cache and re-attempt the auto-resolution against Yahoo Finance. Use this if the fund SHOULD have data (major ETF, well-covered fund) and was likely cached as missing during a transient failure."
                >
                  Retry auto-resolution
                </button>
                <span className="text-slate-400">or paste a holdings URL:</span>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="url"
                  value={urls[f.symbol] || ""}
                  onChange={(e) => setUrls((u) => ({ ...u, [f.symbol]: e.target.value }))}
                  placeholder="https://www.morningstar.com/... or fund factsheet URL"
                  className="flex-1 rounded border border-slate-200 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
                <button
                  onClick={() => { void handleSave(f.symbol); }}
                  disabled={busy[f.symbol] || !(urls[f.symbol] || "").trim()}
                  className="rounded bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  {busy[f.symbol] ? "Scraping..." : "Save & Recompute"}
                </button>
              </div>

              {/* Click-to-fill Morningstar URL suggestions. Morningstar
                  serves to scrapers (no Cloudflare bot wall) and renders
                  holdings as plain HTML, so it's the most reliable
                  source. Issuer sites (Schwab, BlackRock, etc.) often
                  block automated requests. */}
              <div className="mt-1.5 text-[10px] text-slate-500 flex items-center gap-1.5 flex-wrap">
                <span>Suggested URLs (click to fill):</span>
                {suggestions.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => setUrls((u) => ({ ...u, [f.symbol]: s.url }))}
                    className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600 hover:bg-slate-200 transition-colors"
                    title={s.url}
                  >
                    {s.label}
                  </button>
                ))}
              </div>

              {status[f.symbol]?.ok && (
                <div className="mt-1 text-[11px] text-emerald-700">{status[f.symbol].ok}</div>
              )}
              {status[f.symbol]?.err && (
                <div className="mt-1 text-[11px] text-red-600">{status[f.symbol].err}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type ClientPortfolioResult = {
  /** Raw input positions (pre-look-through) with weights and names. */
  positions: { ticker: string; name: string; weight: number; marketValue: number }[];
  cash: number;
  cashWeight: number;
  /** Manual fixed-income placeholder. Lets the PM enter a fixed-income
   *  weight ($ in units mode, % in weight mode) without typing a specific
   *  bond fund — useful when the client account has a generic fixed
   *  income sleeve the PM doesn't want to break out by ticker. Folds
   *  into the allocation pie's Fixed Income bucket alongside any
   *  bond-like positions classified from the actual ticker list. */
  fixedIncome: number;
  fixedIncomeWeight: number;
  totalValue: number;
  /** PIM-style allocation pie: Fixed Income, US Equity, etc. (no "Core ETFs" bucket). */
  allocation: ReportAllocationSlice[];
  /** Look-through xray — individual stock holdings only (preferred shares excluded). */
  xray: ReportXRayRow[];
  /** Funds the look-through couldn't auto-resolve (no Yahoo/cache data).
   *  The PM can provide a holdings URL per fund to enable proper
   *  look-through. The result is scraped via /api/fund-data and
   *  written to pm:fund-data-cache for future use. */
  unresolvedFunds?: Array<{ symbol: string; name: string; weight: number; usedBalancedSplit: boolean }>;
};

/**
 * Convert user-typed preferred share tickers to the format Yahoo Finance
 * expects for its chart API. Common typing conventions:
 *   "BMO.PR.E"  → "BMO-PE.TO"   (Canadian preferred, dotted format)
 *   "CM.PR.O"   → "CM-PO.TO"    (Canadian preferred, dotted format)
 *   "BAC.PRA"   → "BAC-PA"      (US preferred, dotted format)
 *   "BAC.PR.A"  → "BAC-PA"      (US preferred, dotted with separator)
 *   "BMO-PE.TO" → "BMO-PE.TO"   (already Yahoo format — no change)
 *   "BAC-PA"    → "BAC-PA"      (already Yahoo format — no change)
 *
 * If we can't tell whether a `.PR.` ticker is US or Canadian, we default
 * to Canadian (.TO suffix) since that's the most common case where this
 * format is used. For US preferreds, Yahoo's format omits the exchange.
 */
function normalizePreferredTicker(ticker: string): string {
  const t = ticker.trim().toUpperCase();
  // Already in Yahoo format
  if (/^[A-Z]+-P[A-Z]+(\.[A-Z]+)?$/.test(t)) return t;
  // Canadian dotted format: TICKER.PR.LETTER → TICKER-PLETTER.TO
  const cad = t.match(/^([A-Z]+)\.PR\.([A-Z]+)$/);
  if (cad) return `${cad[1]}-P${cad[2]}.TO`;
  // US dotted format: TICKER.PRLETTER → TICKER-PLETTER (no exchange)
  const us = t.match(/^([A-Z]+)\.PR([A-Z]+)$/);
  if (us) return `${us[1]}-P${us[2]}`;
  return t;
}

const VALID_PROFILES: readonly PimProfileType[] = ["conservative", "balanced", "growth", "allEquity"];

// Report theme — sampled from the firm's "Your Portfolio, Built in
// Layers" investment-approach slide so the report reads as part of the
// same deck: deep navy, muted antique gold, warm cream paper, a pale
// sky tint, and a Didone serif for headings. Navy stays the primary
// colour; gold is the accent for rules, eyebrows and highlights.
const RBC_NAVY = "#0A2A50";
const RBC_GOLD = "#B8893F";
const THEME = {
  navy: RBC_NAVY,
  navyDeep: "#051E3C",
  gold: RBC_GOLD,
  goldBand: "#DEB165",
  goldPale: "#F4E7CC",
  cream: "#FBF7EE",
  card: "#FFFDF8",
  sky: "#DCE7F2",
  skyDeep: "#C4D6EA",
  ink: "#1C2B44",
  muted: "#5F6B7E",
  rule: "#E6DAC0",
  positive: "#2F7D5B",
  negative: "#B4423C",
} as const;

// Heading serif for the report body only (scoped via className, so the
// rest of the dashboard keeps IBM Plex).
const reportSerif = Playfair_Display({
  subsets: ["latin"],
  style: ["normal", "italic"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});
const SERIF = reportSerif.style.fontFamily;
const SANS = "system-ui, -apple-system, 'Segoe UI', sans-serif";

// Allocation-slice colours re-tinted to the theme. Keyed by slice key so
// the shared SLICE_COLORS in useReportData (used elsewhere) is untouched.
const THEME_SLICE_COLORS: Record<ReportAllocationSlice["key"], string> = {
  coreEtfs: "#0A2A50",
  usEquity: "#3D6AA3",
  canadianEquity: "#B8893F",
  globalEquity: "#7FA3CC",
  fixedIncome: "#8A97AB",
  alternatives: "#DEB165",
  preferredShares: "#5B4A7A",
  cash: "#CFC4AE",
};
const sliceColor = (s: { key: ReportAllocationSlice["key"]; color: string }) =>
  THEME_SLICE_COLORS[s.key] ?? s.color;

// Sector bars: one navy→sky family so the bar list reads as a single
// calm scale (matching the slide) rather than eleven hues.
const SECTOR_RAMP = ["#0A2A50", "#1D4272", "#305A93", "#4673AE", "#6189C0", "#7FA0CF", "#9DB7DC", "#B9CCE6"];

type ReportLayout = "portrait" | "landscape";

/** Strip Canadian-listing suffixes so two ticker variants (e.g.
 *  `FID5982` vs `FID5982-T`, `XIU` vs `XIU.TO`) compare equal. Mirrors
 *  the `-T` ↔ `.TO` tolerance used by `tickerMatch` elsewhere in the app
 *  and by the blended-MER canonicalization in `/api/client-report-analysis`. */
function canonClientTicker(t: string): string {
  const up = t.toUpperCase().trim();
  if (up.endsWith(".TO")) return up.slice(0, -3);
  if (up.endsWith("-T")) return up.slice(0, -2);
  return up;
}

/** One row in the blended-MER contributors table. Every holding the
 *  report is weighing maps to exactly one of these, so the PDF and the
 *  API payload always agree on what's feeding the number. */
type MerContribRow = {
  symbol: string;        // uppercased ticker as shown on the report
  name: string;
  weight: number;        // portfolio weight, percent
  mer: number | null;    // percent; null = uncovered (fund missing MER)
  /** `stock` → contributes 0% with full coverage.
   *  `fund-covered` → contributes weight × mer to the blended.
   *  `fund-uncovered` → excluded from both numerator and denominator. */
  classification: "stock" | "fund-covered" | "fund-uncovered";
  /** Human-readable provenance for the audit table. */
  source: string;
};

/** Classify one holding using the same priority chain as the payload
 *  builder below. Centralising the logic here means the on-screen
 *  contributors table cannot drift from what /api/client-report-analysis
 *  actually receives. */
function classifyMerRow(
  holding: { symbol: string; name: string; weight: number },
  dashByCanon: Map<string, Stock>,
  typedOverride: { mer?: number; instrumentType?: "stock" | "fund" } | undefined,
): MerContribRow {
  const key = holding.symbol.trim().toUpperCase();
  const name = holding.name || holding.symbol;
  const weight = holding.weight;
  const validEr = (v: number | null | undefined) =>
    typeof v === "number" && Number.isFinite(v) && v > 0;

  // 1. Per-row MER typed on this page — highest priority.
  if (typedOverride && validEr(typedOverride.mer)) {
    return {
      symbol: key, name, weight,
      mer: typedOverride.mer!,
      classification: "fund-covered",
      source: "Typed on report",
    };
  }
  // 2. Explicit per-row Stock/Fund toggle.
  if (typedOverride?.instrumentType === "fund") {
    return {
      symbol: key, name, weight, mer: null,
      classification: "fund-uncovered",
      source: "Set to Fund — no MER typed",
    };
  }
  if (typedOverride?.instrumentType === "stock") {
    return {
      symbol: key, name, weight, mer: 0,
      classification: "stock",
      source: "Set to Stock",
    };
  }
  // 3. Dashboard match (suffix-tolerant).
  const dash = dashByCanon.get(canonClientTicker(key));
  if (dash) {
    const manual = dash.manualExpenseRatio;
    const auto = dash.fundData?.expenseRatio;
    if (validEr(manual)) {
      return {
        symbol: key, name, weight,
        mer: manual as number,
        classification: "fund-covered",
        source: "Dashboard manual override",
      };
    }
    if (validEr(auto)) {
      return {
        symbol: key, name, weight,
        mer: auto as number,
        classification: "fund-covered",
        source: "Dashboard auto-fetch",
      };
    }
    if (dash.instrumentType === "stock" || !dash.instrumentType) {
      return {
        symbol: key, name, weight, mer: 0,
        classification: "stock",
        source: "Dashboard: stock",
      };
    }
    // Dashboard says ETF/mutual-fund but no MER on file.
    return {
      symbol: key, name, weight, mer: null,
      classification: "fund-uncovered",
      source: "Dashboard fund — no MER on file",
    };
  }
  // 4. Not on Dashboard, no typed override → assume individual stock.
  return {
    symbol: key, name, weight, mer: 0,
    classification: "stock",
    source: "Assumed stock (not on Dashboard)",
  };
}

/** Full on-screen breakdown for the Blended-MER Contributors table.
 *  `model` is always populated once report data is loaded — it doesn't
 *  depend on any client comparison being active. `client` is only
 *  populated when a client portfolio has been analysed, so the PM can
 *  audit the model's fees at any time and the client's fees only
 *  once they've entered holdings. */
type MerBreakdown = {
  model: {
    rows: MerContribRow[];
    blended: number;
    coveragePct: number;
  };
  client: {
    rows: MerContribRow[];
    blended: number;
    coveragePct: number;
  } | null;
};

/** Classify holdings using the same pipeline the
 *  /api/client-report-analysis payload uses, and return the result in
 *  the shape the audit table wants. `clientResult` / `clientPositions`
 *  are optional — when absent, only the model side is populated.
 *  Passing the raw inputs (not the payload) keeps this callable during
 *  render without side effects. */
function buildMerBreakdown(
  clientResult: ClientPortfolioResult | null,
  data: ReportData,
  clientPositions: ClientPosition[],
  stocks: Stock[],
): MerBreakdown {
  const dashByCanon = new Map<string, Stock>();
  for (const s of stocks) dashByCanon.set(canonClientTicker(s.ticker), s);
  const typedByCanon = new Map<
    string,
    { mer?: number; instrumentType?: "stock" | "fund" }
  >();
  for (const pos of clientPositions) {
    const key = canonClientTicker(pos.ticker);
    if (!key) continue;
    typedByCanon.set(key, { mer: pos.mer, instrumentType: pos.instrumentType });
  }
  const modelRows = data.rawHoldings.map((h) =>
    classifyMerRow(
      { symbol: h.symbol, name: h.name || h.symbol, weight: h.weight },
      dashByCanon,
      undefined,
    ),
  );
  const m = summarizeMerRows(modelRows);
  let clientSide: MerBreakdown["client"] = null;
  if (clientResult) {
    const clientRows = clientResult.positions.map((p) =>
      classifyMerRow(
        { symbol: p.ticker, name: p.name, weight: p.weight },
        dashByCanon,
        typedByCanon.get(canonClientTicker(p.ticker)),
      ),
    );
    const c = summarizeMerRows(clientRows);
    clientSide = { rows: clientRows, blended: c.blended, coveragePct: c.coveragePct };
  }
  return {
    model: { rows: modelRows, blended: m.blended, coveragePct: m.coveragePct },
    client: clientSide,
  };
}

/** Reduce classified rows to {blended %, covered weight, total weight}.
 *  Matches the math the API's blendedMer() runs server-side. */
function summarizeMerRows(rows: MerContribRow[]): {
  blended: number;
  coveredWeight: number;
  totalWeight: number;
  coveragePct: number;
} {
  let weightedSum = 0;
  let coveredWeight = 0;
  let totalWeight = 0;
  for (const r of rows) {
    if (r.weight <= 0) continue;
    totalWeight += r.weight;
    if (r.classification === "fund-uncovered") continue;
    coveredWeight += r.weight;
    weightedSum += r.weight * (r.mer ?? 0);
  }
  const blended = coveredWeight > 0 ? weightedSum / coveredWeight : 0;
  const coveragePct = totalWeight > 0 ? (coveredWeight / totalWeight) * 100 : 0;
  return { blended, coveredWeight, totalWeight, coveragePct };
}

function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !isFinite(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

function fmtPctSigned(v: number | null | undefined, digits = 1): string {
  if (v == null || !isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

function fmtPctFrac(v: number | null | undefined, digits = 1): string {
  if (v == null || !isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

// ───────── Client presentation bullets ─────────

/** Locally-persisted wrapper around the API result. `fingerprint` is the
 *  hash of the report inputs the bullets were generated from, so the UI
 *  can tell the PM when a later "Refresh live data" has moved the numbers
 *  out from under the copy. */
type StoredBullets = ClientReportBullets & {
  fingerprint: string;
  /** True once the PM has hand-edited the AI copy. Regenerating asks
   *  before replacing edited text. */
  edited?: boolean;
};

/** Bullets as they render on the report: blank (mid-edit) lines dropped. */
function visibleBullets(b: StoredBullets | null): string[] {
  return b ? b.bullets.filter((x) => x.trim().length > 0) : [];
}

type BulletsPayload = {
  profileLabel: string;
  allocation: { label: string; weight: number }[];
  sectors: { label: string; weight: number }[];
  geography: { label: string; weight: number }[];
  breadth: {
    underlyingNames: number;
    top10Weight: number;
    sectorCount: number;
  };
  blendedMerPct?: number;
  merCoveragePct?: number;
  cashWeight?: number;
  performance: {
    annualizedReturnPct: number | null;
    sinceInceptionReturnPct: number | null;
    yearsOfHistory: number | null;
    volatility: number | null;
    benchmarkVolatility: number | null;
    upsideCapture: number | null;
    downsideCapture: number | null;
  };
  weightsSource: "live" | "target";
};

/**
 * Build the exact body POSTed to /api/client-report-bullets.
 *
 * Deliberately position-agnostic: no ticker, holding name, or client
 * data goes into it. Only asset-class, sector, geography, breadth
 * counts, blended fee, and risk/return stats — which is what keeps the
 * generated bullets free of individual-position commentary.
 *
 * Pure function of its inputs so the same call can serve both the POST
 * and the staleness fingerprint below.
 */
function buildBulletsPayload(
  data: ReportData,
  clientPositions: ClientPosition[],
  stocks: Stock[],
  override: MetricsOverride,
): BulletsPayload {
  const modelMer = buildMerBreakdown(null, data, clientPositions, stocks).model;
  const cashSlice = data.allocation.find((a) => a.key === "cash");
  const top10 = data.xray
    .slice(0, 10)
    .reduce((sum, r) => sum + r.weight, 0);
  return {
    profileLabel: data.profileLabel,
    allocation: data.allocation.map((a) => ({ label: a.label, weight: a.weight })),
    sectors: data.sectors.map((s) => ({ label: s.sector, weight: s.weight })),
    geography: data.geography.map((g) => ({ label: g.country, weight: g.weight })),
    breadth: {
      underlyingNames: data.xray.length,
      top10Weight: +top10.toFixed(2),
      sectorCount: data.sectors.length,
    },
    blendedMerPct: modelMer.coveragePct > 0 ? +modelMer.blended.toFixed(3) : undefined,
    merCoveragePct: +modelMer.coveragePct.toFixed(1),
    cashWeight: cashSlice ? cashSlice.weight : data.totals.cash,
    // Overrides win over auto values so the bullets quote the same
    // numbers the printed Risk Profile strip shows the client.
    performance: {
      annualizedReturnPct: data.tracker?.annualizedReturnPct ?? null,
      sinceInceptionReturnPct: data.tracker?.sinceInceptionReturnPct ?? null,
      yearsOfHistory: data.tracker?.yearsOfHistory ?? null,
      volatility: override.stdDev ?? data.performance.volatility ?? null,
      benchmarkVolatility:
        override.benchmarkStdDev ?? data.performance.benchmarkVolatility ?? null,
      upsideCapture: override.upsideCapture ?? data.performance.upsideCapture ?? null,
      downsideCapture:
        override.downsideCapture ?? data.performance.downsideCapture ?? null,
    },
    weightsSource: data.weightsSource,
  };
}

/** FNV-1a over the payload JSON. Only ever compared against another
 *  fingerprint produced here, so a 32-bit non-cryptographic hash is
 *  plenty — this is a "did the numbers move?" check, not security. */
function fingerprintPayload(payload: BulletsPayload): string {
  const s = JSON.stringify(payload);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export default function ClientReportPage() {
  const router = useRouter();
  const params = useSearchParams();
  const groupId = params.get("group") || "pim";
  const profileParam = (params.get("profile") || "balanced") as PimProfileType;
  const profile = VALID_PROFILES.includes(profileParam) ? profileParam : "balanced";
  // Portrait = the letter-sized PDF one-pager. Landscape = 16:9 slides
  // sized for Prezi: each slide is one self-contained screenshot (or one
  // page of a landscape PDF). Lives in the URL like group/profile.
  const layout: ReportLayout = params.get("layout") === "landscape" ? "landscape" : "portrait";
  const reportUrl = useCallback(
    (next: { group?: string; profile?: string; layout?: ReportLayout }) => {
      const g = next.group ?? groupId;
      const p = next.profile ?? profile;
      const l = next.layout ?? layout;
      return `/client-report?group=${encodeURIComponent(g)}&profile=${encodeURIComponent(p)}${
        l === "landscape" ? "&layout=landscape" : ""
      }`;
    },
    [groupId, profile, layout],
  );

  const { data, loading, error, refetch } = useReportData(groupId, profile);
  const { stocks, pimModels } = useStocks();

  // ── Client portfolio comparison state ──
  const [clientInputMode, setClientInputMode] = useState<ClientInputMode>("units");
  const [clientPositions, setClientPositions] = useState<ClientPosition[]>([]);
  const [clientCash, setClientCash] = useState<number>(0);
  // Fixed-income placeholder. Same dual-mode UX as cash: dollars in
  // units mode, percent in weight mode. Folds into the Fixed Income
  // allocation bucket so the PM can represent a generic fixed-income
  // sleeve without typing every bond holding.
  const [clientFixedIncome, setClientFixedIncome] = useState<number>(0);
  // Manual total portfolio value. Only used when inputMode === "weight"
  // (where per-position market values aren't known). Feeds the fee-savings
  // dollar calc; 0 or blank means "no dollar estimate available." Stored
  // separately from per-position weights so typing a value here never
  // alters the holding percentages.
  const [clientManualTotalValue, setClientManualTotalValue] = useState<number>(0);
  // Manual overrides for the Risk Profile strip, keyed per (groupId,
  // profile). Shape: { "groupId::profile": { stdDev?, benchmarkStdDev?,
  // upsideCapture?, downsideCapture? } }. Populated from the saved
  // pm:client-portfolio blob; cleared via the Reset button.
  const [metricsOverrides, setMetricsOverrides] = useState<
    Record<string, MetricsOverride>
  >({});
  const [clientResult, setClientResult] = useState<ClientPortfolioResult | null>(null);
  const [clientLoading, setClientLoading] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);
  const [showComparison, setShowComparison] = useState(false);
  const clientPortfolioLoaded = useRef(false);

  // ── AI-generated analysis (pros/cons + recommendations + summary) ──
  // The result is cached server-side by payload hash and ALSO persisted
  // locally in the pm:client-portfolio blob so the bullets survive page
  // reloads without re-spending an Anthropic call.
  const [analysis, setAnalysis] = useState<ClientReportAnalysis | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // ── Client presentation bullets (model-level talking points) ──
  // Independent of the client comparison — these describe OUR model, so
  // they're available as soon as report data loads. Generation always
  // re-pulls live data first (see generateBullets) so the copy can never
  // be written off a stale snapshot.
  const [bullets, setBullets] = useState<StoredBullets | null>(null);
  const [bulletsLoading, setBulletsLoading] = useState(false);
  const [bulletsError, setBulletsError] = useState<string | null>(null);
  const [bulletsCopied, setBulletsCopied] = useState(false);

  // Load saved client portfolio positions from Redis on mount.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/kv/client-portfolio", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { data: null }))
      .then((payload: { data?: { positions?: ClientPosition[]; cash?: number; fixedIncome?: number; manualTotalValue?: number; inputMode?: ClientInputMode; analysis?: ClientReportAnalysis; presentationBullets?: StoredBullets; metricsOverrides?: Record<string, MetricsOverride> } | null }) => {
        if (cancelled) return;
        const d = payload?.data;
        if (d) {
          if (Array.isArray(d.positions) && d.positions.length > 0) {
            setClientPositions(d.positions);
          }
          if (typeof d.cash === "number") setClientCash(d.cash);
          if (typeof d.fixedIncome === "number") setClientFixedIncome(d.fixedIncome);
          if (typeof d.manualTotalValue === "number") {
            setClientManualTotalValue(d.manualTotalValue);
          }
          if (d.inputMode === "units" || d.inputMode === "weight") setClientInputMode(d.inputMode);
          if (d.analysis && typeof d.analysis === "object") setAnalysis(d.analysis);
          if (
            d.presentationBullets &&
            typeof d.presentationBullets === "object" &&
            Array.isArray(d.presentationBullets.bullets)
          ) {
            setBullets(d.presentationBullets);
          }
          if (d.metricsOverrides && typeof d.metricsOverrides === "object") {
            setMetricsOverrides(d.metricsOverrides);
          }
        }
        clientPortfolioLoaded.current = true;
      })
      .catch(() => {
        clientPortfolioLoaded.current = true;
      });
    return () => { cancelled = true; };
  }, []);

  // ── Daily portfolio snapshot ──
  // Saves today's sector breakdown + top holdings for (group, profile) once
  // per page-render, de-duplicated per composite key within a session via
  // `snapshotSavedRef`. The API route is APPEND-ONLY (see
  // app/api/kv/portfolio-snapshots/route.ts): it rejects past-dated writes
  // and preserves every previously-stored date verbatim on every merge, so
  // historical snapshots can never be clobbered.
  const snapshotSavedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!data) return;
    const today = new Date().toISOString().slice(0, 10);
    const field = `${today}:${data.groupId}:${data.profile}`;
    if (snapshotSavedRef.current.has(field)) return;
    snapshotSavedRef.current.add(field);

    const payload = {
      entries: {
        [field]: {
          date: today,
          groupId: data.groupId,
          profile: data.profile,
          totalValue: data.totals.cad + data.totals.usd + data.totals.cash,
          sectors: data.sectors.map((s) => ({ sector: s.sector, weight: s.weight })),
          topHoldings: data.xray.slice(0, 15).map((h) => ({
            symbol: h.symbol,
            name: h.name,
            weight: h.weight,
          })),
          savedAt: new Date().toISOString(),
        },
      },
    };

    fetch("/api/kv/portfolio-snapshots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {
      // Best-effort; allow retry on next render of this field.
      snapshotSavedRef.current.delete(field);
    });
  }, [data]);

  // Auto-save client portfolio positions to Redis (debounced).
  useEffect(() => {
    if (!clientPortfolioLoaded.current) return;
    const handle = setTimeout(() => {
      fetch("/api/kv/client-portfolio", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          positions: clientPositions,
          cash: clientCash,
          fixedIncome: clientFixedIncome,
          manualTotalValue: clientManualTotalValue,
          inputMode: clientInputMode,
          analysis,
          presentationBullets: bullets,
          metricsOverrides,
        }),
      }).catch(() => { /* best effort */ });
    }, 800);
    return () => clearTimeout(handle);
  }, [clientPositions, clientCash, clientFixedIncome, clientManualTotalValue, clientInputMode, analysis, bullets, metricsOverrides]);

  const addPosition = useCallback(() => {
    setClientPositions((prev) => [
      ...prev,
      { id: crypto.randomUUID(), ticker: "", name: "", units: 0, weight: 0 },
    ]);
  }, []);

  const removePosition = useCallback((id: string) => {
    setClientPositions((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const clearAllPositions = useCallback(() => {
    // Two-step confirmation: window.confirm keeps it native + undismissable
    // by a stray page click, which matters because the action is destructive
    // (wipes the PM's in-progress client-side holdings along with the cash
    // field).
    const count = clientPositions.length;
    if (count === 0) return;
    const ok = window.confirm(
      `Clear all ${count} client-side ${count === 1 ? "holding" : "holdings"} and reset cash + fixed income to 0? This cannot be undone.`
    );
    if (!ok) return;
    setClientPositions([]);
    setClientCash(0);
    setClientFixedIncome(0);
  }, [clientPositions.length]);

  const updatePosition = useCallback(
    (
      id: string,
      field: keyof Omit<ClientPosition, "id">,
      value: string | number | undefined,
    ) => {
      setClientPositions((prev) =>
        prev.map((p) => (p.id === id ? { ...p, [field]: value } : p))
      );
    },
    []
  );

  // Auto-fetch name when the user finishes typing a ticker (on blur).
  const fetchTickerName = useCallback(
    async (id: string, ticker: string) => {
      const t = ticker.trim().toUpperCase();
      if (!t) return;
      // Convert preferred share formats to Yahoo's expected ticker so we
      // can resolve the name (e.g. BMO.PR.E → BMO-PE.TO).
      const yahooTicker = normalizePreferredTicker(t);
      try {
        const res = await fetch("/api/prices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tickers: [yahooTicker] }),
          cache: "no-store",
        });
        if (!res.ok) return;
        const payload = await res.json();
        const name = payload?.names?.[yahooTicker];
        if (name) {
          setClientPositions((prev) =>
            prev.map((p) =>
              p.id === id && !p.name.trim() ? { ...p, name } : p
            )
          );
        }
      } catch {
        /* best effort */
      }
    },
    []
  );

  const computeClientPortfolio = useCallback(async () => {
    setClientError(null);
    setClientLoading(true);
    try {
      // Build a stockBySymbol map for look-through.
      const stockBySymbol = new Map<string, Stock>();
      for (const s of stocks) {
        stockBySymbol.set(s.ticker, s);
        if (s.ticker.endsWith(".TO")) {
          stockBySymbol.set(s.ticker.replace(/\.TO$/, "-T"), s);
        }
      }

      // Fetch fund-data-cache for look-through expansion.
      let fundCache: Record<string, { topHoldings?: FundHolding[] }> = {};
      try {
        const fcRes = await fetch("/api/kv/fund-data-cache", { cache: "no-store" });
        if (fcRes.ok) {
          const payload = await fcRes.json();
          fundCache = payload?.entries ?? {};
        }
      } catch { /* ignore */ }

      // ── Step 1: Resolve positions with weights ──
      let positions: { ticker: string; name: string; weight: number; marketValue: number; quoteType: string | null }[];
      let cashWeight: number;
      let fixedIncomeWeight: number;
      let totalValue: number;

      if (clientInputMode === "weight") {
        const validPositions = clientPositions.filter(
          (p) => p.ticker.trim() && p.weight > 0
        );
        if (validPositions.length === 0 && clientCash <= 0 && clientFixedIncome <= 0) {
          setClientError("Add at least one position with a weight, or a cash / fixed income weight.");
          setClientLoading(false);
          return;
        }
        const rawTotal =
          validPositions.reduce((s, p) => s + p.weight, 0) + clientCash + clientFixedIncome;
        if (rawTotal <= 0) {
          setClientError("Total weight must be positive.");
          setClientLoading(false);
          return;
        }
        // Fetch names + quoteTypes for all tickers. Normalize preferred
        // share inputs (e.g. BMO.PR.E → BMO-PE.TO) so Yahoo can resolve them.
        const tickers = validPositions.map((p) =>
          normalizePreferredTicker(p.ticker.trim().toUpperCase())
        );
        let names: Record<string, string | null> = {};
        let quoteTypes: Record<string, string | null> = {};
        if (tickers.length > 0) {
          try {
            const res = await fetch("/api/prices", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tickers }),
              cache: "no-store",
            });
            if (res.ok) {
              const payload = await res.json();
              names = payload?.names ?? {};
              quoteTypes = payload?.quoteTypes ?? {};
            }
          } catch { /* ignore */ }
        }
        positions = validPositions
          .map((p) => {
            const ticker = p.ticker.trim().toUpperCase();
            const yahooTicker = normalizePreferredTicker(ticker);
            return {
              ticker, // Keep the user's original ticker for display/classification.
              name: p.name.trim() || names[yahooTicker] || ticker,
              weight: (p.weight / rawTotal) * 100,
              marketValue: 0,
              quoteType: quoteTypes[yahooTicker] ?? null,
            };
          })
          .sort((a, b) => b.weight - a.weight);
        cashWeight = (clientCash / rawTotal) * 100;
        fixedIncomeWeight = (clientFixedIncome / rawTotal) * 100;
        // In weight mode the per-position market values aren't known,
        // so totalValue defaults to 0 (hides dollar outputs). When the
        // PM types a manual total in the UI we pass it through here so
        // the fee-savings calc can still produce a dollar figure. This
        // does NOT feed back into per-position weights — weights remain
        // whatever the user typed, normalized above.
        totalValue = clientManualTotalValue > 0 ? clientManualTotalValue : 0;
      } else {
        const validPositions = clientPositions.filter(
          (p) => p.ticker.trim() && p.units > 0
        );
        if (validPositions.length === 0 && clientCash <= 0 && clientFixedIncome <= 0) {
          setClientError("Add at least one position, cash amount, or fixed income amount.");
          setClientLoading(false);
          return;
        }
        const tickers = validPositions.map((p) =>
          normalizePreferredTicker(p.ticker.trim().toUpperCase())
        );
        let prices: Record<string, number | null> = {};
        let names: Record<string, string | null> = {};
        let quoteTypes: Record<string, string | null> = {};
        if (tickers.length > 0) {
          const res = await fetch("/api/prices", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tickers }),
            cache: "no-store",
          });
          if (res.ok) {
            const payload = await res.json();
            prices = payload?.prices ?? {};
            names = payload?.names ?? {};
            quoteTypes = payload?.quoteTypes ?? {};
          }
        }

        const positionsWithValue: {
          ticker: string; name: string; units: number;
          price: number; marketValue: number; quoteType: string | null;
        }[] = [];
        for (const p of validPositions) {
          const ticker = p.ticker.trim().toUpperCase();
          const yahooTicker = normalizePreferredTicker(ticker);
          const price = prices[yahooTicker] ?? prices[ticker] ?? prices[p.ticker.trim()] ?? null;
          if (price == null || price <= 0) continue;
          positionsWithValue.push({
            ticker, // Keep the user's original ticker for display/classification.
            name: p.name.trim() || names[yahooTicker] || ticker,
            units: p.units, price,
            marketValue: p.units * price,
            quoteType: quoteTypes[yahooTicker] ?? null,
          });
        }

        const totalEquity = positionsWithValue.reduce((sum, p) => sum + p.marketValue, 0);
        totalValue = totalEquity + clientCash + clientFixedIncome;
        if (totalValue <= 0) {
          setClientError("Could not compute portfolio value — check tickers and prices.");
          setClientLoading(false);
          return;
        }

        positions = positionsWithValue
          .map((p) => ({
            ticker: p.ticker, name: p.name,
            weight: (p.marketValue / totalValue) * 100,
            marketValue: p.marketValue, quoteType: p.quoteType,
          }))
          .sort((a, b) => b.weight - a.weight);
        cashWeight = totalValue > 0 ? (clientCash / totalValue) * 100 : 0;
        fixedIncomeWeight = totalValue > 0 ? (clientFixedIncome / totalValue) * 100 : 0;
      }

      // ── Step 2: Set up classification helpers + allocation buckets ──
      // Categories: Fixed Income, Alternatives, US Equity, Canadian Equity,
      // Global Equity, Preferred Shares, Cash. No "Core ETFs" bucket
      // (client-side accounts don't carry the firm's Core ETF flagship
      // slice; that's a PIM-side concept only).
      //
      // Colors come from the canonical SLICE_COLORS palette in
      // useReportData.ts. Imported (rather than redefined) so the
      // Current pie and the Growth pie always render slices in
      // identical colors — they can't drift apart.
      const SLICE_COLORS_CLIENT: Record<string, string> = SLICE_COLORS;
      const SLICE_LABELS_CLIENT: Record<string, string> = {
        fixedIncome: "Fixed Income",
        alternatives: "Alternatives",
        usEquity: "US Equity",
        canadianEquity: "Canadian Equity",
        globalEquity: "Global Equity",
        preferredShares: "Preferred Shares",
        cash: "Cash",
      };
      const allocTotals: Record<string, number> = {
        fixedIncome: 0, alternatives: 0,
        usEquity: 0, canadianEquity: 0, globalEquity: 0,
        preferredShares: 0, cash: 0,
      };

      const isBondLike = (name: string, qt: string | null): boolean => {
        if (qt === "MUTUALFUND" || qt === "ETF") {
          const u = name.toUpperCase();
          if (/\b(BOND|FIXED\s*INCOME|AGGREGATE|TREASURY|INCOME\s*FUND|GOVT|CORE\s*PLUS)\b/.test(u)) return true;
        }
        return false;
      };
      const isAltLike = (name: string): boolean => {
        const u = name.toUpperCase();
        return /\b(PREMIUM\s*YIELD|COVERED\s*CALL|OPTION|ALTERNATIVE|HEDGE|REAL\s*ESTATE|REIT|INFRASTRUCTURE)\b/.test(u);
      };
      // Preferred share detection — covers both common typing formats and
      // Yahoo's native format. Examples that match:
      //   BMO.PR.E, CM.PR.O   (Canadian common)
      //   BAC.PRA, BAC.PR.A   (US common)
      //   BMO-PE.TO           (Canadian Yahoo)
      //   BAC-PA              (US Yahoo)
      // Also matches by name when "Preferred" / "Pref" / "Pfd" appears.
      //
      // Fallback heuristic: if the ticker contains "PR" AND at least two
      // periods, it's almost certainly a preferred share (common Canadian
      // dotted format like BMO.PR.E, RY.PR.Z, etc.). Catches edge cases
      // the strict regexes above might miss (e.g. extra suffixes,
      // numerics, or non-standard issuer prefixes).
      const isPreferredShare = (ticker: string, name: string): boolean => {
        const t = ticker.trim().toUpperCase();
        if (/^[A-Z]+\.PR\.[A-Z]+$/.test(t)) return true;
        if (/^[A-Z]+\.PR[A-Z]+$/.test(t)) return true;
        if (/^[A-Z]+-P[A-Z]+(\.[A-Z]+)?$/.test(t)) return true;
        // Simple structural heuristic per PM feedback.
        if (t.includes("PR") && (t.match(/\./g) || []).length >= 2) return true;
        if (name) {
          const u = name.toUpperCase();
          if (/\bPREFERRED\b|\bPREF\b|\bPFD\b/.test(u)) return true;
        }
        return false;
      };

      // ── Step 3: Look-through X-ray expansion + allocation classification ──
      // Recursively expand funds/ETFs into underlying stock holdings.
      // Allocation is driven from look-through leaves so a CAD-listed
      // ETF tracking US markets (e.g. XSP.TO) correctly classifies as
      // US Equity, not Canadian Equity (its listing exchange).
      const normalizeForApi = (sym: string) => sym.replace(/-T$/, ".TO");

      const fundInfoCache = new Map<
        string,
        { topHoldings?: FundHolding[]; sectorWeightings?: FundSectorWeight[] } | null
      >();

      const getFundInfo = async (sym: string) => {
        const key = sym.toUpperCase();
        const altKey = normalizeForApi(key);
        if (fundInfoCache.has(key)) return fundInfoCache.get(key) ?? null;
        if (key !== altKey && fundInfoCache.has(altKey)) return fundInfoCache.get(altKey) ?? null;
        const ownStock = stockBySymbol.get(sym) ?? stockBySymbol.get(key) ?? stockBySymbol.get(altKey);
        if (ownStock?.fundData?.topHoldings?.length) {
          const info = { topHoldings: ownStock.fundData.topHoldings, sectorWeightings: ownStock.fundData.sectorWeightings };
          fundInfoCache.set(key, info);
          return info;
        }
        const cached = fundCache[key] ?? fundCache[altKey];
        if (cached?.topHoldings?.length) {
          const info = { topHoldings: cached.topHoldings, sectorWeightings: undefined as FundSectorWeight[] | undefined };
          fundInfoCache.set(key, info);
          return info;
        }
        const fetchTicker = normalizeForApi(sym);
        try {
          // Hard 5s timeout per fund lookup. Anything slower is almost
          // certainly Yahoo not knowing the ticker; the abort cuts off
          // the wait so the rest of the look-through can proceed.
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5000);
          let res: Response;
          try {
            res = await fetch(`/api/fund-data?ticker=${encodeURIComponent(fetchTicker)}`, {
              cache: "no-store",
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timer);
          }
          if (!res.ok) { fundInfoCache.set(key, null); return null; }
          const d = await res.json().catch(() => null);
          const fd = d?.fundData as FundData | undefined;
          const info = { topHoldings: fd?.topHoldings, sectorWeightings: fd?.sectorWeightings };
          fundInfoCache.set(key, info);
          return info;
        } catch {
          // AbortError or any other failure → cache null, move on.
          fundInfoCache.set(key, null);
          return null;
        }
      };

      const looksLikeFund = (sym: string, name: string, st: Stock | undefined, qt: string | null): boolean => {
        // ── Unambiguous fund signals checked FIRST, BEFORE consulting
        // the user's pm:stocks instrumentType. The stockBySymbol cache
        // can have wrong labels — e.g. a Morningstar ID like 0P0000UJ32
        // gets stored as instrumentType "stock" by default because the
        // company-name lookup can't resolve a non-Yahoo symbol. If we
        // checked instrumentType first, the early "stock" return would
        // hide actual mutual funds from the look-through. ──
        if (/^0P[A-Z0-9]{8}$/i.test(sym)) return true; // Morningstar ID
        if (/^[A-Z]{2,4}\d{2,5}$/.test(sym)) return true; // FUNDSERV code
        const u0 = (name || "").toUpperCase();
        // Allocation / lifestyle / target-date funds (e.g. JNL Moderate
        // Allocation A, BlackRock Conservative Allocation, Vanguard
        // Target Retirement 2050) — almost always insurance / variable
        // annuity / pension funds whose tickers may resemble stocks.
        if (/\b(MODERATE|CONSERVATIVE|AGGRESSIVE|BALANCED)\s+ALLOCATION\b/.test(u0)) return true;
        if (/\bALLOCATION\s+(FUND|PORTFOLIO)\b/.test(u0)) return true;
        if (/\bLIFESTYLE\b/.test(u0)) return true;
        if (/\bTARGET\s+(DATE|RETIREMENT)\b/.test(u0)) return true;
        // Trailing single-letter share class without the word "Class"
        // (e.g. "JNL Moderate Allocation A", "Fidelity Contrafund I").
        if (/\bALLOCATION\s+[A-F]$/.test(u0)) return true;
        if (/\bPORTFOLIO\s+[A-F]$/.test(u0)) return true;

        // ── Then the original instrumentType-based path (fast and
        // correct when the cache has the right label). ──
        if (st?.instrumentType === "stock") return false;
        if (st?.instrumentType === "etf" || st?.instrumentType === "mutual-fund") return true;
        if (st?.fundData?.topHoldings?.length) return true;
        if (isCoreEtf(sym)) return true;
        if (fundCache[sym.toUpperCase()]?.topHoldings?.length) return true;
        if (qt === "ETF" || qt === "MUTUALFUND") return true;
        const u = (name || "").toUpperCase();
        if (/\bETF\b/.test(u)) return true;
        if (/\bINDEX\b/.test(u)) return true;
        if (/\b(MUTUAL|INDEX|INCOME|BOND|EQUITY)\s+FUND\b/.test(u)) return true;
        if (/\bCLASS\s+[FIOAD]\b/.test(u)) return true;
        if (/\bSERIES\s+[FIOAD]\b/.test(u)) return true;
        return false;
      };

      /** For balanced/allocation funds whose underlying holdings can't
       *  be resolved (Yahoo coverage of insurance variable annuity
       *  funds, target-date funds, and lifestyle funds is spotty), use
       *  a sensible default split between equity and fixed income based
       *  on the fund's name. Better than attributing 100% to equity by
       *  default, which is wrong for any "Moderate" / "Conservative"
       *  fund. Returns null for funds that don't match an allocation
       *  template (caller falls back to existing behavior). */
      const balancedFundSplit = (name: string): { equity: number; fixedIncome: number } | null => {
        const u = (name || "").toUpperCase();
        if (/\bCONSERVATIVE\b/.test(u)) return { equity: 0.30, fixedIncome: 0.70 };
        if (/\bMODERATE\b/.test(u)) return { equity: 0.60, fixedIncome: 0.40 };
        if (/\bBALANCED\b/.test(u)) return { equity: 0.60, fixedIncome: 0.40 };
        if (/\bAGGRESSIVE\b/.test(u)) return { equity: 0.80, fixedIncome: 0.20 };
        if (/\bGROWTH\s+(ALLOCATION|PORTFOLIO|FUND)\b/.test(u)) return { equity: 0.70, fixedIncome: 0.30 };
        if (/\bINCOME\s+ALLOCATION\b/.test(u)) return { equity: 0.40, fixedIncome: 0.60 };
        if (/\bLIFESTYLE\b/.test(u)) return { equity: 0.60, fixedIncome: 0.40 };
        if (/\bTARGET\s+(DATE|RETIREMENT)\b/.test(u)) return { equity: 0.65, fixedIncome: 0.35 };
        return null;
      };

      // Non-equity filter: skip fixed-income and cash-like holdings at the leaf level.
      const NON_EQUITY_NAME_RE =
        /\b(TREASURY|T-BILL|BOND|GOVT|GOVERNMENT|CASH|MONEY\s*MARKET|REPO|COMMERCIAL\s*PAPER)\b/i;

      const xrayAcc = new Map<string, { name: string; direct: number; lookThrough: number }>();

      // Track funds the look-through couldn't auto-resolve, so the UI
      // can offer a "provide holdings URL" path. Only funds where
      // looksLikeFund returned true AND we couldn't get top holdings
      // are recorded — successful resolutions don't surface here.
      const unresolvedFundsAcc = new Map<string, { name: string; weight: number; usedBalancedSplit: boolean }>();
      const recordUnresolved = (sym: string, name: string, weight: number, usedBalancedSplit: boolean) => {
        const key = sym.toUpperCase();
        const prev = unresolvedFundsAcc.get(key) ?? { name, weight: 0, usedBalancedSplit };
        prev.weight += weight;
        if (name && name.length > prev.name.length) prev.name = name;
        unresolvedFundsAcc.set(key, prev);
      };

      // Alias dual-class shares + name-keyed entries so look-through
      // weight accumulates into one row per security. Same map as the
      // model report (useReportData.ts); kept inline here rather than
      // shared because the two xrays were originally independent and
      // we want to keep the merge logic isolated. Add new aliases as
      // they surface during real PM use.
      const TICKER_ALIASES: Record<string, string> = {
        // Alphabet
        "GOOG": "GOOGL",
        "ALPHABET INC CLASS A": "GOOGL",
        "ALPHABET INC CLASS C": "GOOGL",
        "ALPHABET INC.": "GOOGL",
        "ALPHABET INC": "GOOGL",
        "ALPHABET": "GOOGL",
        // Meta
        "FB": "META",
        "META PLATFORMS INC": "META",
        "META PLATFORMS, INC.": "META",
        // Berkshire
        "BRK.B": "BRK-B",
        "BRKB": "BRK-B",
        "BERKSHIRE HATHAWAY INC CLASS B": "BRK-B",
        "BERKSHIRE HATHAWAY INC.": "BRK-B",
        // Fox / News Corp
        "FOX": "FOXA",
        "NWS": "NWSA",
      };
      const canonicalizeXRayKey = (raw: string): string => {
        const upper = raw.toUpperCase().trim();
        return TICKER_ALIASES[upper] ?? upper;
      };

      const addXRay = (symbol: string, name: string, direct: number, lookThrough: number) => {
        const rawKey = symbol || name;
        if (!rawKey) return;
        // Skip obviously non-equity leaf holdings.
        if (NON_EQUITY_NAME_RE.test(name)) return;
        const key = canonicalizeXRayKey(rawKey);
        const aliasedName = TICKER_ALIASES[name.toUpperCase().trim()];
        const finalKey = aliasedName ?? key;
        const prev = xrayAcc.get(finalKey) ?? { name, direct: 0, lookThrough: 0 };
        prev.direct += direct;
        prev.lookThrough += lookThrough;
        if (name && name.length > prev.name.length) prev.name = name;
        xrayAcc.set(finalKey, prev);
      };

      // Helper: classify an equity leaf into a country bucket.
      // `parentCountry` is the country of the enclosing fund when this
      // symbol came from a fund's top-holdings list. Many fund-data
      // feeds strip exchange suffixes from underlying tickers (e.g. a
      // Canadian XIC.TO holding listed as "RY" rather than "RY.TO"),
      // which would otherwise default to US Equity via countryFor().
      // When we have a parent-country hint AND the ticker is ambiguous
      // (no exchange suffix and not in our explicit table), inherit
      // the parent's country.
      const addEquityToAllocation = (
        sym: string, weightPct: number, parentCountry?: Country,
      ) => {
        const explicit = SYMBOL_COUNTRY[sym];
        const hasSuffix =
          /\.(TO|V|CN|NE|U)$/.test(sym) || /-T$/.test(sym) || /-U\.TO$/.test(sym);
        const c: Country =
          explicit
            ? explicit
            : parentCountry && !hasSuffix
              ? parentCountry
              : countryFor(sym);
        if (c === "Canada") allocTotals.canadianEquity += weightPct;
        else if (c === "Global") allocTotals.globalEquity += weightPct;
        else allocTotals.usEquity += weightPct;
      };

      const MAX_DEPTH = 4;
      const expandClient = async (
        sym: string, name: string, weightPct: number,
        depth: number, qt: string | null,
        parentCountry?: Country,
      ): Promise<void> => {
        if (weightPct <= 0 || !sym) return;
        const st = stockBySymbol.get(sym);

        // Preferred shares discovered during recursion are not equity —
        // contribute to the Preferred Shares bucket, not equity, and don't
        // include in the equity look-through xray.
        if (isPreferredShare(sym, st?.name || name)) {
          allocTotals.preferredShares += weightPct;
          return;
        }

        const isFund = looksLikeFund(sym, name, st, qt);
        if (!isFund) {
          // Stock leaf — include in xray AND classify by country for allocation.
          const direct = depth === 0 ? weightPct : 0;
          const lookThrough = depth === 0 ? 0 : weightPct;
          addXRay(sym, st?.name || name, direct, lookThrough);
          addEquityToAllocation(sym, weightPct, parentCountry);
          return;
        }

        // Bond/FI funds discovered during recursion: don't expand, don't
        // contribute to equity. They've already been classified at top
        // level if they were the input position.
        if (isBondLike(name, qt)) return;

        // Determine this fund's own country — used as the parentCountry
        // hint for any unsuffixed children we recurse into.
        const fundCountry: Country = countryFor(sym);

        if (depth >= MAX_DEPTH) {
          // Can't expand further — fall back to fund's own country for allocation.
          addEquityToAllocation(sym, weightPct, parentCountry);
          return;
        }
        const info = await getFundInfo(sym);
        const top = info?.topHoldings ?? [];
        if (!top.length) {
          // Couldn't resolve underlying. Record so the UI can offer a
          // "provide holdings URL" override for this fund. Balanced
          // template OR fall back to country bucket.
          const split = balancedFundSplit(name);
          recordUnresolved(sym, name, weightPct, !!split);
          if (split) {
            addEquityToAllocation(sym, weightPct * split.equity, parentCountry);
            allocTotals.fixedIncome += weightPct * split.fixedIncome;
            addXRay(sym, name, depth === 0 ? weightPct * split.equity : 0, depth === 0 ? 0 : weightPct * split.equity);
          } else {
            addEquityToAllocation(sym, weightPct, parentCountry);
          }
          return;
        }
        // Yahoo's top-holdings list typically covers only the top 10
        // names (sums to ~50-70% of the fund, not 100%). If we only
        // expand those, the remaining 30-50% of the fund's portfolio
        // weight silently disappears from the allocation totals —
        // which is why pie totals were summing to ~60% instead of
        // 100% on portfolios with multi-fund exposure.
        //
        // Fix: compute the unattributed remainder and attribute it to
        // the fund's OWN country bucket, plus include it in the xray
        // as the fund itself (so the PM sees "Fund X — residual" if
        // they care). Capped at 100% to handle quirky Yahoo data
        // where top-holdings sum slightly over 100% from rounding.
        const childWeightSum = top.reduce((s, h) => s + (typeof h.weight === "number" ? h.weight : 0), 0);
        const attributedFraction = Math.min(Math.max(childWeightSum / 100, 0), 1);
        const unattributedWeight = weightPct * (1 - attributedFraction);

        await Promise.all(
          top.map((h) => {
            const childSym = (h.symbol || h.name || "").trim();
            if (!childSym) return Promise.resolve();
            const childWeight = (weightPct * h.weight) / 100;
            return expandClient(childSym, h.name, childWeight, depth + 1, null, fundCountry);
          })
        );

        // Attribute the residual (anything Yahoo's top-N didn't cover)
        // to the fund's own country and surface it as the fund itself
        // in the xray. Threshold avoids cluttering the xray with tiny
        // rounding remainders.
        if (unattributedWeight > 0.01) {
          addEquityToAllocation(sym, unattributedWeight, parentCountry);
          addXRay(sym, name, depth === 0 ? unattributedWeight : 0, depth === 0 ? 0 : unattributedWeight);
        }
      };

      // Run look-through on all positions. Top-level branch by category:
      // preferred shares → preferredShares bucket; bond funds → fixedIncome;
      // alt funds → alternatives; everything else → equity look-through.
      const qtMap = new Map(positions.map((p) => [p.ticker, p.quoteType]));
      await Promise.all(
        positions.map(async (p) => {
          if (isPreferredShare(p.ticker, p.name)) {
            allocTotals.preferredShares += p.weight;
            return; // No xray entry for preferred shares.
          }
          if (isBondLike(p.name, p.quoteType)) {
            allocTotals.fixedIncome += p.weight;
            return; // No look-through for bonds.
          }
          if (isAltLike(p.name)) {
            allocTotals.alternatives += p.weight;
            return; // No look-through for alts.
          }
          await expandClient(p.ticker, p.name, p.weight, 0, qtMap.get(p.ticker) ?? null);
        })
      );

      if (cashWeight > 0.05) allocTotals.cash += cashWeight;
      // Manual fixed-income placeholder folds into the same bucket as
      // bond-like positions classified from the actual ticker list.
      if (fixedIncomeWeight > 0.05) allocTotals.fixedIncome += fixedIncomeWeight;

      const allocation: ReportAllocationSlice[] = Object.entries(allocTotals)
        .filter(([, w]) => w > 0.05)
        .map(([key, weight]) => ({
          key: key as ReportAllocationSlice["key"],
          label: SLICE_LABELS_CLIENT[key] ?? key,
          weight,
          color: SLICE_COLORS_CLIENT[key] ?? "#94a3b8",
        }))
        .sort((a, b) => b.weight - a.weight);

      const xray: ReportXRayRow[] = Array.from(xrayAcc.entries())
        .map(([symbol, v]) => ({
          symbol,
          name: v.name,
          direct: v.direct,
          lookThrough: v.lookThrough,
          weight: v.direct + v.lookThrough,
        }))
        .filter((r) => r.weight > 0.05)
        .sort((a, b) => b.weight - a.weight);

      // Also backfill names from the API results into the input form.
      setClientPositions((prev) =>
        prev.map((p) => {
          if (p.name.trim()) return p;
          const match = positions.find(
            (pos) => pos.ticker === p.ticker.trim().toUpperCase()
          );
          return match && match.name !== match.ticker
            ? { ...p, name: match.name }
            : p;
        })
      );

      const unresolvedFunds = Array.from(unresolvedFundsAcc.entries())
        .map(([symbol, v]) => ({
          symbol,
          name: v.name,
          weight: v.weight,
          usedBalancedSplit: v.usedBalancedSplit,
        }))
        .sort((a, b) => b.weight - a.weight);

      setClientResult({
        positions: positions.map(({ quoteType: _qt, ...rest }) => rest),
        cash: clientCash,
        cashWeight,
        fixedIncome: clientFixedIncome,
        fixedIncomeWeight,
        totalValue,
        allocation,
        xray,
        unresolvedFunds: unresolvedFunds.length > 0 ? unresolvedFunds : undefined,
      });
      setShowComparison(true);
    } catch (e) {
      setClientError(
        e instanceof Error ? e.message : "Failed to compute client portfolio"
      );
    } finally {
      setClientLoading(false);
    }
  }, [clientPositions, clientCash, clientFixedIncome, clientManualTotalValue, clientInputMode, stocks]);

  // ── Generate AI analysis ──
  // Builds the full comparison payload, looks up per-ticker MER from the
  // Dashboard's fund-data cache (so blended MER is real, not invented),
  // and hits /api/client-report-analysis. Results are cached server-side
  // by payload hash — a second click on an unchanged portfolio returns
  // the cached bullets for free. `force: true` bypasses the cache.
  const generateAnalysis = useCallback(
    async (force = false) => {
      if (!data || !clientResult) {
        setAnalysisError("Add client holdings first, then try again.");
        return;
      }
      setAnalysisLoading(true);
      setAnalysisError(null);
      try {
        // Classify every holding on both sides into a MerContribRow,
        // then derive the API payload's expenseRatios / stockSymbols
        // from those rows. Single source of truth — the on-screen
        // contributors table (rendered from the same classification
        // pipeline via useMemo below) cannot drift from the numbers the
        // API actually computes.
        const dashByCanon = new Map<string, Stock>();
        for (const s of stocks) dashByCanon.set(canonClientTicker(s.ticker), s);
        const typedByCanon = new Map<
          string,
          { mer?: number; instrumentType?: "stock" | "fund" }
        >();
        for (const pos of clientPositions) {
          const key = canonClientTicker(pos.ticker);
          if (!key) continue;
          typedByCanon.set(key, {
            mer: pos.mer,
            instrumentType: pos.instrumentType,
          });
        }
        const clientRows: MerContribRow[] = clientResult.positions.map((p) =>
          classifyMerRow(
            { symbol: p.ticker, name: p.name, weight: p.weight },
            dashByCanon,
            typedByCanon.get(canonClientTicker(p.ticker)),
          ),
        );
        const modelRows: MerContribRow[] = data.rawHoldings.map((h) =>
          classifyMerRow(
            { symbol: h.symbol, name: h.name || h.symbol, weight: h.weight },
            dashByCanon,
            // Model-side holdings don't accept per-row overrides here —
            // the PM edits MERs on the Dashboard for those tickers.
            undefined,
          ),
        );
        const expenseRatios: Record<string, number> = {};
        const stockSymbols: string[] = [];
        for (const r of [...clientRows, ...modelRows]) {
          if (r.classification === "fund-covered" && r.mer != null) {
            expenseRatios[r.symbol] = r.mer;
          } else if (r.classification === "stock") {
            stockSymbols.push(r.symbol);
          }
          // fund-uncovered rows are intentionally omitted so the API
          // reports their weight as uncovered, surfacing the gap.
        }

        const payload = {
          // Intentionally no clientName — client-identifying text
          // shouldn't flow through prompts or persisted caches.
          clientHoldings: clientResult.positions.map((p) => ({
            symbol: p.ticker,
            name: p.name,
            weight: p.weight,
          })),
          clientAllocation: clientResult.allocation.map((a) => ({
            label: a.label,
            weight: a.weight,
          })),
          clientCashWeight: clientResult.cashWeight,
          // Dollar value of the client portfolio, when known. Unit-mode
          // computes this from live prices; weight-mode carries whatever
          // the PM typed into the optional "Portfolio Value" field (0 if
          // blank). Powers the fee-savings calculation on the server.
          clientTotalValue: clientResult.totalValue > 0 ? clientResult.totalValue : 0,
          modelProfileLabel: data.profileLabel,
          // IMPORTANT: use rawHoldings (actual ETF / fund tickers) here,
          // NOT xray (look-through stock-level names). MER is a fund-
          // level attribute — AAPL inside XUS.TO has no MER; XUS.TO
          // does. Sending xray symbols to the blended-MER calc zeroed
          // out the model blended fee in the previous version.
          modelHoldings: data.rawHoldings.map((h) => ({
            symbol: h.symbol,
            name: h.name || h.symbol,
            weight: h.weight,
          })),
          modelAllocation: data.allocation.map((a) => ({
            label: a.label,
            weight: a.weight,
          })),
          expenseRatios,
          stockSymbols,
          modelPerformance: (() => {
            // Prefer manual overrides over auto values so the AI
            // analysis reflects whatever number the PM has chosen
            // to show the client.
            const o = metricsOverrides[`${groupId}::${profile}`] ?? {};
            return {
              annualizedReturnPct: data.tracker?.annualizedReturnPct ?? null,
              volatility: o.stdDev ?? data.performance.volatility ?? null,
              upsideCapture:
                o.upsideCapture ?? data.performance.upsideCapture ?? null,
              downsideCapture:
                o.downsideCapture ?? data.performance.downsideCapture ?? null,
              yearsOfHistory: data.tracker?.yearsOfHistory ?? null,
            };
          })(),
          force,
        };

        const res = await fetch("/api/client-report-analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Request failed (${res.status})`);
        }
        const { result } = (await res.json()) as { result: ClientReportAnalysis };
        setAnalysis(result);
      } catch (e) {
        setAnalysisError(
          e instanceof Error ? e.message : "Failed to generate analysis",
        );
      } finally {
        setAnalysisLoading(false);
      }
    },
    [data, clientResult, stocks, clientPositions, metricsOverrides, groupId, profile],
  );

  // ── Generate client presentation bullets ──
  // Contract with the PM: these are NEVER written off stale numbers. The
  // handler awaits a full `refetch()` (live positions, live prices, FX,
  // fund cache, performance history) and builds the payload from the
  // value that refetch resolves with — not from the `data` state, which
  // still holds the pre-refresh render's snapshot inside this closure.
  //
  // The server caches by payload hash, so re-clicking on unchanged
  // numbers costs nothing; `force` bypasses that for a reword.
  const generateBullets = useCallback(
    async (force = false) => {
      setBulletsLoading(true);
      setBulletsError(null);
      setBulletsCopied(false);
      try {
        const fresh = await refetch();
        if (!fresh) {
          setBulletsError(
            "Couldn't refresh live data — nothing generated. Try again.",
          );
          return;
        }
        const payload = buildBulletsPayload(
          fresh,
          clientPositions,
          stocks,
          metricsOverrides[`${groupId}::${profile}`] ?? {},
        );
        const res = await fetch("/api/client-report-bullets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, force }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Request failed (${res.status})`);
        }
        const { result } = (await res.json()) as { result: ClientReportBullets };
        setBullets({ ...result, fingerprint: fingerprintPayload(payload) });
      } catch (e) {
        setBulletsError(
          e instanceof Error ? e.message : "Failed to generate bullets",
        );
      } finally {
        setBulletsLoading(false);
      }
    },
    [refetch, clientPositions, stocks, metricsOverrides, groupId, profile],
  );

  // True when the report data has moved since the bullets were written
  // (a later "Refresh live data", a metrics override edit, a weight
  // change). Compares fingerprints rather than timestamps so a plain
  // page reload — which re-pulls identical numbers — doesn't nag.
  const bulletsStale = useMemo(() => {
    // A hand-written set (no AI run yet) has no fingerprint to compare.
    if (!bullets || !data || !bullets.fingerprint) return false;
    const current = fingerprintPayload(
      buildBulletsPayload(
        data,
        clientPositions,
        stocks,
        metricsOverrides[`${groupId}::${profile}`] ?? {},
      ),
    );
    return current !== bullets.fingerprint;
  }, [bullets, data, clientPositions, stocks, metricsOverrides, groupId, profile]);

  const copyBullets = useCallback(async () => {
    const lines = visibleBullets(bullets);
    if (!lines.length) return;
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setBulletsCopied(true);
      setTimeout(() => setBulletsCopied(false), 2000);
    } catch {
      setBulletsError("Clipboard unavailable — select the text below and copy manually.");
    }
  }, [bullets]);

  // Manual edits to the AI copy. Plain state updates, so the report below
  // re-renders on every keystroke; the existing debounced autosave above
  // persists them inside pm:client-portfolio.presentationBullets exactly
  // like a freshly generated set (same blob, same writer).
  const editBullet = useCallback((index: number, text: string) => {
    setBullets((prev) =>
      prev
        ? { ...prev, edited: true, bullets: prev.bullets.map((b, i) => (i === index ? text : b)) }
        : prev,
    );
  }, []);
  const removeBullet = useCallback((index: number) => {
    setBullets((prev) =>
      prev ? { ...prev, edited: true, bullets: prev.bullets.filter((_, i) => i !== index) } : prev,
    );
  }, []);
  const addBullet = useCallback(() => {
    setBullets((prev) =>
      prev
        ? { ...prev, edited: true, bullets: [...prev.bullets, ""] }
        : // Writing from scratch before any AI run: fingerprint left empty,
          // so the staleness banner stays quiet until a real generation.
          { bullets: [""], generatedAt: new Date().toISOString(), fingerprint: "", edited: true },
    );
  }, []);

  // Manager commentary was removed per PM request — it was almost
  // never used. The Redis blob at `pm:client-report-notes` is left
  // intact so any previously-written notes are preserved untouched
  // (read-merge-write-safe: we simply stop reading or writing it).

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  return (
    <div className="min-h-screen bg-slate-100">
      {/* Print CSS — scoped to this route so we don't interfere with
          any other dashboard page. Letter-sized, 0.4" margins. Any
          natural page break inside the one-pager falls at section
          boundaries because key panels are marked `break-inside-avoid`. */}
      <style jsx global>{`
        @media print {
          @page {
            size: ${layout === "landscape" ? "1280px 720px" : "letter"};
            margin: ${layout === "landscape" ? "0" : "0.4in"};
            /* Suppress the browser's default page-margin content
               (URL bottom-left, date top-right, page numbers, title).
               Chrome 121+ honors these @page margin pseudo-elements
               when they're set to empty content; older browsers
               ignore them harmlessly. If the URL still appears, the
               user can also uncheck 'Headers and footers' in the
               Chrome print dialog (More settings → Options) — that
               toggle is sticky once set. */
            @top-left     { content: ""; }
            @top-center   { content: ""; }
            @top-right    { content: ""; }
            @bottom-left  { content: ""; }
            @bottom-center{ content: ""; }
            @bottom-right { content: ""; }
          }
          html,
          body {
            background: #fff !important;
          }
          .report-preview-frame {
            box-shadow: none !important;
            margin: 0 !important;
            width: 100% !important;
          }
          /* Landscape: one 16:9 slide per printed page, at true size
             (1280×720 CSS px = 13.333in × 7.5in; sized in px so the
             page is exactly one slide, no rounding). The on-screen
             fit-to-window zoom is dropped for print. */
          .report-slide-deck {
            display: block !important;
            gap: 0 !important;
            padding: 0 !important;
          }
          /* A 13.333in page is wider than the md breakpoint, so the
             dashboard's 200px rail gutter would apply in print and push
             each slide off the page. The rail itself is print:hidden. */
          .report-slide-host,
          .app-content {
            padding: 0 !important;
            margin: 0 !important;
          }
          .report-slide-zoom {
            zoom: 1 !important;
            overflow: hidden;
          }
          .report-slide + .report-slide {
            break-before: page;
            page-break-before: always;
          }
          /* Blurred shadows rasterise as grey blocks in Chrome's PDF. */
          .report-slide-deck,
          .report-slide-deck * {
            box-shadow: none !important;
          }
          /* Force colored backgrounds (pie slices, sector bars, legend
             swatches) to render in the printed PDF. By default Chrome
             strips these to save ink — which washed out the sector bar
             colors and the pie-chart legend swatches. Apply inside and
             below the report frame so the sticky toolbar is unaffected. */
          .report-preview-frame,
          .report-preview-frame *,
          .report-slide-deck,
          .report-slide-deck * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
        }
      `}</style>

      {/* Screen-only toolbar. */}
      <div className="print:hidden sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur px-6 py-3 flex items-center gap-3 shadow-sm">
        <button
          onClick={() => router.back()}
          className="text-sm text-slate-600 hover:text-slate-800"
          aria-label="Back"
        >
          ← Back
        </button>
        <div className="text-sm font-semibold text-slate-800">Client Report Preview</div>
        {/* Model + profile pickers — the report used to inherit whatever
            Positioning last had selected; switch here without a round-trip.
            Only the URL changes, so a bookmark still carries the choice. */}
        <select
          value={groupId}
          onChange={(e) => router.replace(reportUrl({ group: e.target.value }))}
          className="h-7 rounded border border-slate-300 bg-white px-2 text-xs text-slate-800"
          aria-label="Model"
        >
          {pimModels.groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        <select
          value={profile}
          onChange={(e) => router.replace(reportUrl({ profile: e.target.value }))}
          className="h-7 rounded border border-slate-300 bg-white px-2 text-xs text-slate-800"
          aria-label="Profile"
        >
          {VALID_PROFILES.filter((p) => pimModels.groups.find((g) => g.id === groupId)?.profiles[p]).map((p) => (
            <option key={p} value={p}>{p === "allEquity" ? "All-Equity" : p[0].toUpperCase() + p.slice(1)}</option>
          ))}
        </select>
        {data && (
          <span
            className="text-[10px] rounded px-1.5 py-0.5 font-semibold uppercase tracking-wider"
            style={{
              backgroundColor: data.weightsSource === "live" ? "#dcfce7" : "#fef3c7",
              color: data.weightsSource === "live" ? "#166534" : "#854d0e",
            }}
            title={
              data.weightsSource === "live"
                ? "Weights derived from current positions × live prices."
                : "No saved positions — falling back to target model weights."
            }
          >
            {data.weightsSource === "live" ? "Live positions" : "Target weights"}
          </span>
        )}
        <div className="flex rounded border border-slate-300 overflow-hidden text-xs" role="group" aria-label="Layout">
          {(["portrait", "landscape"] as const).map((l) => (
            <button
              key={l}
              onClick={() => router.replace(reportUrl({ layout: l }))}
              className={`px-2.5 h-7 font-semibold ${
                layout === l ? "text-white" : "bg-white text-slate-600 hover:bg-slate-50"
              }`}
              style={layout === l ? { backgroundColor: RBC_NAVY } : undefined}
              title={
                l === "portrait"
                  ? "Letter-sized PDF one-pager"
                  : "16:9 slides sized for Prezi — screenshot each slide, or Generate PDF for one slide per page"
              }
            >
              {l === "portrait" ? "Portrait PDF" : "Landscape slides"}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button
          onClick={() => refetch()}
          disabled={loading}
          className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200 disabled:opacity-50"
        >
          {loading ? "Refreshing…" : "Refresh live data"}
        </button>
        <button
          onClick={handlePrint}
          disabled={!data || loading}
          className="rounded-lg px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          style={{ backgroundColor: RBC_NAVY }}
        >
          {layout === "landscape" ? "Generate slide PDF" : "Generate PDF"}
        </button>
      </div>

      {/* ── Client presentation bullets (screen only) ──
          Model-level talking points for a client deck. Sits above the
          comparison panel because it needs no client input — just the
          live model. The button re-pulls live data before generating,
          so the copy always matches the numbers on the PDF below. */}
      <div className="print:hidden max-w-4xl mx-auto mt-4 px-4">
        <div className="bg-white rounded-lg shadow border border-slate-200 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <div className="text-sm font-semibold text-slate-700">
                Client presentation bullets
              </div>
              <div className="text-[11px] text-slate-500">
                Refreshes live data first, then writes broad talking points —
                index exposure, diversification, cost, risk. No individual
                positions are named.
              </div>
            </div>
            {bullets && (
              <button
                onClick={() => copyBullets()}
                disabled={bulletsLoading}
                className="rounded bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200 disabled:opacity-50"
              >
                {bulletsCopied ? "Copied" : "Copy"}
              </button>
            )}
            {!bullets && (
              <button
                onClick={addBullet}
                className="rounded bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200"
              >
                Write manually
              </button>
            )}
            <button
              onClick={() => {
                if (
                  bullets?.edited &&
                  !window.confirm("Regenerating replaces your edited bullets with fresh AI copy. Continue?")
                ) {
                  return;
                }
                generateBullets(bullets != null);
              }}
              disabled={bulletsLoading || !!error}
              className="rounded-lg px-4 py-1.5 text-xs font-semibold !text-white disabled:opacity-50"
              style={{ backgroundColor: RBC_NAVY }}
            >
              {bulletsLoading
                ? "Refreshing & generating…"
                : bullets
                  ? "Refresh & regenerate"
                  : "Refresh & generate"}
            </button>
          </div>

          {bulletsError && (
            <div className="mt-2 text-xs text-rose-600">{bulletsError}</div>
          )}

          {bullets && bulletsStale && (
            <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
              The model numbers have changed since these bullets were written —
              regenerate before sending them to a client.
            </div>
          )}

          {bullets && (
            <div className="mt-3">
              {/* Editable in place — every keystroke flows straight to the
                  report below; autosave persists it. */}
              <ul className="space-y-1.5">
                {bullets.bullets.map((b, i) => (
                  <li key={i} className="group flex items-start gap-1.5">
                    <textarea
                      value={b}
                      onChange={(e) => editBullet(i, e.target.value)}
                      rows={2}
                      placeholder="Type a talking point…"
                      aria-label={`Bullet ${i + 1}`}
                      className="flex-1 resize-none rounded-sm border border-transparent bg-transparent py-0.5 pl-3 pr-1 text-[12px] leading-snug text-slate-700 hover:border-slate-200 focus:border-slate-300 focus:bg-slate-50 focus:outline-none"
                      style={{ borderLeft: `2px solid ${RBC_GOLD}`, fieldSizing: "content" } as React.CSSProperties}
                    />
                    <button
                      onClick={() => removeBullet(i)}
                      className="mt-0.5 px-1 text-sm text-slate-300 hover:text-rose-500"
                      title="Remove this bullet"
                      aria-label={`Remove bullet ${i + 1}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex items-center gap-3 text-[11px] text-slate-400">
                <button
                  onClick={addBullet}
                  className="font-semibold text-slate-500 hover:text-slate-800"
                >
                  + Add bullet
                </button>
                <span>
                  {bullets.fingerprint ? "Generated " : "Written "}
                  {new Date(bullets.generatedAt).toLocaleString("en-CA", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                  {bullets.edited && bullets.fingerprint ? " · edited" : ""}
                  . Click any bullet to edit — changes show on the report below.
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Client Portfolio Input (screen only) ── */}
      <div className="print:hidden max-w-4xl mx-auto my-4 px-4">
        <details className="bg-white rounded-lg shadow border border-slate-200">
          <summary className="px-4 py-3 cursor-pointer text-sm font-semibold text-slate-700 hover:text-slate-900 select-none">
            Client Portfolio Comparison
            {clientResult && (
              <span className="ml-2 text-xs font-normal text-emerald-600">
                (active — {clientResult.positions.length} positions)
              </span>
            )}
          </summary>
          <div className="px-4 pb-4 border-t border-slate-100 pt-3">
            {/* Client name was removed — client-identifying labels
                don't belong on personal devices. The comparison section
                now uses generic "Current" labels instead of a typed
                name. */}
            <div className="flex items-center gap-3 mb-3">
              <p className="text-xs text-slate-500 flex-1">
                Add the client&apos;s current holdings to generate a side-by-side comparison on the PDF.
              </p>
              {/* Input mode toggle */}
              <div className="flex rounded-md border border-slate-200 overflow-hidden text-xs">
                <button
                  onClick={() => setClientInputMode("units")}
                  className={`px-3 py-1 font-semibold transition-colors ${
                    clientInputMode === "units"
                      ? "bg-slate-700 text-white"
                      : "bg-white text-slate-500 hover:bg-slate-50"
                  }`}
                >
                  Units
                </button>
                <button
                  onClick={() => setClientInputMode("weight")}
                  className={`px-3 py-1 font-semibold transition-colors ${
                    clientInputMode === "weight"
                      ? "bg-slate-700 text-white"
                      : "bg-white text-slate-500 hover:bg-slate-50"
                  }`}
                >
                  Weight %
                </button>
              </div>
            </div>

            {/* Position rows */}
            <div className="space-y-2 mb-3">
              {clientPositions.map((pos) => (
                <div key={pos.id} className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="Ticker (e.g. AAPL)"
                    value={pos.ticker}
                    onChange={(e) =>
                      updatePosition(pos.id, "ticker", e.target.value)
                    }
                    onBlur={() => {
                      if (pos.ticker.trim() && !pos.name.trim()) {
                        fetchTickerName(pos.id, pos.ticker);
                      }
                    }}
                    className="w-32 rounded border border-slate-200 px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                  <input
                    type="text"
                    placeholder="Name (optional)"
                    value={pos.name}
                    onChange={(e) =>
                      updatePosition(pos.id, "name", e.target.value)
                    }
                    className="flex-1 rounded border border-slate-200 px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                  {clientInputMode === "units" ? (
                    <input
                      type="number"
                      placeholder="Units"
                      value={pos.units || ""}
                      onChange={(e) =>
                        updatePosition(
                          pos.id,
                          "units",
                          parseFloat(e.target.value) || 0
                        )
                      }
                      min={0}
                      step="any"
                      className="w-24 rounded border border-slate-200 px-2 py-1.5 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-blue-400"
                    />
                  ) : (
                    <input
                      type="number"
                      placeholder="Weight %"
                      value={pos.weight || ""}
                      onChange={(e) =>
                        updatePosition(
                          pos.id,
                          "weight",
                          parseFloat(e.target.value) || 0
                        )
                      }
                      min={0}
                      max={100}
                      step="any"
                      className="w-24 rounded border border-slate-200 px-2 py-1.5 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-blue-400"
                    />
                  )}
                  {/* Per-row MER input. Optional; individual stocks
                      should be left blank (treated as 0% management fee
                      by the blended-MER calc). ETFs and mutual funds
                      whose MER isn't auto-fetched on the Dashboard can
                      be typed here — this takes priority over whatever
                      the scraper found. */}
                  <input
                    type="number"
                    placeholder="MER %"
                    value={pos.mer ?? ""}
                    onChange={(e) => {
                      const raw = e.target.value;
                      if (raw === "") {
                        updatePosition(pos.id, "mer", undefined);
                        return;
                      }
                      const n = parseFloat(raw);
                      updatePosition(pos.id, "mer", Number.isFinite(n) ? n : undefined);
                    }}
                    min={0}
                    max={10}
                    step="0.01"
                    title="Optional MER (%) for ETFs / mutual funds. Blank = unknown (0 for direct equities)."
                    className="w-20 rounded border border-slate-200 px-2 py-1.5 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                  {/* Instrument type toggle (Stock / Fund). Auto-defaults
                      based on a Dashboard match by canonical ticker; the
                      PM can override per row for tickers not on the
                      Dashboard. Direct stocks contribute 0% MER with full
                      coverage in the blended-MER calc; funds require an
                      MER to count as covered. */}
                  {(() => {
                    const dash = stocks.find(
                      (s) => canonClientTicker(s.ticker) === canonClientTicker(pos.ticker),
                    );
                    const detected: "stock" | "fund" = dash
                      ? (dash.instrumentType === "stock" || !dash.instrumentType
                          ? "stock"
                          : "fund")
                      : typeof pos.mer === "number" && Number.isFinite(pos.mer) && pos.mer > 0
                      ? "fund"
                      : "stock";
                    const effective: "stock" | "fund" = pos.instrumentType ?? detected;
                    const isOverride = pos.instrumentType != null && pos.instrumentType !== detected;
                    return (
                      <div
                        className="flex rounded border border-slate-200 overflow-hidden text-[10px]"
                        title={
                          isOverride
                            ? "Type manually overridden. Click to clear override and auto-detect."
                            : dash
                            ? `Detected from Dashboard (${dash.instrumentType || "stock"}).`
                            : "Auto-detected: not on Dashboard, so assumed a direct stock (0% MER). Click Fund if this is an ETF/MF."
                        }
                      >
                        <button
                          type="button"
                          onClick={() =>
                            updatePosition(
                              pos.id,
                              "instrumentType",
                              // Clicking the already-effective side clears
                              // an explicit override; clicking the other
                              // side sets one.
                              effective === "stock"
                                ? pos.instrumentType === "stock"
                                  ? undefined
                                  : "stock"
                                : "stock",
                            )
                          }
                          className={`px-1.5 py-1.5 font-semibold transition-colors ${
                            effective === "stock"
                              ? "bg-slate-700 text-white"
                              : "bg-white text-slate-500 hover:bg-slate-50"
                          }`}
                        >
                          Stock
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            updatePosition(
                              pos.id,
                              "instrumentType",
                              effective === "fund"
                                ? pos.instrumentType === "fund"
                                  ? undefined
                                  : "fund"
                                : "fund",
                            )
                          }
                          className={`px-1.5 py-1.5 font-semibold transition-colors ${
                            effective === "fund"
                              ? "bg-indigo-600 text-white"
                              : "bg-white text-slate-500 hover:bg-slate-50"
                          }`}
                        >
                          Fund
                        </button>
                      </div>
                    );
                  })()}
                  <button
                    onClick={() => removePosition(pos.id)}
                    className="text-slate-400 hover:text-rose-500 text-sm px-1"
                    title="Remove"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>

            {/* Cash input + action buttons */}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={addPosition}
                className="rounded bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200"
              >
                + Add Position
              </button>
              <button
                onClick={clearAllPositions}
                disabled={clientPositions.length === 0}
                className="rounded border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300 disabled:hover:bg-white"
                title="Remove every client-side holding in one shot (asks to confirm first)"
              >
                Clear All
              </button>
              <div className="flex items-center gap-1.5">
                <label className="text-xs text-slate-500">
                  Cash {clientInputMode === "units" ? "($)" : "(%)"}:
                </label>
                <input
                  type="number"
                  value={clientCash || ""}
                  onChange={(e) =>
                    setClientCash(parseFloat(e.target.value) || 0)
                  }
                  min={0}
                  step="any"
                  placeholder="0"
                  className="w-28 rounded border border-slate-200 px-2 py-1.5 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
              </div>
              <div
                className="flex items-center gap-1.5"
                title="Optional: a fixed-income placeholder so you don't have to type every bond fund. Folds into the Fixed Income allocation bucket alongside any bond holdings classified from your ticker list."
              >
                <label className="text-xs text-slate-500">
                  Fixed Income {clientInputMode === "units" ? "($)" : "(%)"}:
                </label>
                <input
                  type="number"
                  value={clientFixedIncome || ""}
                  onChange={(e) =>
                    setClientFixedIncome(parseFloat(e.target.value) || 0)
                  }
                  min={0}
                  step="any"
                  placeholder="0"
                  className="w-28 rounded border border-slate-200 px-2 py-1.5 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
              </div>
              {clientInputMode === "weight" && (
                <div
                  className="flex items-center gap-1.5"
                  title="Optional: total portfolio value in dollars. Used only to estimate fee savings in dollar terms — does not affect the position weights you typed above."
                >
                  <label className="text-xs text-slate-500">
                    Portfolio Value ($):
                  </label>
                  <input
                    type="number"
                    value={clientManualTotalValue || ""}
                    onChange={(e) =>
                      setClientManualTotalValue(parseFloat(e.target.value) || 0)
                    }
                    min={0}
                    step="any"
                    placeholder="optional"
                    className="w-32 rounded border border-slate-200 px-2 py-1.5 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                </div>
              )}
              <div className="flex-1" />
              {clientResult && (
                <button
                  onClick={() => {
                    setClientResult(null);
                    setShowComparison(false);
                  }}
                  className="rounded bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-200"
                >
                  Clear Comparison
                </button>
              )}
              <button
                onClick={computeClientPortfolio}
                disabled={clientLoading}
                className="rounded-lg px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                style={{ backgroundColor: RBC_NAVY }}
              >
                {clientLoading ? "Computing…" : "Analyze"}
              </button>
            </div>

            {clientError && (
              <div className="mt-2 text-xs text-rose-600">{clientError}</div>
            )}
            {clientResult && (
              <div className="mt-2 text-xs text-emerald-600">
                Portfolio analyzed: {clientResult.positions.length} positions
                {clientResult.totalValue > 0 &&
                  `, total value $${clientResult.totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                , {clientResult.xray.length} underlying stock exposures via look-through.
                Comparison will appear on the PDF.
              </div>
            )}

            {/* Unresolved-funds override panel. Surfaces any funds the
                look-through couldn't auto-resolve (Yahoo doesn't have
                holdings for them). The PM can paste a holdings URL —
                fund factsheet, Morningstar holdings page, an iShares
                CSV, etc. — and we'll scrape it via /api/fund-data and
                cache the result in pm:fund-data-cache. Future
                computations use the cached data automatically.
                Mirrors the URL-paste workflow on individual stock
                pages for ETFs without auto-resolved holdings. */}
            {clientResult?.unresolvedFunds && clientResult.unresolvedFunds.length > 0 && (
              <UnresolvedFundsPanel
                funds={clientResult.unresolvedFunds}
                onCachedAndRecompute={async () => {
                  // Recompute the comparison so the newly-cached
                  // holdings flow into the look-through. The fund-info
                  // memoization inside expandClient is per-call, so a
                  // fresh compute picks up the cache change.
                  await computeClientPortfolio();
                }}
              />
            )}

            {/* AI-generated analysis controls. Requires clientResult to
                exist (we need the look-through holdings to send to the
                model). "Regenerate" forces a fresh Anthropic call even
                when the payload hash matches the cached result — useful
                if the output wasn't what you wanted. */}
            {clientResult && (
              <div className="mt-4 pt-3 border-t border-slate-100">
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <div className="text-xs font-semibold text-slate-700">
                      AI-generated analysis
                    </div>
                    <div className="text-[11px] text-slate-500">
                      Bullet-form pros/cons, action items, and long-term summary for the PDF.
                    </div>
                  </div>
                  {analysis && (
                    <button
                      onClick={() => generateAnalysis(true)}
                      disabled={analysisLoading}
                      className="rounded bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200 disabled:opacity-50"
                    >
                      Regenerate
                    </button>
                  )}
                  <button
                    onClick={() => generateAnalysis(false)}
                    disabled={analysisLoading}
                    className="rounded-lg px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                    style={{ backgroundColor: RBC_NAVY }}
                  >
                    {analysisLoading
                      ? "Generating…"
                      : analysis
                        ? "Regenerated"
                        : "Generate analysis"}
                  </button>
                </div>
                {analysisError && (
                  <div className="mt-2 text-xs text-rose-600">{analysisError}</div>
                )}
                {analysis && (
                  <div className="mt-2 text-[11px] text-slate-400">
                    Generated{" "}
                    {new Date(analysis.generatedAt).toLocaleString("en-CA", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                    . Will render on the PDF below.
                  </div>
                )}
              </div>
            )}
          </div>
        </details>
      </div>

      {/* Landscape: 16:9 slides for Prezi. */}
      {layout === "landscape" && (
        <SlideDeck
          data={data}
          loading={loading}
          error={error}
          onRetry={() => refetch()}
          clientPortfolio={showComparison ? clientResult : null}
          analysis={showComparison ? analysis : null}
          bullets={bullets}
          merBreakdown={
            data
              ? buildMerBreakdown(showComparison ? clientResult : null, data, clientPositions, stocks)
              : null
          }
          metricsOverride={metricsOverrides[`${groupId}::${profile}`] ?? {}}
        />
      )}

      {/* Letter-sized frame. */}
      {layout === "portrait" && (
      <div
        className="report-preview-frame mx-auto my-6 shadow-lg print:shadow-none print:my-0"
        style={{ width: "8.5in", minHeight: "11in", backgroundColor: THEME.cream }}
      >
        {loading && !data && (
          <div className="p-12 text-center text-slate-500 text-sm">Loading live data…</div>
        )}
        {error && (
          <div className="p-12 text-center text-rose-600 text-sm">
            {error}.{" "}
            <button onClick={() => refetch()} className="underline">
              Try again
            </button>
            .
          </div>
        )}
        {data && (
          <OnePager
            data={data}
            clientPortfolio={showComparison ? clientResult : null}
            analysis={showComparison ? analysis : null}
            bullets={bullets}
            merBreakdown={buildMerBreakdown(
              // Model side always renders; client side only when the PM
              // has run Analyze and toggled the comparison on.
              showComparison ? clientResult : null,
              data,
              clientPositions,
              stocks,
            )}
            metricsOverride={metricsOverrides[`${groupId}::${profile}`] ?? {}}
            onMetricsOverrideChange={(next) =>
              setMetricsOverrides((prev) => ({
                ...prev,
                [`${groupId}::${profile}`]: next,
              }))
            }
          />
        )}
      </div>
      )}
    </div>
  );
}

// ───────── Report body ─────────

function OnePager({
  data,
  clientPortfolio,
  analysis,
  bullets,
  merBreakdown,
  metricsOverride,
  onMetricsOverrideChange,
}: {
  data: ReportData;
  clientPortfolio: ClientPortfolioResult | null;
  analysis: ClientReportAnalysis | null;
  bullets: StoredBullets | null;
  merBreakdown: MerBreakdown | null;
  metricsOverride: MetricsOverride;
  onMetricsOverrideChange: (next: MetricsOverride) => void;
}) {
  // Client-identifying labels are intentionally absent; the comparison
  // section titles read "Current …" so the PDF can be rendered without
  // any name information on the device.
  const dateStr = useMemo(
    () =>
      new Date(data.generatedAt).toLocaleDateString("en-CA", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
    [data.generatedAt]
  );

  return (
    <div
      className="p-6"
      style={{ fontFamily: SANS, color: THEME.ink }}
    >
      {/* ── Header ── */}
      <ReportMasthead
        lead={`${data.profileLabel} Model,`}
        accent="Current Positioning"
        dateStr={dateStr}
        profileLabel={data.profileLabel}
      />

      {/* ── Row 1: Holdings table + Allocation pie ── */}
      <div className="grid grid-cols-5 gap-5 mt-4 break-inside-avoid">
        <div className="col-span-3">
          <SectionTitle>Current Positioning</SectionTitle>
          <HoldingsTable rows={data.xray.slice(0, 10)} />
          <div className="mt-1 text-[9px] flex justify-between" style={{ color: THEME.muted }}>
            <span>
              CAD: {data.totals.cad.toFixed(1)}% · USD: {data.totals.usd.toFixed(1)}%
            </span>
            <span>
              {data.weightsSource === "live"
                ? "Weights reflect current positions × live prices (equity look-through)."
                : "No positions saved — showing target model weights (equity look-through)."}
            </span>
          </div>
        </div>
        <div className="col-span-2">
          <SectionTitle>Asset Allocation</SectionTitle>
          <AllocationPie slices={data.allocation} />
        </div>
      </div>

      {/* ── Row 2: Performance tracker chart + yearly returns ── */}
      <div className="mt-4 break-inside-avoid">
        <div className="flex items-baseline justify-between">
          <SectionTitle>Model Performance (Since Inception)</SectionTitle>
          {data.tracker?.sinceInceptionReturnPct != null && (
            <span className="text-[10px] font-semibold tabular-nums" style={{ color: THEME.navy }}>
              Cumulative: {fmtPctSigned(data.tracker.sinceInceptionReturnPct, 2)}
            </span>
          )}
        </div>
        {data.tracker ? (
          <div className="grid grid-cols-5 gap-4 mt-2">
            <div className="col-span-3">
              <PerformanceChart tracker={data.tracker} />
              {data.tracker.annualizedReturnPct != null && (
                <div className="mt-1 text-center text-[11px]" style={{ color: THEME.ink }}>
                  Annualized Return:{" "}
                  <span
                    className="font-bold tabular-nums"
                    style={{
                      color:
                        data.tracker.annualizedReturnPct >= 0
                          ? THEME.positive
                          : THEME.negative,
                    }}
                  >
                    {fmtPctSigned(data.tracker.annualizedReturnPct, 2)}
                  </span>
                  {data.tracker.yearsOfHistory != null && (
                    <span className="text-slate-400">
                      {" "}
                      · {data.tracker.yearsOfHistory.toFixed(1)}y history
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="col-span-2">
              <YearlyReturnsTable tracker={data.tracker} />
            </div>
          </div>
        ) : (
          <div className="text-[10px] text-slate-400 italic mt-2">
            No performance tracker history yet — seed the model in the Performance tab to
            populate this section.
          </div>
        )}
      </div>

      {/* ── Row 3: X-ray + Sectors ── */}
      <div className="grid grid-cols-2 gap-5 mt-4 break-inside-avoid">
        <div>
          <SectionTitle>Top Exposures (Look-Through)</SectionTitle>
          <XRayTable rows={data.xray.slice(0, 10)} />
          {!data.xray.length && (
            <div className="text-[10px] text-slate-400 italic mt-2">
              Look-through exposures populate once fund-data holdings have been cached.
            </div>
          )}
        </div>
        <div>
          <SectionTitle>Top Sector Exposures</SectionTitle>
          <BarList
            rows={data.sectors.slice(0, 8).map((s, i) => ({
              label: s.sector,
              value: s.weight,
              color: SECTOR_RAMP[i] ?? colorForSector(s.sector),
              tooltip: `${s.sector}: ${s.weight.toFixed(2)}% of equity exposure (post-look-through)`,
            }))}
            accent={RBC_GOLD}
            textColor={RBC_NAVY}
            // Compress the visual range so Materials at ~4% doesn't get
            // dwarfed by Technology at ~27%. The numeric labels on the
            // right stay exact; only the bar lengths are re-scaled.
            scale="sqrt"
            minBarPct={12}
          />
          {!data.sectors.length && (
            <div className="text-[10px] text-slate-400 italic mt-2">
              Sector data will populate once look-through fund data is cached for this
              model&apos;s ETFs.
            </div>
          )}
        </div>
      </div>

      {/* ── Risk metrics strip ──
          Four stats, each with a small inline override input so the PM
          can replace the auto-computed number if the model tracker is
          too short or the scrape looks wrong. Auto values come from
          `data.performance` (tracker-based when available, 5Y synthetic
          otherwise). Overrides are persisted per (group, profile) in
          `pm:client-portfolio.metricsOverrides`. */}
      <div className="mt-4 break-inside-avoid">
        <SectionTitle>
          Risk Profile vs S&amp;P 500 (since inception)
        </SectionTitle>
        <div className="mt-2 grid grid-cols-4 gap-2 text-[11px]">
          <OverridableStat
            label="Std Dev — Portfolio (ann.)"
            auto={data.performance.volatility}
            override={metricsOverride.stdDev}
            fraction
            onChange={(v) =>
              onMetricsOverrideChange({ ...metricsOverride, stdDev: v })
            }
          />
          <OverridableStat
            label="Std Dev — S&P 500 (ann.)"
            auto={data.performance.benchmarkVolatility}
            override={metricsOverride.benchmarkStdDev}
            fraction
            onChange={(v) =>
              onMetricsOverrideChange({
                ...metricsOverride,
                benchmarkStdDev: v,
              })
            }
          />
          <OverridableStat
            label="Upside Capture"
            auto={data.performance.upsideCapture}
            override={metricsOverride.upsideCapture}
            onChange={(v) =>
              onMetricsOverrideChange({ ...metricsOverride, upsideCapture: v })
            }
          />
          <OverridableStat
            label="Downside Capture"
            auto={data.performance.downsideCapture}
            override={metricsOverride.downsideCapture}
            onChange={(v) =>
              onMetricsOverrideChange({
                ...metricsOverride,
                downsideCapture: v,
              })
            }
          />
        </div>
      </div>

      {/* ── Portfolio highlights ──
          AI-written, model-level talking points. Only renders once the
          PM has generated them, so the PDF layout is unchanged for
          anyone who never clicks the button. Deliberately free of
          individual position names — see /api/client-report-bullets. */}
      {visibleBullets(bullets).length > 0 && (
        <div className="mt-4 break-inside-avoid">
          <SectionTitle>Portfolio Highlights</SectionTitle>
          <ul className="mt-2 space-y-1.5">
            {visibleBullets(bullets).map((b, i) => (
              <li key={i} className="flex gap-2 text-[11px] leading-snug text-slate-700">
                <span
                  className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: RBC_GOLD }}
                />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Manager Commentary section removed — almost never used in
          practice, per the PM. The persisted notes blob is left intact. */}

      {/* ── Client Portfolio Comparison (only when active) ── */}
      {clientPortfolio && (
        <div className="mt-6 break-inside-avoid">
          <PageHeading
            eyebrow={`Current holdings vs ${data.profileLabel} Model`}
            title="Portfolio"
            accent="Comparison"
          />

          {/* Side-by-side allocation pies */}
          <div className="grid grid-cols-2 gap-5 break-inside-avoid">
            <div>
              <SectionTitle>Current Asset Allocation</SectionTitle>
              <AllocationPie slices={clientPortfolio.allocation} />
            </div>
            <div>
              <SectionTitle>{data.profileLabel} — Asset Allocation</SectionTitle>
              <AllocationPie slices={data.allocation} />
            </div>
          </div>

          {/* Side-by-side top holdings (look-through) */}
          <div className="grid grid-cols-2 gap-5 mt-4 break-inside-avoid">
            <div>
              <SectionTitle>Current Top Holdings (Look-Through)</SectionTitle>
              <SimpleHoldingsTable
                rows={clientPortfolio.xray.slice(0, 10).map((r) => ({
                  name: r.name || r.symbol,
                  ticker: r.symbol,
                  weight: r.weight,
                }))}
                cashWeight={clientPortfolio.cashWeight}
              />
            </div>
            <div>
              <SectionTitle>{data.profileLabel} — Top Holdings (Look-Through)</SectionTitle>
              <SimpleHoldingsTable
                rows={data.xray.slice(0, 10).map((r) => ({
                  name: r.name || r.symbol,
                  ticker: r.symbol,
                  weight: r.weight,
                }))}
              />
            </div>
          </div>

          {/* Fee-savings tile — rendered whenever we have a portfolio
              dollar value (unit-mode auto-fills from live prices,
              weight-mode pulls from the PM-typed "Portfolio Value"
              field) and the model's blended MER is meaningfully lower
              than the client's. Independent of AI analysis so the PDF
              always carries a concrete dollar anchor when the math
              supports it. */}
          {merBreakdown?.client != null && (
            <FeeSavingsTile
              clientMer={merBreakdown.client.blended}
              modelMer={merBreakdown.model.blended}
              portfolioValueUsd={clientPortfolio.totalValue}
              profileLabel={data.profileLabel}
            />
          )}

          {/* AI-generated analysis: only rendered when it exists so the
              PDF layout stays clean when the user hasn't clicked
              "Generate analysis" yet. Three stacked bullet sections:
              pros/cons of current position, recommended action items,
              and long-term summary. Each section is break-inside-avoid
              so the Chrome print engine doesn't split a bullet list
              across pages mid-list. */}
          {analysis && (
            <AnalysisSections
              analysis={analysis}
              profileLabel={data.profileLabel}
            />
          )}
        </div>
      )}

      {/* ── Allocation breakdown (new page) ──
          Shows exactly which holdings feed into each slice of the Asset
          Allocation pie. Added because Core ETFs were visually dominating
          the pie and the prospect couldn't see what was inside that slice. */}
      {data.allocationBreakdown.length > 0 && (
        <div
          className="relative z-10 mt-8 pt-6"
          style={{ breakBefore: "page", pageBreakBefore: "always", backgroundColor: THEME.cream }}
        >
          <PageHeading
            eyebrow="Each holding's contribution to the Asset Allocation categories (post look-through)"
            title="Asset Allocation,"
            accent="Holdings Breakdown"
          />
          <AllocationBreakdownTables breakdown={data.allocationBreakdown} />
        </div>
      )}

      {/* ── Blended MER — Contributors (new page) ──
          Shows every holding with its weight, MER source, and contribution
          to the blended number. The model-side table ALWAYS renders once
          report data is loaded — the PM shouldn't have to run a client
          comparison to audit our own portfolio's fees. The client-side
          table only appears when a comparison is active (same data that
          feeds the comparison page's blended-MER tiles). */}
      {merBreakdown && (
        <div
          className="relative z-10 mt-8 pt-6"
          style={{ breakBefore: "page", pageBreakBefore: "always", backgroundColor: THEME.cream }}
        >
          <div className="mb-4">
            <PageHeading
              eyebrow="Per-holding breakdown of the blended management fee"
              title="Blended MER,"
              accent="Contributors"
              flush
            />
            <div className="text-[10px] mt-1" style={{ color: THEME.muted }}>
              Per-holding breakdown of the blended management-fee calculation.
              Contribution = Weight × MER ÷ 100 (percentage points of blended MER).
              Stocks contribute 0 pp with full coverage; fund rows without an
              MER are excluded from both the numerator and the denominator.
            </div>
          </div>
          {/* Stacked full-width rather than side-by-side. At letter-width
              with 6 columns per table, a two-column grid crammed the
              Contribution and Source cells (the left table's Contrib
              column was getting clipped). Each table is
              break-inside-avoid so one table doesn't straddle a page
              break mid-rows. */}
          <div className="grid grid-cols-1 gap-5">
            {merBreakdown.client && (
              <MerContributorsTable
                title="Current Portfolio"
                rows={merBreakdown.client.rows}
                blended={merBreakdown.client.blended}
                coveragePct={merBreakdown.client.coveragePct}
                accent={RBC_NAVY}
              />
            )}
            <MerContributorsTable
              title={`${data.profileLabel} Model`}
              rows={merBreakdown.model.rows}
              blended={merBreakdown.model.blended}
              coveragePct={merBreakdown.model.coveragePct}
              accent={THEME.positive}
            />
          </div>
        </div>
      )}

      {/* ── Footer ── */}
      <div
        className="mt-4 pt-2 border-t text-[9px] flex justify-between"
        style={{ borderColor: RBC_GOLD, color: THEME.muted }}
      >
        <span>
          <span className="font-semibold tracking-[0.18em] uppercase" style={{ color: THEME.navy }}>
            Di Iorio Family Wealth
          </span>
          <span className="mx-1.5" style={{ color: THEME.gold }}>|</span>
          <span className="tracking-[0.18em] uppercase">RBC Dominion Securities</span>
          <span className="ml-2">For client presentation purposes only.</span>
        </span>
        <span>
          Generated{" "}
          {new Date(data.generatedAt).toLocaleTimeString("en-CA", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>
    </div>
  );
}

// ───────── Landscape slides (Prezi) ─────────
//
// Each slide is a fixed 1280×720 canvas (16:9, = 13.333in × 7.5in at
// 96dpi) so one screenshot — or one page of the printed landscape PDF —
// drops straight into a Prezi frame. On screen the canvas is CSS-zoomed
// to fit the window (zoom re-lays out at device resolution, so text
// stays crisp in a screenshot); print resets the zoom to 1.
//
// Read-only by construction: no inputs render on a slide (the Risk
// Profile overrides are edited in Portrait and simply displayed here).

const SLIDE_W = 1280;
const SLIDE_H = 720;

function SlideDeck({
  data,
  loading,
  error,
  onRetry,
  clientPortfolio,
  analysis,
  bullets,
  merBreakdown,
  metricsOverride,
}: {
  data: ReportData | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  clientPortfolio: ClientPortfolioResult | null;
  analysis: ClientReportAnalysis | null;
  bullets: StoredBullets | null;
  merBreakdown: MerBreakdown | null;
  metricsOverride: MetricsOverride;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  // Set by slide 1 when the highlights don't fit even at the smallest
  // type size — surfaced above the deck (screen only) so a clipped
  // bullet never ends up in a client screenshot unnoticed.
  const [highlightsOverflow, setHighlightsOverflow] = useState(false);

  // Fit each slide inside the visible window (width AND height) so a
  // single slide is always fully on screen for a one-shot screenshot.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const fit = () => {
      const availW = el.clientWidth - 48;
      const availH = window.innerHeight - 64 - 40; // sticky toolbar + breathing room
      const next = Math.min(availW / SLIDE_W, availH / SLIDE_H);
      setScale(Math.max(0.35, Math.min(1.6, Number.isFinite(next) ? next : 1)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);

  const dateStr = data
    ? new Date(data.generatedAt).toLocaleDateString("en-CA", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "";

  const slides: React.ReactNode[] = [];
  if (data) {
    slides.push(
      <OverviewSlide
        key="overview"
        data={data}
        dateStr={dateStr}
        metricsOverride={metricsOverride}
        bullets={bullets}
        onHighlightsOverflow={setHighlightsOverflow}
      />,
    );
    slides.push(<LookThroughSlide key="lookthrough" data={data} dateStr={dateStr} />);
    if (clientPortfolio) {
      slides.push(
        <ComparisonSlide
          key="comparison"
          data={data}
          dateStr={dateStr}
          clientPortfolio={clientPortfolio}
          merBreakdown={merBreakdown}
        />,
      );
      if (analysis) {
        slides.push(
          <RecommendationsSlide key="recs" data={data} dateStr={dateStr} analysis={analysis} />,
        );
      }
    }
  }

  return (
    <div ref={hostRef} className="report-slide-host px-6">
      <div className="print:hidden mx-auto my-3 max-w-4xl text-[11px] text-slate-500 text-center">
        {slides.length > 0 && `${slides.length} slide${slides.length === 1 ? "" : "s"} · `}16:9 (1280×720). Screenshot a
        slide straight into Prezi, or use <span className="font-semibold">Generate slide PDF</span> for
        one slide per page. The holdings-breakdown and MER audit pages stay in Portrait PDF.
      </div>
      {highlightsOverflow && visibleBullets(bullets).length > 0 && (
        <div className="print:hidden mx-auto mb-3 max-w-4xl rounded border border-amber-300 bg-amber-50 px-3 py-1.5 text-center text-[11px] text-amber-800">
          The portfolio highlights are too long to fit on slide 1 — shorten or remove a bullet above.
        </div>
      )}
      {loading && !data && (
        <div className="p-12 text-center text-slate-500 text-sm">Loading live data…</div>
      )}
      {error && (
        <div className="p-12 text-center text-rose-600 text-sm">
          {error}.{" "}
          <button onClick={onRetry} className="underline">
            Try again
          </button>
          .
        </div>
      )}
      <div className="report-slide-deck flex flex-col items-center gap-10 pb-10">
        {slides.map((slide, i) => (
          <div
            key={i}
            className="report-slide report-slide-zoom shadow-xl"
            style={{ zoom: scale, width: SLIDE_W, height: SLIDE_H }}
          >
            {slide}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 1280×720 canvas: cream paper, masthead, body, firm footer. */
function SlideFrame({
  lead,
  accent,
  dateStr,
  profileLabel,
  children,
}: {
  lead: string;
  accent: string;
  dateStr: string;
  profileLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="relative flex flex-col overflow-hidden"
      style={{
        width: SLIDE_W,
        height: SLIDE_H,
        backgroundColor: THEME.cream,
        fontFamily: SANS,
        color: THEME.ink,
        padding: "30px 56px 0",
      }}
    >
      <ReportMasthead lead={lead} accent={accent} dateStr={dateStr} profileLabel={profileLabel} size="slide" />
      <div className="flex-1 min-h-0" style={{ marginTop: 18 }}>
        {children}
      </div>
      <div
        className="flex items-center justify-between"
        style={{ height: 42, borderTop: `1px solid ${THEME.rule}`, marginTop: 14 }}
      >
        <span className="uppercase" style={{ fontSize: 11, letterSpacing: "0.22em", color: THEME.navy }}>
          <span className="font-semibold">Di Iorio Family Wealth</span>
          <span style={{ color: THEME.gold, margin: "0 10px" }}>|</span>
          RBC Dominion Securities
        </span>
        <span style={{ fontSize: 10.5, color: "#3D6AA3" }}>
          For client presentation purposes only. Past performance is not indicative of future results.
        </span>
      </div>
    </div>
  );
}

type CardTone = "cream" | "sky" | "navy" | "gold";

/** One "layer" from the investment-approach slide. */
function SlideCard({
  tone,
  num,
  eyebrow,
  right,
  children,
  className = "",
  style,
}: {
  tone: CardTone;
  num?: string;
  eyebrow: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const bg =
    tone === "navy"
      ? `linear-gradient(135deg, ${THEME.navy} 0%, ${THEME.navyDeep} 100%)`
      : tone === "gold"
        ? `linear-gradient(135deg, #E6C07C 0%, ${THEME.goldBand} 55%, #CFA052 100%)`
        : tone === "sky"
          ? `linear-gradient(135deg, #E4EDF6 0%, ${THEME.skyDeep} 100%)`
          : THEME.card;
  const border = tone === "cream" ? THEME.goldBand : tone === "sky" ? "#B3C8E0" : "transparent";
  const eyebrowColor = tone === "navy" ? THEME.goldBand : tone === "gold" ? THEME.navy : THEME.gold;
  return (
    <div
      className={`rounded-[3px] flex flex-col min-h-0 min-w-0 ${className}`}
      style={{
        background: bg,
        border: `1px solid ${border}`,
        boxShadow: "0 8px 18px -12px rgba(10,42,80,0.45)",
        padding: "16px 20px",
        color: tone === "navy" ? "#fff" : THEME.ink,
        ...style,
      }}
    >
      <div className="flex items-baseline justify-between gap-3" style={{ marginBottom: 10 }}>
        <div className="flex items-baseline gap-2.5 min-w-0">
          {num && (
            <span
              style={{
                fontFamily: SERIF,
                fontSize: 22,
                lineHeight: 1,
                color: tone === "navy" ? THEME.goldBand : tone === "gold" ? THEME.navy : THEME.gold,
              }}
            >
              {num}
            </span>
          )}
          <span
            className="uppercase truncate"
            style={{ fontSize: 11.5, letterSpacing: "0.2em", color: eyebrowColor, fontWeight: 600 }}
          >
            {eyebrow}
          </span>
        </div>
        {right}
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

function SlideHoldingRows({
  rows,
  fontSize = 13.5,
  rowH = 23,
  cashWeight,
}: {
  rows: { name: string; symbol: string; weight: number }[];
  fontSize?: number;
  rowH?: number;
  cashWeight?: number;
}) {
  if (!rows.length) {
    return <div style={{ fontSize: 12, color: THEME.muted, fontStyle: "italic" }}>No holdings available.</div>;
  }
  const max = Math.max(...rows.map((r) => r.weight), 0.01);
  return (
    <div>
      {rows.map((r, i) => (
        <div
          key={`${r.symbol}-${i}`}
          className="flex items-center gap-3"
          style={{ height: rowH, fontSize, borderTop: i ? `1px solid ${THEME.rule}` : undefined }}
        >
          <span className="tabular-nums" style={{ width: 18, color: THEME.gold, fontSize: fontSize - 2 }}>
            {i + 1}
          </span>
          <span className="flex-1 min-w-0 truncate" style={{ color: THEME.navy }}>
            {formatCompanyName(r.name) || r.symbol}
            {r.symbol && r.symbol !== r.name && (
              <span style={{ marginLeft: 6, fontSize: fontSize - 3.5, color: THEME.muted }}>{r.symbol}</span>
            )}
          </span>
          <span className="block rounded-full" style={{ width: 56, height: 4, backgroundColor: "rgba(10,42,80,0.08)" }}>
            <span
              className="block h-full rounded-full"
              style={{ width: `${Math.max(6, (r.weight / max) * 100)}%`, backgroundColor: THEME.goldBand }}
            />
          </span>
          <span className="tabular-nums font-semibold text-right" style={{ width: 54, color: THEME.navy }}>
            {r.weight.toFixed(2)}%
          </span>
        </div>
      ))}
      {cashWeight != null && cashWeight > 0.05 && (
        <div
          className="flex items-center gap-3"
          style={{ height: rowH, fontSize, borderTop: `1px solid ${THEME.rule}`, color: THEME.muted }}
        >
          <span style={{ width: 18 }} />
          <span className="flex-1 italic">Cash</span>
          <span className="tabular-nums font-semibold text-right" style={{ width: 54 }}>
            {cashWeight.toFixed(2)}%
          </span>
        </div>
      )}
    </div>
  );
}

function SlideStat({
  label,
  value,
  tone = "light",
  size = 30,
}: {
  label: string;
  value: string;
  tone?: "light" | "dark";
  size?: number;
}) {
  return (
    <div>
      <div
        className="uppercase"
        style={{
          fontSize: 10.5,
          letterSpacing: "0.16em",
          color: tone === "dark" ? "rgba(255,255,255,0.72)" : THEME.navy,
          opacity: tone === "dark" ? 1 : 0.8,
        }}
      >
        {label}
      </div>
      <div
        className="tabular-nums"
        style={{
          fontFamily: SERIF,
          fontSize: size,
          lineHeight: 1.15,
          fontWeight: 600,
          color: tone === "dark" ? "#fff" : THEME.navy,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function SlideBullets({
  bullets,
  accent,
  fontSize = 14,
  tone = "light",
}: {
  bullets: string[];
  accent: string;
  /** px; null = inherit from the parent (used by AutoFitBullets). */
  fontSize?: number | null;
  tone?: "light" | "dark";
}) {
  if (!bullets.length) {
    return <div style={{ fontSize: 12, color: THEME.muted, fontStyle: "italic" }}>No items available.</div>;
  }
  return (
    <ul className={fontSize == null ? "space-y-[0.55em]" : "space-y-2.5"}>
      {bullets.map((b, i) => (
        <li
          key={i}
          className="flex gap-2.5"
          style={{ fontSize: fontSize ?? "inherit", lineHeight: fontSize == null ? 1.35 : 1.4, color: tone === "dark" ? "rgba(255,255,255,0.92)" : THEME.ink }}
        >
          <span
            aria-hidden
            className="block shrink-0 rounded-full"
            style={{ width: 6, height: 6, marginTop: "0.5em", backgroundColor: accent }}
          />
          <span>{b}</span>
        </li>
      ))}
    </ul>
  );
}

function fmtStat(v: number | null | undefined, fraction: boolean): string {
  if (v == null || !Number.isFinite(v)) return "N/A";
  return `${(fraction ? v * 100 : v).toFixed(1)}%`;
}

/** Shrinks its bullet text (down to `min` px) until it fits the box —
 *  hand-edited highlights can be any length and must never spill off
 *  a slide. Re-measures synchronously whenever the text changes. */
function AutoFitBullets({
  bullets,
  accent,
  tone,
  max = 15,
  min = 10.5,
  onOverflow,
}: {
  bullets: string[];
  accent: string;
  tone: "light" | "dark";
  max?: number;
  min?: number;
  /** Reports whether the text still overflows at `min` (too long to fit). */
  onOverflow?: (overflowing: boolean) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const key = bullets.join("\u0000");
  useLayoutEffect(() => {
    const box = boxRef.current;
    const inner = innerRef.current;
    if (!box || !inner) return;
    let size = max;
    inner.style.fontSize = `${size}px`;
    while (size > min && inner.scrollHeight > box.clientHeight + 1) {
      size = Math.max(min, size - 0.5);
      inner.style.fontSize = `${size}px`;
    }
    onOverflow?.(inner.scrollHeight > box.clientHeight + 1);
  }, [key, max, min, onOverflow]);
  return (
    <div ref={boxRef} className="h-full overflow-hidden">
      <div ref={innerRef} style={{ fontSize: max }}>
        <SlideBullets bullets={bullets} accent={accent} fontSize={null} tone={tone} />
      </div>
    </div>
  );
}

/** Slide 1 — the whole one-pager story on one 16:9 canvas, including the
 *  portfolio highlights (the slide usually shown on its own). */
function OverviewSlide({
  data,
  dateStr,
  metricsOverride,
  bullets,
  onHighlightsOverflow,
}: {
  data: ReportData;
  dateStr: string;
  metricsOverride: MetricsOverride;
  bullets: StoredBullets | null;
  onHighlightsOverflow?: (overflowing: boolean) => void;
}) {
  const t = data.tracker;
  const perf = data.performance;
  const pick = (o: number | undefined, a: number | null) => (o != null ? o : a);
  const highlights = visibleBullets(bullets);
  const hasHighlights = highlights.length > 0;
  const risk = [
    { label: "Std Dev · Portfolio", value: fmtStat(pick(metricsOverride.stdDev, perf.volatility), true) },
    { label: "Std Dev · S&P 500", value: fmtStat(pick(metricsOverride.benchmarkStdDev, perf.benchmarkVolatility), true) },
    { label: "Upside Capture", value: fmtStat(pick(metricsOverride.upsideCapture, perf.upsideCapture), false) },
    { label: "Downside Capture", value: fmtStat(pick(metricsOverride.downsideCapture, perf.downsideCapture), false) },
  ];
  return (
    <SlideFrame
      lead={`${data.profileLabel} Model,`}
      accent="Current Positioning"
      dateStr={dateStr}
      profileLabel={data.profileLabel}
    >
      <div className="flex flex-col h-full gap-4">
        <div className="grid gap-4 flex-1 min-h-0" style={{ gridTemplateColumns: "1.25fr 1fr 1fr" }}>
          <SlideCard tone="cream" num="01" eyebrow="Top Holdings · Look-Through">
            <SlideHoldingRows
              rows={data.xray.slice(0, 10).map((r) => ({ name: r.name, symbol: r.symbol, weight: r.weight }))}
              fontSize={hasHighlights ? 12.5 : 13}
              rowH={hasHighlights ? 20 : 25}
            />
          </SlideCard>
          <SlideCard tone="cream" num="02" eyebrow="Asset Allocation">
            <div className="flex flex-col h-full">
              <AllocationPie slices={data.allocation} size={hasHighlights ? 112 : 128} fontSize={12.5} />
              <div className="mt-auto pt-2 flex gap-6" style={{ borderTop: `1px solid ${THEME.rule}` }}>
                <SlideStat label="CAD" value={`${data.totals.cad.toFixed(1)}%`} size={20} />
                <SlideStat label="USD" value={`${data.totals.usd.toFixed(1)}%`} size={20} />
              </div>
            </div>
          </SlideCard>
          <SlideCard tone="sky" num="03" eyebrow="Sector Exposure">
            <BarList
              rows={data.sectors.slice(0, 8).map((s, i) => ({
                label: s.sector,
                value: s.weight,
                color: SECTOR_RAMP[i] ?? colorForSector(s.sector),
              }))}
              accent={THEME.navy}
              textColor={THEME.navy}
              scale="sqrt"
              minBarPct={12}
              size={hasHighlights ? "slideCompact" : "slide"}
            />
          </SlideCard>
        </div>
        {hasHighlights ? (
          <div className="grid gap-4" style={{ gridTemplateColumns: "0.75fr 0.65fr 1.9fr", height: 244 }}>
            <SlideCard tone="navy" num="04" eyebrow="Performance">
              {t ? (
                <div className="flex flex-col h-full">
                  <div className="flex items-end gap-5">
                    <SlideStat label="Annualized" value={fmtPctSigned(t.annualizedReturnPct, 2)} tone="dark" size={26} />
                    <SlideStat label="Cumulative" value={fmtPctSigned(t.sinceInceptionReturnPct, 2)} tone="dark" size={20} />
                  </div>
                  <div className="mt-auto">
                    <PerformanceChart tracker={t} width={215} height={104} tone="dark" />
                  </div>
                  {t.yearsOfHistory != null && (
                    <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.6)", marginTop: 2 }}>
                      Since inception · {t.yearsOfHistory.toFixed(1)} years of history
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 13, color: "rgba(255,255,255,0.7)", fontStyle: "italic" }}>
                  No performance tracker history yet.
                </div>
              )}
            </SlideCard>
            <SlideCard tone="gold" num="05" eyebrow="Risk vs S&P 500">
              <div className="flex flex-col justify-between h-full">
                {risk.map((r, i) => (
                  <div
                    key={r.label}
                    className="flex items-baseline justify-between gap-3"
                    style={{ borderTop: i ? "1px solid rgba(10,42,80,0.18)" : undefined, paddingTop: i ? 6 : 0 }}
                  >
                    <span style={{ fontSize: 12, color: THEME.navy }}>{r.label}</span>
                    <span
                      className="tabular-nums"
                      style={{ fontFamily: SERIF, fontSize: 21, fontWeight: 600, color: THEME.navy, lineHeight: 1.1 }}
                    >
                      {r.value}
                    </span>
                  </div>
                ))}
              </div>
            </SlideCard>
            <SlideCard tone="cream" num="06" eyebrow="Portfolio Highlights">
              <AutoFitBullets
                bullets={highlights}
                accent={THEME.gold}
                tone="light"
                max={14.5}
                onOverflow={onHighlightsOverflow}
              />
            </SlideCard>
          </div>
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: "1.75fr 1fr", height: 182 }}>
            <SlideCard
              tone="navy"
              num="04"
              eyebrow="Model Performance · Since Inception"
              right={
                t?.yearsOfHistory != null ? (
                  <span style={{ fontSize: 11, color: "rgba(255,255,255,0.6)" }}>
                    {t.yearsOfHistory.toFixed(1)} years of history
                  </span>
                ) : undefined
              }
            >
              {t ? (
                <div className="flex gap-6 h-full">
                  <div className="flex flex-col justify-between shrink-0" style={{ width: 150 }}>
                    <SlideStat label="Annualized" value={fmtPctSigned(t.annualizedReturnPct, 2)} tone="dark" size={30} />
                    <SlideStat label="Cumulative" value={fmtPctSigned(t.sinceInceptionReturnPct, 2)} tone="dark" size={22} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <PerformanceChart tracker={t} width={560} height={112} tone="dark" />
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 13, color: "rgba(255,255,255,0.7)", fontStyle: "italic" }}>
                  No performance tracker history yet.
                </div>
              )}
            </SlideCard>
            <SlideCard tone="gold" num="05" eyebrow="Risk Profile vs S&P 500">
              <div className="grid grid-cols-2 gap-x-5 gap-y-3">
                {risk.map((r) => (
                  <SlideStat key={r.label} label={r.label} value={r.value} size={24} />
                ))}
              </div>
            </SlideCard>
          </div>
        )}
      </div>
    </SlideFrame>
  );
}

/** Slide 2 — look-through exposures (highlights live on slide 1). */
function LookThroughSlide({
  data,
  dateStr,
}: {
  data: ReportData;
  dateStr: string;
}) {
  const rows = data.xray.slice(0, 12);
  return (
    <SlideFrame lead="Inside the Portfolio," accent="Look-Through" dateStr={dateStr} profileLabel={data.profileLabel}>
      <div className="grid gap-4 h-full" style={{ gridTemplateColumns: "1fr" }}>
        <SlideCard tone="cream" num="01" eyebrow="Top Exposures · Direct + Through Funds">
          {rows.length ? (
            <table className="w-full tabular-nums" style={{ fontSize: 13.5 }}>
              <thead>
                <tr style={{ color: THEME.gold, fontSize: 10.5, letterSpacing: "0.16em" }} className="uppercase">
                  <th className="text-left font-semibold pb-1.5">Position</th>
                  <th className="text-right font-semibold pb-1.5">Direct</th>
                  <th className="text-right font-semibold pb-1.5">Look-Through</th>
                  <th className="text-right font-semibold pb-1.5">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.symbol} style={{ borderTop: `1px solid ${THEME.rule}`, height: 32 }}>
                    <td style={{ color: THEME.navy }}>
                      <span style={{ color: THEME.gold, marginRight: 10, fontSize: 11.5 }}>{i + 1}</span>
                      {formatCompanyName(r.name) || r.symbol}
                      {r.symbol && r.symbol !== r.name && (
                        <span style={{ marginLeft: 6, fontSize: 10, color: THEME.muted }}>{r.symbol}</span>
                      )}
                    </td>
                    <td className="text-right" style={{ color: THEME.muted }}>
                      {r.direct > 0 ? `${r.direct.toFixed(2)}%` : "—"}
                    </td>
                    <td className="text-right" style={{ color: THEME.muted }}>
                      {r.lookThrough > 0 ? `${r.lookThrough.toFixed(2)}%` : "—"}
                    </td>
                    <td className="text-right font-semibold" style={{ color: THEME.navy }}>
                      {r.weight.toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ fontSize: 13, color: THEME.muted, fontStyle: "italic" }}>
              Look-through exposures populate once fund-data holdings have been cached.
            </div>
          )}
        </SlideCard>
      </div>
    </SlideFrame>
  );
}

/** Slide 3 — client's current portfolio beside the model. */
function ComparisonSlide({
  data,
  dateStr,
  clientPortfolio,
  merBreakdown,
}: {
  data: ReportData;
  dateStr: string;
  clientPortfolio: ClientPortfolioResult;
  merBreakdown: MerBreakdown | null;
}) {
  const savings =
    merBreakdown?.client != null
      ? computeFeeSavings(merBreakdown.client.blended, merBreakdown.model.blended, clientPortfolio.totalValue)
      : null;
  const fmt = (n: number) => `$${n.toLocaleString()}`;
  const side = (
    tone: CardTone,
    num: string,
    eyebrow: string,
    slices: ReportAllocationSlice[],
    rows: { name: string; symbol: string; weight: number }[],
    mer: number | undefined,
    cashWeight?: number,
  ) => (
    <SlideCard
      tone={tone}
      num={num}
      eyebrow={eyebrow}
      right={
        mer != null ? (
          <span className="tabular-nums" style={{ fontSize: 12, color: THEME.navy }}>
            Blended MER <span className="font-semibold">{mer.toFixed(2)}%</span>
          </span>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-2 h-full min-w-0">
        <div style={{ maxWidth: 380 }}>
          <AllocationPie slices={slices} size={104} fontSize={12} />
        </div>
        <div className="min-w-0" style={{ borderTop: `1px solid ${THEME.rule}`, paddingTop: 4 }}>
          <SlideHoldingRows rows={rows} fontSize={12.5} rowH={22} cashWeight={cashWeight} />
        </div>
      </div>
    </SlideCard>
  );
  return (
    <SlideFrame lead="Your Portfolio," accent="Side by Side" dateStr={dateStr} profileLabel={data.profileLabel}>
      <div className="flex flex-col h-full gap-4">
        <div className="grid grid-cols-2 gap-4 flex-1 min-h-0">
          {side(
            "cream",
            "01",
            "Current Portfolio",
            clientPortfolio.allocation,
            clientPortfolio.xray.slice(0, 8).map((r) => ({ name: r.name || r.symbol, symbol: r.symbol, weight: r.weight })),
            merBreakdown?.client?.blended,
            clientPortfolio.cashWeight,
          )}
          {side(
            "sky",
            "02",
            `${data.profileLabel} Model`,
            data.allocation,
            data.xray.slice(0, 8).map((r) => ({ name: r.name || r.symbol, symbol: r.symbol, weight: r.weight })),
            merBreakdown?.model.blended,
          )}
        </div>
        {savings && merBreakdown?.client && (
          <SlideCard tone="navy" num="03" eyebrow="Estimated Cost Savings" style={{ height: 124 }}>
            <div className="flex items-center gap-10">
              <SlideStat
                label="Blended MER"
                value={`${merBreakdown.client.blended.toFixed(2)}% → ${merBreakdown.model.blended.toFixed(2)}%`}
                tone="dark"
                size={26}
              />
              <SlideStat label="Per Year" value={fmt(savings.annualRounded)} tone="dark" size={26} />
              <SlideStat label={`Over ${savings.horizon} Years`} value={fmt(savings.total)} tone="dark" size={26} />
              <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.7)", maxWidth: 300, lineHeight: 1.4 }}>
                On a portfolio value of {fmt(Math.round(clientPortfolio.totalValue))}, moving to the{" "}
                {data.profileLabel} model.
              </div>
            </div>
          </SlideCard>
        )}
      </div>
    </SlideFrame>
  );
}

/** Slide 4 — the AI comparison analysis as three columns. */
function RecommendationsSlide({
  data,
  dateStr,
  analysis,
}: {
  data: ReportData;
  dateStr: string;
  analysis: ClientReportAnalysis;
}) {
  const pros = analysis.currentPosition.pros ?? [];
  const cons = analysis.currentPosition.cons ?? [];
  const recs = analysis.recommendations ?? [];
  const summary = analysis.summary ?? [];
  const mer = analysis.blendedMer;
  return (
    <SlideFrame lead="Our" accent="Recommendations" dateStr={dateStr} profileLabel={data.profileLabel}>
      <div className="grid grid-cols-3 gap-4 h-full">
        <SlideCard tone="cream" num="01" eyebrow="Where You Are Now">
          <div className="uppercase" style={{ fontSize: 10.5, letterSpacing: "0.16em", color: THEME.positive, fontWeight: 600, marginBottom: 6 }}>
            Strengths
          </div>
          <SlideBullets bullets={pros} accent={THEME.positive} fontSize={14} />
          <div className="uppercase" style={{ fontSize: 10.5, letterSpacing: "0.16em", color: THEME.negative, fontWeight: 600, margin: "14px 0 6px" }}>
            Risks / Weaknesses
          </div>
          <SlideBullets bullets={cons} accent={THEME.negative} fontSize={14} />
        </SlideCard>
        <SlideCard tone="navy" num="02" eyebrow="Action Items">
          <SlideBullets bullets={recs} accent={THEME.goldBand} fontSize={15} tone="dark" />
        </SlideCard>
        <SlideCard tone="sky" num="03" eyebrow="Why This Works Better">
          <div className="flex flex-col h-full">
            <SlideBullets bullets={summary} accent={THEME.navy} fontSize={15} />
            {(typeof mer?.client === "number" || typeof mer?.model === "number") && (
              <div className="mt-auto pt-3 flex gap-8" style={{ borderTop: `1px solid #B3C8E0` }}>
                <SlideStat
                  label="Current MER"
                  value={typeof mer.client === "number" ? `${mer.client.toFixed(2)}%` : "—"}
                  size={24}
                />
                <SlideStat
                  label={`${data.profileLabel} MER`}
                  value={typeof mer.model === "number" ? `${mer.model.toFixed(2)}%` : "—"}
                  size={24}
                />
              </div>
            )}
          </div>
        </SlideCard>
      </div>
    </SlideFrame>
  );
}

// ───────── Subcomponents ─────────

/**
 * Fee-savings callout. Pure function of the blended MERs + portfolio
 * value — no AI, no server round-trip. Renders nothing when:
 *   - The MER difference is < 5 bps (not meaningful)
 *   - No portfolio value is known (weight-mode without a PM-typed
 *     "Portfolio Value", or unit-mode that never resolved prices)
 *   - Even a 20-year horizon doesn't clear a $2K cumulative savings
 *     threshold (per PM guidance: skip if the dollars aren't
 *     meaningful enough to put in front of a client)
 *
 * Horizon is chosen as the SHORTEST span from [5, 10, 15, 20] where
 * the cumulative estimate clears the threshold. Larger MER gaps
 * collapse to shorter horizons; smaller gaps stretch out. Linear math
 * (annual × years) — the PM explicitly said the formula doesn't need
 * to be shown, just the result.
 */
function FeeSavingsTile({
  clientMer,
  modelMer,
  portfolioValueUsd,
  profileLabel,
}: {
  clientMer: number;
  modelMer: number;
  portfolioValueUsd: number;
  profileLabel: string;
}) {
  const savings = computeFeeSavings(clientMer, modelMer, portfolioValueUsd);
  if (!savings) return null;
  const { horizon, total, annualRounded } = savings;
  const fmt = (n: number) => `$${n.toLocaleString()}`;

  return (
    <div className="mt-4 break-inside-avoid">
      <div
        className="rounded-lg border px-4 py-3 text-xs text-slate-700"
        style={{ borderColor: RBC_NAVY, backgroundColor: THEME.sky }}
      >
        <div
          className="text-[10px] font-semibold uppercase tracking-wider mb-1"
          style={{ color: RBC_NAVY }}
        >
          Estimated Cost Savings
        </div>
        <div className="leading-relaxed">
          Moving to the {profileLabel} model reduces the blended MER from{" "}
          <span className="font-semibold">{clientMer.toFixed(2)}%</span> to{" "}
          <span className="font-semibold">{modelMer.toFixed(2)}%</span>. On a
          portfolio value of {fmt(Math.round(portfolioValueUsd))}, that is
          approximately{" "}
          <span className="font-semibold">{fmt(annualRounded)}</span> per year —{" "}
          <span className="font-semibold">{fmt(total)}</span> over {horizon}{" "}
          years.
        </div>
      </div>
    </div>
  );
}

/** Shared fee-savings math for the portrait tile and the comparison
 *  slide. Null when the gap or the dollars aren't meaningful (see
 *  FeeSavingsTile for the thresholds). */
function computeFeeSavings(
  clientMer: number,
  modelMer: number,
  portfolioValueUsd: number,
): { horizon: number; total: number; annualRounded: number } | null {
  const diff = clientMer - modelMer;
  if (!(diff > 0.05)) return null;
  if (!portfolioValueUsd || portfolioValueUsd <= 0) return null;

  const annual = portfolioValueUsd * (diff / 100);
  const THRESHOLD = 2000;
  const horizons = [5, 10, 15, 20];
  const horizon = horizons.find((y) => annual * y >= THRESHOLD);
  if (!horizon) return null;

  return { horizon, total: Math.round(annual * horizon), annualRounded: Math.round(annual) };
}

/**
 * Three stacked bullet-list sections rendered at the end of the client
 * portfolio comparison block. Kept visually distinct via different
 * accent colors (red for cons, green for pros, navy/gold for action
 * items, slate for the summary). Each card is `break-inside-avoid` so
 * Chrome's print engine doesn't split a bullet list across pages.
 */
function AnalysisSections({
  analysis,
  profileLabel,
}: {
  analysis: ClientReportAnalysis;
  profileLabel: string;
}) {
  const pros = analysis.currentPosition.pros ?? [];
  const cons = analysis.currentPosition.cons ?? [];
  const recs = analysis.recommendations ?? [];
  const summary = analysis.summary ?? [];
  const mer = analysis.blendedMer;
  const showMer =
    typeof mer?.client === "number" || typeof mer?.model === "number";

  return (
    <div className="mt-6 space-y-4">
      {/* "Where you are now" — pros + cons side by side */}
      <div className="break-inside-avoid">
        <div
          className="pb-2 mb-3 border-b-2"
          style={{ borderColor: RBC_NAVY }}
        >
          <div
            className="text-[17px] font-semibold"
            style={{ color: RBC_NAVY, fontFamily: SERIF }}
          >
            Where You Are Now
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <BulletCard title="Strengths" bullets={pros} accent={THEME.positive} />
          <BulletCard title="Risks / Weaknesses" bullets={cons} accent={THEME.negative} />
        </div>
      </div>

      {/* Recommendations — action items */}
      <div className="break-inside-avoid">
        <div
          className="pb-2 mb-3 border-b-2"
          style={{ borderColor: RBC_GOLD }}
        >
          <div
            className="text-[17px] font-semibold"
            style={{ color: RBC_NAVY, fontFamily: SERIF }}
          >
            Our Recommendations
          </div>
        </div>
        <BulletCard title="Action Items" bullets={recs} accent={RBC_NAVY} emphasis />
      </div>

      {/* Summary — why this works better. Optionally includes the
          blended-MER comparison table as a quantitative anchor. */}
      <div className="break-inside-avoid">
        <div
          className="pb-2 mb-3 border-b-2"
          style={{ borderColor: RBC_NAVY }}
        >
          <div
            className="text-[17px] font-semibold"
            style={{ color: RBC_NAVY, fontFamily: SERIF }}
          >
            Why This Works Better
          </div>
        </div>
        <BulletCard title="Summary" bullets={summary} accent={RBC_NAVY} />
        {showMer && (
          <div className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
            <MerStat
              label="Current — Blended MER"
              value={mer.client}
              coverage={mer.clientCoveragePct}
              tone="neutral"
            />
            <MerStat
              label={`${profileLabel} — Blended MER`}
              value={mer.model}
              coverage={mer.modelCoveragePct}
              tone="positive"
            />
          </div>
        )}
      </div>
    </div>
  );
}

function BulletCard({
  title,
  bullets,
  accent,
  emphasis,
}: {
  title: string;
  bullets: string[];
  accent: string;
  emphasis?: boolean;
}) {
  if (!bullets.length) {
    return (
      <div className="rounded border p-3" style={{ borderColor: THEME.rule, backgroundColor: THEME.card }}>
        <div
          className="text-[10px] font-bold uppercase tracking-wider mb-1"
          style={{ color: accent }}
        >
          {title}
        </div>
        <div className="text-[11px] text-slate-400 italic">
          No items available.
        </div>
      </div>
    );
  }
  return (
    <div
      className="rounded border p-3"
      style={{ borderColor: THEME.rule, borderLeftWidth: 4, borderLeftColor: accent, backgroundColor: THEME.card }}
    >
      <div
        className="text-[10px] font-bold uppercase tracking-wider mb-2"
        style={{ color: accent }}
      >
        {title}
      </div>
      <ul className="space-y-1.5">
        {bullets.map((b, i) => (
          <li
            key={i}
            className={`text-[11px] leading-snug text-slate-700 flex gap-2 ${
              emphasis ? "font-medium" : ""
            }`}
          >
            <span
              aria-hidden
              className="mt-[5px] block h-1.5 w-1.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: accent }}
            />
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MerStat({
  label,
  value,
  coverage,
  tone,
}: {
  label: string;
  value?: number;
  coverage?: number;
  tone: "neutral" | "positive";
}) {
  const color = tone === "positive" ? THEME.positive : THEME.muted;
  return (
    <div
      className="rounded border p-2"
      style={{ borderColor: THEME.rule, backgroundColor: THEME.card }}
    >
      <div className="text-[9px] uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div
        className="mt-0.5 font-bold tabular-nums"
        style={{ color, fontSize: "14px" }}
      >
        {typeof value === "number" ? `${value.toFixed(2)}%` : "—"}
      </div>
      {typeof coverage === "number" && coverage < 100 && (
        <div className="text-[9px] text-slate-400 mt-0.5">
          {coverage.toFixed(0)}% of weight covered
        </div>
      )}
    </div>
  );
}

/**
 * Brand acronyms that should stay uppercase even when the source name
 * arrives in all caps. Keep the list small — anything NOT in here gets
 * standard title-casing (e.g. "CONSTELLATION SOFTWARE INC." → "Constellation
 * Software Inc."). Add sparingly when you notice a company name that
 * should stylistically be ALL CAPS.
 */
const ALL_CAPS_BRAND_EXCEPTIONS: ReadonlySet<string> = new Set([
  "NVIDIA", "IBM", "AMD", "HSBC", "SAP", "BMW", "UPS", "CVS", "TSMC",
  "PNC", "AIG", "EOG", "AES", "CSX", "LVMH", "ASML", "AT&T", "P&G",
  "USA", "UK", "US", "EU", "ETF", "REIT", "JPMORGAN",
]);

/**
 * Corporate suffixes that should always be normalized to title case,
 * even when the rest of the company name is already mixed-case. Covers
 * cases like Yahoo returning "Apple INC" where the stem is fine but the
 * entity suffix is all-caps.
 */
const CORPORATE_SUFFIX_MAP: Record<string, string> = {
  INC: "Inc",
  INCORPORATED: "Incorporated",
  CORP: "Corp",
  CORPORATION: "Corporation",
  LTD: "Ltd",
  LIMITED: "Limited",
  CO: "Co",
  COMPANY: "Company",
  HOLDINGS: "Holdings",
  GROUP: "Group",
  // Initialisms that are conventionally uppercase in English typography
  // — list them here so the title-caser leaves them alone.
  LLC: "LLC",
  PLC: "PLC",
  NV: "NV",
  SA: "SA",
  AG: "AG",
  AB: "AB",
  AS: "AS",
  BV: "BV",
  SE: "SE",
};

/**
 * Normalize company names for display. If the source already has a
 * lowercase letter we trust the stem (Yahoo gives us "NVIDIA Corp",
 * "Apple Inc." etc.) but still normalize corporate suffixes so
 * "Apple INC" becomes "Apple Inc". If the source is entirely ALL CAPS
 * we title-case it while preserving known brand acronyms. Hyphens and
 * apostrophes are respected ("COCA-COLA" → "Coca-Cola", "O'REILLY" →
 * "O'Reilly").
 */
function formatCompanyName(name: string | undefined | null): string {
  if (!name) return "";
  const isAllCaps = !/[a-z]/.test(name);
  return name
    .split(/(\s+)/)
    .map((token) => {
      if (/^\s+$/.test(token) || !token) return token;
      // Split core word from trailing punctuation like "INC." or "CO.,"
      const m = token.match(/^([A-Za-z0-9&'\-]+)(.*)$/);
      if (!m) return token;
      const core = m[1];
      const trailing = m[2];
      const upper = core.toUpperCase();
      // Suffix normalization applies regardless of the surrounding
      // name's casing — handles "Apple INC", "Tesla, INC.", etc.
      const suffix = CORPORATE_SUFFIX_MAP[upper];
      if (suffix) return suffix + trailing;
      // Mixed-case source: leave non-suffix tokens alone.
      if (!isAllCaps) return token;
      // All-caps source — title-case unless it's a known brand.
      if (ALL_CAPS_BRAND_EXCEPTIONS.has(upper)) {
        return upper + trailing;
      }
      const cased = core
        .toLowerCase()
        .replace(/(^|[-'\/])([a-z])/g, (_, sep, letter) => sep + letter.toUpperCase());
      return cased + trailing;
    })
    .join("");
}

/**
 * Per-slice breakdown tables shown on page 2 of the PDF. Each slice from
 * the Asset Allocation pie renders as its own mini-table listing the
 * underlying holdings and their weight contribution (after look-through
 * expansion — so Core ETFs, for instance, show the actual underlying
 * holdings rather than just the ETF ticker).
 */
function AllocationBreakdownTables({
  breakdown,
}: {
  breakdown: ReportAllocationBreakdown[];
}) {
  // Single-column stack: grid layouts with `break-inside-avoid` on
  // children caused irregular row heights that let earlier sections
  // (e.g. the sector BarList's weight labels) visually bleed through
  // into the breakdown cards on screen. A vertical stack with solid
  // white-backed cards sidesteps that entirely and still prints cleanly
  // since each card is marked `break-inside-avoid`.
  return (
    <div className="relative z-10 flex flex-col gap-3">
      {breakdown.map((slice) => (
        <div
          key={slice.key}
          className="break-inside-avoid rounded border overflow-hidden"
          style={{ borderColor: THEME.rule, backgroundColor: THEME.card }}
        >
          <div
            className="flex items-center justify-between gap-2 px-2 py-1.5 border-b"
            style={{ borderColor: RBC_GOLD, background: THEME.goldPale }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="inline-block h-3 w-3 rounded-sm flex-shrink-0"
                style={{ background: sliceColor(slice) }}
                aria-hidden
              />
              <span
                className="text-[11px] font-bold truncate"
                style={{ color: RBC_NAVY }}
              >
                {slice.label}
              </span>
            </div>
            <span
              className="text-[11px] font-bold tabular-nums"
              style={{ color: RBC_NAVY }}
            >
              {slice.weight.toFixed(1)}%
            </span>
          </div>
          {slice.holdings.length === 0 ? (
            <div className="px-2 py-2 text-[9px] text-slate-400 italic">
              No underlying holdings available.
            </div>
          ) : (
            <table className="w-full text-[10px]">
              <tbody>
                {slice.holdings.map((h, i) => (
                  <tr
                    key={`${slice.key}-${h.symbol}-${i}`}
                    className="border-t border-slate-100"
                  >
                    <td className="px-2 py-1 font-semibold text-slate-700 tabular-nums w-[72px]">
                      {h.symbol}
                    </td>
                    <td className="px-2 py-1 text-slate-600 truncate">
                      {formatCompanyName(h.name)}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-slate-700 w-[48px]">
                      {h.weight.toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}

/** Audit table for the Blended MER tile. One row per holding with ticker,
 *  weight, MER, and contribution in percentage points (weight × MER ÷ 100).
 *  Sum of the Contribution column equals blended × covered-weight / 100,
 *  so the PM can eyeball each row and see exactly where the blended number
 *  comes from — including WHICH MER source (typed / Dashboard manual /
 *  Dashboard auto / assumed stock) was used. */
function MerContributorsTable({
  title,
  rows,
  blended,
  coveragePct,
  accent,
}: {
  title: string;
  rows: MerContribRow[];
  blended: number;
  coveragePct: number;
  accent: string;
}) {
  // Sort: fund-covered by contribution desc, then uncovered, then stocks.
  // The PM should see fee-contributing rows at the top.
  const order = (r: MerContribRow) =>
    r.classification === "fund-covered"
      ? 0
      : r.classification === "fund-uncovered"
      ? 1
      : 2;
  const sorted = [...rows].sort((a, b) => {
    const ao = order(a);
    const bo = order(b);
    if (ao !== bo) return ao - bo;
    if (a.classification === "fund-covered") {
      return (b.weight * (b.mer ?? 0)) - (a.weight * (a.mer ?? 0));
    }
    return b.weight - a.weight;
  });
  const totalContribPP = sorted.reduce(
    (sum, r) =>
      r.classification === "fund-covered"
        ? sum + (r.weight * (r.mer ?? 0)) / 100
        : sum,
    0,
  );
  return (
    <div
      className="break-inside-avoid rounded border overflow-hidden"
      style={{ borderColor: THEME.rule, backgroundColor: THEME.card }}
    >
      <div
        className="flex items-center justify-between gap-2 px-2 py-1.5 border-b"
        style={{ borderColor: RBC_GOLD, background: THEME.goldPale }}
      >
        <span
          className="text-[11px] font-bold truncate"
          style={{ color: accent }}
        >
          {title}
        </span>
        <span
          className="text-[11px] font-bold tabular-nums"
          style={{ color: accent }}
        >
          {blended.toFixed(2)}%
          <span className="ml-1 text-[9px] font-normal text-slate-500">
            ({coveragePct.toFixed(0)}% covered)
          </span>
        </span>
      </div>
      {sorted.length === 0 ? (
        <div className="px-2 py-2 text-[9px] text-slate-400 italic">
          No holdings to break down.
        </div>
      ) : (
        <table className="w-full text-[10px]">
          <thead>
            <tr className="border-b border-slate-100 text-[9px] uppercase tracking-wider text-slate-500">
              <th className="px-2 py-1 text-left font-semibold w-[70px]">
                Ticker
              </th>
              <th className="px-2 py-1 text-left font-semibold">Name</th>
              <th className="px-2 py-1 text-right font-semibold w-[44px]">
                Wt %
              </th>
              <th className="px-2 py-1 text-right font-semibold w-[44px]">
                MER %
              </th>
              <th className="px-2 py-1 text-right font-semibold w-[56px]">
                Contrib pp
              </th>
              <th className="px-2 py-1 text-left font-semibold w-[120px]">
                Source
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => {
              const contribPP =
                r.classification === "fund-covered"
                  ? (r.weight * (r.mer ?? 0)) / 100
                  : 0;
              const merCellClass =
                r.classification === "fund-uncovered"
                  ? "text-amber-600 italic"
                  : r.classification === "stock"
                  ? "text-slate-400"
                  : "text-slate-800 font-semibold";
              const merText =
                r.classification === "fund-uncovered"
                  ? "—"
                  : r.classification === "stock"
                  ? "0.00"
                  : (r.mer ?? 0).toFixed(2);
              const contribText =
                r.classification === "fund-covered"
                  ? contribPP.toFixed(3)
                  : r.classification === "fund-uncovered"
                  ? "excl."
                  : "0.000";
              return (
                <tr
                  key={`${r.symbol}-${i}`}
                  className="border-t border-slate-100"
                >
                  <td className="px-2 py-1 font-mono font-semibold text-slate-700 tabular-nums">
                    {r.symbol}
                  </td>
                  <td className="px-2 py-1 text-slate-600 truncate max-w-[320px]">
                    {formatCompanyName(r.name)}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-slate-700">
                    {r.weight.toFixed(2)}
                  </td>
                  <td
                    className={`px-2 py-1 text-right tabular-nums ${merCellClass}`}
                  >
                    {merText}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-slate-700">
                    {contribText}
                  </td>
                  <td className="px-2 py-1 text-[9px] text-slate-500 truncate">
                    {r.source}
                  </td>
                </tr>
              );
            })}
            <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
              <td className="px-2 py-1" colSpan={4}>
                Sum of covered contributions
              </td>
              <td className="px-2 py-1 text-right tabular-nums text-slate-800">
                {totalContribPP.toFixed(3)}
              </td>
              <td className="px-2 py-1 text-[9px] text-slate-500">
                ÷ {coveragePct.toFixed(1)}% = {blended.toFixed(2)}%
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  // Gold letter-spaced eyebrow over a hairline rule — the slide's
  // "MARKET EXPOSURE (BETA)" treatment.
  return (
    <div
      className="text-[9.5px] font-semibold uppercase tracking-[0.2em] pb-1 border-b"
      style={{ color: RBC_GOLD, borderColor: THEME.rule }}
    >
      {children}
    </div>
  );
}

/** Report masthead: serif navy lead + gold italic accent, with the
 *  firm line as a letter-spaced eyebrow under a short gold rule —
 *  mirrors the "Your Portfolio, Built in Layers" title block. */
function ReportMasthead({
  lead,
  accent,
  dateStr,
  profileLabel,
  size = "portrait",
}: {
  lead: string;
  accent: string;
  dateStr: string;
  profileLabel: string;
  size?: "portrait" | "slide";
}) {
  const slide = size === "slide";
  return (
    <div className="flex items-end justify-between gap-6">
      <div className="min-w-0">
        <div
          className="leading-[1.05] whitespace-nowrap"
          style={{ fontFamily: SERIF, color: THEME.navy, fontSize: slide ? 44 : 28, fontWeight: 600 }}
        >
          {lead}{" "}
          <span style={{ color: THEME.gold, fontStyle: "italic", fontWeight: 500 }}>{accent}</span>
        </div>
        <div className="flex items-center gap-3" style={{ marginTop: slide ? 10 : 6 }}>
          <span className="block h-px" style={{ width: slide ? 56 : 36, backgroundColor: THEME.gold }} />
          <span
            className="uppercase whitespace-nowrap"
            style={{ color: THEME.navy, letterSpacing: "0.24em", fontSize: slide ? 12 : 9 }}
          >
            Di Iorio Family Wealth · RBC Dominion Securities
          </span>
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="flex justify-end gap-1.5">
          {(["Balanced", "Growth", "All-Equity"].includes(profileLabel)
            ? ["Balanced", "Growth", "All-Equity"]
            : [profileLabel, "Balanced", "Growth", "All-Equity"]
          ).map((p) => {
            const on = p === profileLabel;
            return (
              <span
                key={p}
                className="rounded border"
                style={{
                  fontSize: slide ? 12 : 9,
                  padding: slide ? "4px 12px" : "2px 8px",
                  borderColor: on ? THEME.navy : THEME.gold,
                  backgroundColor: on ? THEME.navy : "transparent",
                  color: on ? "#fff" : THEME.navy,
                  fontWeight: on ? 600 : 400,
                }}
              >
                {p}
              </span>
            );
          })}
        </div>
        <div className="mt-1.5" style={{ color: THEME.muted, fontSize: slide ? 12 : 9.5 }}>
          {dateStr}
        </div>
      </div>
    </div>
  );
}

/** Page-level heading for the continuation pages (comparison, breakdown,
 *  MER audit): serif lead + gold italic accent with a gold eyebrow. */
function PageHeading({
  eyebrow,
  title,
  accent,
  flush,
}: {
  eyebrow: string;
  title: string;
  accent: string;
  flush?: boolean;
}) {
  return (
    <div className={flush ? "" : "mb-4"}>
      <div
        className="text-[9px] uppercase tracking-[0.22em]"
        style={{ color: THEME.gold }}
      >
        {eyebrow}
      </div>
      <div
        className="mt-1 leading-tight pb-2 border-b"
        style={{ fontFamily: SERIF, color: THEME.navy, fontSize: 22, fontWeight: 600, borderColor: THEME.gold }}
      >
        {title}{" "}
        <span style={{ color: THEME.gold, fontStyle: "italic", fontWeight: 500 }}>{accent}</span>
      </div>
    </div>
  );
}

/**
 * Current Positioning table.
 *
 * Driven off the look-through X-ray rather than raw model holdings: the
 * goal of this section is to show clients the *underlying equity
 * exposures* — the actual stocks they own, including the ones sitting
 * one level inside Core ETFs (e.g. AAPL/MSFT/NVDA via IVV rather than
 * "iShares Core S&P 500" as a single line). Fixed income funds are
 * excluded entirely since this block is scoped to top equity holdings;
 * total fixed income weight still shows in the Allocation pie.
 */
function HoldingsTable({ rows }: { rows: ReportXRayRow[] }) {
  if (!rows.length) {
    return (
      <div className="text-[10px] text-slate-400 italic mt-2">
        No equity look-through positions available.
      </div>
    );
  }
  return (
    <table className="w-full mt-2 text-[10px]">
      <thead>
        <tr className="text-slate-500 border-b border-slate-200">
          <th className="text-left font-semibold py-1">Holding</th>
          <th className="text-right font-semibold py-1">Weight</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.symbol} style={i % 2 ? { backgroundColor: "rgba(222,177,101,0.10)" } : undefined}>
            <td className="py-0.5 text-slate-800">
              <span>{formatCompanyName(r.name) || r.symbol}</span>
              {r.symbol && r.symbol !== r.name && (
                <span className="ml-1 text-[8px] text-slate-400">{r.symbol}</span>
              )}
            </td>
            <td className="text-right py-0.5 tabular-nums font-semibold">
              {r.weight.toFixed(2)}%
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ───────── Allocation pie ─────────

/**
 * Pie chart rendered as an SVG so it prints crisply without a chart
 * library. Slices are laid out clockwise starting at 12 o'clock; the
 * legend sits beside the pie and uses the same colours.
 */
function AllocationPie({
  slices,
  size = 120,
  fontSize = 10,
}: {
  slices: ReportAllocationSlice[];
  /** Pie diameter in px. */
  size?: number;
  /** Legend font size in px. */
  fontSize?: number;
}) {
  const filtered = slices.filter((s) => s.weight > 0);
  const total = filtered.reduce((acc, s) => acc + s.weight, 0);
  if (!filtered.length || total <= 0) {
    return (
      <div className="text-[10px] text-slate-400 italic mt-2">
        No allocation data available.
      </div>
    );
  }

  // Pie geometry. View box 200×200; radius 80. Legend uses flex so the
  // whole block flows under the pie when the parent column is narrow.
  const cx = 100;
  const cy = 100;
  const r = 80;

  // Pre-compute cumulative fractions so the slice loop is pure. (We
  // avoid `let acc += frac` patterns inside .map callbacks because
  // React 19's linter treats captured mutation as unsafe after render.)
  const fractions = filtered.map((s) => s.weight / total);
  const cumulative: number[] = [];
  fractions.reduce((sum, f) => {
    const next = sum + f;
    cumulative.push(next);
    return next;
  }, 0);

  const paths = filtered.map((slice, idx) => {
    const frac = fractions[idx];
    const startAngle = (idx === 0 ? 0 : cumulative[idx - 1]) * 2 * Math.PI;
    const endAngle = cumulative[idx] * 2 * Math.PI;
    const large = endAngle - startAngle > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const d =
      frac >= 0.9999
        ? // Full circle — SVG arc can't draw 360° in a single path, so
          // fall back to two half-circles joined at the start.
          `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} Z`
        : `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
    return { slice, d };
  });

  return (
    <div className="mt-2 flex items-center" style={{ gap: Math.round(size / 10) }}>
      <svg
        viewBox="0 0 200 200"
        width={size}
        height={size}
        style={{ transform: "rotate(-90deg)" }}
        aria-label="Asset allocation pie chart"
      >
        {paths.map(({ slice, d }) => (
          <path key={slice.key} d={d} fill={sliceColor(slice)} stroke={THEME.cream} strokeWidth={1.5} />
        ))}
      </svg>
      <div className="flex-1 min-w-0" style={{ fontSize, lineHeight: 1.5 }}>
        {filtered.map((s) => (
          <div key={s.key} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 min-w-0 whitespace-nowrap">
              <span
                className="inline-block rounded-sm shrink-0"
                style={{ backgroundColor: sliceColor(s), width: fontSize, height: fontSize }}
              />
              <span style={{ color: RBC_NAVY }}>{s.label}</span>
            </span>
            <span className="tabular-nums font-semibold text-slate-700">
              {s.weight.toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ───────── Simple holdings table (for comparison) ─────────

/**
 * A minimal holdings table used in the comparison section. Shows name,
 * ticker, and weight. Optional cash row at the bottom.
 */
function SimpleHoldingsTable({
  rows,
  cashWeight,
}: {
  rows: { name: string; ticker: string; weight: number }[];
  cashWeight?: number;
}) {
  if (!rows.length && (!cashWeight || cashWeight <= 0)) {
    return (
      <div className="text-[10px] text-slate-400 italic mt-2">
        No holdings data.
      </div>
    );
  }
  return (
    <table className="w-full mt-2 text-[10px]">
      <thead>
        <tr className="text-slate-500 border-b border-slate-200">
          <th className="text-left font-semibold py-1">Holding</th>
          <th className="text-right font-semibold py-1">Weight</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.ticker} style={i % 2 ? { backgroundColor: "rgba(222,177,101,0.10)" } : undefined}>
            <td className="py-0.5 text-slate-800">
              <span>{formatCompanyName(r.name)}</span>
              {r.ticker && r.ticker !== r.name && (
                <span className="ml-1 text-[8px] text-slate-400">
                  {r.ticker}
                </span>
              )}
            </td>
            <td className="text-right py-0.5 tabular-nums font-semibold">
              {r.weight.toFixed(2)}%
            </td>
          </tr>
        ))}
        {cashWeight != null && cashWeight > 0.05 && (
          <tr style={rows.length % 2 ? { backgroundColor: "rgba(222,177,101,0.10)" } : undefined}>
            <td className="py-0.5 text-slate-600 italic">Cash</td>
            <td className="text-right py-0.5 tabular-nums font-semibold text-slate-600">
              {cashWeight.toFixed(2)}%
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

// ───────── Performance chart ─────────

/**
 * Line chart of the tracker history. Built as an SVG polyline so it
 * prints crisply. Styled to match the PIM Performance Tracker tab —
 * emerald/red area fill + stroke depending on whether cumulative return
 * is positive, with a dashed reference line at value=100. Y-axis is the
 * published index value; X-axis shows start and end dates only.
 */
function PerformanceChart({
  tracker,
  width = 400,
  height = 110,
  tone = "light",
}: {
  tracker: ReportTrackerPerformance;
  /** viewBox width — match the rendered width so labels stay true-size. */
  width?: number;
  /** Rendered height in px; the viewBox keeps a 400-wide coordinate space. */
  height?: number;
  /** "dark" = drawn on the navy slide band (gold line, light labels). */
  tone?: "light" | "dark";
}) {
  const { history } = tracker;
  if (history.length < 2) {
    return <div className="text-[10px] text-slate-400 italic">Insufficient history.</div>;
  }

  // Normalize to a 0..1 viewport. 400×110 keeps it compact next to
  // the yearly-return table without overwhelming the row.
  const dark = tone === "dark";
  const w = width;
  const h = height;
  const padL = dark ? 32 : 24; // left axis room for value labels
  const padR = 2;
  const padT = 4;
  const padB = dark ? 18 : 14;

  const values = history.map((d) => d.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const span = Math.max(1e-6, maxV - minV);
  const x = (i: number) => padL + (i / (history.length - 1)) * (w - padL - padR);
  const y = (v: number) => padT + (1 - (v - minV) / span) * (h - padT - padB);

  const points = history.map((d, i) => `${x(i)},${y(d.value)}`).join(" ");
  const last = history[history.length - 1];
  const first = history[0];

  // Positive if cumulative return ≥ 0 — mirrors the Performance Tracker's
  // "100 is the inception value" convention.
  const isPositive = last.value >= first.value;
  const lineColor = dark ? THEME.goldBand : isPositive ? THEME.navy : THEME.negative;
  const areaFill = dark
    ? "rgba(222,177,101,0.16)"
    : isPositive
      ? "rgba(184,137,63,0.14)"
      : "rgba(180,66,60,0.10)";
  const gridColor = dark ? "rgba(255,255,255,0.18)" : "#e2e8f0";
  const labelColor = dark ? "rgba(255,255,255,0.7)" : "#64748b";
  const labelSize = dark ? 9 : 7;

  // Build a filled-area path (polyline + drop to baseline at each end).
  const baseY = h - padB;
  const areaPath = [
    `M ${x(0)} ${baseY}`,
    `L ${x(0)} ${y(history[0].value)}`,
    ...history.slice(1).map((d, i) => `L ${x(i + 1)} ${y(d.value)}`),
    `L ${x(history.length - 1)} ${baseY}`,
    "Z",
  ].join(" ");

  // Dashed reference line at inception value (100) — matches the
  // Performance Tracker chart.
  const ref100InRange = 100 >= minV && 100 <= maxV;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} aria-label="Performance chart">
      {/* Top / bottom grid */}
      <line x1={padL} y1={padT} x2={w - padR} y2={padT} stroke={gridColor} strokeWidth={0.5} />
      <line x1={padL} y1={h - padB} x2={w - padR} y2={h - padB} stroke={gridColor} strokeWidth={0.5} />
      {/* Filled area (transparent green/red beneath the line) */}
      <path d={areaPath} fill={areaFill} />
      {/* Inception reference line at value = 100 */}
      {ref100InRange && (
        <line
          x1={padL}
          y1={y(100)}
          x2={w - padR}
          y2={y(100)}
          stroke={dark ? "rgba(255,255,255,0.35)" : "#94a3b8"}
          strokeDasharray="4,2"
          strokeWidth={0.5}
        />
      )}
      {/* Line */}
      <polyline
        fill="none"
        stroke={lineColor}
        strokeWidth={1.5}
        strokeLinejoin="round"
        points={points}
      />
      {/* End-point marker, matching the Performance Tracker */}
      <circle
        cx={x(history.length - 1)}
        cy={y(last.value)}
        r={2.5}
        fill={lineColor}
        stroke={dark ? THEME.navy : "white"}
        strokeWidth={1}
      />
      {/* Value labels (min / max) */}
      <text x={2} y={padT + 6} fontSize={labelSize} fill={labelColor}>
        {maxV.toFixed(1)}
      </text>
      <text x={2} y={h - padB} fontSize={labelSize} fill={labelColor}>
        {minV.toFixed(1)}
      </text>
      {/* Date labels — start and end only (no midpoint clutter). */}
      <text x={padL} y={h - 2} fontSize={labelSize} fill={labelColor}>
        {first.date}
      </text>
      <text x={w - padR} y={h - 2} fontSize={labelSize} fill={labelColor} textAnchor="end">
        {last.date}
      </text>
    </svg>
  );
}

function YearlyReturnsTable({ tracker }: { tracker: ReportTrackerPerformance }) {
  if (!tracker.yearlyReturns.length) {
    return <div className="text-[10px] text-slate-400 italic mt-2">No yearly returns yet.</div>;
  }
  return (
    <table className="w-full text-[10px] mt-2">
      <thead>
        <tr className="text-slate-500 border-b border-slate-200">
          <th className="text-left font-semibold py-1">Year</th>
          <th className="text-right font-semibold py-1">Return</th>
        </tr>
      </thead>
      <tbody>
        {tracker.yearlyReturns.map((r) => (
          <tr key={r.year}>
            <td className="py-0.5 text-slate-800">{r.year}</td>
            <td
              className="text-right py-0.5 tabular-nums font-semibold"
              style={{ color: r.returnPct >= 0 ? THEME.positive : THEME.negative }}
            >
              {fmtPctSigned(r.returnPct, 2)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ───────── X-ray table ─────────

function XRayTable({ rows }: { rows: ReportXRayRow[] }) {
  if (!rows.length) {
    return null;
  }
  return (
    <table className="w-full text-[10px] mt-2">
      <thead>
        <tr className="text-slate-500 border-b border-slate-200">
          <th className="text-left font-semibold py-1">Position</th>
          <th className="text-right font-semibold py-1">Direct</th>
          <th className="text-right font-semibold py-1">Look-Through</th>
          <th className="text-right font-semibold py-1">Total</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.symbol} style={i % 2 ? { backgroundColor: "rgba(222,177,101,0.10)" } : undefined}>
            <td className="py-0.5 text-slate-800">
              <span>{formatCompanyName(r.name) || r.symbol}</span>
              {r.symbol && r.symbol !== r.name && (
                <span className="ml-1 text-[8px] text-slate-400">{r.symbol}</span>
              )}
            </td>
            <td className="text-right py-0.5 tabular-nums text-slate-500">
              {r.direct > 0 ? `${r.direct.toFixed(2)}%` : "—"}
            </td>
            <td className="text-right py-0.5 tabular-nums text-slate-500">
              {r.lookThrough > 0 ? `${r.lookThrough.toFixed(2)}%` : "—"}
            </td>
            <td className="text-right py-0.5 tabular-nums font-semibold">
              {r.weight.toFixed(2)}%
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BarList({
  rows,
  accent,
  textColor = "#1e293b",
  tooltip,
  scale = "linear",
  minBarPct = 0,
  size = "portrait",
}: {
  // `color` on the row overrides `accent` (lets the caller tint each bar
  // individually — e.g. per-sector GICS colors). `tooltip` is a per-row
  // hover string that also shows up in print preview context; it does
  // nothing when printed.
  rows: { label: string; value: number; color?: string; tooltip?: string }[];
  accent: string;
  textColor?: string;
  tooltip?: (row: { label: string; value: number }) => string;
  // Optional visual compression so a small value (e.g. Materials at 3.9%)
  // doesn't render as a sliver next to a dominant one (Technology at
  // 27.4%). Numeric labels on the right stay linear so the actual weight
  // is never misrepresented — only the bar length is re-scaled.
  //   "linear"  → proportional (current behavior)
  //   "sqrt"    → square-root scaling, ~half-compresses the range
  //   "pow0.6"  → even gentler; use when the spread is extreme
  scale?: "linear" | "sqrt" | "pow0.6";
  // Floor for rendered bar width (as a percentage of the longest bar) so
  // the smallest slice is still clearly visible even after scaling.
  minBarPct?: number;
  /** "slide" = larger type and bars for the 16:9 landscape canvas;
   *  "slideCompact" = tighter rows when the highlights share slide 1. */
  size?: "portrait" | "slide" | "slideCompact";
}) {
  if (!rows.length) {
    return <div className="text-[10px] text-slate-400 italic mt-2">No data.</div>;
  }
  const slide = size !== "portrait";
  const compact = size === "slideCompact";
  const transform = (v: number) => {
    if (scale === "sqrt") return Math.sqrt(Math.max(0, v));
    if (scale === "pow0.6") return Math.pow(Math.max(0, v), 0.6);
    return Math.max(0, v);
  };
  const maxT = Math.max(...rows.map((r) => transform(r.value)), 1);
  return (
    <div className={compact ? "space-y-[4px]" : slide ? "space-y-[7px]" : "mt-2 space-y-1"}>
      {rows.map((r) => {
        const title = r.tooltip ?? (tooltip ? tooltip(r) : undefined);
        const rawPct = (transform(r.value) / maxT) * 100;
        const pct = r.value > 0 ? Math.max(minBarPct, rawPct) : 0;
        return (
          <div key={r.label} className={slide ? "" : "text-[10px]"} style={slide ? { fontSize: compact ? 12 : 12.5, lineHeight: compact ? 1.25 : 1.35 } : undefined} title={title}>
            <div className="flex justify-between">
              <span style={{ color: textColor }}>{r.label}</span>
              <span className="tabular-nums text-slate-600 font-semibold">
                {r.value.toFixed(1)}%
              </span>
            </div>
            <div
              className={`${compact ? "h-[6px] mt-[2px]" : slide ? "h-[7px] mt-[3px]" : "h-1.5 mt-0.5"} rounded-full overflow-hidden`}
              style={{ backgroundColor: slide ? "rgba(255,255,255,0.6)" : "rgba(10,42,80,0.07)" }}
            >
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${Math.min(100, pct)}%`,
                  backgroundColor: r.color ?? accent,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border p-2" style={{ borderColor: THEME.rule, backgroundColor: THEME.card }}>
      <div className="text-[9px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="text-sm font-bold mt-0.5 tabular-nums" style={{ color: RBC_NAVY }}>
        {value}
      </div>
    </div>
  );
}

/**
 * A risk-stat card with an inline override input. Displays the
 * auto-computed value (from the tracker) when no override is set, and
 * the override otherwise. The input is `print:hidden` so the PDF shows
 * only the number, not the editing affordance.
 *
 * `fraction=true`: value stored as 0.14 for 14% (matches the raw std
 * dev output). Capture ratios are stored as plain percents (e.g. 95).
 */
function OverridableStat({
  label,
  auto,
  override,
  fraction = false,
  onChange,
}: {
  label: string;
  auto: number | null;
  override: number | undefined;
  fraction?: boolean;
  onChange: (v: number | undefined) => void;
}) {
  const displayed = override != null ? override : auto;
  const displayStr =
    displayed == null
      ? "N/A"
      : fraction
      ? `${(displayed * 100).toFixed(1)}%`
      : `${displayed.toFixed(1)}%`;
  // Text shown in the input: the override value in its stored units
  // (fraction → display as percent for easier typing, e.g. "14" for 0.14).
  const inputStr =
    override == null
      ? ""
      : fraction
      ? String(+(override * 100).toFixed(2))
      : String(+override.toFixed(2));

  return (
    <div className="rounded border p-2" style={{ borderColor: THEME.rule, backgroundColor: THEME.card }}>
      <div className="text-[9px] uppercase tracking-wider" style={{ color: THEME.muted }}>
        {label}
      </div>
      <div
        className="text-[17px] font-semibold mt-0.5 tabular-nums"
        style={{ color: RBC_NAVY, fontFamily: SERIF }}
      >
        {displayStr}
      </div>
      <div className="print:hidden mt-1 flex items-center gap-1">
        <input
          type="number"
          step="0.1"
          placeholder={
            auto != null
              ? `auto: ${(fraction ? auto * 100 : auto).toFixed(1)}%`
              : "override %"
          }
          value={inputStr}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") {
              onChange(undefined);
              return;
            }
            const n = parseFloat(raw);
            if (!Number.isFinite(n)) {
              onChange(undefined);
              return;
            }
            onChange(fraction ? n / 100 : n);
          }}
          className="w-full rounded border border-slate-200 px-1.5 py-0.5 text-[10px] tabular-nums focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
      </div>
    </div>
  );
}


