"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { AppIcon } from "@/app/components/AppIcon";
import {
  buildDraftModels,
  currencyModelWeights,
  diffHoldings,
  draftHasBuckets,
  isCoreForDisplay,
  MODEL_SUBSTITUTES,
  rescaleBuckets,
  stagedBucket,
  propagate,
  sameSymbol,
  validateHoldings,
  type CurrencyWeights,
  type DiffRow,
  type ModelDraft,
  type ParsedKind,
  type ParsedRow,
  type StagedModel,
} from "@/app/lib/model-staging";
import type { EquityBucket, PimAssetClass, PimHolding, PimModelGroup, PimProfileType } from "@/app/lib/pim-types";
import { BUCKET_LABELS, bucketOf } from "@/app/lib/sleeve-targets";
import { apportionColumn } from "@/app/lib/display-weights";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import type { BookPlan } from "@/app/lib/staged-rebalance";
import { ZERO_SCORES, type InstrumentType, type Stock } from "@/app/lib/types";

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
  conservative: "Conservative", balanced: "Balanced", growth: "Growth", allEquity: "All-Equity", alpha: "Alpha", core: "Core", thematic: "Thematic",
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
  const { pimModels, stocks, reloadPimModels, moveBucket, updateStockFields, addStock, flushStocks, uiPrefs, setUiPref } = useStocks();
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
  const [applyResult, setApplyResult] = useState<{ versionId: string; changes: number; exits: Record<string, string[]>; roleNote?: string } | null>(null);
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

  /** A draft that starts from the LIVE models — for resizing the buckets (or
   *  any edit) without a screenshot. Every PIM equity row carries its current
   *  bucket, so the draft is a three-bucket draft. */
  const startFromLive = useCallback(() => {
    if (draft && !window.confirm("Replace the current draft with a copy of the live models?")) return;
    const pim = groups.find((g) => g.id === "pim");
    if (!pim) return;
    const now = new Date().toISOString();
    const parsed: ParsedRow[] = pim.holdings.filter((h) => h.assetClass === "equity").map((h) => {
      const b = bucketOf(h.symbol, stocks);
      return { name: h.name, symbol: h.symbol, currency: h.currency, assetClass: "equity", kind: b === "alpha" ? "stock" : "etf", classPct: h.weightInClass * 100, portfolioPct: null, bucket: b };
    });
    const models: Record<string, StagedModel> = {};
    for (const g of groups) models[g.id] = { holdings: g.holdings, origin: g.id === "pim" ? "source" : "propagated", notes: [] };
    setError("");
    setApplyResult(null);
    update({ id: `md-${Date.now().toString(36)}`, name: `Live models · ${now.slice(0, 10)}`, sourceGroupId: "pim", parsed, models, status: "draft", createdAt: now, updatedAt: now }, true);
    setSelectedId("pim");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, groups, stocks, update]);

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
  const setModel = useCallback((gid: string, holdings: PimHolding[], parsedAdd?: ParsedRow, parsedReplace?: ParsedRow[]) => {
    if (!draft) return;
    const parsed = parsedReplace ?? (parsedAdd ? [...draft.parsed, parsedAdd] : draft.parsed);
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

  /** Move one source-model name to another bucket (re-derives the other models). */
  const setBucket = (symbol: string, bucket: EquityBucket) => {
    if (!draft) return;
    const src = draft.models[draft.sourceGroupId];
    const h = src?.holdings.find((x) => sameSymbol(x.symbol, symbol));
    if (!src || !h) return;
    const exists = draft.parsed.some((r) => sameSymbol(r.symbol, symbol));
    const parsed = exists
      ? draft.parsed.map((r) => (sameSymbol(r.symbol, symbol) ? { ...r, bucket } : r))
      : [...draft.parsed, { name: h.name, symbol: h.symbol, currency: h.currency, assetClass: "equity" as const, kind: (bucket === "alpha" ? "stock" : "etf") as ParsedKind, classPct: h.weightInClass * 100, portfolioPct: null, bucket }];
    setModel(draft.sourceGroupId, src.holdings, undefined, parsed);
  };

  // Models that FOLLOW the source are always derived, never authored: recompute
  // them once each time a draft is opened, so a saved draft picks up rule
  // changes (e.g. QQQM in PC USA) and the latest live models. Hand-edited
  // models are left exactly as the PM left them.
  const refreshedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!draft || refreshedFor.current === draft.id || groups.length === 0 || stocks.length === 0) return;
    refreshedFor.current = draft.id;
    const src = groups.find((g) => g.id === draft.sourceGroupId);
    const srcStaged = draft.models[draft.sourceGroupId];
    if (!src || !srcStaged) return;
    const models = { ...draft.models };
    let changed = false;
    for (const g of groups) {
      if (g.id === draft.sourceGroupId || models[g.id]?.origin === "edited") continue;
      const next = propagate(src, srcStaged.holdings, g, stocks, draft.parsed);
      if (JSON.stringify(next) !== JSON.stringify(models[g.id])) { models[g.id] = next; changed = true; }
    }
    if (changed) update({ ...draft, models });
  }, [draft, groups, stocks, update]);

  const repropagate = (gid: string) => {
    if (!draft) return;
    const src = groups.find((g) => g.id === draft.sourceGroupId);
    const g = groups.find((x) => x.id === gid);
    if (!src || !g) return;
    update({ ...draft, models: { ...draft.models, [gid]: propagate(src, draft.models[draft.sourceGroupId].holdings, g, stocks, draft.parsed) } });
  };

  const rederiveAll = () => {
    if (!draft) return;
    const src = groups.find((g) => g.id === draft.sourceGroupId);
    const srcStaged = draft.models[draft.sourceGroupId];
    if (!src || !srcStaged) return;
    const models = { ...draft.models };
    for (const g of groups) {
      if (g.id === draft.sourceGroupId || models[g.id]?.origin !== "edited") continue;
      models[g.id] = propagate(src, srcStaged.holdings, g, stocks, draft.parsed);
    }
    update({ ...draft, models });
  };

  const discard = async () => {
    if (!draft || !window.confirm("Discard this draft? The live models are not affected.")) return;
    await fetch(`/api/kv/model-drafts?id=${encodeURIComponent(draft.id)}`, { method: "DELETE" }).catch(() => {});
    setDraft(null);
    setSaveState("");
  };

  /** After a three-bucket apply: write each source name's bucket to pm:stocks
   *  through the normal client path (designation, a Portfolio record for a
   *  name the book doesn't track yet, Watchlist → Portfolio for a name now in
   *  the models). Never touches pm:pim-models (skipPimModels). */
  const syncRoles = (roles: Record<string, EquityBucket>, parsed: ParsedRow[]): string | undefined => {
    const entries = Object.entries(roles);
    if (entries.length === 0) return undefined;
    let tagged = 0, created = 0, promoted = 0;
    for (const [symbol, b] of entries) {
      const rec = stocks.find((s) => sameSymbol(s.ticker, symbol));
      if (rec) {
        const isStk = !rec.instrumentType || rec.instrumentType === "stock";
        const want = b === "core" ? "core" : b === "thematic" ? "thematic" : "alpha";
        // A stock is always Alpha; only funds carry Core / Thematic.
        if (!isStk && (rec.designation || "alpha") !== want) { updateStockFields(rec.ticker, { designation: want }); tagged++; }
        if (rec.bucket === "Watchlist") { moveBucket(rec.ticker, { skipPimModels: true }); promoted++; }
        continue;
      }
      const row = parsed.find((r) => sameSymbol(r.symbol, symbol));
      const instrumentType: InstrumentType = b === "alpha" ? "stock" : row?.kind === "fund" ? "mutual-fund" : "etf";
      const stock: Stock = {
        ticker: symbol.replace(/-T$/, ".TO"),
        name: row?.name ?? symbol,
        instrumentType,
        bucket: "Portfolio",
        sector: "",
        beta: 1.0,
        weights: { portfolio: 0 },
        scores: { ...ZERO_SCORES },
        notes: "",
        ...(instrumentType !== "stock" ? { designation: b === "core" ? "core" as const : "thematic" as const } : {}),
      };
      addStock(stock, { skipPimModels: true, assetClass: "equity" });
      created++;
    }
    // Substitutes (FINN in Non-Res for FID5982) take their source's bucket.
    for (const list of Object.values(MODEL_SUBSTITUTES)) {
      for (const x of list) {
        const b = Object.entries(roles).find(([sym]) => sameSymbol(sym, x.source))?.[1];
        if (!b || b === "alpha") continue;
        const rec = stocks.find((st) => x.local.some((l) => sameSymbol(l, st.ticker)));
        if (rec && rec.instrumentType && rec.instrumentType !== "stock" && (rec.designation || "alpha") !== b) {
          updateStockFields(rec.ticker, { designation: b });
          tagged++;
        }
      }
    }
    const parts = [tagged && `${tagged} re-tagged`, created && `${created} added to the book`, promoted && `${promoted} moved Watchlist → Portfolio`].filter(Boolean);
    return parts.length ? `Book roles synced: ${parts.join(", ")}.` : "Book roles already matched.";
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
      const roleNote = syncRoles((j.roles ?? {}) as Record<string, EquityBucket>, draft.parsed);
      setLastApplied({ ...draft, status: "applied", appliedAt: new Date().toISOString(), versionId: j.versionId, exits: j.exits });
      setApplyResult({ versionId: j.versionId, changes: Array.isArray(j.diff) ? j.diff.length : 0, exits: j.exits ?? {}, roleNote });
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
  const isCore = (sym: string) => isCoreForDisplay(sym, stocks, draft?.parsed ?? []);
  // A model without the chosen profile shows its HIGHEST-equity profile
  // (CGF tops out at Growth, 77% equity — never more), not Balanced.
  const ccyProfile: PimProfileType = !sel || sel.profiles[profile]
    ? profile
    : ((Object.entries(sel.profiles) as [PimProfileType, { equity: number }][])
        .filter(([p]) => p !== "alpha" && p !== "core" && p !== "thematic")
        .sort((a, b) => b[1].equity - a[1].equity)[0]?.[0] ?? "balanced");
  const ccyLive = sel ? currencyModelWeights(sel.holdings, sel, ccyProfile, isCore) : null;
  const ccyNew = sel && staged ? currencyModelWeights(staged.holdings, sel, ccyProfile, isCore) : null;
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
          <button className={BTN} onClick={startFromLive} disabled={parsing} title="Start a draft from the live models — e.g. to resize the Core / Thematic / Alpha buckets without a screenshot">
            Start from live models
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
          {applyResult.roleNote && <div className="mt-1 text-ink-2">{applyResult.roleNote}</div>}
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
                    {draft.models[g.id]?.origin === "edited" && <span title="Edited by hand — PIM changes no longer carry here" className="ml-1 text-warn">✎</span>}
                    {n > 0 && <span className={`ml-1 rounded-full px-1.5 text-[10.5px] ${bad ? "bg-neg-soft text-neg" : "bg-accent-soft text-accent"}`}>{n}</span>}
                  </button>
                );
              })}
            </div>
            <button className={BTN} disabled={selIdx >= groups.length - 1} onClick={() => setSelectedId(groups[selIdx + 1].id)} aria-label="Next model"><AppIcon name="chevR" size={13} /></button>
            {groups.some((g) => g.id !== draft.sourceGroupId && draft.models[g.id]?.origin === "edited") && (
              <button className={BTN} onClick={rederiveAll} title="Throw away hand edits on every other model and derive them from the source again">
                <AppIcon name="refresh" size={13} />Re-derive edited models ({groups.filter((g) => g.id !== draft.sourceGroupId && draft.models[g.id]?.origin === "edited").length})
              </button>
            )}
            <label className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-3">
              Portfolio % as
              <select value={profile} onChange={(e) => setUiPref("staging.profile", e.target.value)} className={INPUT}>
                {(Object.keys(sel.profiles) as PimProfileType[]).filter((p) => p !== "alpha" && p !== "core" && p !== "thematic").map((p) => <option key={p} value={p}>{PROFILE_LABELS[p]}</option>)}
              </select>
            </label>
          </div>

          {sel.profiles[profile] == null && (
            <div className="text-[11.5px] text-ink-3">{sel.name} has no {PROFILE_LABELS[profile]} profile — showing {PROFILE_LABELS[ccyProfile]} ({pct(sel.profiles[ccyProfile]?.equity ?? 0, 0)} equity), its highest.</div>
          )}
          {staged && ccyLive && ccyNew ? (
            <ModelDiffPanel
              group={sel}
              staged={staged}
              diff={diffs[sel.id] ?? []}
              isSource={sel.id === draft.sourceGroupId}
              profile={ccyProfile}
              ccyLive={ccyLive}
              ccyNew={ccyNew}
              buckets={draftHasBuckets(draft.parsed)}
              liveBucket={(sym) => bucketOf(sym, stocks)}
              stagedBucket={(sym) => stagedBucket(sym, stocks, draft.parsed)}
              onSetBucket={setBucket}
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

          <StagedRebalancePanel
            draft={draft}
            revision={pimModels.revision ?? 0}
            groupIds={changedGroups.map((g) => g.id)}
            blocked={blocking.length > 0}
            onBeforeRun={async () => {
              if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
              const s2 = await fetch("/api/kv/model-drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft }) });
              return s2.ok;
            }}
            onDone={async (j) => {
              // Book follow-through (pm:stocks, through the normal client path):
              // tag roles, then move names that left EVERY model to the Watchlist.
              syncRoles((j.roles ?? {}) as Record<string, EquityBucket>, draft.parsed);
              const stillHeld = (sym: string) => Object.values(draft.models).some((m) => m.holdings.some((h) => sameSymbol(h.symbol, sym)));
              const exited = new Set<string>();
              for (const syms of Object.values(j.exits ?? {})) for (const sym of syms) if (!stillHeld(sym)) exited.add(sym);
              for (const sym of exited) {
                const rec = stocks.find((st) => sameSymbol(st.ticker, sym));
                if (rec && rec.bucket === "Portfolio") moveBucket(rec.ticker, { skipPimModels: true });
              }
              await new Promise((r) => setTimeout(r, 300));
              await flushStocks();
              // Every surface (Models, Positioning, Holdings, Performance) re-reads
              // the new state; no stale tab state can write over it.
              window.location.reload();
            }}
          />
        </>
      )}
    </div>
  );
}

