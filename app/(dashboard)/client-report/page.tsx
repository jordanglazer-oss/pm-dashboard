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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useReportData,
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

// ───────── Client portfolio comparison types ─────────

type ClientInputMode = "units" | "weight";

type ClientPosition = {
  id: string; // unique key for React
  ticker: string;
  name: string;
  units: number;
  /** Portfolio weight (%) — used when inputMode is "weight". */
  weight: number;
};

type ClientPortfolioResult = {
  /** Raw input positions (pre-look-through) with weights and names. */
  positions: { ticker: string; name: string; weight: number; marketValue: number }[];
  cash: number;
  cashWeight: number;
  totalValue: number;
  /** PIM-style allocation pie: Fixed Income, US Equity, etc. (no "Core ETFs" bucket). */
  allocation: ReportAllocationSlice[];
  /** Look-through xray — individual stock holdings only (preferred shares excluded). */
  xray: ReportXRayRow[];
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

const VALID_PROFILES: readonly PimProfileType[] = ["balanced", "growth", "allEquity"];

// RBC Dominion Securities palette. Navy is the primary brand colour;
// gold is the accent used for rules, subtle highlights, and footer
// marks. Everything else stays neutral so the PDF prints cleanly.
const RBC_NAVY = "#002855";
const RBC_GOLD = "#FED141";

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

export default function ClientReportPage() {
  const router = useRouter();
  const params = useSearchParams();
  const groupId = params.get("group") || "pim";
  const profileParam = (params.get("profile") || "balanced") as PimProfileType;
  const profile = VALID_PROFILES.includes(profileParam) ? profileParam : "balanced";

  const { data, loading, error, refetch } = useReportData(groupId, profile);
  const { stocks } = useStocks();

  // ── Client portfolio comparison state ──
  const [clientInputMode, setClientInputMode] = useState<ClientInputMode>("units");
  const [clientPositions, setClientPositions] = useState<ClientPosition[]>([]);
  const [clientCash, setClientCash] = useState<number>(0);
  // Client display name (free-form) — replaces the literal "Client" label
  // on the comparison section titles. Persisted alongside the positions
  // blob in pm:client-portfolio.
  const [clientName, setClientName] = useState<string>("");
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

  // Load saved client portfolio positions from Redis on mount.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/kv/client-portfolio", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { data: null }))
      .then((payload: { data?: { positions?: ClientPosition[]; cash?: number; inputMode?: ClientInputMode; clientName?: string; analysis?: ClientReportAnalysis } | null }) => {
        if (cancelled) return;
        const d = payload?.data;
        if (d) {
          if (Array.isArray(d.positions) && d.positions.length > 0) {
            setClientPositions(d.positions);
          }
          if (typeof d.cash === "number") setClientCash(d.cash);
          if (d.inputMode === "units" || d.inputMode === "weight") setClientInputMode(d.inputMode);
          if (typeof d.clientName === "string") setClientName(d.clientName);
          if (d.analysis && typeof d.analysis === "object") setAnalysis(d.analysis);
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
          inputMode: clientInputMode,
          clientName,
          analysis,
        }),
      }).catch(() => { /* best effort */ });
    }, 800);
    return () => clearTimeout(handle);
  }, [clientPositions, clientCash, clientInputMode, clientName, analysis]);

  const addPosition = useCallback(() => {
    setClientPositions((prev) => [
      ...prev,
      { id: crypto.randomUUID(), ticker: "", name: "", units: 0, weight: 0 },
    ]);
  }, []);

  const removePosition = useCallback((id: string) => {
    setClientPositions((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const updatePosition = useCallback(
    (id: string, field: keyof Omit<ClientPosition, "id">, value: string | number) => {
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
      let totalValue: number;

      if (clientInputMode === "weight") {
        const validPositions = clientPositions.filter(
          (p) => p.ticker.trim() && p.weight > 0
        );
        if (validPositions.length === 0 && clientCash <= 0) {
          setClientError("Add at least one position with a weight, or a cash weight.");
          setClientLoading(false);
          return;
        }
        const rawTotal =
          validPositions.reduce((s, p) => s + p.weight, 0) + clientCash;
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
        totalValue = 0;
      } else {
        const validPositions = clientPositions.filter(
          (p) => p.ticker.trim() && p.units > 0
        );
        if (validPositions.length === 0 && clientCash <= 0) {
          setClientError("Add at least one position or cash amount.");
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
        totalValue = totalEquity + clientCash;
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
      }

      // ── Step 2: Set up classification helpers + allocation buckets ──
      // Categories: Fixed Income, Alternatives, US Equity, Canadian Equity,
      // Global Equity, Preferred Shares, Cash. No "Core ETFs" bucket.
      const SLICE_COLORS_CLIENT: Record<string, string> = {
        fixedIncome: "#5b6b8a",
        alternatives: "#a16207",
        usEquity: "#005DAA",
        canadianEquity: "#c8102e",
        globalEquity: "#0d9488",
        preferredShares: "#7c3aed",
        cash: "#94a3b8",
      };
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
          const res = await fetch(`/api/fund-data?ticker=${encodeURIComponent(fetchTicker)}`, { cache: "no-store" });
          if (!res.ok) { fundInfoCache.set(key, null); return null; }
          const d = await res.json().catch(() => null);
          const fd = d?.fundData as FundData | undefined;
          const info = { topHoldings: fd?.topHoldings, sectorWeightings: fd?.sectorWeightings };
          fundInfoCache.set(key, info);
          return info;
        } catch {
          fundInfoCache.set(key, null);
          return null;
        }
      };

      const looksLikeFund = (sym: string, name: string, st: Stock | undefined, qt: string | null): boolean => {
        if (st?.instrumentType === "stock") return false;
        if (st?.instrumentType === "etf" || st?.instrumentType === "mutual-fund") return true;
        if (st?.fundData?.topHoldings?.length) return true;
        if (isCoreEtf(sym)) return true;
        if (/^[A-Z]{2,4}\d{2,5}$/.test(sym)) return true;
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

      // Non-equity filter: skip fixed-income and cash-like holdings at the leaf level.
      const NON_EQUITY_NAME_RE =
        /\b(TREASURY|T-BILL|BOND|GOVT|GOVERNMENT|CASH|MONEY\s*MARKET|REPO|COMMERCIAL\s*PAPER)\b/i;

      const xrayAcc = new Map<string, { name: string; direct: number; lookThrough: number }>();
      const addXRay = (symbol: string, name: string, direct: number, lookThrough: number) => {
        const key = (symbol || name).toUpperCase();
        if (!key) return;
        // Skip obviously non-equity leaf holdings.
        if (NON_EQUITY_NAME_RE.test(name)) return;
        const prev = xrayAcc.get(key) ?? { name, direct: 0, lookThrough: 0 };
        prev.direct += direct;
        prev.lookThrough += lookThrough;
        if (name && name.length > prev.name.length) prev.name = name;
        xrayAcc.set(key, prev);
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
          // Couldn't resolve underlying — use the fund's own country.
          addEquityToAllocation(sym, weightPct, parentCountry);
          return;
        }
        await Promise.all(
          top.map((h) => {
            const childSym = (h.symbol || h.name || "").trim();
            if (!childSym) return Promise.resolve();
            const childWeight = (weightPct * h.weight) / 100;
            return expandClient(childSym, h.name, childWeight, depth + 1, null, fundCountry);
          })
        );
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

      setClientResult({
        positions: positions.map(({ quoteType: _qt, ...rest }) => rest),
        cash: clientCash,
        cashWeight,
        totalValue,
        allocation,
        xray,
      });
      setShowComparison(true);
    } catch (e) {
      setClientError(
        e instanceof Error ? e.message : "Failed to compute client portfolio"
      );
    } finally {
      setClientLoading(false);
    }
  }, [clientPositions, clientCash, clientInputMode, stocks]);

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
        // Build per-ticker MER map from the Dashboard's Stock.fundData.
        // Client-typed tickers that aren't in the portfolio/watchlist
        // simply won't have an MER, and the route treats those as
        // unknown (the blended value becomes a lower bound rather than
        // guessed). Stocks with no fundData (i.e. individual equities)
        // contribute 0% MER via stockSymbols below.
        const expenseRatios: Record<string, number> = {};
        const stockSymbols: string[] = [];
        for (const s of stocks) {
          const key = s.ticker.toUpperCase();
          const er = s.fundData?.expenseRatio;
          if (typeof er === "number" && Number.isFinite(er)) {
            expenseRatios[key] = er;
          } else if (s.instrumentType === "stock" || !s.instrumentType) {
            stockSymbols.push(key);
          }
        }

        const payload = {
          clientName: clientName.trim() || undefined,
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
          modelProfileLabel: data.profileLabel,
          modelHoldings: data.xray.slice(0, 20).map((h) => ({
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
          modelPerformance: {
            annualizedReturnPct: data.tracker?.annualizedReturnPct ?? null,
            volatility: data.performance.volatility ?? null,
            upsideCapture: data.performance.upsideCapture ?? null,
            downsideCapture: data.performance.downsideCapture ?? null,
            yearsOfHistory: data.tracker?.yearsOfHistory ?? null,
          },
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
    [data, clientResult, clientName, stocks],
  );

  // Manager commentary — persisted per (group, profile) so switching
  // between Balanced / Growth doesn't clobber one with the other.
  const noteKey = `${groupId}::${profile}`;
  const [commentary, setCommentary] = useState("");
  const [commentarySaving, setCommentarySaving] = useState(false);
  const commentaryLoaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    commentaryLoaded.current = false;
    setCommentary("");
    fetch("/api/kv/client-report-notes", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { notes: {} }))
      .then((payload: { notes?: Record<string, string> }) => {
        if (cancelled) return;
        setCommentary(payload?.notes?.[noteKey] ?? "");
        commentaryLoaded.current = true;
      })
      .catch(() => {
        commentaryLoaded.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [noteKey]);

  useEffect(() => {
    if (!commentaryLoaded.current) return;
    setCommentarySaving(true);
    const handle = setTimeout(async () => {
      try {
        const current = await fetch("/api/kv/client-report-notes", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : { notes: {} }))
          .catch(() => ({ notes: {} }));
        const notes = { ...(current.notes ?? {}), [noteKey]: commentary };
        await fetch("/api/kv/client-report-notes", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes }),
        });
      } finally {
        setCommentarySaving(false);
      }
    }, 600);
    return () => clearTimeout(handle);
  }, [commentary, noteKey]);

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
            size: letter;
            margin: 0.4in;
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
          /* Force colored backgrounds (pie slices, sector bars, legend
             swatches) to render in the printed PDF. By default Chrome
             strips these to save ink — which washed out the sector bar
             colors and the pie-chart legend swatches. Apply inside and
             below the report frame so the sticky toolbar is unaffected. */
          .report-preview-frame,
          .report-preview-frame * {
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
          Generate PDF
        </button>
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
            {/* Client display name — shown in place of "Client" on the
                comparison section titles. Supports multiple names (e.g.
                "John & Mary Smith"). Persists across refreshes. */}
            <div className="flex items-center gap-2 mb-3">
              <label
                htmlFor="client-name"
                className="text-xs font-semibold text-slate-600 whitespace-nowrap"
              >
                Client name
              </label>
              <input
                id="client-name"
                type="text"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                placeholder="e.g. John & Mary Smith"
                className="flex-1 rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-400"
              />
            </div>
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

      {/* Letter-sized frame. */}
      <div
        className="report-preview-frame mx-auto my-6 bg-white shadow-lg print:shadow-none print:my-0"
        style={{ width: "8.5in", minHeight: "11in" }}
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
            commentary={commentary}
            onCommentaryChange={setCommentary}
            commentarySaving={commentarySaving}
            clientPortfolio={showComparison ? clientResult : null}
            clientName={clientName}
            analysis={showComparison ? analysis : null}
          />
        )}
      </div>
    </div>
  );
}

