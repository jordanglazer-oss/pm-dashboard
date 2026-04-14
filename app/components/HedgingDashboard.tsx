"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { HedgingLiveData, HedgingQuote } from "@/app/api/hedging/route";
import type { HedgingHistory, HedgingSnapshot } from "@/app/api/kv/hedging-history/route";

type StrikeKey = "atm" | "otm5" | "otm10";

const STRIKE_ROWS: { key: StrikeKey; label: string }[] = [
  { key: "atm", label: "ATM" },
  { key: "otm5", label: "~5% OTM" },
  { key: "otm10", label: "~10% OTM" },
];

function strikeOf(q: HedgingQuote, k: StrikeKey): number {
  return k === "atm" ? q.atmStrike : k === "otm5" ? q.otm5Strike : q.otm10Strike;
}
function premiumOf(q: HedgingQuote, k: StrikeKey): number | null {
  return k === "atm" ? q.atmPremium : k === "otm5" ? q.otm5Premium : q.otm10Premium;
}
function pctOf(q: HedgingQuote, k: StrikeKey): number | null {
  return k === "atm" ? q.atmPctOfSpot : k === "otm5" ? q.otm5PctOfSpot : q.otm10PctOfSpot;
}

function premiumFromSnapshot(snap: HedgingSnapshot, expiry: string, k: StrikeKey): number | null {
  const row = snap.quotes.find((q) => q.expiry === expiry);
  if (!row) return null;
  return k === "atm" ? row.atmPremium : k === "otm5" ? row.otm5Premium : row.otm10Premium;
}

