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
  type ReportAllocationSlice,
  type ReportData,
  type ReportTrackerPerformance,
  type ReportXRayRow,
} from "@/app/lib/useReportData";
import type { PimProfileType } from "@/app/lib/pim-types";

// ───────── Client portfolio comparison types ─────────

type ClientPosition = {
  id: string; // unique key for React
  ticker: string;
  name: string;
  units: number;
};

type ClientPortfolioResult = {
  positions: { ticker: string; name: string; weight: number; marketValue: number }[];
  cash: number;
  cashWeight: number;
  totalValue: number;
  slices: { label: string; weight: number; color: string }[];
};

/** Colour ramp for client portfolio pie slices. */
const CLIENT_PIE_COLORS = [
  "#002855", "#005DAA", "#c8102e", "#0d9488", "#a16207",
  "#7c3aed", "#dc2626", "#2563eb", "#059669", "#d97706",
  "#6366f1", "#84cc16", "#f43f5e", "#06b6d4", "#8b5cf6",
];

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

  // ── Client portfolio comparison state ──
  const [clientPositions, setClientPositions] = useState<ClientPosition[]>([]);
  const [clientCash, setClientCash] = useState<number>(0);
  const [clientResult, setClientResult] = useState<ClientPortfolioResult | null>(null);
  const [clientLoading, setClientLoading] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);
  const [showComparison, setShowComparison] = useState(false);

  const addPosition = useCallback(() => {
    setClientPositions((prev) => [
      ...prev,
      { id: crypto.randomUUID(), ticker: "", name: "", units: 0 },
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

  const computeClientPortfolio = useCallback(async () => {
    const validPositions = clientPositions.filter(
      (p) => p.ticker.trim() && p.units > 0
    );
    if (validPositions.length === 0 && clientCash <= 0) {
      setClientError("Add at least one position or cash amount.");
      return;
    }
    setClientError(null);
    setClientLoading(true);
    try {
      // Fetch live prices for all client tickers.
      const tickers = validPositions.map((p) => p.ticker.trim().toUpperCase());
      let prices: Record<string, number | null> = {};
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
        }
      }

      // Compute market values and weights.
      const positionsWithValue: {
        ticker: string;
        name: string;
        units: number;
        price: number;
        marketValue: number;
      }[] = [];
      for (const p of validPositions) {
        const ticker = p.ticker.trim().toUpperCase();
        const price = prices[ticker] ?? prices[p.ticker.trim()] ?? null;
        if (price == null || price <= 0) continue;
        positionsWithValue.push({
          ticker,
          name: p.name.trim() || ticker,
          units: p.units,
          price,
          marketValue: p.units * price,
        });
      }

      const totalEquity = positionsWithValue.reduce(
        (sum, p) => sum + p.marketValue,
        0
      );
      const totalValue = totalEquity + clientCash;
      if (totalValue <= 0) {
        setClientError("Could not compute portfolio value — check tickers and prices.");
        setClientLoading(false);
        return;
      }

      const positions = positionsWithValue
        .map((p) => ({
          ticker: p.ticker,
          name: p.name,
          weight: (p.marketValue / totalValue) * 100,
          marketValue: p.marketValue,
        }))
        .sort((a, b) => b.weight - a.weight);

      const cashWeight = totalValue > 0 ? (clientCash / totalValue) * 100 : 0;

      // Build pie slices — top positions + cash.
      const slicePositions = positions.slice(0, 12);
      const otherWeight =
        positions.slice(12).reduce((s, p) => s + p.weight, 0);
      const slices: ClientPortfolioResult["slices"] = slicePositions.map(
        (p, i) => ({
          label: p.name || p.ticker,
          weight: p.weight,
          color: CLIENT_PIE_COLORS[i % CLIENT_PIE_COLORS.length],
        })
      );
      if (otherWeight > 0.05) {
        slices.push({
          label: "Other",
          weight: otherWeight,
          color: "#94a3b8",
        });
      }
      if (cashWeight > 0.05) {
        slices.push({
          label: "Cash",
          weight: cashWeight,
          color: "#5b6b8a",
        });
      }

      setClientResult({
        positions,
        cash: clientCash,
        cashWeight,
        totalValue,
        slices,
      });
      setShowComparison(true);
    } catch (e) {
      setClientError(
        e instanceof Error ? e.message : "Failed to compute client portfolio"
      );
    } finally {
      setClientLoading(false);
    }
  }, [clientPositions, clientCash]);

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
            <p className="text-xs text-slate-500 mb-3">
              Add the client&apos;s current holdings to generate a side-by-side comparison on the PDF.
            </p>

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
                <label className="text-xs text-slate-500">Cash ($):</label>
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
                Portfolio analyzed: {clientResult.positions.length} positions,
                total value ${clientResult.totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}.
                Comparison will appear on the PDF.
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
}: {
  data: ReportData;
  commentary: string;
  onCommentaryChange: (v: string) => void;
  commentarySaving: boolean;
  clientPortfolio: ClientPortfolioResult | null;
}) {
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
          <HoldingsTable rows={data.xray.slice(0, 15)} />
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
          <XRayTable rows={data.xray.slice(0, 12)} />
          {!data.xray.length && (
            <div className="text-[10px] text-slate-400 italic mt-2">
              Look-through exposures populate once fund-data holdings have been cached.
            </div>
          )}
        </div>
        <div>
          <SectionTitle>Top Sector Exposures</SectionTitle>
          <BarList
            rows={data.sectors.slice(0, 8).map((s) => ({ label: s.sector, value: s.weight }))}
            accent={RBC_GOLD}
            textColor={RBC_NAVY}
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
              Client&apos;s current holdings vs {data.profileLabel} Model
            </div>
          </div>

          {/* Side-by-side pies */}
          <div className="grid grid-cols-2 gap-5 break-inside-avoid">
            <div>
              <SectionTitle>Client — Current Holdings</SectionTitle>
              <GenericPie slices={clientPortfolio.slices} />
            </div>
            <div>
              <SectionTitle>{data.profileLabel} — Asset Allocation</SectionTitle>
              <AllocationPie slices={data.allocation} />
            </div>
          </div>

          {/* Side-by-side holdings tables */}
          <div className="grid grid-cols-2 gap-5 mt-4 break-inside-avoid">
            <div>
              <SectionTitle>Client — Top Holdings</SectionTitle>
              <SimpleHoldingsTable
                rows={clientPortfolio.positions.slice(0, 12).map((p) => ({
                  name: p.name || p.ticker,
                  ticker: p.ticker,
                  weight: p.weight,
                }))}
                cashWeight={clientPortfolio.cashWeight}
              />
            </div>
            <div>
              <SectionTitle>{data.profileLabel} — Top Holdings</SectionTitle>
              <SimpleHoldingsTable
                rows={data.xray.slice(0, 12).map((r) => ({
                  name: r.name || r.symbol,
                  ticker: r.symbol,
                  weight: r.weight,
                }))}
              />
            </div>
          </div>
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
              <span>{r.name || r.symbol}</span>
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

// ───────── Generic pie (for client portfolio) ─────────

/**
 * Generic pie chart that works with any { label, weight, color } slices.
 * Used for the client portfolio comparison where slices are individual
 * holdings rather than allocation categories.
 */
function GenericPie({
  slices,
}: {
  slices: { label: string; weight: number; color: string }[];
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

  const cx = 100;
  const cy = 100;
  const r = 80;

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
        ? `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} Z`
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
        aria-label="Client portfolio pie chart"
      >
        {paths.map(({ slice, d }) => (
          <path
            key={slice.label}
            d={d}
            fill={slice.color}
            stroke="#fff"
            strokeWidth={1.5}
          />
        ))}
      </svg>
      <div className="flex-1 text-[10px] space-y-0.5">
        {filtered.map((s) => (
          <div key={s.label} className="flex items-center justify-between gap-2">
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
              <span>{r.name}</span>
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
              <span>{r.name || r.symbol}</span>
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
}: {
  rows: { label: string; value: number }[];
  accent: string;
  textColor?: string;
}) {
  if (!rows.length) {
    return <div className="text-[10px] text-slate-400 italic mt-2">No data.</div>;
  }
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="mt-2 space-y-1">
      {rows.map((r) => (
        <div key={r.label} className="text-[10px]">
          <div className="flex justify-between">
            <span style={{ color: textColor }}>{r.label}</span>
            <span className="tabular-nums text-slate-600 font-semibold">
              {r.value.toFixed(1)}%
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-100 mt-0.5 overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, (r.value / max) * 100)}%`,
                backgroundColor: accent,
              }}
            />
          </div>
        </div>
      ))}
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
