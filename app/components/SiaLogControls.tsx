"use client";

import React, { useEffect, useRef, useState } from "react";

/**
 * Where "Contribution by holding" gets its holdings, and the controls for it:
 * load an SIA transaction-log export (preview first, then save), and switch
 * between the SIA log and the dashboard's own trade log. Talks only to
 * /api/admin/sia-transactions, which touches one key and never a performance
 * series — so nothing here can change recorded performance. Transient UI
 * state only (an inline form), so nothing to persist.
 */

type Status = { onFile: boolean; enabled: boolean; rows?: number; first?: string; last?: string; importedAt?: string; fileName?: string | null };
type Preview = {
  mode?: string;
  error?: string;
  refuse?: string;
  summary?: { rows: number; first: string | null; last: string | null; symbols: number; tradeDays: number; heldAtEnd: string[]; resetToZero: string[] };
  unreadableRows?: string[];
  splitsFound?: Record<string, string>;
  noPriceSource?: string[];
  modelCheck?: { date: string; rows: { symbol: string; logPct: number; modelPct: number | null }[]; worstGapPts: number | null; note: string } | null;
  onFileNow?: Status;
};

export function SiaLogControls({ source, onChanged }: { source: "sia" | "tradelog"; onChanged: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const refresh = () =>
    fetch("/api/admin/sia-transactions")
      .then((r) => r.json())
      .then((s: Status) => setStatus(s))
      .catch(() => setStatus({ onFile: false, enabled: false }));
  useEffect(() => {
    refresh();
  }, []);

  const post = async (body: object): Promise<Preview> => {
    const r = await fetch("/api/admin/sia-transactions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json()) as Preview;
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setPreview(null);
    const text = await f.text();
    setFile({ name: f.name, text });
    setBusy("Reading the file and looking up stock splits (about a minute)…");
    try {
      setPreview(await post({ csv: text, fileName: f.name }));
    } catch {
      setPreview({ error: "Could not read that file." });
    }
    setBusy(null);
  };

  const save = async (replace: boolean) => {
    if (!file) return;
    setBusy("Saving…");
    try {
      const res = await post({ csv: file.text, fileName: file.name, confirm: "LOAD", ...(replace ? { replace: true } : {}) });
      setPreview(res);
      if (res.mode === "SAVED") {
        setFile(null);
        await refresh();
        onChanged();
      }
    } catch {
      setPreview({ error: "Saving failed. Nothing was changed." });
    }
    setBusy(null);
  };

  const flip = async (action: "enable" | "disable") => {
    setBusy(action === "disable" ? "Switching back…" : "Switching…");
    try {
      await post({ action });
      await refresh();
      onChanged();
    } catch {
      /* status line stays as it was */
    }
    setBusy(null);
  };

  const s = status;
  const p = preview;
  const off = p?.modelCheck?.worstGapPts != null && p.modelCheck.worstGapPts > 1;

  return (
    <div className="mx-3.5 mt-2.5 rounded-control border border-line bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          <span className="font-semibold text-ink">Holdings source:</span>{" "}
          {source === "sia" && s?.onFile ? (
            <>SIA transaction log — actual units and trade dates, {s.first} to {s.last}</>
          ) : s?.onFile && !s.enabled ? (
            <>the dashboard&apos;s own trade log (the SIA log is on file but switched off)</>
          ) : (
            <>the dashboard&apos;s own trade log — model target weights, from 13 Apr 2026</>
          )}
        </span>
        {s?.onFile && s.enabled && (
          <button disabled={!!busy} onClick={() => flip("disable")} className="font-medium underline decoration-line underline-offset-2">
            Switch back to the trade log
          </button>
        )}
        {s?.onFile && !s.enabled && (
          <button disabled={!!busy} onClick={() => flip("enable")} className="font-medium underline decoration-line underline-offset-2">
            Use the SIA log
          </button>
        )}
        <button disabled={!!busy} onClick={() => setOpen((v) => !v)} className="font-medium underline decoration-line underline-offset-2">
          {open ? "Close" : s?.onFile ? "Load a newer SIA export" : "Load the SIA transaction log"}
        </button>
        {busy && <span className="text-ink-3">{busy}</span>}
      </div>

      {open && (
        <div className="mt-2 border-t border-line pt-2">
          <p className="text-ink-3">
            In SIA Charts, export the portfolio&apos;s transaction table (Date, Symbol, Action, Units, Price) as a CSV, then choose it here. You will see a preview before anything is saved. This only affects this panel&apos;s holding detail — it never changes recorded performance, and you can switch back at any time.
          </p>
          <input ref={input} type="file" accept=".csv,text/csv" className="mt-1.5 text-[12.5px]" onChange={(e) => pick(e.target.files?.[0])} />

          {p?.error && <p className="mt-2 text-neg">{p.error}</p>}
          {p?.refuse && <p className="mt-2 text-neg">{p.refuse}</p>}
          {p?.summary && (
            <div className="mt-2 flex flex-col gap-1.5">
              <p>
                <span className="font-semibold text-ink">{p.mode === "SAVED" ? "Saved." : "Preview — nothing saved yet."}</span> {p.summary.rows.toLocaleString()} trades on {p.summary.tradeDays} days, {p.summary.first} to {p.summary.last}; {p.summary.symbols} holdings over time, {p.summary.heldAtEnd.length} held at the end.
              </p>
              {(p.unreadableRows?.length ?? 0) > 0 && <p className="text-neg">{p.unreadableRows!.length} row(s) could not be read: {p.unreadableRows!.slice(0, 3).join(" · ")}</p>}
              {p.modelCheck && (
                <p className={off ? "text-neg" : ""}>
                  Check against the model on {p.modelCheck.date}: the largest difference in any holding&apos;s weight is {p.modelCheck.worstGapPts ?? "—"} point(s).{" "}
                  {off ? "That is larger than expected — a stock split may be missing. Ask before saving." : "That is in line with the model."}
                </p>
              )}
              {p.splitsFound && Object.keys(p.splitsFound).length > 0 && <p className="text-ink-3">Stock splits applied: {Object.entries(p.splitsFound).map(([k, v]) => k + " (" + v + ")").join("; ")}.</p>}
              {p.summary.resetToZero.length > 0 && <p className="text-ink-3">Unit counts that dipped below zero and were reset (usually reinvested fund distributions or an old merger): {p.summary.resetToZero.join(", ")}.</p>}
              {p.mode !== "SAVED" && file && (
                <div className="flex flex-wrap items-center gap-3">
                  <button disabled={!!busy} onClick={() => save(false)} className="rounded-control border border-line bg-surface px-3 py-1 font-medium text-ink">
                    Save and use this log
                  </button>
                  {p.refuse && (
                    <button disabled={!!busy} onClick={() => save(true)} className="font-medium underline decoration-line underline-offset-2">
                      Replace the one on file anyway
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