/** Find snapshot closest to target days-ago (within tolerance) */
function findSnapshotDaysAgo(history: HedgingSnapshot[], daysAgo: number, toleranceDays: number): HedgingSnapshot | null {
  if (history.length === 0) return null;
  const today = new Date();
  const target = new Date(today.getTime() - daysAgo * 86400000);
  const targetISO = target.toISOString().slice(0, 10);

  let best: HedgingSnapshot | null = null;
  let bestDiff = Infinity;
  for (const s of history) {
    const diff = Math.abs((new Date(s.date).getTime() - new Date(targetISO).getTime()) / 86400000);
    if (diff <= toleranceDays && diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  return best;
}

function fmtDollar(v: number | null): string {
  if (v == null) return "—";
  return `$${v.toFixed(2)}`;
}

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  return `${v.toFixed(2)}%`;
}

function fmtDelta(v: number | null): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function fmtFetchedAt(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

type ViewMode = "current" | "wow" | "mom";

export default function HedgingDashboard() {
  const [data, setData] = useState<HedgingLiveData | null>(null);
  const [history, setHistory] = useState<HedgingSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("current");

  const loadAll = useCallback(async (persist: boolean) => {
    setError(null);
    const pending: Promise<unknown>[] = [
      fetch("/api/hedging", { cache: "no-store" }).then(async (r) => {
        if (!r.ok) throw new Error(`Hedging fetch failed (${r.status})`);
        return r.json() as Promise<HedgingLiveData>;
      }),
      fetch("/api/kv/hedging-history", { cache: "no-store" }).then(async (r) => {
        if (!r.ok) return { snapshots: [], lastUpdated: null };
        return r.json() as Promise<HedgingHistory>;
      }),
    ];

    try {
      const [live, hist] = (await Promise.all(pending)) as [HedgingLiveData, HedgingHistory];
      setData(live);
      setHistory(hist.snapshots || []);

      // Persist today's snapshot
      if (persist && live && live.quotes.length > 0) {
        const today = new Date().toISOString().slice(0, 10);
        const snapshot: HedgingSnapshot = {
          date: today,
          fetchedAt: live.fetchedAt,
          spotPrice: live.spotPrice,
          quotes: live.quotes.map((q) => ({
            expiry: q.expiry,
            atmStrike: q.atmStrike,
            atmPremium: q.atmPremium,
            otm5Strike: q.otm5Strike,
            otm5Premium: q.otm5Premium,
            otm10Strike: q.otm10Strike,
            otm10Premium: q.otm10Premium,
          })),
        };
        fetch("/api/kv/hedging-history", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(snapshot),
        }).catch(() => { /* non-blocking */ });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await loadAll(true);
      setLoading(false);
    })();
  }, [loadAll]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAll(true);
    setRefreshing(false);
  }, [loadAll]);

  // WoW / MoM reference snapshots
  const wowSnap = useMemo(() => findSnapshotDaysAgo(history, 7, 2), [history]);
  const momSnap = useMemo(() => findSnapshotDaysAgo(history, 30, 5), [history]);

  /** % change in premium vs. reference snapshot for a given strike+expiry */
  const deltaFor = useCallback((q: HedgingQuote, k: StrikeKey, refSnap: HedgingSnapshot | null): number | null => {
    if (!refSnap) return null;
    const prior = premiumFromSnapshot(refSnap, q.expiry, k);
    const curr = premiumOf(q, k);
    if (prior == null || curr == null || prior === 0) return null;
    return ((curr - prior) / prior) * 100;
  }, []);

  return (
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-slate-900 md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-800">Hedging</h1>
            <p className="text-sm text-slate-500 mt-1">
              SPY protective put premiums · ATM / ~5% OTM / ~10% OTM · strikes rounded to nearest $5
            </p>
          </div>
          <div className="flex items-center gap-2">
            {data && (
              <span className="text-xs text-slate-400 hidden sm:inline">
                Updated {fmtFetchedAt(data.fetchedAt)}
              </span>
            )}
            <button
              onClick={handleRefresh}
              disabled={refreshing || loading}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              <svg className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
              </svg>
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>

        {/* Spot + summary */}
        {data && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
              <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">SPY Spot</div>
              <div className="text-sm font-bold mt-0.5 text-slate-800">${data.spotPrice.toFixed(2)}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
              <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">ATM Strike</div>
              <div className="text-sm font-bold mt-0.5 text-slate-800">
                ${data.quotes[0] ? data.quotes[0].atmStrike : "—"}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
              <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">~5% OTM Strike</div>
              <div className="text-sm font-bold mt-0.5 text-slate-800">
                ${data.quotes[0] ? data.quotes[0].otm5Strike : "—"}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
              <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">~10% OTM Strike</div>
              <div className="text-sm font-bold mt-0.5 text-slate-800">
                ${data.quotes[0] ? data.quotes[0].otm10Strike : "—"}
              </div>
            </div>
          </div>
        )}

        {/* View toggle */}
        <div className="flex gap-1 mb-4 bg-white rounded-xl border border-slate-200 p-1 w-fit">
          {[
            { key: "current" as ViewMode, label: "Current" },
            { key: "wow" as ViewMode, label: "Week over Week" },
            { key: "mom" as ViewMode, label: "Month over Month" },
          ].map((v) => (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors whitespace-nowrap ${
                view === v.key ? "bg-slate-800 text-white" : "text-slate-500 hover:text-slate-800 hover:bg-slate-50"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>

        {error && (
          <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <div className="text-center py-12 text-slate-400 text-sm">Loading SPY option chain...</div>
        ) : !data || data.quotes.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-8 text-center">
            <p className="text-slate-400 text-sm">No hedging data available.</p>
          </div>
        ) : (
          <>
            {/* Main table */}
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50 text-xs text-slate-500">
                      <th className="text-left py-2.5 pl-5 pr-2 font-semibold">Strike</th>
                      <th className="text-right py-2.5 px-2 font-semibold">$</th>
                      {data.quotes.map((q) => (
                        <th key={q.expiry} className="text-right py-2.5 px-2 font-semibold">
                          <div>{q.expiryLabel}</div>
                          <div className="text-[9px] font-normal text-slate-400">{q.daysToExpiry}d</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {STRIKE_ROWS.map((row) => (
                      <tr key={row.key} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                        <td className="py-2.5 pl-5 pr-2 font-semibold text-slate-700 text-xs">{row.label}</td>
                        <td className="py-2.5 px-2 text-right font-mono text-xs font-semibold text-slate-600">
                          ${strikeOf(data.quotes[0], row.key)}
                        </td>
                        {data.quotes.map((q) => {
                          if (view === "current") {
                            const prem = premiumOf(q, row.key);
                            const pct = pctOf(q, row.key);
                            return (
                              <td key={q.expiry} className="py-2.5 px-2 text-right">
                                <div className="font-mono text-xs font-semibold text-slate-800">
                                  {fmtDollar(prem)}
                                </div>
                                <div className="font-mono text-[10px] text-slate-400">
                                  {fmtPct(pct)}
                                </div>
                              </td>
                            );
                          }
                          const ref = view === "wow" ? wowSnap : momSnap;
                          const delta = deltaFor(q, row.key, ref);
                          const prior = ref ? premiumFromSnapshot(ref, q.expiry, row.key) : null;
                          const curr = premiumOf(q, row.key);
                          return (
                            <td key={q.expiry} className="py-2.5 px-2 text-right">
                              <div className={`font-mono text-xs font-semibold ${
                                delta == null ? "text-slate-400" :
                                delta > 0 ? "text-red-600" :
                                delta < 0 ? "text-emerald-600" : "text-slate-500"
                              }`}>
                                {fmtDelta(delta)}
                              </div>
                              <div className="font-mono text-[10px] text-slate-400">
                                {prior != null && curr != null ? `${fmtDollar(prior)} → ${fmtDollar(curr)}` : "—"}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(view === "wow" || view === "mom") && (
                <div className="px-5 py-2.5 border-t border-slate-100 text-[11px] text-slate-400">
                  {view === "wow" ? (
                    wowSnap ? (
                      <>Comparing to snapshot from {wowSnap.date} (SPY ${wowSnap.spotPrice.toFixed(2)})</>
                    ) : (
                      <>No snapshot ~7 days ago yet — keep refreshing to build history.</>
                    )
                  ) : momSnap ? (
                    <>Comparing to snapshot from {momSnap.date} (SPY ${momSnap.spotPrice.toFixed(2)})</>
                  ) : (
                    <>No snapshot ~30 days ago yet — keep refreshing to build history.</>
                  )}
                  {view === "wow" || view === "mom" ? (
                    <span className="ml-2 text-slate-400">· Red = more expensive · Green = cheaper</span>
                  ) : null}
                </div>
              )}
            </div>

            {/* Footnote */}
            <p className="mt-3 text-[11px] text-slate-400">
              Premiums are mid-prices (bid+ask)/2 where available, else last traded price. Strikes round to
              nearest $5 from the live SPY spot. Standard monthly expiries (3rd-Friday contracts) only.
              Snapshots are captured on every refresh and stored permanently for week/month comparisons.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
