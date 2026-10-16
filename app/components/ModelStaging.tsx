"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { AppIcon } from "@/app/components/AppIcon";
import {
  buildDraftModels,
  diffHoldings,
  propagate,
  sameSymbol,
  validateHoldings,
  type DiffRow,
  type ModelDraft,
  type ParsedKind,
  type ParsedRow,
  type StagedModel,
} from "@/app/lib/model-staging";
import type { PimAssetClass, PimHolding, PimModelGroup, PimProfileType } from "@/app/lib/pim-types";

/**
 * Model staging — upload the target model as a screenshot, review what it
 * means for EVERY model group, edit any of them, then apply them all in one
 * confirmed write. Drafts live in pm:model-drafts; pm:pim-models is written
 * only by the Apply button (server route, snapshot first, revision-guarded).
 * Trades are a separate step: Positioning's Rebalance trades to the applied
 * model and sells the names the apply removed.
 */

const BTN = "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover disabled:opacity-50";
const BTN_PRIMARY = "inline-flex h-7 items-center gap-1.5 rounded-control bg-ink px-2.5 text-[12.5px] font-medium !text-white hover:bg-ink-2 disabled:opacity-50";
const INPUT = "h-7 rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent-border";

const CLASS_LABELS: Record<PimAssetClass, string> = { fixedIncome: "Fixed Income", equity: "Equities", alternative: "Alternatives" };
const PROFILE_LABELS: Record<PimProfileType, string> = {
  conservative: "Conservative", balanced: "Balanced", growth: "Growth", allEquity: "All-Equity", alpha: "Alpha", core: "Core",
};
const pct = (v: number | null | undefined, dp = 2) => (v == null ? "—" : `${(v * 100).toFixed(dp)}%`);
const allocOf = (g: PimModelGroup | undefined, profile: PimProfileType, ac: PimAssetClass): number => {
  const p = g?.profiles[profile];
  if (!p) return 0;
  return ac === "fixedIncome" ? p.fixedIncome : ac === "equity" ? p.equity : p.alternatives;
};

/** Shrink a pasted / dropped image so the request stays well under the
 *  serverless body limit. Text stays legible at 2400px wide. */
async function fileToDataUrl(file: File): Promise<string> {
  const raw = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
  if (raw.length < 3_000_000) return raw;
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = raw;
  });
  const scale = Math.min(1, 2400 / img.width);
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.9);
}

