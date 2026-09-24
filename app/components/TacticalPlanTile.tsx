"use client";

import React, { useEffect, useMemo, useState } from "react";
import type { Stock } from "@/app/lib/types";
import { CollapsibleSection } from "@/app/components/CollapsibleSection";
import { computeSetup } from "@/app/lib/setup-grade";
import { checkTacticalPlan, nextFirstMonday, planReturn, type TacticalPlan, type PlanFlag } from "@/app/lib/tactical-plan";

/* Tactical plan tile (stock page) — the terms of a Tactical-sleeve position:
 * why now, where it is done, where it is wrong, when it is next reviewed.
 * Stored on the thesis record (pm:position-theses → tacticalPlan); this tile is
 * its only editor, and a save touches nothing but that field. */

type Draft = { catalyst: string; horizon: string; entryDate: string; entryPrice: string; target: string; stop: string; reviewBy: string };

const toDraft = (p: TacticalPlan | null): Draft => ({
  catalyst: p?.catalyst ?? "",
  horizon: p?.horizon ?? "",
  entryDate: p?.entryDate ?? "",
  entryPrice: p?.entryPrice != null ? String(p.entryPrice) : "",
  target: p?.target != null ? String(p.target) : "",
  stop: p?.stop != null ? String(p.stop) : "",
  reviewBy: p?.reviewBy ?? nextFirstMonday(),
});

const FLAG_CLS: Record<PlanFlag["severity"], string> = { high: "text-neg", medium: "text-warn", info: "text-ink-3" };
const FLAG_DOT: Record<PlanFlag["severity"], string> = { high: "bg-neg", medium: "bg-warn", info: "bg-ink-faint" };

const INPUT = "h-8 w-full rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink";
const LABEL = "flex flex-col gap-1 text-[11px] font-medium text-ink-3";

