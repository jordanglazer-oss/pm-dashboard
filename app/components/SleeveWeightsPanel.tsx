"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useStocks } from "@/app/lib/StockContext";
import { CollapsibleSection } from "@/app/components/CollapsibleSection";
import { displayTicker } from "@/app/lib/ticker";
import {
  CORE_SHARE,
  DEFAULT_THESIS_SHARE,
  MAX_STOCK_WEIGHT,
  computeSleeveLegs,
  proposeGroupWeights,
  type SleeveRole,
} from "@/app/lib/sleeve-weights";

/* Proposed sleeve weights — READ-ONLY. Shows what every equity weight would be
 * under the Thesis / Tactical rule, next to what it is today. The only thing
 * this panel saves is the split itself (pm:alpha-sleeves); pm:pim-models is
 * never written from here. */

const pct = (v: number, d = 2) => `${(v * 100).toFixed(d)}%`;

const ROLE_LABEL: Record<SleeveRole, string> = {
  core: "Core",
  thesis: "Thesis",
  tactical: "Tactical",
  both: "Thesis + Tactical",
  untagged: "Untagged",
  unknown: "No record",
};
const ROLE_CLS: Record<SleeveRole, string> = {
  core: "text-ink-3",
  thesis: "text-accent",
  tactical: "text-violet",
  both: "text-accent",
  untagged: "text-warn",
  unknown: "text-warn",
};
const ROLE_ORDER: SleeveRole[] = ["thesis", "both", "tactical", "untagged", "unknown", "core"];

type SplitChange = { at: string; from: number | null; to: number };

