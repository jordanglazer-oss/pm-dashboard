"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useStocks } from "@/app/lib/StockContext";
import type { ScoredStock } from "@/app/lib/types";
import { MAX_SCORE } from "@/app/lib/types";
import { computeSetup } from "@/app/lib/setup-grade";
import { sleevesOf, isCoreDesignated, isFund } from "@/app/lib/sleeves";
import { useLiveModelWeights } from "@/app/lib/useLiveModelWeights";
import { canonicalTicker } from "@/app/lib/ticker";
import { skewWord, SKEW_TONE } from "@/app/lib/synthesis-screen-display";
import { isPlanComplete, type TacticalPlan } from "@/app/lib/tactical-plan";

/* Summary card — the one screen a reader needs on a stock page: sleeve,
 * thesis status, score, setup, synthesis and the evidence on file, each with
 * its source underneath, plus model target vs live and the next earnings date.
 * Read-only; every figure comes from the same stores the tiles below read. */

type ThesisStatus = "intact" | "eroding" | "broken" | "stale" | "none";
const fmtDate = (iso?: string | null) => (iso ? iso.slice(5, 10) : null);

export function StockSummaryCard({ stock }: { stock: ScoredStock }) {
  const { getAnalystReports, pimModels } = useStocks();
  const tk = stock.ticker.toUpperCase();
  const held = stock.bucket === "Portfolio";
  const scoreable = !stock.instrumentType || stock.instrumentType === "stock";
  const sl = sleevesOf(stock);
  const core = isCoreDesignated(stock);

  const [thesis, setThesis] = useState<{ status: ThesisStatus; pillars?: number; reviewBy?: string } | null>(null);
  const [plan, setPlan] = useState<TacticalPlan | null>(null);
  const [synth, setSynth] = useState<{ skew: number; generatedAt: string; stale: boolean } | null | undefined>(undefined);
  const [factset, setFactset] = useState<{ n: number; last: string | null } | null>(null);
  const { weights: live } = useLiveModelWeights("pim", "balanced");

  useEffect(() => {
    let alive = true;
    const today = new Date().toISOString().slice(0, 10);
    Promise.all([
      held ? fetch("/api/thesis-health", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null,
      held ? fetch("/api/thesis-watch", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null,
      fetch("/api/kv/position-theses", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/synthesis-screen", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`/api/street-takeaways?ticker=${encodeURIComponent(tk)}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([health, watch, theses, syn, fs]) => {
      if (!alive) return;
      const t = theses?.theses?.[tk];
      setPlan((t?.tacticalPlan as TacticalPlan | undefined) ?? null);
      if (held) {
        const hv = (health?.thesisHealth?.holdings ?? []).find((h: { ticker: string }) => h.ticker.toUpperCase() === tk)?.verdict as string | undefined;
        const w = (watch?.holdings ?? []).find((h: { ticker: string }) => h.ticker.toUpperCase() === tk) as { reUnderwriteBy?: string } | undefined;
        const missing = (watch?.coverage?.missing ?? []).some((m: { ticker: string }) => m.ticker.toUpperCase() === tk);
        let status: ThesisStatus = missing || (!w && !t?.why) ? "none" : hv === "eroding" || hv === "broken" ? hv : "intact";
        if (status !== "broken" && status !== "none" && w?.reUnderwriteBy && w.reUnderwriteBy < today) status = "stale";
        setThesis({ status, pillars: Array.isArray(t?.pillars) ? t.pillars.length : undefined, reviewBy: w?.reUnderwriteBy });
      }
      const row = (syn?.rows ?? []).find((r: { ticker: string }) => canonicalTicker(r.ticker) === canonicalTicker(tk));
      setSynth(row?.entry?.result ? { skew: Number(row.entry.result.skew ?? 0), generatedAt: row.entry.generatedAt, stale: Array.isArray(row.stale) && row.stale.length > 0 } : null);
      const entries = (fs?.entries ?? []) as Array<{ ingestedAt?: string; date?: string }>;
      setFactset({ n: entries.length, last: entries.map((e) => e.ingestedAt ?? e.date ?? "").filter(Boolean).sort().slice(-1)[0] ?? null });
    });
    return () => { alive = false; };
  }, [tk, held]);

  const reports = getAnalystReports(stock.ticker);
  const latestReportAt = useMemo(() => [reports?.rbc, reports?.jpm, reports?.morningstar].map((m) => m?.extractedAt || m?.uploadedAt).filter((x): x is string => Boolean(x)).sort().slice(-1)[0] ?? null, [reports]);
  const setup = useMemo(() => (scoreable ? computeSetup(stock) : null), [stock, scoreable]);
  const missingFeeds = setup ? setup.inputs.filter((i) => !i.present && i.key !== "charting").map((i) => i.label) : [];
  const presentFeeds = setup ? setup.inputs.filter((i) => i.present).map((i) => i.label.replace(" (PM)", "")) : [];
  const pim = pimModels.groups.find((g) => g.id === "pim");
  const holding = pim?.holdings.find((h) => canonicalTicker(h.symbol) === canonicalTicker(stock.ticker));
  const eq = pim?.profiles.balanced?.equity ?? 0.66;
  const target = holding ? holding.weightInClass * eq * 100 : null;
  const liveW = live?.get(canonicalTicker(stock.ticker)) ?? null;
  const earnings = stock.healthData?.earningsDate?.slice(0, 10) ?? null;
  const word = synth ? skewWord(synth.skew) : null;
  const synthAfterReports = synth && latestReportAt ? synth.generatedAt >= latestReportAt : null;

  const cell = (label: string, main: React.ReactNode, sub: React.ReactNode) => (
    <div className="min-w-0">
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-ink-3">{label}</div>
      <div className="mt-1 min-h-[22px]">{main}</div>
      <div className="mt-1 truncate text-[11px] text-ink-3">{sub}</div>
    </div>
  );
  const chip = (text: string, cls: string) => <span className={`inline-flex h-[22px] items-center rounded px-2 text-[12px] font-medium ${cls}`}>{text}</span>;
  const dotWord = (dot: string, text: string, cls = "text-ink") => <span className="inline-flex items-center gap-1.5"><span className={`dot ${dot}`} /><span className={`text-[14px] font-medium ${cls}`}>{text}</span></span>;

  // Sleeve cell
  const sleeveMain = core ? chip("Core", "bg-line-soft text-ink-2") : !held ? chip("Watchlist", "bg-line-soft text-ink-2") : sl.thesis && sl.tactical ? <span className="inline-flex gap-1">{chip("Thesis", "border border-accent-border bg-accent-soft text-accent")}{chip("Tactical", "border border-violet-border bg-violet-soft text-violet")}</span> : sl.thesis ? chip("Thesis", "border border-accent-border bg-accent-soft text-accent") : sl.tactical ? chip("Tactical", "border border-violet-border bg-violet-soft text-violet") : chip("Untagged", "bg-warn-soft text-warn");
  const sleeveSub = core ? "indexed / passive" : !held ? "not owned" : sl.thesis && sl.tactical ? "long-run hold with a tactical overweight" : sl.thesis ? "long-run hold — sold only on a broken thesis" : sl.tactical ? "held on a plan — stop, target, review date" : "tag it on Holdings";

  // Thesis / plan cell
  let statusMain: React.ReactNode = <span className="text-[13px] text-ink-faint">—</span>;
  let statusSub: React.ReactNode = "not owned";
  if (held && !core) {
    if (sl.tactical && !sl.thesis) {
      statusMain = !plan ? dotWord("bg-warn", "No plan", "text-warn") : !isPlanComplete(plan) ? dotWord("bg-warn", "Plan incomplete", "text-warn") : dotWord("bg-pos", "On plan");
      statusSub = plan ? `stop ${plan.stop ?? "—"} · target ${plan.target ?? "—"} · review ${plan.reviewBy ?? "—"}` : "write the plan below";
    } else if (thesis) {
      const s = thesis.status;
      statusMain = s === "broken" ? dotWord("bg-neg", "Broken", "text-neg") : s === "eroding" ? dotWord("bg-warn", "Eroding", "text-warn") : s === "stale" ? dotWord("bg-warn", "Stale", "text-warn") : s === "intact" ? dotWord("bg-pos", "Intact") : dotWord("bg-ink-faint", "Not written", "text-ink-3");
      statusSub = s === "none" ? "underwrite below" : `${thesis.pillars ? `${thesis.pillars} pillars` : "no pillars"}${thesis.reviewBy ? ` · review ${fmtDate(thesis.reviewBy)}` : ""}${s === "stale" ? " (overdue)" : ""}`;
    } else {
      statusMain = <span className="text-[13px] text-ink-faint">…</span>;
      statusSub = "";
    }
  }

  return (
    <section className="panel px-4 py-3.5">
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-3 xl:grid-cols-6">
        {cell("Sleeve", sleeveMain, sleeveSub)}
        {cell(held && sl.tactical && !sl.thesis ? "Plan status" : "Thesis status", statusMain, statusSub)}
        {cell(
          "Score",
          scoreable ? <span><span className="font-mono text-[18px] font-semibold tabular-nums text-ink">{Number(stock.adjusted.toFixed(1))}</span><span className="text-[11px] text-ink-faint">/{MAX_SCORE}</span> <span className={`text-[12px] ${/Buy/.test(stock.ratingLabel || stock.rating) ? "text-pos" : /Underweight|Sell/.test(stock.ratingLabel || stock.rating) ? "text-neg" : "text-ink-2"}`}>{stock.ratingLabel || stock.rating}</span></span> : <span className="text-[13px] text-ink-faint">n/a for a fund</span>,
          scoreable ? `FactSet · ${stock.lastScored ? `scored ${fmtDate(stock.lastScored)}` : "not scored"}` : "funds carry no conviction score",
        )}
        {cell(
          "Setup",
          setup?.grade ? chip(`${setup.grade} ${setup.rawPoints}/${setup.availableMax}`, setup.grade === "Strong" || setup.grade === "Constructive" ? "bg-pos-soft text-pos" : setup.grade === "Weak" || setup.grade === "Broken" ? "bg-neg-soft text-neg" : "bg-line-soft text-ink-2") : <span className="text-[13px] text-ink-faint">{scoreable ? "not enough feeds" : "n/a"}</span>,
          setup ? `${presentFeeds.join(" · ") || "no feeds"}${missingFeeds.length ? ` · no ${missingFeeds.join(" / ")}` : ""}` : "",
        )}
        {cell(
          "Synthesis",
          synth === undefined ? <span className="text-[13px] text-ink-faint">…</span> : word ? chip(word, SKEW_TONE[word]) : <span className="text-[13px] text-ink-faint">none</span>,
          synth ? `AI · ${synthAfterReports === false ? "BEFORE the latest report — regenerate" : `generated ${fmtDate(synth.generatedAt)}`}${synth.stale ? " · stale" : ""}` : latestReportAt ? "reports on file — generate on Synthesis" : "needs the reports first",
        )}
        {cell(
          "Evidence on file",
          <span className="text-[12.5px]">
            {(["rbc", "jpm", "morningstar"] as const).map((k) => {
              const on = reports?.[k];
              const label = k === "rbc" ? "RBC" : k === "jpm" ? "JPM" : "MS";
              return <span key={k} className={`mr-2 ${on ? "text-pos" : "text-ink-faint"}`} title={on ? `${label} ${fmtDate(on.extractedAt || on.uploadedAt)}` : `${label} not received`}>{label}{on ? " ✓" : ""}</span>;
            })}
          </span>,
          factset ? `FactSet emails ${factset.n}${factset.last ? ` · last ${fmtDate(factset.last)}` : ""}` : "…",
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line-soft pt-2.5 text-[12px] text-ink-2">
        {held && target != null && (
          <span><span className="text-ink-3">Model</span> {target.toFixed(2)}% target{liveW != null ? <> · {liveW.toFixed(2)}% live · <span className={Math.abs(liveW - target) * 100 >= 50 ? (liveW > target ? "text-pos" : "text-neg") : "text-ink-3"}>{liveW - target >= 0 ? "+" : ""}{Math.round((liveW - target) * 100)} bps</span></> : null} <span className="text-ink-3">(Balanced)</span></span>
        )}
        <span><span className="text-ink-3">Next earnings</span> {earnings ?? "—"}</span>
        {!isFund(stock) && <span><span className="text-ink-3">Sector</span> {stock.sector || "—"}</span>}
        <span className="ml-auto text-[11px] text-ink-faint">sources: FactSet · SIA · BoostedAI · MarketEdge · RBC/JPM/MS reports · Synthesis (AI)</span>
      </div>
    </section>
  );
}
