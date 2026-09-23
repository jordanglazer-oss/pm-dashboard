"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { useLiveModelWeights } from "@/app/lib/useLiveModelWeights";
import { canonicalTicker, displayTicker } from "@/app/lib/ticker";
import { sleevesOf, isCoreDesignated, isFund } from "@/app/lib/sleeves";
import { computeSleeveLegs, CORE_SHARE, DEFAULT_THESIS_SHARE, MAX_STOCK_PORTFOLIO_WEIGHT, maxEquityAllocation } from "@/app/lib/sleeve-weights";
import { applyDecisions, inheritDecisions, monthKey, reconcile, WEIGHT_COMMIT_ENABLED, type DecisionAction, type MonthReview, type WeightDecision, type WeightDecisionStore } from "@/app/lib/weight-decisions";
import { LegVerdictChips, useSleeveVerdicts } from "@/app/components/LegVerdicts";
import { CollapsibleSection } from "@/app/components/CollapsibleSection";
import { TacticalBench } from "@/app/components/TacticalBench";
import { AppIcon } from "@/app/components/AppIcon";
import { THESIS_VERDICT_LABEL, type ThesisVerdict } from "@/app/lib/thesis-verdict";
import type { PimProfileType } from "@/app/lib/pim-types";

/**
 * /review — the monthly meeting's one-pager and the daily portfolio hub.
 *
 * One table: every held Alpha name with its sleeve, per-leg verdicts, TARGET
 * weight, LIVE weight, drift, 1M return vs its sector, and the month's decision
 * (keep / adopt live / set). Decisions save as a DRAFT to pm:weight-decisions;
 * the commit that turns them into model targets is disabled on this build
 * (WEIGHT_COMMIT_ENABLED) — preview shares the database with production.
 *
 * Rule: a change nets to zero INSIDE its sleeve. The strip shows what is still
 * unallocated per sleeve; commit is blocked until both read zero.
 *
 * Every weight the PM sees is % of the chosen profile's portfolio; the record
 * stores weightInClass so it is profile-independent.
 */

const PROFILES: PimProfileType[] = ["balanced", "growth", "allEquity"];
const pct = (v: number | null | undefined, d = 2) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);
const signed = (v: number | null | undefined, d = 1) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
const tone = (v: number | null | undefined) => (v == null ? "text-ink-faint" : v > 0 ? "text-pos" : v < 0 ? "text-neg" : "text-ink-3");

type ReviewData = {
  today: string;
  lastMeeting: string;
  nextMeeting: string;
  returns: { computedAt: string | null; spy1m: number | null; rows: Record<string, { r1m: number | null; sectorEtf: string | null; sector1m: number | null }> };
  model: { mtd: number | null; r1m: number | null; asOf: string | null };
  since: {
    verdictChanges: Array<{ ticker: string; from: ThesisVerdict | null; to: ThesisVerdict | null; date: string; summary: string }>;
    trips: Array<{ ticker: string; tripped: number; auto: number; what: string[] }>;
    reUnderwriteDue: Array<{ ticker: string; due: string }>;
    planFlags: Array<{ ticker: string; flags: string[]; severity: string }>;
    verdictNow: Record<string, ThesisVerdict>;
  };
};

type Row = {
  symbol: string;
  ticker: string;
  name: string;
  kind: "stock" | "fund";
  sleeve: "thesis" | "tactical" | "both";
  netSleeve: "thesis" | "tactical";
  targetInClass: number;
  target: number; // % of portfolio (fraction)
  live: number | null;
  liveInClass: number | null;
};

