"use client";

/**
 * "Why we own it" — the points for one holding: read, draft from what is on
 * file, edit, approve, and see earlier versions. Used on Holdings and in the
 * Snapshot pop-up. Saves ONE holding through POST /api/why-we-own.
 */

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { draftFromOnFile, whyKey, type WhyEntry, type WhySource, type WhyStore } from "@/app/lib/why-we-own";

const BTN = "inline-flex h-8 items-center rounded-control border border-line bg-surface px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-hover disabled:opacity-50";
const BTN_P = "inline-flex h-8 items-center rounded-control border border-accent bg-accent px-3 text-[13px] font-semibold !text-white hover:opacity-90 disabled:opacity-50";

type OnFile = { theses: Record<string, { why?: string; pillars?: unknown[] }>; pagers: Record<string, { whyWeOwn?: string[]; headline?: string }> };

/** Loads the points store plus the theses and one-pagers a first draft is written from. */
export function useWhyStore(): { store: WhyStore | null; onFile: OnFile; save: (symbol: string, points: string[], status: "draft" | "approved", source: WhySource, approvedBy?: string) => Promise<string | null> } {
  const [store, setStore] = useState<WhyStore | null>(null);
  const [onFile, setOnFile] = useState<OnFile>({ theses: {}, pagers: {} });
  useEffect(() => {
    let alive = true;
    fetch("/api/why-we-own").then((r) => (r.ok ? r.json() : null)).then((d: WhyStore | null) => alive && setStore(d && d.entries ? d : { entries: {} })).catch(() => alive && setStore({ entries: {} }));
    Promise.all([
      fetch("/api/kv/position-theses").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/fund-one-pagers").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([t, p]) => alive && setOnFile({ theses: t?.theses ?? {}, pagers: p?.pagers ?? {} }));
    return () => {
      alive = false;
    };
  }, []);
  const save = useCallback(async (symbol: string, points: string[], status: "draft" | "approved", source: WhySource, approvedBy?: string) => {
    try {
      const r = await fetch("/api/why-we-own", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol, points, status, source, approvedBy }) });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.entry) return d?.error ?? "Could not save.";
      setStore((s) => ({ ...(s ?? { entries: {} }), entries: { ...(s?.entries ?? {}), [whyKey(symbol)]: d.entry as WhyEntry } }));
      return null;
    } catch {
      return "Could not save.";
    }
  }, []);
  return { store, onFile, save };
}

const lookup = <T,>(map: Record<string, T>, symbol: string): T | undefined => map[whyKey(symbol)] ?? map[symbol] ?? map[symbol.toUpperCase()] ?? map[symbol.replace(/-T$/i, "").toUpperCase()];
const day = (iso?: string) => (iso ? iso.slice(0, 10) : "");

