"use client";

import React, { useCallback, useEffect, useState } from "react";
import { CollapsibleSection } from "@/app/components/CollapsibleSection";
import type { ModelVersionMeta } from "@/app/lib/model-versions";

/* Versions of the models — every commit and restore snapshots the models first,
 * so any of them can be put back. Restore shows what would change, needs the
 * version id typed, and snapshots the current models again before writing, so
 * a restore is itself undoable. */

type Diff = Array<{ groupId: string; symbol: string; before: number; after: number }>;
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const SOURCE: Record<string, string> = { "review-commit": "before a review commit", restore: "before a restore", manual: "manual" };

export function ModelVersions({ onRestored }: { onRestored?: () => Promise<void> | void }) {
  const [versions, setVersions] = useState<ModelVersionMeta[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const j = await fetch("/api/model-versions", { cache: "no-store" }).then((r) => r.json());
      setVersions(Array.isArray(j.versions) ? j.versions : []);
    } catch {
      setVersions([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const inspect = async (id: string) => {
    if (openId === id) { setOpenId(null); setDiff(null); return; }
    setOpenId(id); setDiff(null); setConfirmText(""); setMsg(null);
    try {
      const j = await fetch(`/api/model-versions?id=${encodeURIComponent(id)}`, { cache: "no-store" }).then((r) => r.json());
      setDiff(Array.isArray(j.diff) ? j.diff : []);
    } catch { setDiff([]); }
  };

  const restore = async (id: string) => {
    if (confirmText.trim() !== `RESTORE ${id}`) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/weight-decisions/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ versionId: id, confirm: confirmText.trim() }) });
      const j = await r.json();
      if (!r.ok) { setMsg(j.error ?? "restore failed"); return; }
      setMsg(`Restored ${id} — ${j.diff?.length ?? 0} weights changed. Today's models were saved as ${j.undoVersionId} first.`);
      setOpenId(null); setDiff(null); setConfirmText("");
      await load();
      await onRestored?.();
    } finally { setBusy(false); }
  };

  return (
    <CollapsibleSection prefKey="review.versions" className="border-line" titleClass="text-[13px] font-semibold text-ink" title="Model versions" subtitle="every commit and restore saves the models first — any of these can be put back" defaultCollapsed>
      {msg && <div className="mb-2 rounded-card border border-line bg-surface-2 px-3 py-2 text-[12px] text-ink-2">{msg}</div>}
      {!versions ? <p className="text-[12px] text-ink-3">Loading…</p> : versions.length === 0 ? <p className="text-[12px] text-ink-3">No versions yet — the first commit will create one.</p> : (
        <div className="overflow-auto"><table className="data-table">
          <thead><tr><th>Saved</th><th>Why</th><th>Note</th><th className="text-right">Action</th></tr></thead>
          <tbody>
            {versions.map((v) => (
              <React.Fragment key={v.id}>
                <tr>
                  <td className="font-mono text-[12px] text-ink">{v.at.slice(0, 16).replace("T", " ")}</td>
                  <td className="text-[12px] text-ink-2">{SOURCE[v.source] ?? v.source}{v.month ? ` · ${v.month}` : ""}</td>
                  <td className="text-[12px] text-ink-3">{v.note}</td>
                  <td className="text-right"><button type="button" onClick={() => inspect(v.id)} className="inline-flex h-6 items-center rounded-control border border-line bg-surface px-2 text-[11.5px] text-ink-2 hover:bg-surface-hover">{openId === v.id ? "Close" : "Inspect / restore"}</button></td>
                </tr>
                {openId === v.id && (
                  <tr className="bg-surface-2">
                    <td colSpan={4} className="!h-auto whitespace-normal !px-3.5 !py-3 align-top">
                      {!diff ? <span className="text-[12px] text-ink-3">Comparing…</span> : (
                        <div className="flex flex-col gap-2 text-[12px]">
                          <div className="text-ink-2">{diff.length === 0 ? "Identical to today's models." : `Restoring this version changes ${diff.length} weight${diff.length === 1 ? "" : "s"}:`}</div>
                          {diff.length > 0 && (
                            <div className="grid gap-x-6 gap-y-0.5 font-mono tabular-nums text-ink-2 md:grid-cols-3">
                              {diff.slice(0, 60).map((d) => <div key={`${d.groupId}-${d.symbol}`}>{d.groupId} · {d.symbol} {pct(d.before)} → {pct(d.after)}</div>)}
                              {diff.length > 60 && <div className="text-ink-3">…and {diff.length - 60} more</div>}
                            </div>
                          )}
                          {diff.length > 0 && (
                            <div className="flex flex-wrap items-center gap-2 pt-1">
                              <span className="text-ink-3">Type <span className="font-mono text-ink">RESTORE {v.id}</span></span>
                              <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} className="h-7 w-[420px] max-w-full rounded-control border border-line bg-surface px-2 font-mono text-[11.5px] text-ink" />
                              <button type="button" disabled={busy || confirmText.trim() !== `RESTORE ${v.id}`} onClick={() => restore(v.id)} className="inline-flex h-7 items-center rounded-control bg-neg px-3 text-[12px] font-medium text-white disabled:opacity-40">{busy ? "Restoring…" : "Restore this version"}</button>
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table></div>
      )}
    </CollapsibleSection>
  );
}
