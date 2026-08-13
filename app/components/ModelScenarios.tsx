"use client";

import React, { useState, useMemo, useEffect, useCallback } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useStocks } from "@/app/lib/StockContext";
import { displayTicker } from "@/app/lib/ticker";
import { apportionColumn, fmtPct2, sameAtDisplay } from "@/app/lib/display-weights";
import {
  applyScenario,
  diffHoldings,
  type ScenarioAction,
  type WeightBasis,
  type ResidualPolicy,
} from "@/app/lib/model-scenarios";
import type {
  PimModelGroup,
  PimHolding,
  PimProfileType,
  PimAssetClass,
  PimPortfolioPositions,
} from "@/app/lib/pim-types";

/**
 * Model Scenarios — preview model changes without touching the live model.
 *
 * A DELIBERATELY SEPARATE component from PimModel. The models table is dense,
 * load-bearing display code; a scenario is a scratchpad. Keeping them apart
 * means nothing here can regress a weight the PM actually trades on, and the
 * only shared state is read-only (`pimModels`, `pimPortfolioState`).
 *
 * There is NO write path from this panel into pm:pim-models. "Keep" saves the
 * scenario to its own key (pm:model-scenarios); turning a scenario into the
 * real model stays a manual edit in the models table, on purpose.
 */

type Props = { groups: PimModelGroup[] };

// Mirrors PimModel's own labels/colors on purpose: the scenario result is
// meant to be read side-by-side with the model table, so it uses the same
// asset-class cards, the same header colors and the same column rhythm.
const ASSET_CLASS_LABELS: Record<PimAssetClass, string> = {
  fixedIncome: "Fixed Income",
  equity: "Equities",
  alternative: "Alternatives",
};

const ASSET_CLASS_COLORS: Record<PimAssetClass, { bg: string; header: string }> = {
  fixedIncome: { bg: "bg-accent-soft", header: "bg-accent-soft text-accent" },
  equity: { bg: "bg-pos-soft", header: "bg-pos-soft text-pos" },
  alternative: { bg: "bg-warn-soft", header: "bg-warn-soft text-warn" },
};

function symbolToTicker(symbol: string): string {
  return symbol.endsWith("-T") ? symbol.replace(/-T$/, ".TO") : symbol;
}

