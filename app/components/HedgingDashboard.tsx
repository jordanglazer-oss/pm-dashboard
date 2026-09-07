"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStocks } from "@/app/lib/StockContext";
import type { HedgingLiveData, HedgingQuote, CustomStrikeRow } from "@/app/api/hedging/route";
import type { HedgingHistory, HedgingSnapshot } from "@/app/api/kv/hedging-history/route";
import type { HedgingCustomStrikes } from "@/app/api/kv/hedging-custom-strikes/route";
import { AppIcon } from "./AppIcon";
import { StatStrip } from "./StatStrip";
import { EmptyState } from "./EmptyState";

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

/** WoW/MoM lookup for a custom strike: match by numeric strike, then by expiry. */
function customPremiumFromSnapshot(snap: HedgingSnapshot, strike: number, expiry: string): number | null {
  const row = snap.customRows?.find((r) => r.strike === strike);
  if (!row) return null;
  return row.quotes.find((q) => q.expiry === expiry)?.premium ?? null;
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
  const [customStrikes, setCustomStrikes] = useState<number[]>([]);
  const [newStrikeInput, setNewStrikeInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("current");
  const { priceRefreshNonce } = useStocks();

  const loadAll = useCallback(async (persist: boolean, strikes: number[]) => {
    setError(null);
    const qs = strikes.length > 0 ? `?extraStrikes=${strikes.join(",")}` : "";
    const pending: Promise<unknown>[] = [
      fetch(`/api/hedging${qs}`, { cache: "no-store" }).then(async (r) => {
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

      // Persist today's snapshot (includes custom strike premiums for WoW/MoM)
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
          customRows: (live.customRows || []).map((r) => ({
            strike: r.strike,
            quotes: r.quotes.map((q) => ({ expiry: q.expiry, premium: q.premium })),
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

  // Initial mount: load custom strikes first, then live data with them
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const r = await fetch("/api/kv/hedging-custom-strikes", { cache: "no-store" });
        if (r.ok) {
          const cs = (await r.json()) as HedgingCustomStrikes;
          const clean = (cs.strikes || []).filter((n) => Number.isFinite(n) && n > 0);
          setCustomStrikes(clean);
          await loadAll(true, clean);
        } else {
          await loadAll(true, []);
        }
      } catch {
        await loadAll(true, []);
      }
      setLoading(false);
    })();
  }, [loadAll]);

  const persistCustomStrikes = useCallback(async (next: number[]) => {
    try {
      await fetch("/api/kv/hedging-custom-strikes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strikes: next }),
      });
    } catch {
      /* non-blocking */
    }
  }, []);

  const handleAddStrike = useCallback(async () => {
    const parsed = parseFloat(newStrikeInput.trim());
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    if (customStrikes.includes(parsed)) {
      setNewStrikeInput("");
      return;
    }
    const next = [...customStrikes, parsed].sort((a, b) => b - a);
    setCustomStrikes(next);
    setNewStrikeInput("");
    // Re-fetch live data with the new strike and persist the list
    await Promise.all([persistCustomStrikes(next), loadAll(false, next)]);
  }, [newStrikeInput, customStrikes, persistCustomStrikes, loadAll]);

  const handleRemoveStrike = useCallback(async (strike: number) => {
    const next = customStrikes.filter((s) => s !== strike);
    setCustomStrikes(next);
    await Promise.all([persistCustomStrikes(next), loadAll(false, next)]);
  }, [customStrikes, persistCustomStrikes, loadAll]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAll(true, customStrikes);
    setRefreshing(false);
  }, [loadAll, customStrikes]);

  // When the nav "Refresh prices" button runs, re-pull the visible table so an
  // open Hedging tab updates too. That refresh already captured a fresh
  // snapshot server-side (/api/hedging/snapshot), so reload display-only
  // (persist=false) to avoid a duplicate same-day write.
  const nonceSeen = useRef(0);
  useEffect(() => {
    if (priceRefreshNonce === nonceSeen.current) return;
    nonceSeen.current = priceRefreshNonce;
    if (priceRefreshNonce === 0) return;
    // Defer off the effect tick so loadAll's internal setState isn't called
    // synchronously within the effect (avoids cascading-render churn).
    const id = setTimeout(() => { void loadAll(false, customStrikes); }, 0);
    return () => clearTimeout(id);
  }, [priceRefreshNonce, loadAll, customStrikes]);

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

  /** WoW/MoM % change for a custom strike at a given expiry */
  const customDeltaFor = useCallback(
    (row: CustomStrikeRow, expiry: string, refSnap: HedgingSnapshot | null): number | null => {
      if (!refSnap) return null;
      const prior = customPremiumFromSnapshot(refSnap, row.strike, expiry);
      const curr = row.quotes.find((q) => q.expiry === expiry)?.premium ?? null;
      if (prior == null || curr == null || prior === 0) return null;
      return ((curr - prior) / prior) * 100;
    },
    [],
  );

  const seg = [
    { key: "current" as ViewMode, label: "Current" },
    { key: "wow" as ViewMode, label: "Week over week" },
    { key: "mom" as ViewMode, label: "Month over month" },
  ];
  const ref = view === "wow" ? wowSnap : view === "mom" ? momSnap : null;
  const tdTone = (delta: number | null) =>
    delta == null ? "text-ink-3" : delta > 0 ? "text-neg" : delta < 0 ? "text-pos" : "text-ink-3";

  return (
    // Full-width inside the shell's content column; the page title lives in
    // the top bar. First row = the toolbar: view seg · updated · Refresh.
    <main className="flex flex-col gap-3.5 text-ink">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="seg">
          {seg.map((v) => (
            <button key={v.key} type="button" className={view === v.key ? "on" : ""} onClick={() => setView(v.key)}>
              {v.label}
            </button>
          ))}
        </div>
        <span className="text-[12px] text-ink-3">
          SPY protective put premiums · ATM / ~5% OTM / ~10% OTM · strikes rounded to nearest $5
        </span>
        <div className="ml-auto flex items-center gap-2">
          {data && <span className="text-[11.5px] text-ink-3">Updated {fmtFetchedAt(data.fetchedAt)}</span>}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing || loading}
            className="inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 transition-colors hover:bg-surface-hover disabled:opacity-50"
          >
            <AppIcon name="refresh" size={13} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {/* Spot + the three reference strikes, one hairline strip. */}
      {data && (
        <StatStrip
          cols={4}
          items={[
            { label: "SPY spot", value: `$${data.spotPrice.toFixed(2)}` },
            { label: "ATM strike", value: data.quotes[0] ? `$${data.quotes[0].atmStrike}` : "—" },
            { label: "~5% OTM strike", value: data.quotes[0] ? `$${data.quotes[0].otm5Strike}` : "—" },
            { label: "~10% OTM strike", value: data.quotes[0] ? `$${data.quotes[0].otm10Strike}` : "—" },
          ]}
        />
      )}

      {error && <div className="panel px-3.5 py-2.5 text-[12.5px] text-neg">{error}</div>}

      {loading ? (
        <div className="panel py-10 text-center text-[12.5px] text-ink-3">Loading SPY option chain…</div>
      ) : !data || data.quotes.length === 0 ? (
        <section className="panel">
          <EmptyState glyph={<AppIcon name="umbrella" size={18} />} title="No hedging data" body="The SPY option chain did not come back. Refresh to try again." />
        </section>
      ) : (
        <section className="panel">
          <div className="panel-h">
            <span className="t">Put chain</span>
            <span className="m">
              {view === "current" ? "mid premium · % of spot" : view === "wow" ? "premium vs ~7 days ago" : "premium vs ~30 days ago"}
            </span>
            {view !== "current" && (
              <span className="m ml-auto">
                <span className="dot bg-neg mr-1.5 align-[1px]" />more expensive · <span className="dot bg-pos mr-1.5 align-[1px]" />cheaper
              </span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="pl-3.5">Strike</th>
                  <th className="n">$</th>
                  {data.quotes.map((q) => (
                    <th key={q.expiry} className="n">
                      {q.expiryLabel} <span className="font-mono text-ink-faint">{q.daysToExpiry}d</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {STRIKE_ROWS.map((row) => (
                  <tr key={row.key}>
                    <td className="pl-3.5 text-ink-2">{row.label}</td>
                    <td className="n text-ink-2">${strikeOf(data.quotes[0], row.key)}</td>
                    {data.quotes.map((q) => {
                      if (view === "current") {
                        return (
                          <td key={q.expiry} className="n">
                            {fmtDollar(premiumOf(q, row.key))}
                            <span className="ml-1.5 text-[11px] text-ink-3">{fmtPct(pctOf(q, row.key))}</span>
                          </td>
                        );
                      }
                      const delta = deltaFor(q, row.key, ref);
                      const prior = ref ? premiumFromSnapshot(ref, q.expiry, row.key) : null;
                      const curr = premiumOf(q, row.key);
                      return (
                        <td key={q.expiry} className={`n ${tdTone(delta)}`}>
                          {fmtDelta(delta)}
                          <span className="ml-1.5 text-[11px] text-ink-3">
                            {prior != null && curr != null ? `${fmtDollar(prior)} → ${fmtDollar(curr)}` : "—"}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}

                {/* Custom user-added strike rows */}
                {(data.customRows || []).map((row) => (
                  <tr key={`custom-${row.strike}`}>
                    <td className="pl-3.5 text-ink-2">
                      <span className="inline-flex items-center gap-1.5">
                        Custom
                        <button
                          type="button"
                          onClick={() => handleRemoveStrike(row.strike)}
                          className="grid h-5 w-5 place-items-center rounded-control text-ink-faint hover:bg-surface-hover hover:text-neg"
                          aria-label={`Remove ${row.strike}`}
                          title="Remove row"
                        >
                          <AppIcon name="x" size={12} />
                        </button>
                      </span>
                    </td>
                    <td className="n text-ink-2">${row.strike}</td>
                    {data.quotes.map((q) => {
                      const cq = row.quotes.find((r) => r.expiry === q.expiry);
                      if (view === "current") {
                        return (
                          <td key={q.expiry} className="n">
                            {fmtDollar(cq?.premium ?? null)}
                            <span className="ml-1.5 text-[11px] text-ink-3">{fmtPct(cq?.pctOfSpot ?? null)}</span>
                          </td>
                        );
                      }
                      const delta = customDeltaFor(row, q.expiry, ref);
                      const prior = ref ? customPremiumFromSnapshot(ref, row.strike, q.expiry) : null;
                      const curr = cq?.premium ?? null;
                      return (
                        <td key={q.expiry} className={`n ${tdTone(delta)}`}>
                          {fmtDelta(delta)}
                          <span className="ml-1.5 text-[11px] text-ink-3">
                            {prior != null && curr != null ? `${fmtDollar(prior)} → ${fmtDollar(curr)}` : "—"}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}

                {/* Add-custom-strike input row */}
                <tr>
                  <td className="pl-3.5 text-ink-3">Add strike</td>
                  <td className="text-right" colSpan={1 + data.quotes.length}>
                    <div className="flex items-center justify-end gap-2">
                      <label className="inline-flex h-7 items-center rounded-control border border-line bg-surface px-2.5 text-[12.5px] focus-within:border-accent-border">
                        <span className="mr-1 text-ink-3">$</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          step="1"
                          min="1"
                          placeholder="e.g. 680"
                          value={newStrikeInput}
                          onChange={(e) => setNewStrikeInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleAddStrike();
                            }
                          }}
                          className="w-20 bg-transparent font-mono text-[12.5px] text-ink outline-none"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={handleAddStrike}
                        disabled={!newStrikeInput.trim()}
                        className="inline-flex h-7 items-center rounded-control bg-ink px-3 text-[12.5px] font-medium text-white hover:bg-ink-2 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Add
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {(view === "wow" || view === "mom") && (
            <div className="flex h-8 items-center border-t border-line-soft px-3.5 text-[11.5px] text-ink-3">
              {view === "wow" ? (
                wowSnap ? (
                  <>Comparing to the snapshot from {wowSnap.date} (SPY ${wowSnap.spotPrice.toFixed(2)})</>
                ) : (
                  <>No snapshot ~7 days ago yet — keep refreshing to build history.</>
                )
              ) : momSnap ? (
                <>Comparing to the snapshot from {momSnap.date} (SPY ${momSnap.spotPrice.toFixed(2)})</>
              ) : (
                <>No snapshot ~30 days ago yet — keep refreshing to build history.</>
              )}
            </div>
          )}
        </section>
      )}

      {!loading && data && data.quotes.length > 0 && (
        <p className="text-[11.5px] leading-[1.5] text-ink-3">
          Premiums are mid-prices (bid+ask)/2 where available, else last traded price. Strikes round to
          nearest $5 from the live SPY spot. One expiry per calendar month (3rd-Friday preferred).
          Custom strikes are priced only if that exact strike is listed on CBOE; otherwise the cell shows &quot;—&quot;.
          Snapshots are captured on every refresh and stored permanently for week/month comparisons.
        </p>
      )}
    </main>
  );
}
