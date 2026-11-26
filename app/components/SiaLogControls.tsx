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
type BookStatus = Status & { book: string; label: string };
const BOOKS: { id: string; label: string }[] = [
  { id: "allEquity", label: "All-Equity" },
  { id: "growth", label: "Growth" },
  { id: "balanced", label: "Balanced" },
];
type Preview = {
  mode?: string;
  sameAs?: string | null;
  error?: string;
  refuse?: string;
  summary?: { rows: number; first: string | null; last: string | null; symbols: number; tradeDays: number; heldAtEnd: string[]; resetToZero: string[] };
  unreadableRows?: string[];
  splitsFound?: Record<string, string>;
  noPriceSource?: string[];
  modelCheck?: { date: string; rows: { symbol: string; logPct: number; modelPct: number | null }[]; worstGapPts: number | null; worst?: { symbol: string; logPct: number; modelPct: number } | null; splitLike?: string[]; unpriced?: string[]; note: string } | null;
  onFileNow?: Status;
};

export function SiaLogControls({ source, onChanged }: { source: "sia" | "tradelog"; onChanged: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Which mandate the chosen file belongs to. Transient form state.
  const [book, setBook] = useState("allEquity");
  const [books, setBooks] = useState<BookStatus[]>([]);

  const refresh = () =>
    fetch("/api/admin/sia-transactions?all=1")
      .then((r) => r.json())
      .then((d: { books?: BookStatus[] }) => {
        setBooks(d.books ?? []);
        setStatus(d.books?.find((b) => b.book === "allEquity") ?? { onFile: false, enabled: false });
      })
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
      setPreview(await post({ csv: text, fileName: f.name, book }));
    } catch {
      setPreview({ error: "Could not read that file." });
    }
    setBusy(null);
  };

  const save = async (replace: boolean) => {
    if (!file) return;
    setBusy("Saving…");
    try {
      const res = await post({ csv: file.text, fileName: file.name, book, confirm: "LOAD", ...(replace ? { replace: true } : {}) });
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
  const mc = p?.modelCheck;
  const splitLike = mc?.splitLike ?? [];
  // Older responses carry no split test: fall back to the plain 1-point rule.
  const off = mc?.splitLike ? splitLike.length > 0 : mc?.worstGapPts != null && mc.worstGapPts > 1;
  const drift = !off && mc?.worstGapPts != null && mc.worstGapPts > 1;

  return (
    <div className={open ? "mx-3.5 mt-2.5 rounded-control border border-line bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2" : "px-3.5 pt-2 text-[12px] text-ink-3"}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          <span className="font-medium text-ink-2">Holdings source:</span>{" "}
          {source === "sia" && s?.onFile ? (
            <>SIA log · actual units · {s.first} to {s.last}</>
          ) : s?.onFile && !s.enabled ? (
            <>trade log · model weights (SIA log switched off)</>
          ) : (
            <>trade log · model weights · from 13 Apr 2026</>
          )}
        </span>
        {s?.onFile && s.enabled && (
          <button disabled={!!busy} onClick={() => flip("disable")} className="font-medium underline decoration-line underline-offset-2">
            Use the trade log
          </button>
        )}
        {s?.onFile && !s.enabled && (
          <button disabled={!!busy} onClick={() => flip("enable")} className="font-medium underline decoration-line underline-offset-2">
            Use the SIA log
          </button>
        )}
        <button disabled={!!busy} onClick={() => setOpen((v) => !v)} className="font-medium underline decoration-line underline-offset-2">
          {open ? "Close" : s?.onFile ? "Load a newer export" : "Load the SIA log"}
        </button>
        {busy && <span className="text-ink-3">{busy}</span>}
      </div>

      {open && (
        <div className="mt-2 border-t border-line pt-2">
          <p className="text-ink-3">Export the transaction table from SIA Charts as a CSV and choose it here. You see a preview before anything is saved; recorded performance is never changed.</p>
          <p className="mt-1.5">
            <span className="font-medium text-ink-2">On file:</span>{" "}
            {BOOKS.map((b) => {
              const st = books.find((x) => x.book === b.id);
              return `${b.label} ${st?.onFile ? `to ${st.last}` : "none"}`;
            }).join(" · ")}
          </p>
          <label className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink-2">This file is for:</span>
            <select
              value={book}
              disabled={!!busy}
              onChange={(e) => {
                setBook(e.target.value);
                setFile(null);
                setPreview(null);
                if (input.current) input.current.value = "";
              }}
              className="rounded-control border border-line bg-surface px-2 py-1 text-ink"
            >
              {BOOKS.map((b) => (
                <option key={b.id} value={b.id}>{b.label}</option>
              ))}
            </select>
            <span className="text-ink-3">Pick the mandate first, then the file.</span>
          </label>
          <input ref={input} type="file" accept=".csv,text/csv" className="mt-1.5 text-[12.5px]" onChange={(e) => pick(e.target.files?.[0])} />

          {p?.error && <p className="mt-2 text-neg">{p.error}</p>}
          {p?.refuse && <p className="mt-2 text-neg">{p.refuse}</p>}
          {p?.sameAs && <p className="mt-2 text-neg">This file is identical to the {p.sameAs} log already on file. Check you picked the right file for {BOOKS.find((b) => b.id === book)?.label}.</p>}
          {p?.summary && (
            <div className="mt-2 flex flex-col gap-1.5">
              <p>
                <span className="font-semibold text-ink">{BOOKS.find((b) => b.id === book)?.label} log. {p.mode === "SAVED" ? "Saved." : "Preview — nothing saved yet."}</span> {p.summary.rows.toLocaleString()} trades · {p.summary.first} to {p.summary.last} · {p.summary.symbols} holdings over time, {p.summary.heldAtEnd.length} held at the end
              </p>
              {(p.unreadableRows?.length ?? 0) > 0 && <p className="text-neg">{p.unreadableRows!.length} row(s) could not be read: {p.unreadableRows!.slice(0, 3).join(" · ")}</p>}
              {p.modelCheck && (
                <p className={off ? "text-neg" : ""}>
                  Model check ({p.modelCheck.date}): largest weight difference {p.modelCheck.worstGapPts ?? "—"} pt
                  {mc?.worst ? " (" + mc.worst.symbol + ": log " + mc.worst.logPct + "%, model today " + mc.worst.modelPct + "%)" : ""}.{" "}
                  {off
                    ? "A stock split may be missing" + (splitLike.length ? " for " + splitLike.join(", ") : "") + ". Ask before saving."
                    : drift
                      ? "No holding is at half or double its model weight, so no split is missing; the difference is drift or a model change since that day."
                      : "In line with the model."}
                  {(mc?.unpriced?.length ?? 0) > 0 ? " Not traded that day, so left out of the check: " + mc!.unpriced!.join(", ") + "." : ""}
                </p>
              )}
              {p.splitsFound && Object.keys(p.splitsFound).length > 0 && (
                <p className="text-ink-3" title={Object.entries(p.splitsFound).map(([k, v]) => k + " (" + v + ")").join("; ")}>
                  Stock splits applied to {Object.keys(p.splitsFound).length} names: {Object.keys(p.splitsFound).join(", ")}
                </p>
              )}
              {p.summary.resetToZero.length > 0 && <p className="text-ink-3">Unit counts reset at zero (fund distributions or an old merger): {p.summary.resetToZero.join(", ")}</p>}
              {p.mode !== "SAVED" && file && (
                <div className="flex flex-wrap items-center gap-3">
                  <button disabled={!!busy} onClick={() => save(false)} className="rounded-control border border-line bg-surface px-3 py-1 font-medium text-ink">
                    Save as the {BOOKS.find((b) => b.id === book)?.label} log
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