/* ── One model's proposed vs live ─────────────────────────────────── */

type SortKey = "status" | "name" | "symbol" | "ccy" | "bucket" | "live" | "proposed" | "delta" | "port" | "cad" | "usd";

function ModelDiffPanel({
  group, staged, diff, isSource, profile, ccyLive, ccyNew, buckets, liveBucket, stagedBucket: bucketFn, onSetBucket, errors, onChange, onRepropagate,
}: {
  group: PimModelGroup;
  staged: StagedModel;
  diff: DiffRow[];
  isSource: boolean;
  profile: PimProfileType;
  ccyLive: CurrencyWeights;
  ccyNew: CurrencyWeights;
  buckets: boolean;
  liveBucket: (symbol: string) => EquityBucket;
  stagedBucket: (symbol: string) => EquityBucket;
  onSetBucket: (symbol: string, bucket: EquityBucket) => void;
  errors: string[];
  onChange: (holdings: PimHolding[], parsedAdd?: ParsedRow) => void;
  onRepropagate: () => void;
}) {
  const [adding, setAdding] = useState<{ symbol: string; name: string; currency: "CAD" | "USD"; assetClass: PimAssetClass; kind: ParsedKind; pct: string } | null>(null);
  const classes = (["fixedIncome", "equity", "alternative"] as PimAssetClass[]).filter((ac) => diff.some((r) => r.assetClass === ac));
  const kindOrder = { add: 0, change: 1, remove: 2, same: 3 } as const;
  // Column sort (within each asset class). Persisted like the other staging
  // prefs so the order survives a refresh.
  const { uiPrefs, setUiPref } = useStocks();
  const [sortKey, sortDir] = ((uiPrefs["staging.sort"] as string) || "status:asc").split(":") as [SortKey, "asc" | "desc"];
  const setSort = (k: SortKey, d: "asc" | "desc") => setUiPref("staging.sort", `${k}:${d}`);
  const sortVal = (r: DiffRow, ac: PimAssetClass): number | string => {
    switch (sortKey) {
      case "name": return r.name;
      case "symbol": return r.symbol;
      case "ccy": return r.currency;
      case "bucket": return BUCKET_LABELS[r.after == null ? liveBucket(r.symbol) : bucketFn(r.symbol)];
      case "live": return r.before ?? -1;
      case "proposed": return r.after ?? -1;
      case "delta": return (r.after ?? 0) - (r.before ?? 0);
      case "port": return (r.after ?? -1) * allocOf(group, profile, ac);
      case "cad": return (r.after == null ? null : ccyNew.rows[r.symbol]?.cad) ?? -1;
      case "usd": return (r.after == null ? null : ccyNew.rows[r.symbol]?.usd) ?? -1;
      default: return 0;
    }
  };
  const sortTh = (k: SortKey, label: string, right?: boolean, className = "") => (
    <th key={k} className={`${right ? "text-right" : ""} ${className}`}>
      <button
        className={`inline-flex items-center gap-1 hover:text-ink ${sortKey === k ? "text-ink" : ""}`}
        onClick={() => setSort(k, sortKey === k && sortDir === "desc" ? "asc" : sortKey === k ? "desc" : (["name", "symbol", "ccy", "bucket"].includes(k) ? "asc" : "desc"))}
      >
        {label}
        {sortKey === k && <AppIcon name={sortDir === "asc" ? "sortAsc" : "sortDesc"} size={11} />}
      </button>
    </th>
  );

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
          {isSource ? "the source — edits here carry to every other model" : staged.origin === "edited" ? <span className="font-medium text-warn">edited by hand — PIM changes no longer carry here</span> : "follows the source automatically"}
        </span>
        {!isSource && staged.origin === "edited" && (
          <button className={`${BTN} ml-auto`} onClick={onRepropagate}><AppIcon name="refresh" size={13} />Re-derive from screenshot</button>
        )}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 border-b border-line-soft px-3.5 py-2 text-[12px] text-ink-2">
        {(["CAD", "USD"] as const).map((c) => (
          <span key={c}>
            <span className="font-semibold text-ink">{c} account</span> · {PROFILE_LABELS[profile]}{" "}
            <span className="tabular-nums text-ink-3">{pct(ccyLive.account[c])}</span> →{" "}
            <span className={`tabular-nums font-medium ${Math.abs(ccyNew.account[c] - ccyLive.account[c]) > 0.00005 ? "text-accent" : "text-ink"}`}>{pct(ccyNew.account[c])}</span>
            <span className="text-ink-3"> of portfolio</span>
          </span>
        ))}
        <span className="text-ink-3">
          {group.id === "pc-usa" ? "PC USA: the CAD account is its CAD stocks — it moves with them." : "Built 50% CAD / 50% USD in equity."}
        </span>
      </div>
      {buckets && (
        <BucketPanel
          group={group}
          staged={staged}
          isSource={isSource}
          profile={profile}
          liveBucket={liveBucket}
          bucketFn={bucketFn}
          onResize={(t) => {
            const { holdings, problems } = rescaleBuckets(staged.holdings, bucketFn, t);
            if (problems.length) { window.alert(`Can't resize: ${problems.join("; ")}`); return; }
            onChange(holdings);
          }}
        />
      )}
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
              {sortTh("name", "Holding", false, "pl-3.5")}
              {sortTh("symbol", "Symbol", false)}
              {sortTh("ccy", "Ccy", false)}
              {buckets && sortTh("bucket", "Bucket", false)}
              {sortTh("live", "Live · class", true)}
              {sortTh("proposed", "Proposed · class", true)}
              {sortTh("delta", "Δ", true)}
              {sortTh("port", `Proposed · ${PROFILE_LABELS[profile]}`, true)}
              {sortTh("cad", "CAD model", true)}
              {sortTh("usd", "USD model", true)}
              <th>
                {sortKey !== "status" && (
                  <button className="text-[11px] font-normal text-ink-3 hover:text-ink" onClick={() => setSort("status", "asc")} title="Back to the default order (new, changed, removed, then by weight)">reset</button>
                )}
              </th>
            </tr>
          </thead>
          <tbody>
            {classes.map((ac) => {
              const rows = diff.filter((r) => r.assetClass === ac).sort((a, b) => {
                if (sortKey === "status") return kindOrder[a.kind] - kindOrder[b.kind] || (b.after ?? 0) - (a.after ?? 0);
                const va = sortVal(a, ac), vb = sortVal(b, ac);
                const c = typeof va === "string" || typeof vb === "string" ? String(va).localeCompare(String(vb)) : (va as number) - (vb as number);
                return sortDir === "asc" ? c : -c;
              });
              // 2-decimal columns that sum exactly — what is shown is what gets
              // typed into the modelling tool.
              const coreFlags = rows.map((r) => r.after != null && bucketFn(r.symbol) === "core");
              // Same apportioning as the Models / Positioning tables: equal
              // weights stay equal, the remainder lands on a Core ETF.
              const col = (v: (number | null)[]) => apportionColumn(v, undefined, { prefer: coreFlags }).values;
              const shown = {
                cls: col(rows.map((r) => r.after)),
                port: col(rows.map((r) => (r.after == null ? null : r.after * allocOf(group, profile, ac)))),
                cad: col(rows.map((r) => (r.after == null ? null : ccyNew.rows[r.symbol]?.cad ?? null))),
                usd: col(rows.map((r) => (r.after == null ? null : ccyNew.rows[r.symbol]?.usd ?? null))),
              };
              const shownAt = (k: keyof typeof shown, sym: string) => shown[k][rows.findIndex((x) => x.symbol === sym)] ?? null;
              const colTotal = (k: keyof typeof shown) => shown[k].reduce<number>((a, v) => a + (v ?? 0), 0);
              const liveSum = rows.reduce((a, r) => a + (r.before ?? 0), 0);
              const newSum = rows.reduce((a, r) => a + (r.after ?? 0), 0);
              return (
                <React.Fragment key={ac}>
                  <tr><td colSpan={buckets ? 11 : 10} className="bg-surface-hover pl-3.5 text-[11.5px] font-semibold text-ink-2">{CLASS_LABELS[ac]}</td></tr>
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
                        {buckets && (
                          <td>
                            {ac !== "equity" ? null : isSource && r.after != null ? (
                              <select
                                value={bucketFn(r.symbol)}
                                onChange={(e) => onSetBucket(r.symbol, e.target.value as EquityBucket)}
                                className={`${INPUT} h-6 px-1 text-[11.5px]`}
                                aria-label={`${r.symbol} bucket`}
                              >
                                {(["core", "thematic", "alpha"] as EquityBucket[]).map((b) => <option key={b} value={b}>{BUCKET_LABELS[b]}</option>)}
                              </select>
                            ) : (
                              <span className="text-[11.5px] text-ink-2">{BUCKET_LABELS[r.after == null ? liveBucket(r.symbol) : bucketFn(r.symbol)]}</span>
                            )}
                          </td>
                        )}
                        <td className="text-right tabular-nums">{pct(r.before)}</td>
                        <td className="text-right">
                          {r.after == null ? "—" : (
                            <input
                              key={`${r.symbol}-${r.after}-${shownAt("cls", r.symbol)}`}
                              defaultValue={((shownAt("cls", r.symbol) ?? 0) * 100).toFixed(2)}
                              onBlur={(e) => { if (e.target.value.trim() !== ((shownAt("cls", r.symbol) ?? 0) * 100).toFixed(2)) setWeight(r.symbol, e.target.value); }}
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                              className={`${INPUT} h-6 w-[84px] text-right tabular-nums`}
                              aria-label={`${r.symbol} proposed weight in class`}
                            />
                          )}
                        </td>
                        <td className={`text-right tabular-nums ${Math.abs(delta) < 1e-6 ? "text-ink-3" : delta > 0 ? "text-pos" : "text-neg"}`}>
                          {Math.abs(delta) < 1e-6 ? "—" : `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(2)}`}
                        </td>
                        <td className="text-right tabular-nums">{r.after == null ? "—" : pct(shownAt("port", r.symbol))}</td>
                        {(["cad", "usd"] as const).map((k) => {
                          const lv = ccyLive.rows[r.symbol]?.[k] ?? null;
                          const nv = r.after == null ? null : shownAt(k, r.symbol);
                          if (lv == null && nv == null) return <td key={k} className="text-right text-ink-faint">·</td>;
                          const moved = lv == null || nv == null || Math.abs(nv - lv) > 0.00005;
                          return (
                            <td key={k} className="whitespace-nowrap text-right tabular-nums">
                              {moved && <span className="text-[11px] text-ink-3">{pct(lv)} → </span>}
                              <span className={moved ? "font-medium text-ink" : "text-ink-2"}>{pct(nv)}</span>
                            </td>
                          );
                        })}
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
                    <td colSpan={buckets ? 4 : 3} className="pl-3.5 text-[11.5px] text-ink-3">{CLASS_LABELS[ac]} total</td>
                    <td className="text-right tabular-nums">{pct(liveSum)}</td>
                    <td className={`text-right tabular-nums ${Math.abs(newSum - 1) > 0.002 ? "text-neg" : ""}`}>{pct(colTotal("cls"))}</td>
                    <td />
                    <td className="text-right tabular-nums">{pct(colTotal("port"))}</td>
                    {(["cad", "usd"] as const).map((k) => {
                      const t = colTotal(k);
                      return <td key={k} className="text-right tabular-nums">{t > 0 ? pct(t) : "—"}</td>;
                    })}
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

/* ── Core / Thematic / Alpha bucket strip ─────────────────────────── */

function BucketPanel({
  group, staged, isSource, profile, liveBucket, bucketFn, onResize,
}: {
  group: PimModelGroup;
  staged: StagedModel;
  isSource: boolean;
  profile: PimProfileType;
  liveBucket: (symbol: string) => EquityBucket;
  bucketFn: (symbol: string) => EquityBucket;
  onResize: (t: Record<EquityBucket, number>) => void;
}) {
  const tot = (hs: PimHolding[], f: (s: string) => EquityBucket) => {
    const o: Record<EquityBucket, number> = { core: 0, thematic: 0, alpha: 0 };
    for (const h of hs) if (h.assetClass === "equity") o[f(h.symbol)] += h.weightInClass;
    return o;
  };
  const live = tot(group.holdings, liveBucket);
  const next = tot(staged.holdings, bucketFn);
  const eqAlloc = allocOf(group, profile, "equity");
  const cell = (k: EquityBucket) => (
    <span key={k} className="whitespace-nowrap">
      <span className="font-semibold text-ink">{BUCKET_LABELS[k]}</span>{" "}
      <span className="tabular-nums text-ink-3">{pct(live[k])}</span> →{" "}
      <span className={`tabular-nums font-medium ${Math.abs(next[k] - live[k]) > 0.00005 ? "text-accent" : "text-ink"}`}>{pct(next[k])}</span>
      <span className="text-ink-3"> of equity · {pct(next[k] * eqAlloc)} {PROFILE_LABELS[profile]}</span>
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-b border-line-soft px-3.5 py-2 text-[12px] text-ink-2">
      {(["core", "thematic", "alpha"] as EquityBucket[]).map(cell)}
      {isSource && (
        <BucketInputs key={`${next.alpha.toFixed(6)}|${next.thematic.toFixed(6)}`} alpha0={next.alpha} thematic0={next.thematic} onResize={onResize} />
      )}
    </div>
  );
}

/** Target inputs, re-seeded (via `key`) whenever the staged totals change. */
function BucketInputs({ alpha0, thematic0, onResize }: { alpha0: number; thematic0: number; onResize: (t: Record<EquityBucket, number>) => void }) {
  const [alpha, setAlpha] = useState((alpha0 * 100).toFixed(2));
  const [thematic, setThematic] = useState((thematic0 * 100).toFixed(2));
  const a = parseFloat(alpha) / 100;
  const t = parseFloat(thematic) / 100;
  const coreT = 1 - (Number.isFinite(a) ? a : 0) - (Number.isFinite(t) ? t : 0);
  return (
    <span className="ml-auto flex items-center gap-1.5">
      Alpha
      <input value={alpha} onChange={(e) => setAlpha(e.target.value)} className={`${INPUT} h-6 w-[64px] text-right tabular-nums`} aria-label="Alpha bucket % of equity" />
      Thematic
      <input value={thematic} onChange={(e) => setThematic(e.target.value)} className={`${INPUT} h-6 w-[64px] text-right tabular-nums`} aria-label="Thematic bucket % of equity" />
      <span className="text-ink-3">Core {Number.isFinite(coreT) ? (coreT * 100).toFixed(2) : "—"}%</span>
      <button
        className={BTN}
        disabled={!Number.isFinite(a) || !Number.isFinite(t) || a < 0 || t < 0 || coreT < 0}
        onClick={() => onResize({ alpha: a, thematic: t, core: coreT })}
        title="Scale each bucket's holdings proportionally to these shares of equity"
      >
        Resize buckets
      </button>
    </span>
  );
}

/* ── Apply + record the rebalance the desk traded on the previous day ── */

/** The last 5 trading days (weekdays) before today ET, newest first — the
 *  dates the route accepts (MAX_BACKDATE_SESSIONS). */
const recentTradeDatesET = () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  const out: string[] = [];
  while (out.length < 5) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

type PlanSymbol = { symbol: string; name: string; isMF: boolean; traded: boolean; sizingClose: { price: number; date: string } | null; asOfClose: number | null; netUnits: number; needsPrice: boolean };
type PlanResponse = { asOf: string; sizingDate: string; fx: { sizing: number | null; asOf: number | null }; symbols: PlanSymbol[]; books: BookPlan[]; problems: string[]; revision: number };
type RebalanceDone = { roles?: Record<string, EquityBucket>; exits?: Record<string, string[]>; versionId: string; trades: number; stashes: string[] };

function StagedRebalancePanel({
  draft, revision, groupIds, blocked, onBeforeRun, onDone,
}: {
  draft: ModelDraft;
  revision: number;
  groupIds: string[];
  blocked: boolean;
  onBeforeRun: () => Promise<boolean>;
  onDone: (j: RebalanceDone) => Promise<void>;
}) {
  const dates = recentTradeDatesET();
  // No default on purpose: the PM picks the day the desk actually traded.
  const [asOf, setAsOf] = useState("");
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [busy, setBusy] = useState<"" | "plan" | "commit">("");
  const [err, setErr] = useState("");
  const [px, setPx] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState("");
  const [detailOpen, toggleDetail] = usePersistedOpen("staging.rebalance.detail", false);

  const build = async () => {
    setBusy("plan");
    setErr("");
    try {
      if (!(await onBeforeRun())) { setErr("Could not save the draft first — nothing built."); return; }
      const mfOverrides = Object.fromEntries(Object.entries(px).filter(([sym, v]) => plan?.symbols.find((x) => x.symbol === sym)?.isMF && parseFloat(v) > 0).map(([sym, v]) => [sym, parseFloat(v)]));
      const r = await fetch("/api/model-staging/rebalance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "plan", draftId: draft.id, asOf, execPrices: mfOverrides }) });
      const j = await r.json();
      if (!r.ok) { setErr(j.error ?? "Could not build the trade list."); return; }
      setPlan(j);
    } finally {
      setBusy("");
    }
  };
  const need = (plan?.symbols ?? []).filter((s) => s.needsPrice);
  const missing = need.filter((s) => !(parseFloat(px[s.symbol] ?? "") > 0));
  const commit = async () => {
    if (!plan) return;
    setBusy("commit");
    setErr("");
    try {
      if (!(await onBeforeRun())) { setErr("Could not save the draft first — nothing written."); return; }
      const execPrices: Record<string, number> = Object.fromEntries(need.map((s) => [s.symbol, parseFloat(px[s.symbol])]));
      // Optional NAV overrides for mutual funds (blank = the fetched NAV).
      for (const s of plan.symbols) if (s.isMF && parseFloat(px[s.symbol] ?? "") > 0) execPrices[s.symbol] = parseFloat(px[s.symbol]);
      const r = await fetch("/api/model-staging/rebalance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "commit", draftId: draft.id, asOf, expectedRevision: revision, execPrices, confirm: confirm.trim(), groupIds }),
      });
      // A timeout / platform error returns HTML, not JSON — never swallow it.
      const text = await r.text();
      let j: { error?: string; problems?: string[]; missing?: string[]; note?: string; trace?: string[] } | null = null;
      try { j = JSON.parse(text); } catch { /* non-JSON */ }
      if (!r.ok || !j) {
        const steps = j?.trace?.length ? ` · completed: ${j.trace.join(" → ")}` : "";
        setErr(j ? [j.error, ...(j.problems ?? []), ...(j.missing ?? []), j.note].filter(Boolean).join(" · ") + steps : `The server didn't finish (HTTP ${r.status}${text ? `: ${text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)}` : ""}). Some steps may have run — reload the page, then check Models and Positioning before re-running.`);
        return;
      }
      await onDone(j as RebalanceDone);
    } catch (e) {
      setErr(`The request failed before the server answered (${e instanceof Error ? e.message : String(e)}). Reload, then check Models and Positioning before re-running.`);
    } finally {
      setBusy("");
    }
  };

  const fmt = (v: number | null | undefined, dp = 2) => (v == null ? "—" : v.toLocaleString("en-CA", { minimumFractionDigits: dp, maximumFractionDigits: dp }));
  return (
    <section className="panel px-3.5 py-3 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="font-semibold text-ink">Apply + record a rebalance the desk already traded</span>
        <label className="flex items-center gap-1.5 text-ink-2">
          Trade date
          <select
            value={asOf}
            onChange={(e) => { setAsOf(e.target.value); setPlan(null); setConfirm(""); }}
            className={INPUT}
            aria-label="Trade date"
          >
            <option value="">Pick the day…</option>
            {dates.map((d) => <option key={d} value={d}>{new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })} ({d})</option>)}
          </select>
        </label>
        {asOf && <span className="text-ink-3">Writes the models AND every PIM positions book as of {asOf}&apos;s close.</span>}
      </div>
      <p className="mt-1 text-[11.5px] text-ink-3">
        Performance: the trade day&apos;s return stays on the old holdings (locked first); every day after it is recomputed on the new models and positions (the Appendix follows). It is refused if any trade was recorded after the trade date. Units are sized off the prior close like the desk; you enter the average fill for stocks / ETFs (cost basis); mutual funds fill at that day&apos;s NAV automatically (type a NAV to override). The Alpha book becomes stocks-only. Names leaving every model move to the Watchlist. Each store is copied aside first, and the models are snapshotted.
      </p>
      {err && <div className="mt-2 rounded-control bg-neg-soft px-2.5 py-1.5 text-[12px] text-neg">{err}</div>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className={BTN} disabled={!!busy || blocked || !asOf} onClick={build}>
          <AppIcon name="refresh" size={13} />{busy === "plan" ? "Building trade list…" : plan ? "Rebuild trade list" : "Build trade list"}
        </button>
        {blocked && <span className="text-[11.5px] text-neg">Fix the model errors above first.</span>}
      </div>

      {plan && (
        <div className="mt-3 flex flex-col gap-2.5">
          {plan.problems.length > 0 && <div className="rounded-control bg-neg-soft px-2.5 py-1.5 text-[12px] text-neg">Can&apos;t commit: {plan.problems.join(" · ")}</div>}
          <div className="text-[11.5px] text-ink-3">
            Sizing close {plan.sizingDate} · USD/CAD {fmt(plan.fx.sizing, 4)} (sizing) / {fmt(plan.fx.asOf, 4)} ({plan.asOf}, cost basis of USD buys) · {plan.books.length} books: {plan.books.map((b) => b.profile).join(", ")}
          </div>
          <div className="tbl-wrap overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="pl-3.5">Holding</th><th>Symbol</th>
                  <th className="text-right">Prior close ({plan.sizingDate})</th>
                  <th className="text-right">Close {plan.asOf}</th>
                  <th className="text-right">Net units (all books)</th>
                  <th className="text-right">Average fill price</th>
                </tr>
              </thead>
              <tbody>
                {plan.symbols.filter((s) => s.traded).sort((a, b) => Number(a.isMF) - Number(b.isMF) || a.symbol.localeCompare(b.symbol)).map((s) => (
                  <tr key={s.symbol}>
                    <td className="pl-3.5">{s.name}</td>
                    <td className="font-mono">{s.symbol}</td>
                    <td className="text-right tabular-nums">{fmt(s.sizingClose?.price ?? null, 4)}</td>
                    <td className="text-right tabular-nums">{fmt(s.asOfClose, 4)}</td>
                    <td className={`text-right tabular-nums ${s.netUnits > 0 ? "text-pos" : s.netUnits < 0 ? "text-neg" : "text-ink-3"}`}>{s.netUnits > 0 ? "+" : ""}{fmt(s.netUnits, 4)}</td>
                    <td className="text-right">
                      {s.isMF ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="text-[11.5px] text-ink-3">{s.asOfClose != null ? "NAV auto" : "no NAV found"}</span>
                          <input
                            value={px[s.symbol] ?? ""}
                            onChange={(e) => setPx((p) => ({ ...p, [s.symbol]: e.target.value }))}
                            placeholder={s.asOfClose != null ? s.asOfClose.toFixed(4) : "NAV"}
                            inputMode="decimal"
                            title="Optional — type the NAV to override the fetched one, then Rebuild so the units use it"
                            className={`${INPUT} h-6 w-[90px] text-right tabular-nums ${s.asOfClose == null && !(parseFloat(px[s.symbol] ?? "") > 0) ? "border-warn-border" : ""}`}
                            aria-label={`${s.symbol} NAV override`}
                          />
                        </span>
                      ) : (
                        <input
                          value={px[s.symbol] ?? ""}
                          onChange={(e) => setPx((p) => ({ ...p, [s.symbol]: e.target.value }))}
                          placeholder={s.asOfClose != null ? s.asOfClose.toFixed(2) : "price"}
                          inputMode="decimal"
                          className={`${INPUT} h-6 w-[100px] text-right tabular-nums ${parseFloat(px[s.symbol] ?? "") > 0 ? "" : "border-warn-border"}`}
                          aria-label={`${s.symbol} average fill price`}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="self-start text-[12px] text-accent hover:underline" onClick={toggleDetail}>{detailOpen ? "Hide" : "Show"} each book&apos;s trades</button>
          {detailOpen && (
            <div className="grid gap-3 lg:grid-cols-2">
              {plan.books.map((b) => (
                <div key={b.profile} className="rounded-card border border-line">
                  <div className="border-b border-line-soft px-3 py-1.5 text-[12px] font-medium text-ink">{b.profile} <span className="font-normal text-ink-3">· value {fmt(b.totalCad, 0)} CAD at the prior close · cash {fmt(b.cash, 0)}</span></div>
                  <table className="data-table">
                    <thead><tr><th className="pl-3">Symbol</th><th className="text-right">Target</th><th className="text-right">Units now</th><th className="text-right">Units after</th><th>Trade</th></tr></thead>
                    <tbody>
                      {b.rows.map((r) => (
                        <tr key={r.symbol}>
                          <td className="pl-3 font-mono">{r.symbol}{r.exit && <span className="ml-1 text-[10.5px] text-neg">exit</span>}</td>
                          <td className="text-right tabular-nums">{(r.modelPct * 100).toFixed(2)}%</td>
                          <td className="text-right tabular-nums">{fmt(r.unitsBefore, 4)}</td>
                          <td className="text-right tabular-nums">{fmt(r.unitsAfter, 4)}</td>
                          <td className={r.action === "BUY" ? "text-pos" : r.action === "SELL" ? "text-neg" : "text-ink-3"}>{r.action}{r.action !== "HOLD" && ` ${fmt(Math.abs(r.deltaUnits), 4)}`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t border-line-soft pt-2.5">
            {missing.length > 0 && <span className="text-[12px] text-warn">{missing.length} average price{missing.length === 1 ? "" : "s"} still to enter.</span>}
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={`Type REBALANCE ${asOf}`} className={`${INPUT} w-[230px] font-mono`} />
            <button
              className={BTN_PRIMARY}
              disabled={!!busy || blocked || plan.problems.length > 0 || missing.length > 0 || confirm.trim() !== `REBALANCE ${asOf}`}
              onClick={commit}
            >
              {busy === "commit" ? "Applying + recording…" : `Apply models + record rebalance (${asOf})`}
            </button>
            {busy === "commit" && <span className="text-[11.5px] text-ink-3">This can take up to a minute — keep this window open; the page reloads when it&apos;s done.</span>}
          </div>
        </div>
      )}
    </section>
  );
}