// ───────── Report body ─────────

function OnePager({
  data,
  commentary,
  onCommentaryChange,
  commentarySaving,
  clientPortfolio,
  clientName,
  analysis,
}: {
  data: ReportData;
  commentary: string;
  onCommentaryChange: (v: string) => void;
  commentarySaving: boolean;
  clientPortfolio: ClientPortfolioResult | null;
  clientName: string;
  analysis: ClientReportAnalysis | null;
}) {
  // Resolved label: user-supplied name, or "Client" as a safe fallback so
  // the report still reads naturally when no name has been entered yet.
  const clientLabel = clientName.trim() || "Client";
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
      className="p-6 text-slate-800"
      style={{ fontFamily: "system-ui, -apple-system, sans-serif" }}
    >
      {/* ── Header ── */}
      <div
        className="flex items-start justify-between pb-3 border-b-4"
        style={{ borderColor: RBC_NAVY }}
      >
        <div>
          <div className="text-[10px] tracking-[0.2em] uppercase text-slate-500">
            RBC Dominion Securities
          </div>
          <div className="mt-0.5 text-xl font-bold" style={{ color: RBC_NAVY }}>
            Di Iorio Wealth Management
          </div>
          <div className="mt-0.5 text-xs text-slate-600">
            {data.profileLabel} Model — Current Positioning
          </div>
        </div>
        <div className="text-right">
          <div
            className="w-20 h-10 border rounded flex items-center justify-center text-[10px] text-slate-400"
            style={{ borderColor: RBC_NAVY }}
            aria-label="RBC logo placeholder"
          >
            RBC
          </div>
          <div className="mt-1 text-[10px] text-slate-500">{dateStr}</div>
        </div>
      </div>

      {/* ── Row 1: Holdings table + Allocation pie ── */}
      <div className="grid grid-cols-5 gap-5 mt-4 break-inside-avoid">
        <div className="col-span-3">
          <SectionTitle>Current Positioning</SectionTitle>
          <HoldingsTable rows={data.xray.slice(0, 10)} />
          <div className="mt-1 text-[9px] text-slate-400 flex justify-between">
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
            <span className="text-[10px] text-slate-600 font-semibold tabular-nums">
              Cumulative: {fmtPctSigned(data.tracker.sinceInceptionReturnPct, 2)}
            </span>
          )}
        </div>
        {data.tracker ? (
          <div className="grid grid-cols-5 gap-4 mt-2">
            <div className="col-span-3">
              <PerformanceChart tracker={data.tracker} />
              {data.tracker.annualizedReturnPct != null && (
                <div className="mt-1 text-center text-[11px] text-slate-700">
                  Annualized Return:{" "}
                  <span
                    className="font-bold tabular-nums"
                    style={{
                      color:
                        data.tracker.annualizedReturnPct >= 0
                          ? "#059669"
                          : "#dc2626",
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
            rows={data.sectors.slice(0, 8).map((s) => ({
              label: s.sector,
              value: s.weight,
              color: colorForSector(s.sector),
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

      {/* ── Risk metrics strip ── */}
      <div className="mt-4 break-inside-avoid">
        <SectionTitle>Risk Profile vs S&amp;P 500 (5Y)</SectionTitle>
        <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
          <Stat label="Volatility (ann.)" value={fmtPctFrac(data.performance.volatility)} />
          <Stat label="Upside Capture" value={fmtPct(data.performance.upsideCapture)} />
          <Stat label="Downside Capture" value={fmtPct(data.performance.downsideCapture)} />
        </div>
      </div>

      {/* ── Manager commentary ── */}
      <div className="mt-4 break-inside-avoid">
        <div className="flex items-center justify-between">
          <SectionTitle>Manager Commentary</SectionTitle>
          <span className="print:hidden text-[9px] text-slate-400 pl-2 pb-1">
            {commentarySaving ? "Saving…" : "Auto-saved"}
          </span>
        </div>
        <textarea
          value={commentary}
          onChange={(e) => onCommentaryChange(e.target.value)}
          placeholder="Optional — leave blank if not used."
          className="print:hidden mt-2 w-full min-h-[48px] rounded border border-slate-200 p-2 text-xs text-slate-700 focus:outline-none focus:ring-1"
          style={{ resize: "vertical" }}
          rows={2}
        />
        <div className="hidden print:block mt-2 text-xs text-slate-700 whitespace-pre-wrap">
          {commentary}
        </div>
      </div>

      {/* ── Client Portfolio Comparison (only when active) ── */}
      {clientPortfolio && (
        <div className="mt-6 break-inside-avoid">
          <div
            className="pb-3 border-b-4 mb-4"
            style={{ borderColor: RBC_NAVY }}
          >
            <div
              className="text-lg font-bold"
              style={{ color: RBC_NAVY }}
            >
              Portfolio Comparison
            </div>
            <div className="text-[10px] text-slate-500">
              {clientLabel}&apos;s current holdings vs {data.profileLabel} Model
            </div>
          </div>

          {/* Side-by-side allocation pies */}
          <div className="grid grid-cols-2 gap-5 break-inside-avoid">
            <div>
              <SectionTitle>{clientLabel} — Asset Allocation</SectionTitle>
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
              <SectionTitle>{clientLabel} — Top Holdings (Look-Through)</SectionTitle>
              <SimpleHoldingsTable
                rows={clientPortfolio.xray.slice(0, 12).map((r) => ({
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
                rows={data.xray.slice(0, 12).map((r) => ({
                  name: r.name || r.symbol,
                  ticker: r.symbol,
                  weight: r.weight,
                }))}
              />
            </div>
          </div>

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
              clientLabel={clientLabel}
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
          className="relative z-10 mt-8 pt-6 bg-white"
          style={{ breakBefore: "page", pageBreakBefore: "always" }}
        >
          <div
            className="pb-3 border-b-4 mb-4"
            style={{ borderColor: RBC_NAVY }}
          >
            <div className="text-lg font-bold" style={{ color: RBC_NAVY }}>
              Asset Allocation — Holdings Breakdown
            </div>
            <div className="text-[10px] text-slate-500">
              Each holding&apos;s contribution to the categories shown in the
              Asset Allocation pie chart (post look-through).
            </div>
          </div>
          <AllocationBreakdownTables breakdown={data.allocationBreakdown} />
        </div>
      )}

      {/* ── Footer ── */}
      <div
        className="mt-4 pt-2 border-t text-[9px] text-slate-400 flex justify-between"
        style={{ borderColor: RBC_GOLD }}
      >
        <span>
          Di Iorio Wealth Management · RBC Dominion Securities Inc. · For client
          presentation purposes only.
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

// ───────── Subcomponents ─────────

/**
 * Three stacked bullet-list sections rendered at the end of the client
 * portfolio comparison block. Kept visually distinct via different
 * accent colors (red for cons, green for pros, navy/gold for action
 * items, slate for the summary). Each card is `break-inside-avoid` so
 * Chrome's print engine doesn't split a bullet list across pages.
 */
function AnalysisSections({
  analysis,
  clientLabel,
  profileLabel,
}: {
  analysis: ClientReportAnalysis;
  clientLabel: string;
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
            className="text-sm font-bold uppercase tracking-wider"
            style={{ color: RBC_NAVY }}
          >
            Where You Are Now
          </div>
          <div className="text-[10px] text-slate-500">
            A plain-English read on {clientLabel}&apos;s current holdings.
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <BulletCard title="Strengths" bullets={pros} accent="#059669" />
          <BulletCard title="Risks / Weaknesses" bullets={cons} accent="#dc2626" />
        </div>
      </div>

      {/* Recommendations — action items */}
      <div className="break-inside-avoid">
        <div
          className="pb-2 mb-3 border-b-2"
          style={{ borderColor: RBC_GOLD }}
        >
          <div
            className="text-sm font-bold uppercase tracking-wider"
            style={{ color: RBC_NAVY }}
          >
            Our Recommendations
          </div>
          <div className="text-[10px] text-slate-500">
            Concrete actions to move from today&apos;s portfolio toward the {profileLabel} model.
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
            className="text-sm font-bold uppercase tracking-wider"
            style={{ color: RBC_NAVY }}
          >
            Why This Works Better
          </div>
          <div className="text-[10px] text-slate-500">
            Long-term fit vs {clientLabel}&apos;s current positioning.
          </div>
        </div>
        <BulletCard title="Summary" bullets={summary} accent={RBC_NAVY} />
        {showMer && (
          <div className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
            <MerStat
              label={`${clientLabel} — Blended MER`}
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
      <div className="rounded border border-slate-200 p-3">
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
      style={{ borderColor: "#e2e8f0", borderLeftWidth: 4, borderLeftColor: accent }}
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
  const color = tone === "positive" ? "#059669" : "#475569";
  return (
    <div
      className="rounded border p-2"
      style={{ borderColor: "#e2e8f0" }}
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
    <div className="relative z-10 flex flex-col gap-3 bg-white">
      {breakdown.map((slice) => (
        <div
          key={slice.key}
          className="break-inside-avoid rounded border border-slate-200 overflow-hidden bg-white"
        >
          <div
            className="flex items-center justify-between gap-2 px-2 py-1.5 border-b"
            style={{ borderColor: RBC_GOLD, background: "#f8fafc" }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="inline-block h-3 w-3 rounded-sm flex-shrink-0"
                style={{ background: slice.color }}
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

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="text-[10px] font-bold uppercase tracking-[0.15em] pb-1 border-b"
      style={{ color: RBC_NAVY, borderColor: RBC_GOLD }}
    >
      {children}
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
          <tr key={r.symbol} className={i % 2 ? "bg-slate-50" : ""}>
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
function AllocationPie({ slices }: { slices: ReportAllocationSlice[] }) {
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
    <div className="mt-2 flex items-center gap-3">
      <svg
        viewBox="0 0 200 200"
        width="120"
        height="120"
        style={{ transform: "rotate(-90deg)" }}
        aria-label="Asset allocation pie chart"
      >
        {paths.map(({ slice, d }) => (
          <path key={slice.key} d={d} fill={slice.color} stroke="#fff" strokeWidth={1.5} />
        ))}
      </svg>
      <div className="flex-1 text-[10px] space-y-0.5">
        {filtered.map((s) => (
          <div key={s.key} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-sm"
                style={{ backgroundColor: s.color }}
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
          <tr key={r.ticker} className={i % 2 ? "bg-slate-50" : ""}>
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
          <tr className={rows.length % 2 ? "bg-slate-50" : ""}>
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
function PerformanceChart({ tracker }: { tracker: ReportTrackerPerformance }) {
  const { history } = tracker;
  if (history.length < 2) {
    return <div className="text-[10px] text-slate-400 italic">Insufficient history.</div>;
  }

  // Normalize to a 0..1 viewport. 400×110 keeps it compact next to
  // the yearly-return table without overwhelming the row.
  const w = 400;
  const h = 110;
  const padL = 24; // left axis room for value labels
  const padR = 2;
  const padT = 4;
  const padB = 14;

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
  const lineColor = isPositive ? "#10b981" : "#ef4444";
  const areaFill = isPositive ? "rgba(16,185,129,0.08)" : "rgba(239,68,68,0.08)";

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
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="110" aria-label="Performance chart">
      {/* Top / bottom grid */}
      <line x1={padL} y1={padT} x2={w - padR} y2={padT} stroke="#e2e8f0" strokeWidth={0.5} />
      <line x1={padL} y1={h - padB} x2={w - padR} y2={h - padB} stroke="#e2e8f0" strokeWidth={0.5} />
      {/* Filled area (transparent green/red beneath the line) */}
      <path d={areaPath} fill={areaFill} />
      {/* Inception reference line at value = 100 */}
      {ref100InRange && (
        <line
          x1={padL}
          y1={y(100)}
          x2={w - padR}
          y2={y(100)}
          stroke="#94a3b8"
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
        stroke="white"
        strokeWidth={1}
      />
      {/* Value labels (min / max) */}
      <text x={2} y={padT + 6} fontSize={7} fill="#64748b">
        {maxV.toFixed(1)}
      </text>
      <text x={2} y={h - padB} fontSize={7} fill="#64748b">
        {minV.toFixed(1)}
      </text>
      {/* Date labels — start and end only (no midpoint clutter). */}
      <text x={padL} y={h - 2} fontSize={7} fill="#64748b">
        {first.date}
      </text>
      <text x={w - padR} y={h - 2} fontSize={7} fill="#64748b" textAnchor="end">
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
              style={{ color: r.returnPct >= 0 ? "#166534" : "#be123c" }}
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
          <tr key={r.symbol} className={i % 2 ? "bg-slate-50" : ""}>
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
}) {
  if (!rows.length) {
    return <div className="text-[10px] text-slate-400 italic mt-2">No data.</div>;
  }
  const transform = (v: number) => {
    if (scale === "sqrt") return Math.sqrt(Math.max(0, v));
    if (scale === "pow0.6") return Math.pow(Math.max(0, v), 0.6);
    return Math.max(0, v);
  };
  const maxT = Math.max(...rows.map((r) => transform(r.value)), 1);
  return (
    <div className="mt-2 space-y-1">
      {rows.map((r) => {
        const title = r.tooltip ?? (tooltip ? tooltip(r) : undefined);
        const rawPct = (transform(r.value) / maxT) * 100;
        const pct = r.value > 0 ? Math.max(minBarPct, rawPct) : 0;
        return (
          <div key={r.label} className="text-[10px]" title={title}>
            <div className="flex justify-between">
              <span style={{ color: textColor }}>{r.label}</span>
              <span className="tabular-nums text-slate-600 font-semibold">
                {r.value.toFixed(1)}%
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-slate-100 mt-0.5 overflow-hidden">
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
    <div className="rounded border p-2" style={{ borderColor: "#e2e8f0" }}>
      <div className="text-[9px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="text-sm font-bold mt-0.5 tabular-nums" style={{ color: RBC_NAVY }}>
        {value}
      </div>
    </div>
  );
}