export function TacticalPlanTile({ stock, alsoThesis }: { stock: Stock; alsoThesis: boolean }) {
  const ticker = stock.ticker.toUpperCase();
  const [plan, setPlan] = useState<TacticalPlan | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(toDraft(null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/kv/position-theses")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setPlan((d?.theses?.[ticker]?.tacticalPlan as TacticalPlan | undefined) ?? null);
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [ticker]);

  const price = typeof stock.price === "number" ? stock.price : stock.healthData?.currentPrice ?? null;
  const setup = useMemo(() => computeSetup(stock), [stock]);
  const flags = useMemo(
    () => (plan ? checkTacticalPlan(plan, { price, setupGrade: setup.grade, earningsDate: stock.healthData?.earningsDate?.slice(0, 10) ?? null }) : []),
    [plan, price, setup.grade, stock.healthData?.earningsDate],
  );
  const ret = plan ? planReturn(plan, price) : null;

  const save = async (clear = false) => {
    setSaving(true);
    setError(null);
    const n = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));
    const body = clear
      ? { ticker, tacticalPlan: null }
      : {
          ticker,
          tacticalPlan: {
            catalyst: draft.catalyst,
            horizon: draft.horizon,
            entryDate: draft.entryDate || undefined,
            entryPrice: n(draft.entryPrice),
            target: n(draft.target),
            stop: n(draft.stop),
            reviewBy: draft.reviewBy || undefined,
          },
        };
    try {
      const r = await fetch("/api/kv/position-theses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error("save failed");
      const d = await fetch("/api/kv/position-theses").then((x) => x.json());
      setPlan((d?.theses?.[ticker]?.tacticalPlan as TacticalPlan | undefined) ?? null);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  };

  const stat = (label: string, value: React.ReactNode) => (
    <div className="min-w-0">
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className="font-mono text-[13px] tabular-nums text-ink">{value}</div>
    </div>
  );
  const px = (v: number | null | undefined) => (v != null ? v.toFixed(2) : "—");

  return (
    <div id="tactical-plan-tile">
    <CollapsibleSection
      prefKey="stock.tacticalPlan"
      className="border-line"
      titleClass="text-[13px] font-semibold text-ink"
      title="Tactical plan"
      subtitle={alsoThesis ? "terms of the tactical overweight — the long-run thesis is below" : "terms of this Tactical position"}
      right={
        !editing && loaded ? (
          <button
            type="button"
            onClick={() => {
              setDraft(toDraft(plan));
              setEditing(true);
            }}
            className="h-7 rounded-control border border-line bg-surface px-2.5 text-[12px] text-ink-2 hover:bg-surface-hover"
          >
            {plan ? "Edit" : "Write plan"}
          </button>
        ) : null
      }
    >
      {!loaded ? (
        <p className="text-[12px] text-ink-3">Loading…</p>
      ) : editing ? (
        <div className="flex flex-col gap-3">
          <label className={LABEL}>
            Why now — the short-term view
            <textarea
              value={draft.catalyst}
              onChange={(e) => setDraft({ ...draft, catalyst: e.target.value })}
              rows={3}
              className="w-full rounded-control border border-line bg-surface px-2 py-1.5 text-[12.5px] leading-relaxed text-ink"
              placeholder="What is expected to happen, over what window, and what would prove it wrong."
            />
          </label>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
            <label className={LABEL}>Horizon<input className={INPUT} value={draft.horizon} onChange={(e) => setDraft({ ...draft, horizon: e.target.value })} placeholder="1–3 months" /></label>
            <label className={LABEL}>Entry date<input type="date" className={INPUT} value={draft.entryDate} onChange={(e) => setDraft({ ...draft, entryDate: e.target.value })} /></label>
            <label className={LABEL}>Entry price<input type="number" step="0.01" className={INPUT} value={draft.entryPrice} onChange={(e) => setDraft({ ...draft, entryPrice: e.target.value })} /></label>
            <label className={LABEL}>Target<input type="number" step="0.01" className={INPUT} value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })} /></label>
            <label className={LABEL}>Stop<input type="number" step="0.01" className={INPUT} value={draft.stop} onChange={(e) => setDraft({ ...draft, stop: e.target.value })} /></label>
            <label className={LABEL}>Review by<input type="date" className={INPUT} value={draft.reviewBy} onChange={(e) => setDraft({ ...draft, reviewBy: e.target.value })} /></label>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => save()} disabled={saving} className="h-8 rounded-control bg-ink px-3 text-[12.5px] font-medium text-surface disabled:opacity-50">
              {saving ? "Saving…" : "Save plan"}
            </button>
            <button type="button" onClick={() => setEditing(false)} disabled={saving} className="h-8 rounded-control border border-line bg-surface px-3 text-[12.5px] text-ink-2 hover:bg-surface-hover">
              Cancel
            </button>
            {plan && (
              <button type="button" onClick={() => save(true)} disabled={saving} className="ml-auto h-8 rounded-control border border-line bg-surface px-3 text-[12.5px] text-neg hover:bg-surface-hover" title="Removes the tactical plan only. The thesis and its conditions are untouched.">
                Clear plan
              </button>
            )}
            {error && <span className="text-[12px] text-neg">{error}</span>}
          </div>
        </div>
      ) : !plan ? (
        <p className="text-[12.5px] leading-relaxed text-ink-3">
          No plan written. A Tactical position should state why now, where it is done, where it is wrong, and when it is next reviewed.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {plan.catalyst && <p className="whitespace-pre-line text-[12.5px] leading-relaxed text-ink">{plan.catalyst}</p>}
          <div className="grid grid-cols-3 gap-x-4 gap-y-2.5">
            {stat("Entry", <>{px(plan.entryPrice)}{plan.entryDate ? <span className="block text-[11px] text-ink-3">{plan.entryDate}</span> : null}</>)}
            {stat("Now", <>{px(price)}{ret != null ? <span className={`block text-[11px] ${ret >= 0 ? "text-pos" : "text-neg"}`}>{ret >= 0 ? "+" : ""}{(ret * 100).toFixed(1)}%</span> : null}</>)}
            {stat("Target", px(plan.target))}
            {stat("Stop", px(plan.stop))}
            {stat("Horizon", <span className="font-sans text-[12.5px]">{plan.horizon || "—"}</span>)}
            {stat("Review by", plan.reviewBy ?? "—")}
          </div>
          {flags.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {flags.map((f) => (
                <li key={f.kind} className="flex items-center gap-2 text-[12px]">
                  <span className={`dot ${FLAG_DOT[f.severity]}`} />
                  <span className={FLAG_CLS[f.severity]}>{f.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex items-center gap-2 text-[12px] text-ink-3"><span className="dot bg-pos" />Within plan — no stop, target, review or setup flag.</div>
          )}
        </div>
      )}
    </CollapsibleSection>
    </div>
  );
}
