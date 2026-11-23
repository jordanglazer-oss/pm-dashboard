"use client";

/**
 * Spot-check & verification panel for a COMPUTED score (growth or quality).
 *
 * Code can check the arithmetic; only a person at a FactSet terminal can check
 * that each formula returns what its name says. This panel shows:
 *   - whether the peer bands are healthy (age, the calibration's own checks),
 *   - whether anyone has recorded a spot check (and against which calibration),
 *   - the spot-check set: ~12 companies covering the awkward cases, each with
 *     the exact formula, the value we stored and the arithmetic written out,
 *   - a CSV of that set to fill in at the terminal,
 *   - a form to record the result (append-only, POST /api/scoring-verification).
 *
 * Open state persists (pm:ui-prefs). Reads /api/<score>-bands/detail?spot=1.
 */

import React, { useCallback, useEffect, useState } from "react";
import { usePersistedOpen } from "@/app/lib/useCollapsed";

type Card = { ticker: string; group: string; why: string; fields: { label: string; formula: string; unit: string; value: number | null }[]; arithmetic: { metric: string; used: boolean; text: string }[] };
type Resp = {
  stored: boolean; calibratedAt?: string; inSync?: boolean;
  health?: { usable: boolean; ageDays: number | null; reason: string | null; warning: string | null; selfChecked: boolean | null };
  selfChecks?: { ranAt: string; passed: boolean; hardFailures: string[]; warnings: string[] } | null;
  verification?: { verified: boolean; current: boolean; text: string };
  spotCheck?: Card[]; spotCheckNote?: string;
};

const fmt = (v: number | null) => (v == null ? "missing" : Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toLocaleString("en-US", { maximumFractionDigits: 4 }));

export function ScoreVerificationPanel({ score }: { score: "growth" | "quality" }) {
  const [open, toggle] = usePersistedOpen(`methodology.verify.${score}.open`, true);
  const [data, setData] = useState<Resp | null>(null);
  const [who, setWho] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/${score}-bands/detail?spot=1`).then((r) => r.json()).then((d: Resp) => setData(d)).catch(() => setData({ stored: false }));
  }, [score]);
  useEffect(() => { load(); }, [load]);

  const record = async (result: "matched" | "mismatched") => {
    if (!data?.spotCheck?.length) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/scoring-verification", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ score, who, result, notes, tickers: data.spotCheck.map((c) => c.ticker) }) });
      const d = await res.json();
      if (!res.ok) setMsg(d.error ?? "Could not save.");
      else { setMsg("Recorded."); setNotes(""); load(); }
    } catch { setMsg("Could not save."); }
    setBusy(false);
  };

  const v = data?.verification, h = data?.health;
  return (
    <section className="rounded border border-line bg-surface">
      <button type="button" onClick={toggle} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] font-medium text-ink hover:bg-surface-hover">
        <span>Check these figures against FactSet</span>
        <span className={`text-[11.5px] ${v?.verified ? "text-pos" : "text-warn"}`}>{!data ? "loading…" : !data.stored ? "no calibration on file" : v?.verified ? "verified" : "not verified"}</span>
      </button>
      {open && data && (
        <div className="flex flex-col gap-3 border-t border-line px-3 py-3 text-[12.5px] leading-relaxed text-ink-2">
          {!data.stored ? (
            <p>The calibration has not been stored yet, so there is nothing to check.</p>
          ) : (
            <>
              <p>
                The app checks its own arithmetic. It cannot check that each FactSet formula returns what its name says — only a person at a FactSet terminal can.
                Compare the companies below with the terminal, then record the result. Until someone does, treat the {score} score as unverified.
              </p>
              <ul className="flex flex-col gap-0.5">
                <li><span className={v?.verified ? "text-pos" : "text-warn"}>{v?.text}</span></li>
                <li>
                  Peer bands calibrated {data.calibratedAt?.slice(0, 10)}{h?.ageDays != null ? ` (${h.ageDays} days ago)` : ""}.{" "}
                  {h && !h.usable ? <span className="text-neg">Not in use: {h.reason}.</span> : h?.warning ? <span className="text-warn">{h.warning}.</span> : "In use."}
                </li>
                <li>
                  Calibration&apos;s own checks:{" "}
                  {data.selfChecks == null ? <span className="text-warn">not run (calibrated before they existed — re-run the calibration)</span>
                    : data.selfChecks.passed ? <span className="text-pos">passed{data.selfChecks.warnings.length ? `, ${data.selfChecks.warnings.length} warning(s)` : ""}</span>
                    : <span className="text-neg">FAILED — {data.selfChecks.hardFailures.join("; ")}</span>}
                </li>
                {data.inSync === false && <li><span className="text-neg">The bands and the per-company detail come from different calibration runs — re-run the calibration.</span></li>}
              </ul>
              {data.selfChecks?.warnings.length ? (
                <ul className="list-disc pl-4 text-ink-3">{data.selfChecks.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <a href={`/api/${score}-bands/detail?spot=csv`} className="rounded border border-line px-2.5 py-1 text-[12px] !text-accent-ink hover:bg-surface-hover">Download the spot-check sheet (CSV)</a>
                <span className="text-ink-3">{data.spotCheck?.length ?? 0} companies. {data.spotCheckNote}</span>
              </div>

              <div className="flex flex-col gap-2">
                {data.spotCheck?.map((c) => (
                  <div key={c.ticker} className="rounded border border-line p-2">
                    <div><span className="font-medium text-ink">{c.ticker}</span> · {c.group} <span className="text-ink-3">— {c.why}</span></div>
                    <div className="overflow-x-auto">
                      <table className="mt-1 w-full text-[11.5px]">
                        <thead><tr className="text-left text-ink-3"><th className="pr-2 font-normal">Field</th><th className="pr-2 font-normal">FactSet formula</th><th className="text-right font-normal">Value we stored</th></tr></thead>
                        <tbody>
                          {c.fields.map((f) => (
                            <tr key={f.formula} className="border-t border-line">
                              <td className="py-0.5 pr-2">{f.label} <span className="text-ink-3">({f.unit})</span></td>
                              <td className="pr-2 font-mono text-[11px]">{f.formula}</td>
                              <td className="text-right tabular-nums">{fmt(f.value)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {c.arithmetic.map((a) => <li key={a.metric}><span className={a.used ? "text-ink" : "text-ink-3"}>{a.text}</span></li>)}
                    </ul>
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-2 rounded border border-line p-2">
                <div className="font-medium text-ink">Record the result</div>
                <div className="flex flex-wrap items-center gap-2">
                  <input value={who} onChange={(e) => setWho(e.target.value)} placeholder="Who checked" className="rounded border border-line bg-surface px-2 py-1 text-[12.5px]" />
                  <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (required for a mismatch: which company, which figure)" className="min-w-[260px] flex-1 rounded border border-line bg-surface px-2 py-1 text-[12.5px]" />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" disabled={busy || !who.trim()} onClick={() => record("matched")} className="rounded border border-line px-2.5 py-1 text-[12px] disabled:opacity-50"><span className="text-pos">Every figure matched</span></button>
                  <button type="button" disabled={busy || !who.trim() || !notes.trim()} onClick={() => record("mismatched")} className="rounded border border-line px-2.5 py-1 text-[12px] disabled:opacity-50"><span className="text-neg">Something did not match</span></button>
                  {msg && <span className="text-ink-3">{msg}</span>}
                </div>
                <p className="text-[11.5px] text-ink-3">Entries are kept permanently and cannot be edited. A check applies to the calibration it was made against; after a re-calibration the score reads &quot;not verified&quot; again until re-checked.</p>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
