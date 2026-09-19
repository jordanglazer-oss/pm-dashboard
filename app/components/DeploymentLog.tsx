"use client";

/**
 * Deployment log — lives inside the Brief's Cash Deployment tile.
 *
 * Records the day the monthly installment actually went in (pm:deployments via
 * /api/kv/deployments — one entry added or voided at a time, never a
 * whole-list write). Once the month is fully logged the brief stops making a
 * cash call until the 1st. The timing record grades each logged day against
 * the 1st–20th window it sat in; the arithmetic is shown, not summarised away.
 */

import React, { useCallback, useEffect, useState } from "react";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import type { Deployment, TimingRow } from "@/app/lib/deployments";

type Scorecard = { rows: TimingRow[]; monthsBeaten: number; monthsGraded: number; avgAdvantagePct: number | null };
export type LedgerStatus = "none" | "half" | "full";

const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function DeploymentLog({ onStatus }: { onStatus?: (s: LedgerStatus) => void }) {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [formOpen, setFormOpen] = useState(false); // inline form — deliberately transient
  const [date, setDate] = useState(todayET());
  const [portion, setPortion] = useState<"full" | "half">("full");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recordOpen, toggleRecord] = usePersistedOpen("brief.deploymentLog.record", false);

  const month = todayET().slice(0, 7);
  const mine = deployments.filter((d) => !d.voided && d.month === month).sort((a, b) => a.date.localeCompare(b.date));
  const fraction = Math.min(1, mine.reduce((s, d) => s + (d.portion === "full" ? 1 : 0.5), 0));
  const status: LedgerStatus = fraction >= 1 ? "full" : fraction > 0 ? "half" : "none";

  const load = useCallback(async () => {
    try {
      const j = await (await fetch("/api/kv/deployments")).json();
      if (Array.isArray(j?.deployments)) setDeployments(j.deployments as Deployment[]);
      if (j?.scorecard) setScorecard(j.scorecard as Scorecard);
    } catch { /* tile degrades to "not logged" */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { onStatus?.(status); }, [status, onStatus]);

  async function post(body: unknown) {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/kv/deployments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok) { setError(j?.error ?? "Could not save"); return false; }
      await load();
      return true;
    } catch { setError("Could not save"); return false; } finally { setBusy(false); }
  }

  const rows = scorecard?.rows ?? [];

  return (
    <div className="mt-3 border-t border-line pt-3 text-[12px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-ink-2">
          {status === "none" && "Not logged as deployed this month"}
          {status !== "none" && (
            <>
              <span className="font-semibold text-ink">{status === "full" ? "Deployed" : "Half deployed"}</span>{" "}
              {mine.map((d) => `${shortDate(d.date)} (${d.portion})`).join(", ")}
            </>
          )}
        </span>
        {status !== "full" && !formOpen && (
          <button type="button" onClick={() => { setFormOpen(true); setPortion(status === "half" ? "half" : "full"); }} className="rounded border border-line bg-surface px-2 py-1 text-[11px] font-semibold text-ink hover:bg-surface-hover">
            Log deployment
          </button>
        )}
      </div>

      {formOpen && (
        <div className="mt-2 grid gap-2 rounded border border-line bg-surface p-2 sm:grid-cols-[auto_auto_1fr_auto]">
          <label className="flex flex-col gap-0.5"><span className="text-[10px] uppercase tracking-wide text-ink-3">Day</span>
            <input id="deploy-log-date" type="date" max={todayET()} value={date} onChange={(e) => setDate(e.target.value)} className="rounded border border-line bg-surface px-1.5 py-1" /></label>
          <label className="flex flex-col gap-0.5"><span className="text-[10px] uppercase tracking-wide text-ink-3">Amount</span>
            <select id="deploy-log-portion" value={portion} onChange={(e) => setPortion(e.target.value as "full" | "half")} className="rounded border border-line bg-surface px-1.5 py-1">
              <option value="full">Full installment</option><option value="half">Half</option>
            </select></label>
          <label className="flex flex-col gap-0.5"><span className="text-[10px] uppercase tracking-wide text-ink-3">Note (optional)</span>
            <input id="deploy-log-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={280} className="rounded border border-line bg-surface px-1.5 py-1" /></label>
          <div className="flex items-end gap-1.5">
            <button type="button" disabled={busy} onClick={async () => { if (await post({ add: { date, portion, note } })) { setFormOpen(false); setNote(""); } }} className="rounded bg-ink px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50">Save</button>
            <button type="button" onClick={() => { setFormOpen(false); setError(null); }} className="rounded border border-line px-2.5 py-1 text-[11px]">Cancel</button>
          </div>
          {error && <div className="text-neg sm:col-span-4">{error}</div>}
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-2">
          <button type="button" onClick={toggleRecord} className="text-[11px] font-medium text-accent hover:underline">
            {recordOpen ? "Hide" : "Show"} timing record ({rows.length})
          </button>
          {recordOpen && scorecard && (
            <div className="mt-2">
              <p className="text-ink-2">
                {scorecard.monthsGraded > 0
                  ? <>Beat the window average in <span className="font-semibold text-ink">{scorecard.monthsBeaten} of {scorecard.monthsGraded}</span> months{scorecard.avgAdvantagePct != null ? <> (average {scorecard.avgAdvantagePct >= 0 ? "+" : ""}{scorecard.avgAdvantagePct.toFixed(2)}%)</> : null}. </>
                  : "No month can be graded yet. "}
                <span className="text-ink-3">Measured on SPY, a stand-in for the book. With {scorecard.monthsGraded} month{scorecard.monthsGraded === 1 ? "" : "s"} of data this is anecdote, not a success rate.</span>
              </p>
              <div className="mt-1.5 overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead><tr className="border-b border-line text-left text-[10px] uppercase tracking-wide text-ink-3">
                    <th className="py-1 pr-2">Day</th><th className="px-2">Amount</th><th className="px-2">SPY close</th><th className="px-2">Window avg (1st–20th)</th><th className="px-2">vs average</th><th className="px-2">Rank in window</th><th className="px-2">Brief said</th><th className="px-2"></th>
                  </tr></thead>
                  <tbody>
                    {rows.map((r) => {
                      const dep = deployments.find((d) => !d.voided && d.date === r.date && d.portion === r.portion);
                      return (
                        <tr key={`${r.date}-${r.portion}-${dep?.id ?? ""}`} className="border-b border-line">
                          <td className="py-1 pr-2 tabular-nums">{r.date}</td>
                          <td className="px-2">{r.portion}</td>
                          <td className="px-2 tabular-nums">{r.close != null ? `$${r.close.toFixed(2)}` : "—"}</td>
                          <td className="px-2 tabular-nums">{r.windowAvg != null ? `$${r.windowAvg.toFixed(2)}` : "—"}</td>
                          <td className={`px-2 tabular-nums ${r.advantagePct == null ? "" : r.advantagePct >= 0 ? "text-pos" : "text-neg"}`}>{r.advantagePct != null ? `${r.advantagePct >= 0 ? "+" : ""}${r.advantagePct.toFixed(2)}%` : "—"}</td>
                          <td className="px-2 tabular-nums">{r.rank != null ? `${r.rank} of ${r.windowDays} (1 = cheapest)` : "window still open"}</td>
                          <td className="px-2">{r.brief ? `${r.brief.action === "DEPLOY_PARTIAL" ? "PARTIAL" : r.brief.action}${r.brief.score != null ? ` · ${r.brief.score}` : ""}${r.followedBrief === false ? " — not followed" : ""}` : "no brief that day"}</td>
                          <td className="px-2 text-right">{dep && dep.month === month && (
                            <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Void the ${r.date} entry? It stays in the log, marked void.`)) void post({ voidId: dep.id }); }} className="text-ink-3 hover:text-neg hover:underline">void</button>
                          )}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-ink-3">“vs average” is how much cheaper (+) or dearer (−) the close on your day was than the average close across the window for that month: what spreading the cash evenly would have paid. A month still inside its window is graded on the days so far.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