export function SleeveWeightsPanel() {
  const { pimModels, stocks } = useStocks();
  const groups = pimModels.groups;
  const params = useSearchParams();
  const urlModel = params.get("model");

  const [groupId, setGroupId] = useState<string>("pim");
  useEffect(() => {
    if (urlModel && groups.some((g) => g.id === urlModel)) setGroupId(urlModel);
  }, [urlModel, groups]);

  // Saved split (null until loaded / when none has ever been saved).
  const [savedShare, setSavedShare] = useState<number | null>(null);
  const [lastChange, setLastChange] = useState<SplitChange | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/kv/alpha-sleeves")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        const c = d?.config ?? {};
        if (typeof c.thesisShare === "number") setSavedShare(c.thesisShare);
        if (Array.isArray(c.log) && c.log.length > 0) setLastChange(c.log[c.log.length - 1] as SplitChange);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const activeShare = savedShare ?? DEFAULT_THESIS_SHARE;
  const draftNum = draft.trim() === "" ? null : Number(draft);
  const draftValid = draftNum != null && Number.isFinite(draftNum) && draftNum >= 0 && draftNum <= 100;
  // The table previews the draft as it is typed, so a split can be tried before it is saved.
  const thesisShare = draftValid ? draftNum / 100 : activeShare;
  const dirty = draftValid && Math.abs(draftNum / 100 - activeShare) > 1e-6;

  const saveSplit = async () => {
    if (!draftValid) return;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await fetch("/api/kv/alpha-sleeves", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thesisShare: draftNum / 100 }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "save failed");
      setSavedShare(d.config.thesisShare);
      const lg = d.config.log;
      if (Array.isArray(lg) && lg.length > 0) setLastChange(lg[lg.length - 1]);
      setDraft("");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  };

  const pim = useMemo(() => groups.find((g) => g.id === "pim"), [groups]);
  const legs = useMemo(() => computeSleeveLegs(pim, stocks, thesisShare), [pim, stocks, thesisShare]);
  const group = groups.find((g) => g.id === groupId) ?? pim ?? groups[0];
  const result = useMemo(() => (group ? proposeGroupWeights(group, stocks, legs) : null), [group, stocks, legs]);

  if (!group || !result) return null;

  const balancedEq = group.profiles.balanced?.equity ?? null;
  const rows = [...result.rows].sort((a, b) => {
    const r = ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role);
    if (r !== 0) return r;
    if (a.kind !== b.kind) return a.kind === "fund" ? -1 : 1;
    return a.symbol.localeCompare(b.symbol);
  });
  const warnings = [...legs.warnings, ...result.warnings];
  const alphaTarget = 1 - CORE_SHARE;

  const cell = (label: string, target: number, proposed: number, now: number | null, note: string) => (
    <div className="rounded-card border border-line bg-surface px-3.5 py-2.5">
      <div className="text-[11px] font-medium text-ink-3">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="font-mono text-[18px] font-semibold tabular-nums text-ink">{pct(proposed, 1)}</span>
        <span className="text-[11.5px] text-ink-3">target {pct(target, 1)}{now != null ? ` · today ${pct(now, 1)}` : ""}</span>
      </div>
      <div className="mt-1 text-[11.5px] leading-snug text-ink-3">{note}</div>
    </div>
  );

  return (
    <CollapsibleSection
      prefKey="pimModel.sleeveWeights"
      className="border-line"
      titleClass="text-[13px] font-semibold text-ink"
      title="Proposed sleeve weights"
      subtitle="read-only — shows what the Thesis / Tactical rule would do. No live weight is changed."
    >
      <div className="flex flex-col gap-3.5">
        {/* Controls: model + split */}
        <div className="flex flex-wrap items-end gap-x-5 gap-y-2.5">
          <label className="flex flex-col gap-1 text-[11px] font-medium text-ink-3">
            Model
            <select
              value={group.id}
              onChange={(e) => setGroupId(e.target.value)}
              className="h-8 rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink"
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-medium text-ink-3">
            Thesis share of Alpha (%)
            <span className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={draft}
                placeholder={(activeShare * 100).toFixed(1)}
                onChange={(e) => setDraft(e.target.value)}
                className="h-8 w-24 rounded-control border border-line bg-surface px-2 font-mono text-[12.5px] tabular-nums text-ink"
              />
              <span className="text-[12px] font-normal text-ink-2">
                Tactical {((1 - thesisShare) * 100).toFixed(1)}%
              </span>
              <button
                type="button"
                onClick={saveSplit}
                disabled={!dirty || saving}
                className="h-8 rounded-control border border-line bg-surface px-3 text-[12.5px] text-ink-2 transition-colors hover:bg-surface-hover disabled:opacity-40"
                title="Saves the split only. Live model weights are not changed."
              >
                {saving ? "Saving…" : "Save split"}
              </button>
            </span>
          </label>
          <div className="pb-1.5 text-[11.5px] text-ink-3">
            Core is fixed at {pct(CORE_SHARE, 0)} of equity.{" "}
            {savedShare == null
              ? `No split saved yet — using the ${(DEFAULT_THESIS_SHARE * 100).toFixed(1)} / ${((1 - DEFAULT_THESIS_SHARE) * 100).toFixed(1)} default.`
              : lastChange
                ? `Split last changed ${lastChange.at.slice(0, 10)}.`
                : ""}
            {dirty && <span className="text-warn"> Previewing an unsaved split.</span>}
            {saveError && <span className="text-neg"> {saveError}</span>}
          </div>
        </div>

        {/* Sleeve summary */}
        <div className="grid gap-2.5 md:grid-cols-3">
          {cell(
            "Core",
            CORE_SHARE,
            result.totals.core,
            result.currentTotals.core,
            "The residual: whatever the Alpha sleeves do not use, spread across the Core holdings in today's proportions.",
          )}
          {cell(
            "Thesis",
            alphaTarget * thesisShare,
            result.totals.thesis,
            null,
            `Funds ${pct(legs.thesisFunds)} + ${legs.thesisStockLegs} stock${legs.thesisStockLegs === 1 ? "" : "s"} × ${pct(legs.thesisLeg)} (leg size set by PIM).`,
          )}
          {cell(
            "Tactical",
            alphaTarget * (1 - thesisShare),
            result.totals.tactical,
            null,
            `Funds ${pct(legs.tacticalFunds)} + ${legs.tacticalStockLegs} stock leg${legs.tacticalStockLegs === 1 ? "" : "s"} × ${pct(legs.tacticalLeg)} (leg size set by PIM).`,
          )}
        </div>
        <div className="text-[11.5px] text-ink-3">
          Alpha today {pct(result.currentTotals.alpha, 1)} of equity → proposed {pct(result.totals.thesis + result.totals.tactical + result.totals.untagged, 1)}.
          A single stock is capped at {pct(MAX_STOCK_WEIGHT, 0)} of equity; funds are not capped.
        </div>

        {warnings.length > 0 && (
          <ul className="rounded-card border border-warn-border bg-warn-soft px-3.5 py-2.5 text-[12px] leading-relaxed text-warn">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}

        {/* Per-holding table */}
        <div className="overflow-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Holding</th>
                <th>Sleeve</th>
                <th className="text-right" title="Weight within the equity class, as stored today">Today</th>
                <th className="text-right" title="Weight within the equity class under the sleeve rule">Proposed</th>
                <th className="text-right">Change</th>
                {balancedEq != null && <th className="text-right" title={`Balanced profile — equity is ${pct(balancedEq, 0)} of the portfolio`}>Balanced today</th>}
                {balancedEq != null && <th className="text-right">Balanced proposed</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const d = r.proposed - r.current;
                const flat = Math.abs(d) < 0.00005;
                return (
                  <tr key={r.symbol}>
                    <td>
                      <span className="font-mono font-medium text-ink">{displayTicker(r.symbol)}</span>
                      <span className="ml-2 text-[12px] text-ink-3">{r.name}</span>
                    </td>
                    <td>
                      <span className={`text-[12px] ${ROLE_CLS[r.role]}`}>{ROLE_LABEL[r.role]}</span>
                      {r.kind === "fund" && r.role !== "core" && <span className="ml-1.5 text-[11px] text-ink-faint">fund · manual</span>}
                      {r.capped && <span className="ml-1.5 text-[11px] text-warn">capped</span>}
                    </td>
                    <td className="n">{pct(r.current)}</td>
                    <td className="n">{pct(r.proposed)}</td>
                    <td className="n">
                      <span className={flat ? "text-ink-faint" : d > 0 ? "text-pos" : "text-neg"}>
                        {flat ? "—" : `${d > 0 ? "+" : ""}${(d * 100).toFixed(2)}`}
                      </span>
                    </td>
                    {balancedEq != null && <td className="n">{pct(r.current * balancedEq)}</td>}
                    {balancedEq != null && <td className="n">{pct(r.proposed * balancedEq)}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </CollapsibleSection>
  );
}