type SavedScenario = {
  id: string;
  name: string;
  groupId: string;
  profile?: string;
  actions: ScenarioAction[];
  basis: WeightBasis;
  residual?: ResidualPolicy;
  residualTargets?: string[];
  allocBasis?: "target" | "actual" | "custom";
  customAlloc?: { equity: number; fixedIncome: number; alternative: number; cash: number };
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

type ScenarioRow = {
  symbol: string;
  name: string;
  currency: "CAD" | "USD";
  assetClass: PimAssetClass;
  /** Weight on the comparison side; null = not held there (a new position). */
  from: number | null;
  /** Weight under the scenario; null = sold out of the model. */
  to: number | null;
  delta: number;
  changed: boolean;
};

/** Same 2dp contract as the model tables — these numbers are model inputs. */
const pct = (v: number) => fmtPct2(v);
const yahooSymbol = (s: string) =>
  s.endsWith("-T") ? s.replace("-T", ".TO") : s.endsWith(".U") ? s.replace(".U", "-U.TO") : s;

export function ModelScenarios({ groups }: Props) {
  const { stocks } = useStocks();
  const searchParams = useSearchParams();

  // Follow the shared header selectors (?model=&version=) the same way
  // PimModel does, so the scenario panel always previews the model the PM is
  // looking at rather than a second, silently-diverging selection.
  const groupId = searchParams.get("model") || groups[0]?.id || "";
  const profile = (searchParams.get("version") as PimProfileType) || "balanced";
  const group = useMemo(() => groups.find((g) => g.id === groupId) ?? groups[0], [groups, groupId]);
  const baseHoldings: PimHolding[] = useMemo(() => group?.holdings ?? [], [group]);

  const [open, setOpen] = useState(false);

  // ── Actual weights (Positioning tab basis) ───────────────────────────────
  // The Positioning tab shows weights as a share of the WHOLE portfolio
  // (cash included). The scenario engine works in weightInClass space, so
  // actual values are normalised WITHIN each asset class here. That makes the
  // number directly comparable to a model weight and independent of both cash
  // and the profile's allocation.
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [usdCadRate, setUsdCadRate] = useState(1.35);
  const [pricesLoading, setPricesLoading] = useState(false);

  // Units come from pm:pim-positions — the same store the Positioning tab
  // reads. Fetched here rather than taken from context because the context
  // doesn't carry it, and read-only either way.
  const [positions, setPositions] = useState<PimPortfolioPositions[]>([]);

  const positionMap = useMemo(() => {
    const map = new Map<string, number>();
    const entry = positions.find((p) => p.groupId === groupId && p.profile === profile);
    for (const p of entry?.positions ?? []) map.set(p.symbol, p.units);
    return map;
  }, [positions, groupId, profile]);

  const fetchPrices = useCallback(async () => {
    if (!baseHoldings.length) return;
    setPricesLoading(true);
    const mapped: Record<string, number> = {};
    try {
      const res = await fetch("/api/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers: [...baseHoldings.map((h) => yahooSymbol(h.symbol)), "USDCAD=X"] }),
      });
      if (res.ok) {
        const data = await res.json();
        for (const h of baseHoldings) {
          const p = data.prices?.[yahooSymbol(h.symbol)] ?? data.prices?.[h.symbol];
          if (p != null) mapped[h.symbol] = p;
        }
        const fx = data.prices?.["USDCAD=X"];
        if (fx && fx > 0) setUsdCadRate(fx);
      }
    } catch {
      /* leave actual weights empty — the UI falls back to the model basis */
    }
    setLivePrices(mapped);
    setPricesLoading(false);
  }, [baseHoldings]);

  // Only pay for prices — and the positions read — once the panel is opened.
  useEffect(() => {
    if (!open) return;
    fetchPrices();
    (async () => {
      try {
        const res = await fetch("/api/kv/pim-positions");
        if (res.ok) {
          const data = await res.json();
          setPositions(data.portfolios || []);
        }
      } catch {
        /* actual weights simply stay unavailable */
      }
    })();
  }, [open, groupId]); // eslint-disable-line react-hooks/exhaustive-deps

  const actualWeights = useMemo(() => {
    const classTotals: Record<string, number> = {};
    const valueBySymbol: Record<string, number> = {};
    for (const h of baseHoldings) {
      const units = positionMap.get(h.symbol) ?? 0;
      const price = livePrices[h.symbol] ?? 0;
      const valueCad = units * price * (h.currency === "USD" ? usdCadRate : 1);
      valueBySymbol[h.symbol] = valueCad;
      classTotals[h.assetClass] = (classTotals[h.assetClass] ?? 0) + valueCad;
    }
    const out: Record<string, number> = {};
    for (const h of baseHoldings) {
      const total = classTotals[h.assetClass] ?? 0;
      // A class with no positions yet has no "actual" — leaving the symbol out
      // makes the engine fall back to that holding's model weight rather than
      // seeding a fabricated zero.
      if (total > 0) out[h.symbol] = valueBySymbol[h.symbol] / total;
    }
    return out;
  }, [baseHoldings, positionMap, livePrices, usdCadRate]);

  const hasActuals = Object.keys(actualWeights).length > 0;

  /**
   * The live asset-class split, from the same priced positions.
   *
   * Rebasing holdings to actual weights but still scaling them by the
   * PROFILE's class allocation would be half a rebase: the book's equity share
   * has drifted away from 66% too, so the "% of portfolio" column would be a
   * blend of today's holdings and yesterday's allocation. Cash is included in
   * the denominator so these are comparable to the profile weights.
   */
  const actualClassAlloc = useMemo(() => {
    const entry = positions.find((p) => p.groupId === groupId && p.profile === profile);
    const byClass: Record<string, number> = { equity: 0, fixedIncome: 0, alternative: 0 };
    for (const h of baseHoldings) {
      const units = positionMap.get(h.symbol) ?? 0;
      const price = livePrices[h.symbol] ?? 0;
      byClass[h.assetClass] += units * price * (h.currency === "USD" ? usdCadRate : 1);
    }
    const cash = entry?.cashBalance ?? 0;
    const total = byClass.equity + byClass.fixedIncome + byClass.alternative + cash;
    if (total <= 0) return null;
    return {
      equity: byClass.equity / total,
      fixedIncome: byClass.fixedIncome / total,
      alternative: byClass.alternative / total,
      cash: cash / total,
    };
  }, [positions, groupId, profile, baseHoldings, positionMap, livePrices, usdCadRate]);

  // Core-tagged holdings absorb the residual, mirroring the live rebalance
  // (designation lives on pm:stocks; default-undefined means alpha).
  const isCore = useCallback(
    (symbol: string) => {
      const t = symbol.replace(/\.TO$/, "-T").toUpperCase();
      const s = stocks.find((x) => x.ticker.replace(/\.TO$/, "-T").toUpperCase() === t);
      return s?.designation === "core";
    },
    [stocks],
  );

  // ── Draft scenario ───────────────────────────────────────────────────────
  const [draftId, setDraftId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [actions, setActions] = useState<ScenarioAction[]>([]);
  const [basis, setBasis] = useState<WeightBasis>("actual");
  /**
   * Where the asset-class splits come from. "custom" is the hypothetical:
   * selling bonds to fund alts is an ALLOCATION decision, not a holdings one —
   * within-class weights always renormalise to 100% of their own class, so the
   * only way to model moving money between sleeves is to move the splits.
   */
  const [allocBasis, setAllocBasis] = useState<"target" | "actual" | "custom">("target");
  const [customAlloc, setCustomAlloc] = useState<{ equity: number; fixedIncome: number; alternative: number; cash: number } | null>(null);
  const [residual, setResidual] = useState<ResidualPolicy>("core");
  /** Symbols that absorb under the "named" policy, split evenly. */
  const [residualTargets, setResidualTargets] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  /** The residual rule matters only for standalone weight edits now, so it
   *  starts hidden — one less control in the way of the common flow. */
  const [showAdvanced, setShowAdvanced] = useState(false);

  /** Starting weights under the chosen basis — used to show, before you
   *  commit the change, how much weight a trim would actually move. */
  const seededWeights = useMemo(() => {
    const out: Record<string, number> = {};
    for (const h of baseHoldings) {
      const hit = Object.entries(actualWeights).find(
        ([sym]) => sym.replace(/\.TO$/, "-T").toUpperCase() === h.symbol.replace(/\.TO$/, "-T").toUpperCase(),
      );
      out[h.symbol.toUpperCase()] =
        basis === "actual" && hasActuals && hit ? hit[1] : h.weightInClass;
    }
    return out;
  }, [baseHoldings, actualWeights, hasActuals, basis]);


  // ── Saved scenarios ──────────────────────────────────────────────────────
  const [saved, setSaved] = useState<SavedScenario[]>([]);
  const [compareId, setCompareId] = useState<string>("current");

  const loadSaved = useCallback(async () => {
    try {
      const res = await fetch("/api/kv/model-scenarios", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setSaved(Array.isArray(data.scenarios) ? data.scenarios : []);
      }
    } catch {
      /* keep whatever is already on screen */
    }
  }, []);

  useEffect(() => {
    if (open) loadSaved();
  }, [open, loadSaved]);

  /** The class splits the scenario STARTS from (before any cross-class move). */
  const startAlloc = useMemo(() => {
    if (allocBasis === "custom" && customAlloc)
      return { equity: customAlloc.equity, fixedIncome: customAlloc.fixedIncome, alternative: customAlloc.alternative };
    if (allocBasis === "actual" && actualClassAlloc)
      return { equity: actualClassAlloc.equity, fixedIncome: actualClassAlloc.fixedIncome, alternative: actualClassAlloc.alternative };
    const w = group?.profiles?.[profile];
    return { equity: w?.equity ?? 0, fixedIncome: w?.fixedIncome ?? 0, alternative: w?.alternatives ?? 0 };
  }, [allocBasis, customAlloc, actualClassAlloc, group, profile]);

  const result = useMemo(
    () =>
      applyScenario(baseHoldings, actions, {
        basis: basis === "actual" && hasActuals ? "actual" : "model",
        actualWeights,
        isCore,
        residual,
        residualTargets,
        allocations: startAlloc,
      }),
    [baseHoldings, actions, basis, hasActuals, actualWeights, isCore, residual, residualTargets, startAlloc],
  );

  // The left-hand side of the comparison: today's model, or another scenario
  // replayed against the same base so two proposals are judged like-for-like.
  const comparisonBase = useMemo(() => {
    if (compareId === "current") {
      // Same starting point as the draft, no actions — isolates what YOUR
      // changes did.
      return applyScenario(baseHoldings, [], {
        basis: basis === "actual" && hasActuals ? "actual" : "model",
        actualWeights,
        isCore,
        residual,
      }).holdings;
    }
    if (compareId === "model") {
      // The model as written. Against an actual-basis draft this shows the
      // rebase ITSELF plus your changes — the full impact of adopting today's
      // book as the new model.
      return applyScenario(baseHoldings, [], { basis: "model", isCore, residual }).holdings;
    }
    const other = saved.find((s) => s.id === compareId);
    if (!other) return baseHoldings;
    return applyScenario(baseHoldings, other.actions, {
      basis: other.basis === "actual" && hasActuals ? "actual" : "model",
      actualWeights,
      isCore,
      residual: other.residual ?? "core",
      residualTargets: other.residualTargets,
    }).holdings;
  }, [compareId, saved, baseHoldings, basis, hasActuals, actualWeights, isCore, residual]);

  const deltas = useMemo(
    () => diffHoldings(comparisonBase, result.holdings),
    [comparisonBase, result.holdings],
  );

  /** Every holding on EITHER side, so the result reads like the model table
   *  (full book, changed rows highlighted) rather than a list of edits. */
  const rowsByClass = useMemo(() => {
    const key = (sym: string) => sym.replace(/\.TO$/, "-T").toUpperCase();
    const out: Record<PimAssetClass, ScenarioRow[]> = {
      fixedIncome: [],
      equity: [],
      alternative: [],
    };
    const seen = new Map<string, ScenarioRow>();
    for (const h of comparisonBase) {
      seen.set(key(h.symbol), {
        symbol: h.symbol,
        name: h.name,
        currency: h.currency,
        assetClass: h.assetClass,
        from: h.weightInClass,
        to: null,
        delta: 0,
        changed: false,
      });
    }
    for (const h of result.holdings) {
      const k = key(h.symbol);
      const prev = seen.get(k);
      if (prev) prev.to = h.weightInClass;
      else
        seen.set(k, {
          symbol: h.symbol,
          name: h.name,
          currency: h.currency,
          assetClass: h.assetClass,
          from: null,
          to: h.weightInClass,
          delta: 0,
          changed: false,
        });
    }
    for (const r of seen.values()) {
      r.delta = (r.to ?? 0) - (r.from ?? 0);
      // A row counts as changed if it was added, removed, or actually moved —
      // not merely because floating-point renormalisation grazed it.
      r.changed = r.from == null || r.to == null || Math.abs(r.delta) > 1e-9;
      out[r.assetClass].push(r);
    }
    for (const cls of Object.keys(out) as PimAssetClass[]) {
      out[cls].sort((a, b) => a.name.localeCompare(b.name));
    }
    return out;
  }, [comparisonBase, result.holdings]);

  const compareLabel =
    compareId === "current"
      ? basis === "actual" && hasActuals
        ? "Actual"
        : "Current"
      : compareId === "model"
        ? "Model"
        : (saved.find((s) => s.id === compareId)?.name ?? "Current");

  /** Allocations AFTER the scenario — a cross-class buy moves them, so the
   *  "% of portfolio" column reflects the sleeve shift without the PM having
   *  to go and edit the split by hand. */
  const profileAlloc = useCallback(
    (cls: PimAssetClass) => (result.allocations?.[cls] ?? startAlloc[cls]) ?? null,
    [result.allocations, startAlloc],
  );

  // ── Action builder ───────────────────────────────────────────────────────
  // Two modes. "Fund" is first and default because it is the change actually
  // being made most of the time — trim one position, buy another with the
  // proceeds — and expressing that as two separate edits is what made the
  // panel confusing: you had to work out the freed weight yourself and hope
  // the residual policy didn't move the rest of the sleeve behind your back.
  const [mode, setMode] = useState<"fund" | "single">("fund");
  const [fundFrom, setFundFrom] = useState("");
  const [fundTo, setFundTo] = useState("");
  const [fundAmount, setFundAmount] = useState("");
  const [fundAll, setFundAll] = useState(false);
  /** Asset class for the bought position. "" = inherit the source's class.
   *  Explicit because inheriting silently misfiles a fund — an alt bought with
   *  bond proceeds is not a bond. */
  const [fundToClass, setFundToClass] = useState<PimAssetClass | "">("");
  /** Currency of the bought position. The symbol heuristic (.TO/-T → CAD)
   *  can't read a Fundserv code like LDM301, so it is asked for, not guessed. */
  const [fundToCcy, setFundToCcy] = useState<"CAD" | "USD">("CAD");

  const [newKind, setNewKind] = useState<ScenarioAction["kind"]>("setWeight");
  const [newSymbol, setNewSymbol] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newClass, setNewClass] = useState<PimAssetClass>("equity");

  const addFund = () => {
    const from = fundFrom.trim().toUpperCase();
    const to = fundTo.trim().toUpperCase();
    const num = parseFloat(fundAmount);
    if (!from || !to) return;
    if (!fundAll && !isFinite(num)) return;
    const srcClass = baseHoldings.find((h) => h.symbol.toUpperCase() === from)?.assetClass;
    setActions((prev) => [
      ...prev,
      {
        kind: "fund",
        from,
        to,
        fraction: fundAll ? 1 : num / 100,
        toAssetClass: (fundToClass || srcClass || "equity") as PimAssetClass,
        toCurrency: fundToCcy,
      },
    ]);
    setFundFrom("");
    setFundTo("");
    setFundAmount("");
    setFundAll(false);
    setFundToClass("");
    setFundToCcy("CAD");
  };

  const addAction = () => {
    const sym = newSymbol.trim().toUpperCase();
    if (!sym) return;
    const num = parseFloat(newValue);
    let a: ScenarioAction | null = null;
    if (newKind === "drop") a = { kind: "drop", symbol: sym };
    else if (newKind === "setWeight" && isFinite(num)) a = { kind: "setWeight", symbol: sym, weight: num / 100 };
    else if (newKind === "trim" && isFinite(num)) a = { kind: "trim", symbol: sym, fraction: num / 100 };
    else if (newKind === "add")
      a = { kind: "add", symbol: sym, assetClass: newClass, weight: isFinite(num) ? num / 100 : undefined };
    if (!a) return;
    setActions((prev) => [...prev, a!]);
    setNewSymbol("");
    setNewValue("");
  };

  const resetDraft = () => {
    setDraftId(null);
    setName("");
    setActions([]);
    setBasis("actual");
    setResidual("core");
    setResidualTargets([]);
    setAllocBasis("target");
    setCustomAlloc(null);
    setFundFrom("");
    setFundTo("");
    setFundAmount("");
    setFundAll(false);
  };

  const save = async () => {
    if (!name.trim() || !group) return;
    setSaving(true);
    try {
      const res = await fetch("/api/kv/model-scenarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: draftId,
          name: name.trim(),
          groupId: group.id,
          profile,
          actions,
          basis,
          residual,
          residualTargets,
          allocBasis,
          customAlloc,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setDraftId(data.scenario?.id ?? null);
        await loadSaved();
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/kv/model-scenarios?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (draftId === id) resetDraft();
    if (compareId === id) setCompareId("current");
    await loadSaved();
  };

  const load = (s: SavedScenario) => {
    setDraftId(s.id);
    setName(s.name);
    setActions(s.actions ?? []);
    setBasis(s.basis ?? "actual");
    setResidual(s.residual ?? "core");
    setResidualTargets(s.residualTargets ?? []);
    setAllocBasis(s.allocBasis ?? "target");
    setCustomAlloc(s.customAlloc ?? null);
  };

  const groupScenarios = saved.filter((s) => s.groupId === group?.id);
  const warnings = result.diagnostics.flatMap((d) => d.warnings);

  if (!group) return null;

  return (
    <div className="mt-6 rounded-lg border border-line bg-white">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div>
          <div className="text-sm font-semibold text-ink">Scenarios</div>
          <div className="text-xs text-ink-3">
            Preview model changes — nothing here writes to the live model
            {groupScenarios.length > 0 && ` · ${groupScenarios.length} saved`}
          </div>
        </div>
        <span className="text-xs text-ink-3">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="border-t border-line-soft px-4 py-4">
          {/* Basis + residual */}
          {/* Each label + control stays glued together while the ROW wraps, so
              on a phone the settings read as a stacked list rather than a
              jumble of half-sentences. */}
          <div className="mb-4 flex flex-col gap-3 text-xs sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
            <div className="flex items-center gap-2 min-w-0">
              <span className="shrink-0 text-ink-3">Start from</span>
              <select
                value={basis}
                onChange={(e) => setBasis(e.target.value as WeightBasis)}
                className="w-full rounded border border-line bg-surface-2 px-2 py-1 text-ink sm:w-auto"
              >
                <option value="actual">Current actual %</option>
                <option value="model">Model target % (rebalance to model)</option>
              </select>
              {basis === "actual" && !hasActuals && (
                <span className="text-warn">
                  {pricesLoading ? "loading prices…" : "no positions priced — using model weights"}
                </span>
              )}
            </div>
            {allocBasis === "custom" && customAlloc && (() => {
            const total = customAlloc.equity + customAlloc.fixedIncome + customAlloc.alternative + customAlloc.cash;
            const off = !sameAtDisplay(total, 1);
            const w = group?.profiles?.[profile];
            const targetOf = (k: keyof typeof customAlloc) =>
              k === "equity" ? w?.equity : k === "fixedIncome" ? w?.fixedIncome : k === "alternative" ? w?.alternatives : w?.cash;
            return (
              <div className="mb-3 grid grid-cols-1 gap-2 rounded border border-accent-border bg-accent-soft px-3 py-2 text-xs sm:flex sm:flex-wrap sm:items-center sm:gap-3">
                <span className="font-medium text-ink">Hypothetical splits</span>
                {(["equity", "fixedIncome", "alternative", "cash"] as const).map((k) => {
                  const tgt = targetOf(k) ?? 0;
                  const cur = customAlloc[k];
                  const moved = !sameAtDisplay(cur, tgt);
                  return (
                    <label key={k} className="flex items-center gap-1.5">
                      <span className="text-ink-3">
                        {k === "cash" ? "Cash" : ASSET_CLASS_LABELS[k as PimAssetClass]}
                      </span>
                      <input
                        value={(cur * 100).toFixed(2)}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          if (!isFinite(v)) return;
                          setCustomAlloc({ ...customAlloc, [k]: v / 100 });
                        }}
                        className="w-16 rounded border border-line bg-white px-1.5 py-0.5 text-right font-mono text-ink"
                      />
                      <span className="text-ink-3">%</span>
                      {moved && (
                        <span className={`font-mono ${cur > tgt ? "text-pos" : "text-neg"}`}>
                          {cur > tgt ? "+" : ""}
                          {fmtPct2(cur - tgt)}
                        </span>
                      )}
                    </label>
                  );
                })}
                <span className={off ? "font-semibold text-neg" : "text-ink-3"}>
                  Total {fmtPct2(total)}
                  {off && " — must be 100.00%"}
                </span>
                <button
                  onClick={() => {
                    const src = { equity: w?.equity ?? 0, fixedIncome: w?.fixedIncome ?? 0, alternative: w?.alternatives ?? 0, cash: w?.cash ?? 0 };
                    setCustomAlloc(src);
                  }}
                  className="rounded border border-line bg-white px-2 py-0.5 text-ink-3 hover:text-ink"
                >
                  Reset to profile
                </button>
              </div>
            );
          })()}

          {/* Rebasing holdings to actual but keeping the profile's class
                split would be half a rebase — the book's equity share has
                drifted too. This makes that second half explicit. */}
            <div className="flex items-center gap-2 min-w-0">
              <span className="shrink-0 text-ink-3">Class splits</span>
              <select
                value={allocBasis}
                onChange={(e) => {
                  const next = e.target.value as "target" | "actual" | "custom";
                  if (next === "custom" && !customAlloc) {
                    // Seed from whatever is on screen right now, so "custom"
                    // starts as a copy of the current split rather than blank.
                    const w = group?.profiles?.[profile];
                    const src =
                      allocBasis === "actual" && actualClassAlloc
                        ? actualClassAlloc
                        : {
                            equity: w?.equity ?? 0,
                            fixedIncome: w?.fixedIncome ?? 0,
                            alternative: w?.alternatives ?? 0,
                            cash: w?.cash ?? 0,
                          };
                    setCustomAlloc({ ...src });
                  }
                  setAllocBasis(next);
                }}
                className="w-full rounded border border-line bg-surface-2 px-2 py-1 text-ink sm:w-auto"
              >
                <option value="target">Profile targets</option>
                <option value="actual" disabled={!actualClassAlloc}>Current actual</option>
                <option value="custom">Hypothetical…</option>
              </select>
            </div>
            {/* Hidden by default, but never hidden while a NON-default rule is
                in force — a rule you can't see is a rule you'll forget. */}
            <div className={`flex items-center gap-2 ${showAdvanced || residual !== "core" ? "" : "hidden"}`}>
              <span className="text-ink-3">Freed weight goes to</span>
              <select
                value={residual}
                onChange={(e) => setResidual(e.target.value as ResidualPolicy)}
                className="w-full rounded border border-line bg-surface-2 px-2 py-1 text-ink sm:w-auto"
              >
                <option value="core">Core ETFs</option>
                <option value="proportional">All untouched holdings</option>
                <option value="named">Specific holdings (split evenly)</option>
              </select>
            </div>
            {residual === "named" && (
              <div className="flex items-center gap-2">
                <select
                  value=""
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v && !residualTargets.includes(v)) setResidualTargets((p) => [...p, v]);
                  }}
                  className="w-full rounded border border-line bg-surface-2 px-2 py-1 text-ink sm:w-auto"
                >
                  <option value="">Add a holding…</option>
                  {baseHoldings
                    .filter((h) => !residualTargets.includes(h.symbol))
                    .map((h) => (
                      <option key={h.symbol} value={h.symbol}>
                        {h.symbol} — {h.name}
                      </option>
                    ))}
                </select>
                {residualTargets.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center gap-1 rounded border border-accent-border bg-accent-soft px-2 py-1 text-ink"
                  >
                    {t}
                    <button
                      onClick={() => setResidualTargets((p) => p.filter((x) => x !== t))}
                      className="text-ink-faint hover:text-ink"
                    >
                      ×
                    </button>
                  </span>
                ))}
                {residualTargets.length > 1 && (
                  <span className="text-ink-faint">
                    {(100 / residualTargets.length).toFixed(0)}% each
                  </span>
                )}
                {residualTargets.length === 0 && (
                  <span className="text-warn">pick at least one holding to absorb</span>
                )}
              </div>
            )}
            <button
              onClick={() => setActions([])}
              className="rounded border border-line px-2 py-1 text-ink-3 hover:text-ink"
            >
              Clear changes
            </button>
            <button
              onClick={() => setShowAdvanced((v) => !v)}
              className="text-ink-faint hover:text-ink"
            >
              {showAdvanced ? "Fewer options" : "More options"}
            </button>
          </div>

          {/* Action builder */}
          <div className="mb-3 flex gap-1 text-xs">
            <button
              onClick={() => setMode("fund")}
              className={`rounded px-3 py-1 font-medium ${
                mode === "fund" ? "bg-accent !text-white" : "border border-line text-ink-3 hover:text-ink"
              }`}
            >
              Trim one to fund another
            </button>
            <button
              onClick={() => setMode("single")}
              className={`rounded px-3 py-1 font-medium ${
                mode === "single" ? "bg-accent !text-white" : "border border-line text-ink-3 hover:text-ink"
              }`}
            >
              Single change
            </button>
          </div>

          {mode === "fund" ? (
            <div className="mb-3 flex flex-col gap-2 text-xs sm:flex-row sm:flex-wrap sm:items-center">
              <span className="text-ink-3">Sell</span>
              <select
                value={fundAll ? "all" : "some"}
                onChange={(e) => setFundAll(e.target.value === "all")}
                className="w-full rounded border border-line bg-surface-2 px-2 py-1 text-ink sm:w-auto"
              >
                <option value="some">some of</option>
                <option value="all">all of</option>
              </select>
              {!fundAll && (
                <>
                  <input
                    value={fundAmount}
                    onChange={(e) => setFundAmount(e.target.value)}
                    placeholder="25"
                    className="w-full rounded border border-line bg-surface-2 px-2 py-1 text-ink sm:w-16"
                  />
                  <span className="text-ink-3">% of</span>
                </>
              )}
              <select
                value={fundFrom}
                onChange={(e) => setFundFrom(e.target.value)}
                className="w-full rounded border border-line bg-surface-2 px-2 py-1 text-ink sm:w-auto"
              >
                <option value="">Choose a holding…</option>
                {baseHoldings.map((h) => (
                  <option key={h.symbol} value={h.symbol}>
                    {h.symbol} — {h.name}
                  </option>
                ))}
              </select>
              <span className="text-ink-3">and buy</span>
              <input
                list="scenario-symbols"
                value={fundTo}
                onChange={(e) => setFundTo(e.target.value)}
                placeholder="Symbol"
                className="w-full rounded border border-line bg-surface-2 px-2 py-1 text-ink sm:w-32"
              />
              <span className="text-ink-3">as</span>
              <select
                value={fundToClass}
                onChange={(e) => setFundToClass(e.target.value as PimAssetClass | "")}
                className="w-full rounded border border-line bg-surface-2 px-2 py-1 text-ink sm:w-auto"
              >
                <option value="">
                  same class as source
                  {fundFrom
                    ? ` (${ASSET_CLASS_LABELS[baseHoldings.find((h) => h.symbol === fundFrom)?.assetClass ?? "equity"]})`
                    : ""}
                </option>
                <option value="equity">Equities</option>
                <option value="fixedIncome">Fixed Income</option>
                <option value="alternative">Alternatives</option>
              </select>
              <select
                value={fundToCcy}
                onChange={(e) => setFundToCcy(e.target.value as "CAD" | "USD")}
                className="w-full rounded border border-line bg-surface-2 px-2 py-1 text-ink sm:w-auto"
              >
                <option value="CAD">CAD</option>
                <option value="USD">USD</option>
              </select>
              <button
                onClick={addFund}
                disabled={!fundFrom || !fundTo || (!fundAll && !fundAmount)}
                className="rounded bg-accent px-3 py-1 font-medium !text-white disabled:opacity-40"
              >
                Add change
              </button>
              {fundFrom && fundTo && (fundAll || fundAmount) && (
                <span className="text-ink-faint">
                  {(() => {
                    const src = seededWeights[fundFrom.toUpperCase()];
                    if (src == null) return null;
                    const f = fundAll ? 1 : parseFloat(fundAmount) / 100;
                    if (!isFinite(f)) return null;
                    return `moves ${pct(src * Math.min(Math.max(f, 0), 1))} of the class`;
                  })()}
                </span>
              )}
            </div>
          ) : (
            <div className="mb-3 flex flex-col gap-2 text-xs sm:flex-row sm:flex-wrap sm:items-end">
              <select
                value={newKind}
                onChange={(e) => setNewKind(e.target.value as ScenarioAction["kind"])}
                className="w-full rounded border border-line bg-surface-2 px-2 py-1 text-ink sm:w-auto"
              >
                <option value="setWeight">Set weight</option>
                <option value="trim">Trim by</option>
                <option value="drop">Sell all of</option>
                <option value="add">Add new</option>
              </select>
              <input
                list="scenario-symbols"
                value={newSymbol}
                onChange={(e) => setNewSymbol(e.target.value)}
                placeholder="Symbol"
                className="w-full rounded border border-line bg-surface-2 px-2 py-1 text-ink sm:w-28"
              />
              {newKind !== "drop" && (
                <input
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  placeholder={newKind === "trim" ? "% of position" : "% of class"}
                  className="w-full rounded border border-line bg-surface-2 px-2 py-1 text-ink sm:w-28"
                />
              )}
              {newKind === "add" && (
                <select
                  value={newClass}
                  onChange={(e) => setNewClass(e.target.value as PimAssetClass)}
                  className="w-full rounded border border-line bg-surface-2 px-2 py-1 text-ink sm:w-auto"
                >
                  <option value="equity">Equity</option>
                  <option value="fixedIncome">Fixed Income</option>
                  <option value="alternative">Alternatives</option>
                </select>
              )}
              <button onClick={addAction} className="rounded bg-accent px-3 py-1 font-medium !text-white">
                Add change
              </button>
              <span className="text-ink-faint">
                Freed weight lands per the &ldquo;{residual === "core" ? "Core ETFs" : residual === "named" ? "Specific holdings" : "All untouched holdings"}&rdquo; rule above.
              </span>
            </div>
          )}
          <datalist id="scenario-symbols">
            {baseHoldings.map((h) => (
              <option key={h.symbol} value={h.symbol}>
                {h.name}
              </option>
            ))}
          </datalist>

          {/* Pending actions */}
          {actions.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-2">
              {actions.map((a, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-2 rounded border border-accent-border bg-accent-soft px-2 py-1 text-xs text-ink"
                >
                  {a.kind === "drop" && `Sell all ${a.symbol}`}
                  {a.kind === "setWeight" && `${a.symbol} → ${pct(a.weight)}`}
                  {a.kind === "trim" && `Trim ${a.symbol} by ${pct(a.fraction)}`}
                  {a.kind === "add" && `Add ${a.symbol}${a.weight != null ? ` at ${pct(a.weight)}` : ""}`}
                  {a.kind === "fund" &&
                    `${a.fraction >= 1 ? `Sell all ${a.from}` : `Trim ${a.from} by ${pct(a.fraction)}`} → buy ${a.to}${
                      a.toAssetClass ? ` (${ASSET_CLASS_LABELS[a.toAssetClass]}${a.toCurrency ? `, ${a.toCurrency}` : ""})` : ""
                    }`}
                  {a.kind === "retag" && `Retag ${a.symbol} → ${a.designation}`}
                  <button
                    onClick={() => setActions((prev) => prev.filter((_, j) => j !== i))}
                    className="text-ink-faint hover:text-ink"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {warnings.length > 0 && (
            <div className="mb-4 rounded border border-line bg-surface-2 px-3 py-2 text-xs text-warn">
              {warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          )}

          {/* Where the book actually sits vs the profile, so adopting today's
              weights is a decision made with the drift visible rather than an
              invisible side effect of a dropdown. */}
          {actualClassAlloc && group?.profiles?.[profile] && (
            <div className="mb-3 flex flex-col gap-1 rounded border border-line bg-surface-2 px-3 py-2 text-xs sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5">
              <span className="font-medium text-ink-3">Asset class split</span>
              {(["equity", "fixedIncome", "alternative"] as PimAssetClass[]).map((cls) => {
                const w = group.profiles[profile]!;
                const tgt = cls === "equity" ? w.equity : cls === "fixedIncome" ? w.fixedIncome : w.alternatives;
                const act =
                  cls === "equity"
                    ? actualClassAlloc.equity
                    : cls === "fixedIncome"
                      ? actualClassAlloc.fixedIncome
                      : actualClassAlloc.alternative;
                if (tgt === 0 && act === 0) return null;
                const drift = act - tgt;
                return (
                  <span key={cls} className="inline-flex items-center gap-1.5">
                    <span className="text-ink-3">{ASSET_CLASS_LABELS[cls]}</span>
                    <span className="font-mono text-ink">{fmtPct2(act)}</span>
                    <span className="text-ink-faint">vs {fmtPct2(tgt)} tgt</span>
                    {!sameAtDisplay(act, tgt) && (
                      <span className={`font-mono ${drift > 0 ? "text-pos" : "text-neg"}`}>
                        {drift > 0 ? "+" : ""}
                        {fmtPct2(drift)}
                      </span>
                    )}
                  </span>
                );
              })}
              <span className="text-ink-faint">
                {allocBasis === "custom"
                  ? "using hypothetical splits"
                  : allocBasis === "actual"
                    ? "using actual splits"
                    : "using profile targets"}
              </span>
            </div>
          )}

          {/* Comparison */}
          <div className="mb-2 flex flex-col gap-2 text-xs sm:flex-row sm:items-center">
            <span className="shrink-0 text-ink-3">Compare against</span>
            <select
              value={compareId}
              onChange={(e) => setCompareId(e.target.value)}
              className="w-full rounded border border-line bg-surface-2 px-2 py-1 text-ink sm:w-auto"
            >
              <option value="current">Starting point (no changes)</option>
              <option value="model">Model targets — shows the rebase too</option>
              {groupScenarios
                .filter((s) => s.id !== draftId)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </div>

          {deltas.length === 0 ? (
            <div className="py-6 text-center text-xs text-ink-3">
              No changes yet — add a change above to preview it.
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {(["fixedIncome", "equity", "alternative"] as PimAssetClass[]).map((ac) => {
                const rows = rowsByClass[ac];
                if (!rows.length) return null;
                const colors = ASSET_CLASS_COLORS[ac];
                // The sleeve's share of the portfolio BEFORE and AFTER. A
                // cross-class buy shrinks one and grows the other, so the two
                // sides of the table are scaled by different allocations.
                const allocTo = profileAlloc(ac) ?? 0;
                const allocFrom = startAlloc[ac] ?? allocTo;
                // Apportion to the column's OWN total, never to a forced 100%.
                // Forcing it scaled an unnormalised sleeve up to look correct —
                // the engine reported "left unnormalised at 92.96%" while the
                // table showed 100.00% and per-holding weights that were pure
                // fabrication. If a sleeve doesn't add up, that has to be
                // visible, because these numbers get typed into the model.
                // PRIMARY COLUMNS ARE % OF PORTFOLIO — the same number the
                // model's Target Wt column shows, so the two tables can be read
                // against each other. Leading with % of class was actively
                // misleading: when a sleeve shrinks, every survivor's share OF
                // THAT SLEEVE rises, so an untouched holding appeared to have
                // been bought (JBND "+3.85%") when its portfolio weight had not
                // moved at all.
                const rawFrom = rows.reduce((t, r) => t + (r.from ?? 0), 0);
                const rawTo = rows.reduce((t, r) => t + (r.to ?? 0), 0);
                // The odd hundredth goes to a row the scenario actually
                // changed, so an untouched holding never shows a phantom
                // ±0.01% purely because the column had to tie.
                const preferChanged = rows.map((r) => r.changed);
                const dFromP = apportionColumn(
                  rows.map((r) => (r.from == null ? null : r.from * allocFrom)),
                  rawFrom * allocFrom,
                  { prefer: preferChanged },
                );
                const dToP = apportionColumn(
                  rows.map((r) => (r.to == null ? null : r.to * allocTo)),
                  rawTo * allocTo,
                  { prefer: preferChanged },
                );
                // Class-space figures are kept as a secondary column and as the
                // internal check that the sleeve still adds to 100% of itself.
                const dToClass = apportionColumn(rows.map((r) => r.to));
                const balanced = sameAtDisplay(dToClass.total, 1);
                const allocMoved = !sameAtDisplay(allocFrom, allocTo);
                const changed = rows.filter((r) => r.changed).length;

                return (
                  <div key={ac} className="overflow-hidden rounded-card border border-line bg-white shadow-sm">
                    <div className={`${colors.header} flex items-center justify-between px-5 py-3`}>
                      <h3 className="text-sm font-bold">
                        {ASSET_CLASS_LABELS[ac]}
                        <span className="ml-2 text-xs font-normal opacity-70">
                          ({rows.filter((r) => r.to != null).length} holdings
                          {changed > 0 && `, ${changed} changed`})
                        </span>
                      </h3>
                      <span className="text-xs">
                        {/* The sleeve's share of the portfolio is the headline;
                            the 100%-of-class check is the fine print. */}
                        <span className="font-semibold">{pct(dToP.total)}</span> of portfolio
                        {allocMoved && (
                          <span className="ml-1 opacity-70">(was {pct(dFromP.total)})</span>
                        )}
                        {!balanced && (
                          <span className="ml-2 font-semibold text-neg">
                            class sums to {pct(dToClass.total)} — does not add up
                          </span>
                        )}
                      </span>
                    </div>
                    {/* Scrolls sideways rather than compressing seven columns
                        into an unreadable width; the page itself never scrolls
                        horizontally because the overflow is owned here. */}
                    <div className="max-w-full overflow-x-auto">
                      <table className="w-full min-w-[720px] text-sm">
                        <thead className="bg-white shadow-[0_1px_0_0_rgb(226_232_240)]">
                          <tr className="border-b border-line-soft text-xs text-ink-3">
                            <th className="py-2.5 pl-5 pr-2 text-left font-semibold">Name</th>
                            <th className="py-2.5 px-2 text-left font-semibold">Symbol</th>
                            <th className="py-2.5 px-2 text-center font-semibold">Ccy</th>
                            <th className="py-2.5 px-2 text-right font-semibold whitespace-nowrap">
                              {compareLabel} Wt
                            </th>
                            <th className="py-2.5 px-2 text-right font-semibold whitespace-nowrap">Scenario Wt</th>
                            <th className="py-2.5 px-2 text-right font-semibold whitespace-nowrap">Δ</th>
                            <th className="py-2.5 px-2 pr-5 text-right font-normal whitespace-nowrap opacity-70">
                              % of sleeve
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r, i) => (
                            <tr
                              key={r.symbol}
                              className={`border-b border-line-soft transition-colors hover:bg-surface-hover ${
                                r.to == null ? "opacity-40" : ""
                              } ${r.changed ? "bg-accent-soft/40" : ""}`}
                            >
                              <td className="max-w-[200px] truncate py-2 pl-5 pr-2 font-medium text-ink">
                                <Link
                                  href={`/stock/${symbolToTicker(r.symbol).toLowerCase()}?from=pim-model`}
                                  className="transition-colors hover:text-accent hover:underline"
                                >
                                  {r.name}
                                </Link>
                              </td>
                              <td className="py-2 px-2 font-mono text-xs text-ink-2">
                                <span className="inline-flex items-center gap-1.5">
                                  {displayTicker(r.symbol)}
                                  {r.from == null && (
                                    <span className="inline-flex items-center rounded-full bg-pos-soft px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-pos ring-1 ring-pos-border">
                                      New
                                    </span>
                                  )}
                                  {r.to == null && (
                                    <span className="inline-flex items-center rounded-full bg-neg-soft px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-neg ring-1 ring-neg-border">
                                      Sold
                                    </span>
                                  )}
                                </span>
                              </td>
                              <td className="py-2 px-2 text-center">
                                <span
                                  className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                    r.currency === "CAD" ? "bg-neg-soft text-neg" : "bg-pos-soft text-pos"
                                  }`}
                                >
                                  {r.currency}
                                </span>
                              </td>
                              <td className="py-2 px-2 text-right font-mono text-xs text-ink-2">
                                {dFromP.values[i] == null ? <span className="text-ink-faint">&mdash;</span> : pct(dFromP.values[i] as number)}
                              </td>
                              <td className="py-2 px-2 text-right font-mono text-xs font-semibold">
                                {dToP.values[i] == null ? <span className="text-ink-faint">&mdash;</span> : pct(dToP.values[i] as number)}
                              </td>
                              <td
                                className={(() => {
                                  // Delta is the change in PORTFOLIO weight —
                                  // what the position is actually worth in the
                                  // book — and both it and its colour come from
                                  // the two displayed numbers, so a row can
                                  // never show a move it doesn't show.
                                  const d = (dToP.values[i] ?? 0) - (dFromP.values[i] ?? 0);
                                  const flat = sameAtDisplay(dFromP.values[i], dToP.values[i]);
                                  return `py-2 px-2 text-right font-mono text-xs ${
                                    flat ? "text-ink-faint" : d >= 0 ? "text-pos" : "text-neg"
                                  }`;
                                })()}
                              >
                                {(() => {
                                  const d = (dToP.values[i] ?? 0) - (dFromP.values[i] ?? 0);
                                  if (sameAtDisplay(dFromP.values[i], dToP.values[i])) return "—";
                                  return `${d >= 0 ? "+" : ""}${pct(d)}`;
                                })()}
                              </td>
                              <td className="py-2 px-2 pr-5 text-right font-mono text-xs text-ink-faint">
                                {dToClass.values[i] == null ? (
                                  <span className="text-ink-faint">&mdash;</span>
                                ) : (
                                  pct(dToClass.values[i] as number)
                                )}
                              </td>
                            </tr>
                          ))}
                          <tr className={`${colors.bg} font-semibold`}>
                            <td className="py-2 pl-5 pr-2 text-xs text-ink-3" colSpan={3}>
                              TOTAL
                            </td>
                            <td className="py-2 px-2 text-right font-mono text-xs font-bold">{pct(dFromP.total)}</td>
                            <td className="py-2 px-2 text-right font-mono text-xs font-bold">{pct(dToP.total)}</td>
                            <td
                              className={`py-2 px-2 text-right font-mono text-xs font-bold ${
                                sameAtDisplay(dFromP.total, dToP.total)
                                  ? "text-ink-faint"
                                  : dToP.total > dFromP.total
                                    ? "text-pos"
                                    : "text-neg"
                              }`}
                            >
                              {sameAtDisplay(dFromP.total, dToP.total)
                                ? "—"
                                : `${dToP.total > dFromP.total ? "+" : ""}${pct(dToP.total - dFromP.total)}`}
                            </td>
                            <td className="py-2 px-2 pr-5 text-right font-mono text-xs text-ink-faint">
                              {pct(dToClass.total)}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Keep / discard */}
          <div className="mt-4 flex flex-col gap-2 text-xs sm:flex-row sm:flex-wrap sm:items-center">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Scenario name"
              className="w-full rounded border border-line bg-surface-2 px-2 py-1 text-ink sm:w-56"
            />
            <button
              onClick={save}
              disabled={saving || !name.trim() || actions.length === 0}
              className="rounded bg-accent px-3 py-1 font-medium !text-white disabled:opacity-40"
            >
              {saving ? "Saving…" : draftId ? "Update" : "Keep"}
            </button>
            <button onClick={resetDraft} className="rounded border border-line px-3 py-1 text-ink-3 hover:text-ink">
              Discard
            </button>
            <span className="text-ink-faint">Saved scenarios are kept for 90 days from the last edit.</span>
          </div>

          {/* Saved list */}
          {groupScenarios.length > 0 && (
            <div className="mt-4 border-t border-line-soft pt-3">
              <div className="mb-2 text-xs font-medium text-ink-3">Saved scenarios</div>
              <div className="flex flex-col gap-1">
                {groupScenarios.map((s) => (
                  <div key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span className="font-medium text-ink">{s.name}</span>
                    <span className="text-ink-faint">
                      {s.actions.length} change{s.actions.length === 1 ? "" : "s"} ·{" "}
                      {new Date(s.updatedAt).toLocaleDateString()}
                    </span>
                    <button onClick={() => load(s)} className="text-accent hover:underline">
                      Load
                    </button>
                    <button onClick={() => remove(s.id)} className="text-ink-faint hover:text-neg">
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