export function WhyPanel({ symbol, why, fullHref, fullLabel }: { symbol: string; why: ReturnType<typeof useWhyStore>; fullHref?: string; fullLabel?: string }) {
  const entry = why.store ? lookup(why.store.entries, symbol) : undefined;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [source, setSource] = useState<WhySource>("written by hand");
  const [by, setBy] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const startEdit = (points: string[], src: WhySource) => {
    setText(points.join("\n"));
    setSource(src);
    setErr(null);
    setEditing(true);
  };
  const draft = draftFromOnFile(lookup(why.onFile.theses, symbol), lookup(why.onFile.pagers, symbol));
  const submit = async (status: "draft" | "approved") => {
    setBusy(true);
    const points = text.split("\n").map((s) => s.trim()).filter(Boolean);
    const e = await why.save(symbol, points, status, source, by || undefined);
    setBusy(false);
    setErr(e);
    if (!e) setEditing(false);
  };

  if (!why.store) return <p className="text-[13.5px] text-ink-3">Loading…</p>;
  return (
    <div className="flex flex-col gap-2">
      {editing ? (
        <>
          <label className="text-[12.5px] text-ink-3">One point per line, up to five. Plain language.</label>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} className="w-full rounded-control border border-line bg-surface p-2.5 text-[14px] text-ink" />
          <div className="flex flex-wrap items-center gap-2">
            <input value={by} onChange={(e) => setBy(e.target.value)} placeholder="Approved by (name)" className="h-8 w-[180px] rounded-control border border-line bg-surface px-2 text-[13px] text-ink" />
            <button type="button" className={BTN_P} disabled={busy} onClick={() => void submit("approved")}>Approve</button>
            <button type="button" className={BTN} disabled={busy} onClick={() => void submit("draft")}>Save as draft</button>
            <button type="button" className={BTN} disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
            {err && <span className="text-[13px] text-neg">{err}</span>}
          </div>
        </>
      ) : entry ? (
        <>
          <ul className="list-disc space-y-1 pl-5 text-[14.5px] leading-snug text-ink">
            {entry.points.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
            {entry.status === "approved" ? <span className="font-semibold text-pos">Approved{entry.approvedBy ? ` by ${entry.approvedBy}` : ""} {day(entry.approvedAt)}</span> : <span className="rounded-full bg-warn-soft px-2 py-0.5 font-semibold text-ink">Draft: needs review</span>}
            <span>{entry.source} · updated {day(entry.updatedAt)}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BTN} onClick={() => startEdit(entry.points, entry.source)}>Edit</button>
            {entry.status !== "approved" && <button type="button" className={BTN_P} onClick={() => startEdit(entry.points, entry.source)}>Review and approve</button>}
            {(entry.history?.length ?? 0) > 0 && <button type="button" className={BTN} onClick={() => setShowHistory((v) => !v)}>{showHistory ? "Hide" : "Show"} earlier versions ({entry.history!.length})</button>}
            {fullHref && <Link href={fullHref} className={BTN}>{fullLabel ?? "Open the full page"}</Link>}
          </div>
          {showHistory && (
            <div className="flex flex-col gap-2 border-t border-line-soft pt-2">
              {[...(entry.history ?? [])].reverse().map((v, i) => (
                <div key={i} className="text-[13px] text-ink-2">
                  <div className="text-[12px] text-ink-3">{day(v.updatedAt)} · {v.status === "approved" ? "approved" : "draft"} · {v.source}</div>
                  <ul className="list-disc pl-5">{v.points.map((p, j) => <li key={j}>{p}</li>)}</ul>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <p className="text-[14px] text-ink-2">Not written yet.</p>
          <div className="flex flex-wrap gap-2">
            {draft && <button type="button" className={BTN_P} onClick={() => startEdit(draft.points, draft.source)}>Start {draft.source === "from one-pager" ? "from the one-pager" : "from the thesis on file"}</button>}
            <button type="button" className={BTN} onClick={() => startEdit([], "written by hand")}>Write it by hand</button>
            {fullHref && <Link href={fullHref} className={BTN}>{fullLabel ?? "Open the full page"}</Link>}
          </div>
        </>
      )}
    </div>
  );
}

/** Click-to-open pop-up (never hover). */
export function WhyPopup({ symbol, name, why, onClose }: { symbol: string; name: string; why: ReturnType<typeof useWhyStore>; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label={`Why we own ${name}`}>
      <div className="max-h-[85vh] w-full max-w-[560px] overflow-y-auto rounded-[12px] bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Why we own it</div>
            <div className="text-[19px] font-bold leading-tight text-ink">{name} <span className="text-[14px] font-medium text-ink-3">{symbol}</span></div>
          </div>
          <button type="button" onClick={onClose} className={BTN} aria-label="Close">Close</button>
        </div>
        <WhyPanel symbol={symbol} why={why} fullHref={`/stock/${encodeURIComponent(symbol.toLowerCase())}`} fullLabel="Open the stock / fund page" />
      </div>
    </div>
  );
}