export function ModelStaging() {
  const { pimModels, stocks, reloadPimModels, moveBucket, uiPrefs, setUiPref } = useStocks();
  const groups = pimModels.groups;
  const [draft, setDraft] = useState<ModelDraft | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [lastApplied, setLastApplied] = useState<ModelDraft | null>(null);
  const [sourceGroupId, setSourceGroupId] = useState("pim");
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState<"" | "saving" | "saved" | "error">("");
  const [confirmText, setConfirmText] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{ versionId: string; changes: number; exits: Record<string, string[]> } | null>(null);
  const [showParsed, setShowParsed] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const selectedId = (uiPrefs["staging.model"] as string) || "pim";
  const setSelectedId = (id: string) => setUiPref("staging.model", id);
  const profile = ((uiPrefs["staging.profile"] as PimProfileType) || "balanced") as PimProfileType;

  // ── Load the active draft ──
  useEffect(() => {
    let alive = true;
    fetch("/api/kv/model-drafts", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j?.active) { setDraft(j.active); setSourceGroupId(j.active.sourceGroupId); }
        if (Array.isArray(j?.history) && j.history[0]) setLastApplied(j.history[0]);
      })
      .catch(() => {})
      .finally(() => alive && setLoaded(true));
    return () => { alive = false; };
  }, []);

  // ── Save (debounced, one draft at a time) ──
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const save = useCallback((d: ModelDraft, replace = false) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/kv/model-drafts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ draft: d, replace }),
        });
        if (res.status === 409) { setSaveState("error"); setError("Another draft was started elsewhere — reload this window."); return; }
        setSaveState(res.ok ? "saved" : "error");
      } catch {
        setSaveState("error");
      }
    }, replace ? 0 : 600);
  }, []);
  const update = useCallback((d: ModelDraft, replace = false) => { setDraft(d); save(d, replace); }, [save]);

  // ── Screenshot → draft ──
  const handleFile = useCallback(async (file: File | null | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    if (draft && !window.confirm("Replace the current draft with this screenshot? Your edits to it will be lost.")) return;
    setParsing(true);
    setError("");
    setApplyResult(null);
    try {
      const dataUrl = await fileToDataUrl(file);
      const res = await fetch("/api/model-staging/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl }),
      });
      const j = await res.json();
      const rows: ParsedRow[] = Array.isArray(j?.rows) ? j.rows : [];
      if (!res.ok || rows.length === 0) { setError(j?.error || "No rows could be read from that screenshot."); return; }
      const now = new Date().toISOString();
      const src = groups.find((g) => g.id === sourceGroupId);
      const next: ModelDraft = {
        id: `md-${Date.now().toString(36)}`,
        name: `${src?.name ?? sourceGroupId} target · ${now.slice(0, 10)}`,
        sourceGroupId,
        parsed: rows,
        models: buildDraftModels(rows, sourceGroupId, groups, stocks),
        status: "draft",
        createdAt: now,
        updatedAt: now,
      };
      update(next, true);
      setSelectedId(sourceGroupId);
    } catch {
      setError("Upload failed.");
    } finally {
      setParsing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, groups, sourceGroupId, stocks, update]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      if (item) { e.preventDefault(); void handleFile(item.getAsFile()); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handleFile]);

  // ── Per-model diffs vs LIVE ──
  const diffs = useMemo(() => {
    const out: Record<string, DiffRow[]> = {};
    if (!draft) return out;
    for (const g of groups) {
      const m = draft.models[g.id];
      if (m) out[g.id] = diffHoldings(g.holdings, m.holdings);
    }
    return out;
  }, [draft, groups]);
  const changeCount = (gid: string) => (diffs[gid] ?? []).filter((r) => r.kind !== "same").length;
  const errorsFor = (gid: string) => (draft?.models[gid] ? validateHoldings(draft.models[gid].holdings) : []);
  const changedGroups = groups.filter((g) => changeCount(g.id) > 0);
  const blocking = changedGroups.flatMap((g) => errorsFor(g.id).map((e) => `${g.name}: ${e}`));

  // ── Editing ──
  /** Write one model's holdings; editing the source re-propagates to every
   *  model the PM has not hand-edited. */
  const setModel = useCallback((gid: string, holdings: PimHolding[], parsedAdd?: ParsedRow) => {
    if (!draft) return;
    const parsed = parsedAdd ? [...draft.parsed, parsedAdd] : draft.parsed;
    const models: Record<string, StagedModel> = { ...draft.models };
    if (gid === draft.sourceGroupId) {
      models[gid] = { ...models[gid], holdings, origin: "source" };
      const src = groups.find((g) => g.id === gid);
      if (src) {
        for (const g of groups) {
          if (g.id === gid || models[g.id]?.origin === "edited") continue;
          models[g.id] = propagate(src, holdings, g, stocks, parsed);
        }
      }
    } else {
      models[gid] = { ...(models[gid] ?? { notes: [] }), holdings, origin: "edited" };
    }
    update({ ...draft, parsed, models });
  }, [draft, groups, stocks, update]);

  const repropagate = (gid: string) => {
    if (!draft) return;
    const src = groups.find((g) => g.id === draft.sourceGroupId);
    const g = groups.find((x) => x.id === gid);
    if (!src || !g) return;
    update({ ...draft, models: { ...draft.models, [gid]: propagate(src, draft.models[draft.sourceGroupId].holdings, g, stocks, draft.parsed) } });
  };

  const discard = async () => {
    if (!draft || !window.confirm("Discard this draft? The live models are not affected.")) return;
    await fetch(`/api/kv/model-drafts?id=${encodeURIComponent(draft.id)}`, { method: "DELETE" }).catch(() => {});
    setDraft(null);
    setSaveState("");
  };

  // ── Apply ──
  const apply = async () => {
    if (!draft || confirmText !== "APPLY") return;
    setApplying(true);
    setError("");
    try {
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      // Flush the latest edits before the server reads the draft.
      const s = await fetch("/api/kv/model-drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft }) });
      if (!s.ok) { setError("Could not save the draft before applying — nothing written."); return; }
      const res = await fetch("/api/model-staging/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId: draft.id, expectedRevision: pimModels.revision ?? 0, confirm: "APPLY", groupIds: changedGroups.map((g) => g.id) }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 409 && typeof j?.revision === "number") {
        await reloadPimModels();
        setError("The live models changed since this diff was drawn (a trade or another tab). The diff has been refreshed — review it and apply again.");
        return;
      }
      if (!res.ok) { setError([j?.error, ...(j?.problems ?? [])].filter(Boolean).join(" · ") || "Apply failed."); return; }
      await reloadPimModels();
      setLastApplied({ ...draft, status: "applied", appliedAt: new Date().toISOString(), versionId: j.versionId, exits: j.exits });
      setApplyResult({ versionId: j.versionId, changes: Array.isArray(j.diff) ? j.diff.length : 0, exits: j.exits ?? {} });
      setDraft(null);
      setConfirmText("");
    } finally {
      setApplying(false);
    }
  };

  // ── Book follow-ups after an apply (pm:stocks is never written by the apply) ──
  const followUps = useMemo(() => {
    if (!lastApplied?.appliedAt) return { promote: [] as string[], demote: [] as string[] };
    const inAnyModel = (sym: string) => groups.some((g) => g.holdings.some((h) => sameSymbol(h.symbol, sym)));
    const promote: string[] = [];
    const demote: string[] = [];
    for (const m of Object.values(lastApplied.models)) {
      for (const h of m.holdings) {
        if (h.assetClass !== "equity") continue;
        const rec = stocks.find((s) => sameSymbol(s.ticker, h.symbol));
        if (rec && rec.bucket === "Watchlist" && inAnyModel(h.symbol) && !promote.includes(rec.ticker)) promote.push(rec.ticker);
      }
    }
    for (const syms of Object.values(lastApplied.exits ?? {})) {
      for (const sym of syms) {
        const rec = stocks.find((s) => sameSymbol(s.ticker, sym));
        if (rec && rec.bucket === "Portfolio" && !inAnyModel(sym) && !demote.includes(rec.ticker)) demote.push(rec.ticker);
      }
    }
    return { promote, demote };
  }, [lastApplied, groups, stocks]);

  if (!loaded) return <div className="p-4 text-[12.5px] text-ink-3">Loading…</div>;

  const sel = groups.find((g) => g.id === selectedId) ?? groups[0];
  const staged = draft && sel ? draft.models[sel.id] : undefined;
  const selIdx = groups.findIndex((g) => g.id === sel?.id);

  return (
    <div className="flex flex-col gap-3.5 text-ink">
      {/* ── Upload ── */}
      <section className="panel">
        <div className="panel-h flex-wrap gap-2 py-2">
          <span className="t">Target screenshot</span>
          <span className="m">paste (⌘V), drop, or choose an image of the model sheet</span>
        </div>
        <div
          className="flex flex-wrap items-center gap-2.5 px-3.5 py-3"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); void handleFile(e.dataTransfer.files?.[0]); }}
        >
          <label className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
            This screenshot is
            <select value={sourceGroupId} onChange={(e) => setSourceGroupId(e.target.value)} className={INPUT} disabled={parsing}>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => void handleFile(e.target.files?.[0])} />
          <button className={BTN_PRIMARY} onClick={() => fileRef.current?.click()} disabled={parsing}>
            <AppIcon name="upload" size={13} />
            {parsing ? "Reading screenshot…" : "Upload screenshot"}
          </button>
          <span className="text-[11.5px] text-ink-3">
            Every other model is derived from it — names dropped leave, weight changes carry over, new names join where eligible, Core ETFs absorb the rest.
          </span>
          {draft && (
            <span className="ml-auto flex items-center gap-2 text-[11.5px] text-ink-3">
              {draft.name} · {saveState === "saving" ? "saving…" : saveState === "error" ? <span className="text-neg">not saved</span> : "saved"}
              <button className={BTN} onClick={() => setShowParsed((v) => !v)}>{showParsed ? "Hide" : "Show"} parsed rows ({draft.parsed.length})</button>
              <button className={BTN} onClick={discard}><AppIcon name="trash" size={13} />Discard</button>
            </span>
          )}
        </div>
        {error && <div className="border-t border-line-soft bg-neg-soft px-3.5 py-2 text-[12px] text-neg">{error}</div>}
        {draft && showParsed && (
          <div className="tbl-wrap max-h-[260px] overflow-auto border-t border-line-soft">
            <table className="data-table">
              <thead><tr><th className="pl-3.5">Name</th><th>Symbol</th><th>Ccy</th><th>Class</th><th>Kind</th><th className="text-right">Asset class %</th><th className="text-right">Portfolio %</th></tr></thead>
              <tbody>
                {draft.parsed.map((r, i) => (
                  <tr key={`${r.symbol}-${i}`}>
                    <td className="pl-3.5">{r.name}</td><td className="font-mono">{r.symbol}</td><td>{r.currency}</td>
                    <td>{CLASS_LABELS[r.assetClass]}</td><td>{r.kind}</td>
                    <td className="text-right tabular-nums">{r.classPct ?? "—"}</td><td className="text-right tabular-nums">{r.portfolioPct ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {applyResult && (
        <section className="panel border-l-2 border-l-pos px-3.5 py-3 text-[12.5px]">
          <div className="font-semibold text-ink">Applied — {applyResult.changes} weight changes written.</div>
          <div className="mt-1 text-ink-2">
            Undo: restore version <span className="font-mono">{applyResult.versionId}</span> from the model version history on the Review page.
            {" "}Next: <Link href="/portfolio" className="!text-accent underline">Positioning → Rebalance</Link> trades the PIM book to the new model
            {applyResult.exits.pim?.length ? <> and sells {applyResult.exits.pim.join(", ")} to zero</> : null}.
          </div>
        </section>
      )}

      {(followUps.promote.length > 0 || followUps.demote.length > 0) && (
        <section className="panel px-3.5 py-3 text-[12.5px]">
          <div className="font-semibold text-ink">Book follow-ups</div>
          <div className="mt-1 text-ink-3">The apply changes the models only. These names&apos; Portfolio / Watchlist bucket no longer matches — the models are not touched by these buttons.</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {followUps.promote.map((t) => (
              <button key={t} className={BTN} onClick={() => moveBucket(t, { skipPimModels: true })}>{t} → Portfolio</button>
            ))}
            {followUps.demote.map((t) => (
              <button key={t} className={BTN} onClick={() => moveBucket(t, { skipPimModels: true })}>{t} → Watchlist</button>
            ))}
          </div>
        </section>
      )}

      {!draft && !applyResult && (
        <div className="panel px-3.5 py-6 text-center text-[12.5px] text-ink-3">No staged changes. Upload a screenshot of the target model to start.</div>
      )}

      {draft && sel && (
        <>
          {/* ── Model toggle ── */}
          <div className="flex flex-wrap items-center gap-2">
            <button className={BTN} disabled={selIdx <= 0} onClick={() => setSelectedId(groups[selIdx - 1].id)} aria-label="Previous model"><AppIcon name="chevL" size={13} /></button>
            <div className="seg max-w-full overflow-x-auto">
              {groups.map((g) => {
                const n = changeCount(g.id);
                const bad = n > 0 && errorsFor(g.id).length > 0;
                return (
                  <button key={g.id} onClick={() => setSelectedId(g.id)} className={g.id === sel.id ? "on" : ""}>
                    {g.name}
                    {n > 0 && <span className={`ml-1 rounded-full px-1.5 text-[10.5px] ${bad ? "bg-neg-soft text-neg" : "bg-accent-soft text-accent"}`}>{n}</span>}
                  </button>
                );
              })}
            </div>
            <button className={BTN} disabled={selIdx >= groups.length - 1} onClick={() => setSelectedId(groups[selIdx + 1].id)} aria-label="Next model"><AppIcon name="chevR" size={13} /></button>
            <label className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-3">
              Portfolio % as
              <select value={profile} onChange={(e) => setUiPref("staging.profile", e.target.value)} className={INPUT}>
                {(Object.keys(sel.profiles) as PimProfileType[]).map((p) => <option key={p} value={p}>{PROFILE_LABELS[p]}</option>)}
              </select>
            </label>
          </div>

          {staged ? (
            <ModelDiffPanel
              group={sel}
              staged={staged}
              diff={diffs[sel.id] ?? []}
              isSource={sel.id === draft.sourceGroupId}
              profile={profile}
              errors={errorsFor(sel.id)}
              onChange={(h, add) => setModel(sel.id, h, add)}
              onRepropagate={() => repropagate(sel.id)}
            />
          ) : (
            <div className="panel px-3.5 py-4 text-[12.5px] text-ink-3">Nothing staged for {sel.name}.</div>
          )}

          {/* ── Apply ── */}
          <section className="panel px-3.5 py-3">
            <div className="flex flex-wrap items-center gap-2.5 text-[12.5px]">
              <span className="font-semibold text-ink">Apply to the live models</span>
              <span className="text-ink-3">
                {changedGroups.length === 0 ? "No model differs from live." : `${changedGroups.length} model${changedGroups.length === 1 ? "" : "s"} change: ${changedGroups.map((g) => g.name).join(", ")}.`}
              </span>
            </div>
            <p className="mt-1 text-[11.5px] text-ink-3">
              Writes the new targets (snapshot first — undoable from the Review page). Performance tracks targets from that moment, so apply on the day you trade, then run Rebalance in Positioning. No trades are made here.
            </p>
            {blocking.length > 0 && <div className="mt-2 text-[12px] text-neg">Fix before applying: {blocking.join(" · ")}</div>}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="Type APPLY" className={`${INPUT} w-[130px] font-mono`} />
              <button className={BTN_PRIMARY} disabled={applying || confirmText !== "APPLY" || changedGroups.length === 0 || blocking.length > 0} onClick={apply}>
                {applying ? "Applying…" : `Apply ${changedGroups.length} model${changedGroups.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/* ── One model's proposed vs live ─────────────────────────────────── */

function ModelDiffPanel({
  group, staged, diff, isSource, profile, errors, onChange, onRepropagate,
}: {
  group: PimModelGroup;
  staged: StagedModel;
  diff: DiffRow[];
  isSource: boolean;
  profile: PimProfileType;
  errors: string[];
  onChange: (holdings: PimHolding[], parsedAdd?: ParsedRow) => void;
  onRepropagate: () => void;
}) {
  const [adding, setAdding] = useState<{ symbol: string; name: string; currency: "CAD" | "USD"; assetClass: PimAssetClass; kind: ParsedKind; pct: string } | null>(null);
  const classes = (["fixedIncome", "equity", "alternative"] as PimAssetClass[]).filter((ac) => diff.some((r) => r.assetClass === ac));
  const kindOrder = { add: 0, change: 1, remove: 2, same: 3 } as const;

  const setWeight = (symbol: string, pctStr: string) => {
    const v = parseFloat(pctStr);
    if (!Number.isFinite(v) || v < 0) return;
    onChange(staged.holdings.map((h) => (sameSymbol(h.symbol, symbol) ? { ...h, weightInClass: parseFloat((v / 100).toFixed(6)) } : h)));
  };
  const remove = (symbol: string) => onChange(staged.holdings.filter((h) => !sameSymbol(h.symbol, symbol)));
  const restore = (symbol: string) => {
    const live = group.holdings.find((h) => sameSymbol(h.symbol, symbol));
    if (live) onChange([...staged.holdings, live]);
  };
  /** Put the class's gap onto one holding so it sums to 100%. */
  const plug = (ac: PimAssetClass, symbol: string) => {
    const others = staged.holdings.filter((h) => h.assetClass === ac && !sameSymbol(h.symbol, symbol)).reduce((a, h) => a + h.weightInClass, 0);
    onChange(staged.holdings.map((h) => (sameSymbol(h.symbol, symbol) ? { ...h, weightInClass: parseFloat(Math.max(0, 1 - others).toFixed(6)) } : h)));
  };
  const addRow = () => {
    if (!adding || !adding.symbol.trim()) return;
    const symbol = adding.symbol.trim().toUpperCase();
    if (staged.holdings.some((h) => sameSymbol(h.symbol, symbol))) return;
    const w = parseFloat(((parseFloat(adding.pct) || 0) / 100).toFixed(6));
    const name = (adding.name.trim() || symbol).toUpperCase();
    onChange(
      [...staged.holdings, { name, symbol, currency: adding.currency, assetClass: adding.assetClass, weightInClass: w }],
      { name, symbol, currency: adding.currency, assetClass: adding.assetClass, kind: adding.kind, classPct: w * 100, portfolioPct: null },
    );
    setAdding(null);
  };

  return (
    <section className="panel">
      <div className="panel-h flex-wrap gap-2 py-2">
        <span className="t">{group.name}</span>
        <span className="m">
          {isSource ? "from the screenshot" : staged.origin === "edited" ? "edited by hand — no longer follows the screenshot" : "derived from the screenshot"}
        </span>
        {!isSource && staged.origin === "edited" && (
          <button className={`${BTN} ml-auto`} onClick={onRepropagate}><AppIcon name="refresh" size={13} />Re-derive from screenshot</button>
        )}
      </div>
      {staged.notes.length > 0 && (
        <ul className="border-b border-line-soft px-3.5 py-2 text-[11.5px] text-ink-3">
          {staged.notes.map((n, i) => <li key={i}>· {n}</li>)}
        </ul>
      )}
      {errors.length > 0 && <div className="border-b border-line-soft bg-neg-soft px-3.5 py-1.5 text-[12px] text-neg">{errors.join(" · ")}</div>}
      <div className="tbl-wrap overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th className="pl-3.5">Holding</th>
              <th>Symbol</th>
              <th>Ccy</th>
              <th className="text-right">Live · class</th>
              <th className="text-right">Proposed · class</th>
              <th className="text-right">Δ</th>
              <th className="text-right">Proposed · {PROFILE_LABELS[profile]}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {classes.map((ac) => {
              const rows = diff.filter((r) => r.assetClass === ac).sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || (b.after ?? 0) - (a.after ?? 0));
              const liveSum = rows.reduce((a, r) => a + (r.before ?? 0), 0);
              const newSum = rows.reduce((a, r) => a + (r.after ?? 0), 0);
              const alloc = allocOf(group, profile, ac);
              return (
                <React.Fragment key={ac}>
                  <tr><td colSpan={8} className="bg-surface-hover pl-3.5 text-[11.5px] font-semibold text-ink-2">{CLASS_LABELS[ac]}</td></tr>
                  {rows.map((r) => {
                    const delta = (r.after ?? 0) - (r.before ?? 0);
                    const chip = r.kind === "add" ? "bg-pos-soft text-pos" : r.kind === "remove" ? "bg-neg-soft text-neg" : r.kind === "change" ? "bg-accent-soft text-accent" : "";
                    return (
                      <tr key={r.symbol} className={r.kind === "remove" ? "opacity-60" : ""}>
                        <td className="pl-3.5">
                          <span className={r.kind === "remove" ? "line-through" : ""}>{r.name}</span>
                          {r.kind !== "same" && <span className={`ml-1.5 rounded px-1 text-[10.5px] ${chip}`}>{r.kind === "add" ? "new" : r.kind === "remove" ? "removed" : "changed"}</span>}
                        </td>
                        <td className="font-mono">{r.symbol}</td>
                        <td>{r.currency}</td>
                        <td className="text-right tabular-nums">{pct(r.before)}</td>
                        <td className="text-right">
                          {r.after == null ? "—" : (
                            <input
                              key={`${r.symbol}-${r.after}`}
                              defaultValue={(r.after * 100).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}
                              onBlur={(e) => { if (Math.abs(parseFloat(e.target.value) / 100 - (r.after ?? 0)) > 1e-7) setWeight(r.symbol, e.target.value); }}
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                              className={`${INPUT} h-6 w-[84px] text-right tabular-nums`}
                              aria-label={`${r.symbol} proposed weight in class`}
                            />
                          )}
                        </td>
                        <td className={`text-right tabular-nums ${Math.abs(delta) < 1e-6 ? "text-ink-3" : delta > 0 ? "text-pos" : "text-neg"}`}>
                          {Math.abs(delta) < 1e-6 ? "—" : `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(2)}`}
                        </td>
                        <td className="text-right tabular-nums">{r.after == null ? "—" : pct(r.after * alloc)}</td>
                        <td className="whitespace-nowrap pr-2 text-right">
                          {r.after == null ? (
                            <button className="text-[11.5px] text-accent hover:underline" onClick={() => restore(r.symbol)}>keep</button>
                          ) : (
                            <>
                              <button className="mr-2 text-[11.5px] text-ink-3 hover:text-ink" title="Set this holding to whatever makes the class sum to 100%" onClick={() => plug(ac, r.symbol)}>plug</button>
                              <button className="text-ink-3 hover:text-neg" onClick={() => remove(r.symbol)} aria-label={`Remove ${r.symbol}`}><AppIcon name="x" size={12} /></button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="font-medium">
                    <td colSpan={3} className="pl-3.5 text-[11.5px] text-ink-3">{CLASS_LABELS[ac]} total</td>
                    <td className="text-right tabular-nums">{pct(liveSum)}</td>
                    <td className={`text-right tabular-nums ${Math.abs(newSum - 1) > 0.002 ? "text-neg" : ""}`}>{pct(newSum)}</td>
                    <td />
                    <td className="text-right tabular-nums">{pct(newSum * alloc)}</td>
                    <td />
                  </tr>
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line-soft px-3.5 py-2">
        {adding ? (
          <>
            <input autoFocus placeholder="Symbol" value={adding.symbol} onChange={(e) => setAdding({ ...adding, symbol: e.target.value })} className={`${INPUT} w-[100px] font-mono`} />
            <input placeholder="Name" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} className={`${INPUT} w-[200px]`} />
            <select value={adding.currency} onChange={(e) => setAdding({ ...adding, currency: e.target.value as "CAD" | "USD" })} className={INPUT}><option>CAD</option><option>USD</option></select>
            <select value={adding.assetClass} onChange={(e) => setAdding({ ...adding, assetClass: e.target.value as PimAssetClass })} className={INPUT}>
              {(Object.keys(CLASS_LABELS) as PimAssetClass[]).map((c) => <option key={c} value={c}>{CLASS_LABELS[c]}</option>)}
            </select>
            <select value={adding.kind} onChange={(e) => setAdding({ ...adding, kind: e.target.value as ParsedKind })} className={INPUT}>
              <option value="stock">Stock</option><option value="etf">ETF</option><option value="fund">Mutual fund</option>
            </select>
            <input placeholder="% of class" value={adding.pct} onChange={(e) => setAdding({ ...adding, pct: e.target.value })} className={`${INPUT} w-[90px] text-right`} />
            <button className={BTN_PRIMARY} onClick={addRow}>Add</button>
            <button className={BTN} onClick={() => setAdding(null)}>Cancel</button>
          </>
        ) : (
          <button className={BTN} onClick={() => setAdding({ symbol: "", name: "", currency: "CAD", assetClass: "equity", kind: "stock", pct: "" })}>
            <AppIcon name="plus" size={13} />Add holding
          </button>
        )}
        <span className="ml-auto text-[11.5px] text-ink-3">Weights are % of the asset class (stored); the {PROFILE_LABELS[profile]} column is display-only.</span>
      </div>
    </section>
  );
}