export default function ReviewPage() {
  const { pimModels, stocks, uiPrefs, setUiPref } = useStocks();
  const groupId = "pim";
  const profile = (PROFILES.includes(uiPrefs["review.profile"] as PimProfileType) ? uiPrefs["review.profile"] : "balanced") as PimProfileType;
  const group = pimModels.groups.find((g) => g.id === groupId);
  const eqAlloc = group?.profiles[profile]?.equity ?? 0.66;
  const { weights: live, refetch } = useLiveModelWeights(groupId, profile);
  const verdicts = useSleeveVerdicts();

  const [data, setData] = useState<ReviewData | null>(null);
  const [store, setStore] = useState<WeightDecisionStore | null>(null);
  const [month, setMonth] = useState<string>(monthKey());
  const [saving, setSaving] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/review-data?group=${groupId}&profile=${profile}`, { cache: "no-store" }).then((r) => r.json()).then((d) => alive && !d.error && setData(d)).catch(() => {});
    fetch("/api/kv/weight-decisions", { cache: "no-store" }).then((r) => r.json()).then((d) => alive && setStore(d.store ?? { months: {} })).catch(() => {});
    return () => { alive = false; };
  }, [profile]);

  const review: MonthReview | undefined = store?.months[month];
  const decisions = useMemo(() => review?.decisions ?? {}, [review]);
  const committed = review?.status === "committed";

  // ── Rows: held Alpha equity holdings of the PIM group ──
  const byTicker = useMemo(() => {
    const m = new Map<string, (typeof stocks)[number]>();
    for (const s of stocks) if (s.bucket === "Portfolio") m.set(canonicalTicker(s.ticker), s);
    return m;
  }, [stocks]);
  const rows: Row[] = useMemo(() => {
    if (!group) return [];
    const out: Row[] = [];
    for (const h of group.holdings) {
      if (h.assetClass !== "equity") continue;
      const s = byTicker.get(canonicalTicker(h.symbol));
      if (!s || isCoreDesignated(s)) continue;
      const sl = sleevesOf(s);
      if (!sl.thesis && !sl.tactical) continue;
      const lv = live?.get(canonicalTicker(h.symbol));
      const liveFrac = lv != null ? lv / 100 : null;
      out.push({
        symbol: h.symbol,
        ticker: s.ticker,
        name: h.name,
        kind: isFund(s) ? "fund" : "stock",
        sleeve: sl.thesis && sl.tactical ? "both" : sl.thesis ? "thesis" : "tactical",
        netSleeve: sl.tactical ? "tactical" : "thesis",
        targetInClass: h.weightInClass,
        target: h.weightInClass * eqAlloc,
        live: liveFrac,
        liveInClass: liveFrac != null && eqAlloc > 0 ? liveFrac / eqAlloc : null,
      });
    }
    const order = { thesis: 0, both: 1, tactical: 2 };
    return out.sort((a, b) => order[a.sleeve] - order[b.sleeve] || (a.kind === b.kind ? a.symbol.localeCompare(b.symbol) : a.kind === "fund" ? -1 : 1));
  }, [group, byTicker, live, eqAlloc]);
  const untagged = useMemo(() => {
    if (!group) return [];
    return group.holdings.filter((h) => h.assetClass === "equity").filter((h) => { const s = byTicker.get(canonicalTicker(h.symbol)); return s && !isCoreDesignated(s) && !sleevesOf(s).thesis && !sleevesOf(s).tactical; }).map((h) => h.symbol);
  }, [group, byTicker]);

  // ── Sleeve totals: target vs live vs the rule's budget ──
  const legs = useMemo(() => computeSleeveLegs(group, stocks, DEFAULT_THESIS_SHARE), [group, stocks]);
  const totals = useMemo(() => {
    const t = { thesis: { target: 0, live: 0, liveKnown: true }, tactical: { target: 0, live: 0, liveKnown: true } };
    for (const r of rows) {
      const k = r.netSleeve;
      t[k].target += r.target;
      if (r.live == null) t[k].liveKnown = false; else t[k].live += r.live;
    }
    return t;
  }, [rows]);

  const recon = useMemo(() => (group ? reconcile(group, stocks, decisions) : null), [group, stocks, decisions]);
  const capInClass = group ? MAX_STOCK_PORTFOLIO_WEIGHT / maxEquityAllocation(group) : 1;

  // ── Decision editing (draft, read-merge-write per symbol) ──
  const saveDecision = useCallback(async (symbol: string, d: WeightDecision | null) => {
    setSaving(symbol);
    try {
      const r = await fetch("/api/kv/weight-decisions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month, groupId, profile, decisions: { [symbol]: d } }) });
      const j = await r.json();
      if (r.ok && j.review) setStore((s) => ({ months: { ...(s?.months ?? {}), [month]: j.review } }));
      else setCommitMsg(j.error ?? "save failed");
    } finally {
      setSaving(null);
    }
  }, [month, profile]);

  const setAction = (r: Row, action: DecisionAction) => {
    if (action === "keep") return saveDecision(r.symbol, { action: "keep", liveInClass: r.liveInClass, at: "" });
    if (action === "adopt") {
      if (r.liveInClass == null) return;
      const capped = r.kind === "stock" ? Math.min(r.liveInClass, capInClass) : r.liveInClass;
      return saveDecision(r.symbol, { action: "adopt", targetInClass: capped, liveInClass: r.liveInClass, at: "" });
    }
    return saveDecision(r.symbol, { action: "set", targetInClass: decisions[r.symbol]?.targetInClass ?? r.targetInClass, liveInClass: r.liveInClass, at: "" });
  };
  const setTarget = (r: Row, pctOfPortfolio: number) => {
    if (!Number.isFinite(pctOfPortfolio) || pctOfPortfolio < 0) return;
    return saveDecision(r.symbol, { action: "set", targetInClass: pctOfPortfolio / 100 / eqAlloc, liveInClass: r.liveInClass, at: "" });
  };

  const tryCommit = async () => {
    const r = await fetch("/api/weight-decisions/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month }) });
    const j = await r.json();
    setCommitMsg(j.error ?? (r.ok ? "committed" : "commit failed"));
  };

  // ── Diff preview across every model ──
  const diff = useMemo(() => {
    if (!group || !showDiff) return [];
    return pimModels.groups.map((g) => {
      const after = g.id === groupId ? applyDecisions(g, decisions) : inheritDecisions(group, g, stocks, decisions);
      const changes = g.holdings.filter((h) => h.assetClass === "equity").map((h) => ({ symbol: h.symbol, before: h.weightInClass, after: after.holdings.find((x) => x.symbol === h.symbol)?.weightInClass ?? h.weightInClass })).filter((c) => Math.abs(c.after - c.before) > 0.00005);
      return { id: g.id, name: g.name, changes };
    });
  }, [group, pimModels.groups, stocks, decisions, showDiff]);

  const months = useMemo(() => {
    const set = new Set<string>([monthKey(), ...Object.keys(store?.months ?? {})]);
    return [...set].sort().reverse();
  }, [store]);

  if (!group) return <main className="text-[13px] text-ink-3">No PIM model loaded.</main>;

  const decided = Object.keys(decisions).length;
  const spy = data?.returns.spy1m ?? null;

  const cell = (label: string, value: React.ReactNode, sub?: React.ReactNode, cls = "") => (
    <div className={`rounded-card border border-line bg-surface px-3 py-2 ${cls}`}>
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-ink-3">{label}</div>
      <div className="font-mono text-[16px] font-semibold tabular-nums text-ink">{value}</div>
      {sub && <div className="text-[11px] leading-snug text-ink-3">{sub}</div>}
    </div>
  );
  const sleeveCell = (k: "thesis" | "tactical", label: string) => {
    const budget = (1 - CORE_SHARE) * (k === "thesis" ? DEFAULT_THESIS_SHARE : 1 - DEFAULT_THESIS_SHARE) * eqAlloc;
    const net = recon?.nets.find((n) => n.sleeve === k);
    const unalloc = net ? -net.delta * eqAlloc : 0;
    return cell(
      label,
      <>{pct(totals[k].target, 1)}<span className="ml-1.5 text-[11px] font-normal text-ink-3">target</span></>,
      <>
        live {totals[k].liveKnown ? pct(totals[k].live, 1) : "—"} · rule {pct(budget, 1)}
        {net && !net.ok && <span className="block font-medium text-warn">{unalloc > 0 ? `${pct(unalloc)} freed — assign it to a ${label} name` : `${pct(-unalloc)} over — trim a ${label} name`}</span>}
        {net && net.ok && decided > 0 && <span className="block text-pos">nets to zero</span>}
      </>,
    );
  };

  return (
    <main className="flex flex-col gap-3 text-ink">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[13px] font-semibold">Monthly review</h1>
        <select value={month} onChange={(e) => setMonth(e.target.value)} className="h-7 rounded-control border border-line bg-surface px-2 text-[12px] text-ink">
          {months.map((m) => <option key={m} value={m}>{m}{store?.months[m]?.status === "committed" ? " · committed" : store?.months[m] ? " · draft" : ""}</option>)}
        </select>
        <div className="seg">
          {PROFILES.map((p) => (
            <button key={p} type="button" className={profile === p ? "on" : ""} onClick={() => setUiPref("review.profile", p)}>{p === "allEquity" ? "All-Equity" : p[0].toUpperCase() + p.slice(1)}</button>
          ))}
        </div>
        <span className="text-[11.5px] text-ink-3">
          {data ? <>last meeting {data.lastMeeting} · next {data.nextMeeting}</> : "…"}
        </span>
        <span className="flex-grow" />
        <button type="button" onClick={() => { refetch(); fetch(`/api/review-data?group=${groupId}&profile=${profile}&refresh=1`).then((r) => r.json()).then((d) => !d.error && setData(d)); }} className="inline-flex h-7 items-center gap-1 rounded-control border border-line bg-surface px-2.5 text-[12px] text-ink-2 hover:bg-surface-hover">
          <AppIcon name="refresh" size={12} /> Refresh
        </button>
      </div>

      {/* Strip */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {cell("Model · " + (profile === "allEquity" ? "All-Equity" : profile), <span className={tone(data?.model.mtd)}>{signed(data?.model.mtd)}</span>, <>MTD · 1M {signed(data?.model.r1m)} · SPY 1M {signed(spy)}{data?.model.asOf ? ` · as of ${data.model.asOf}` : ""}</>)}
        {sleeveCell("thesis", "Thesis")}
        {sleeveCell("tactical", "Tactical")}
        {cell("Decisions", <>{decided}<span className="ml-1.5 text-[11px] font-normal text-ink-3">of {rows.length}</span></>, committed ? `committed ${review?.committedAt?.slice(0, 10)}` : review ? `draft · ${review.updatedAt.slice(0, 10)}` : "nothing decided yet")}
        {cell("Attention", <>{(data?.since.trips.length ?? 0) + (data?.since.planFlags.length ?? 0) + (data?.since.verdictChanges.filter((v) => v.to && v.to !== "intact").length ?? 0)}</>, <>{data?.since.trips.length ?? 0} trips · {data?.since.planFlags.length ?? 0} plan flags · {data?.since.reUnderwriteDue.length ?? 0} re-underwrites due</>)}
      </div>

      {(untagged.length > 0 || (recon && recon.capBreaches.length > 0) || commitMsg) && (
        <div className="rounded-card border border-warn-border bg-warn-soft px-3 py-2 text-[12px] text-warn">
          {untagged.length > 0 && <div>Untagged Alpha holdings (tag them on Holdings before deciding): {untagged.join(", ")}</div>}
          {recon?.capBreaches.map((c) => <div key={c.symbol}>{c.symbol} target {pct(c.targetInClass * eqAlloc)} breaches the {pct(MAX_STOCK_PORTFOLIO_WEIGHT, 0)}-of-portfolio stock cap ({pct(c.capInClass * eqAlloc)} in this profile).</div>)}
          {commitMsg && <div>{commitMsg}</div>}
        </div>
      )}

      {/* The table */}
      <div className="panel overflow-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Sleeve</th>
              <th className="hidden lg:table-cell">Verdict</th>
              <th className="text-right" title="Model target, % of this profile's portfolio">Target</th>
              <th className="text-right" title="Positions × live prices">Live</th>
              <th className="text-right" title="Live − target, basis points of portfolio">Drift</th>
              <th className="text-right" title="1M price return · sector ETF 1M in brackets">1M vs sector</th>
              <th className="text-right" title="New target, % of portfolio">New target</th>
              <th>Decision</th>
              <th className="hidden xl:table-cell">Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = decisions[r.symbol];
              const ret = data?.returns.rows[r.ticker.toUpperCase()];
              const rel = ret?.r1m != null && ret.sector1m != null ? ret.r1m - ret.sector1m : null;
              const drift = r.live != null ? (r.live - r.target) * 10000 : null;
              const newTarget = d?.action === "keep" ? r.target : d?.targetInClass != null ? d.targetInClass * eqAlloc : null;
              const busy = saving === r.symbol;
              return (
                <tr key={r.symbol} className={d ? "" : "opacity-95"}>
                  <td>
                    <Link href={`/stock/${r.ticker.toLowerCase()}`} className="font-mono font-medium text-ink hover:underline">{displayTicker(r.ticker)}</Link>
                    <span className="ml-2 hidden text-[11.5px] text-ink-3 md:inline">{r.name}</span>
                    {r.kind === "fund" && <span className="ml-1.5 text-[10.5px] text-ink-faint">fund</span>}
                  </td>
                  <td><span className={`text-[11.5px] ${r.sleeve === "tactical" ? "text-violet" : "text-accent"}`}>{r.sleeve === "both" ? "Thesis + Tactical" : r.sleeve === "thesis" ? "Thesis" : "Tactical"}</span></td>
                  <td className="hidden lg:table-cell"><span className="inline-flex flex-wrap gap-1"><LegVerdictChips legs={verdicts[r.ticker.toUpperCase()]} /></span></td>
                  <td className="n">{pct(r.target)}</td>
                  <td className="n">{pct(r.live)}</td>
                  <td className={`n ${drift == null ? "text-ink-faint" : Math.abs(drift) >= 50 ? (drift > 0 ? "text-pos" : "text-neg") : "text-ink-3"}`}>{drift == null ? "—" : `${drift >= 0 ? "+" : ""}${drift.toFixed(0)}`}</td>
                  <td className="n">
                    <span className={tone(ret?.r1m)}>{signed(ret?.r1m)}</span>
                    {ret?.sectorEtf && <span className="ml-1 text-[11px] text-ink-3">({ret.sectorEtf} {signed(ret.sector1m)}{rel != null ? `, ${rel >= 0 ? "+" : ""}${(rel * 100).toFixed(1)}` : ""})</span>}
                  </td>
                  <td className="n">
                    {d?.action === "set" && !committed ? (
                      <input
                        type="number"
                        step="0.05"
                        min={0}
                        defaultValue={(newTarget! * 100).toFixed(2)}
                        onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && Math.abs(v / 100 - newTarget!) > 1e-6) setTarget(r, v); }}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        className="h-7 w-20 rounded-control border border-line bg-surface px-1.5 text-right font-mono text-[12px] tabular-nums text-ink"
                      />
                    ) : (
                      <span className={newTarget == null ? "text-ink-faint" : Math.abs(newTarget - r.target) > 1e-6 ? "font-medium text-ink" : "text-ink-3"}>{newTarget == null ? "—" : pct(newTarget)}</span>
                    )}
                  </td>
                  <td>
                    <div className="seg" aria-busy={busy}>
                      <button type="button" disabled={committed || busy} className={d?.action === "keep" ? "on" : ""} onClick={() => setAction(r, "keep")} title="The drift is noise — trade back to the current target">Keep</button>
                      <button type="button" disabled={committed || busy || r.live == null} className={d?.action === "adopt" ? "on" : ""} onClick={() => setAction(r, "adopt")} title={r.live == null ? "No live weight — save positions first" : "Let it ride — the live weight becomes the new target, no trade"}>Adopt live</button>
                      <button type="button" disabled={committed || busy} className={d?.action === "set" ? "on" : ""} onClick={() => setAction(r, "set")} title="An explicit trim or add — type the new target">Set</button>
                    </div>
                    {d && !committed && <button type="button" onClick={() => saveDecision(r.symbol, null)} className="ml-1 text-[10.5px] text-ink-faint hover:text-ink-2" title="Clear this decision">×</button>}
                  </td>
                  <td className="hidden xl:table-cell">
                    {d && !committed ? (
                      <input defaultValue={d.note ?? ""} placeholder="why" onBlur={(e) => { if ((e.target.value || "") !== (d.note ?? "")) saveDecision(r.symbol, { ...d, note: e.target.value }); }} className="h-7 w-40 rounded-control border border-line bg-surface px-1.5 text-[11.5px] text-ink" />
                    ) : <span className="text-[11.5px] text-ink-3">{d?.note ?? ""}</span>}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={10} className="text-ink-3">No tagged Alpha holdings in PIM — tag names Thesis / Tactical on Holdings.</td></tr>}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-3 border-t border-line-soft px-3 py-2 text-[11.5px] text-ink-3">
          <span>Rule: stocks {pct(legs.thesisLeg * eqAlloc)} Thesis leg · {pct(legs.tacticalLeg * eqAlloc)} Tactical leg (equal legs, {(DEFAULT_THESIS_SHARE * 100).toFixed(0)}/{((1 - DEFAULT_THESIS_SHARE) * 100).toFixed(0)} split) — targets above are what the models hold today.</span>
          <span className="flex-grow" />
          <button type="button" onClick={() => setShowDiff((v) => !v)} className="inline-flex h-7 items-center rounded-control border border-line bg-surface px-2.5 text-[12px] text-ink-2 hover:bg-surface-hover">{showDiff ? "Hide diff" : "Preview diff — every model"}</button>
          <button
            type="button"
            onClick={tryCommit}
            disabled={!WEIGHT_COMMIT_ENABLED || committed || !recon?.ok || decided === 0}
            className="inline-flex h-7 items-center rounded-control bg-ink px-3 text-[12px] font-medium text-surface disabled:opacity-40"
            title={!WEIGHT_COMMIT_ENABLED ? "Commit is disabled on this build — the preview shares the database with production. Decisions are kept as a draft." : !recon?.ok ? "Blocked: every sleeve must net to zero and no stock may breach the cap." : "Write these targets to every model (stashes the current model first)"}
          >
            {committed ? "Committed" : WEIGHT_COMMIT_ENABLED ? "Commit targets" : "Commit disabled (preview)"}
          </button>
        </div>
        {showDiff && (
          <div className="grid gap-2 border-t border-line-soft px-3 py-2 md:grid-cols-3">
            {diff.map((g) => (
              <div key={g.id} className="text-[11.5px]">
                <div className="font-medium text-ink">{g.name} <span className="font-normal text-ink-3">· {g.changes.length} change{g.changes.length === 1 ? "" : "s"}</span></div>
                {g.changes.map((c) => <div key={c.symbol} className="font-mono tabular-nums text-ink-2">{c.symbol} {pct(c.before)} → {pct(c.after)}</div>)}
                {g.changes.length === 0 && <div className="text-ink-faint">no change</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Since the last meeting */}
      <CollapsibleSection prefKey="review.since" className="border-line" titleClass="text-[13px] font-semibold text-ink" title="Since the last meeting" subtitle={data ? `changes since ${data.lastMeeting}` : undefined}>
        {!data ? <p className="text-[12px] text-ink-3">Loading…</p> : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4 text-[12px]">
            <div>
              <div className="mb-1 font-medium text-ink">Thesis verdicts</div>
              {data.since.verdictChanges.length === 0 ? <div className="text-ink-faint">no verdict changed</div> : data.since.verdictChanges.map((v) => (
                <div key={v.ticker} className="mb-1"><Link href={`/stock/${v.ticker.toLowerCase()}`} className="font-mono font-medium hover:underline">{displayTicker(v.ticker)}</Link> <span className={v.to === "broken" ? "text-neg" : v.to === "challenged" ? "text-warn" : "text-pos"}>{v.to ? THESIS_VERDICT_LABEL[v.to] : "—"}</span> <span className="text-ink-3">{v.from ? `was ${v.from}` : "first read"} · {v.date}</span></div>
              ))}
            </div>
            <div>
              <div className="mb-1 font-medium text-ink">Kill conditions tripped</div>
              {data.since.trips.length === 0 ? <div className="text-ink-faint">none tripped</div> : data.since.trips.map((t) => (
                <div key={t.ticker} className="mb-1"><Link href={`/stock/${t.ticker.toLowerCase()}`} className="font-mono font-medium hover:underline">{displayTicker(t.ticker)}</Link> <span className="text-neg">{t.tripped} of {t.auto}</span> <span className="text-ink-3">{t.what.join(" · ")}</span></div>
              ))}
            </div>
            <div>
              <div className="mb-1 font-medium text-ink">Tactical plan flags</div>
              {data.since.planFlags.length === 0 ? <div className="text-ink-faint">every plan within terms</div> : data.since.planFlags.map((p) => (
                <div key={p.ticker} className="mb-1"><Link href={`/stock/${p.ticker.toLowerCase()}`} className="font-mono font-medium hover:underline">{displayTicker(p.ticker)}</Link> <span className={p.severity === "high" ? "text-neg" : "text-warn"}>{p.flags.join(" · ")}</span></div>
              ))}
            </div>
            <div>
              <div className="mb-1 font-medium text-ink">Re-underwrites due</div>
              {data.since.reUnderwriteDue.length === 0 ? <div className="text-ink-faint">none due</div> : data.since.reUnderwriteDue.map((u) => (
                <div key={u.ticker} className="mb-1"><Link href={`/stock/${u.ticker.toLowerCase()}`} className="font-mono font-medium hover:underline">{displayTicker(u.ticker)}</Link> <span className="text-warn">due {u.due}</span></div>
              ))}
              <div className="mt-2"><Link href="/thesis" className="!text-accent hover:underline">Thesis desk</Link> · <Link href="/journal" className="!text-accent hover:underline">Journal</Link> · <Link href="/portfolio" className="!text-accent hover:underline">Positioning</Link></div>
            </div>
          </div>
        )}
      </CollapsibleSection>

      <TacticalBench />
    </main>
  );
}
