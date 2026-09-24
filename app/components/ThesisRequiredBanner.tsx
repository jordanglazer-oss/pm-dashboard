"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { canonicalTicker, displayTicker } from "@/app/lib/ticker";
import { AppIcon } from "@/app/components/AppIcon";

/**
 * "Thesis required" — funnel stage 4 → 5.
 *
 * Every Portfolio stock is expected to be UNDERWRITTEN (a written thesis plus
 * at least one pre-registered kill condition) — that's what the nightly
 * monitoring runs off. A Buy doesn't block on it (trades are queued in
 * batches and a modal would interrupt them); instead this banner follows the
 * PM until the position is underwritten: on the Dashboard listing every gap,
 * and on the stock page for that one name with the two ways to close it —
 * write it, or draft it with AI and sign.
 *
 * Source of truth is /api/thesis-watch's `coverage.missing` (Portfolio bucket,
 * scoreable stocks only, no kill conditions yet), so the banner and the
 * Thesis desk can never disagree. Read-only; nothing is written here.
 */

type MissingRow = { ticker: string; name?: string; hasProse: boolean };

const BADGE = "inline-flex h-6 items-center gap-1 rounded-control border border-warn-border bg-surface px-2 font-mono text-[11.5px] font-medium !text-warn hover:bg-warn-soft transition-colors";

export function ThesisRequiredBanner({ ticker, className }: { ticker?: string; className?: string }) {
  const [missing, setMissing] = useState<MissingRow[] | null>(null);
  // Tactical-sleeve holdings with no tactical plan (additive field on the route).
  const [planMissing, setPlanMissing] = useState<Array<{ ticker: string; name?: string; incomplete?: boolean }>>([]);
  const pathname = usePathname();

  useEffect(() => {
    let alive = true;
    fetch("/api/thesis-watch", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive) return;
        setMissing(Array.isArray(j?.coverage?.missing) ? (j.coverage.missing as MissingRow[]) : []);
        setPlanMissing(Array.isArray(j?.coverage?.planMissing) ? j.coverage.planMissing : []);
      })
      .catch(() => alive && setMissing([]));
    return () => { alive = false; };
    // Re-check whenever the route changes so a Buy on /portfolio shows up on
    // the next page the PM lands on.
  }, [pathname]);

  if (!missing) return null;

  const planBanner = (rows: Array<{ ticker: string; name?: string; incomplete?: boolean }>, single: boolean) => (
    <div className={`flex flex-wrap items-center gap-2 rounded-card border border-violet-border bg-violet-soft px-3.5 py-2 ${className ?? ""}`}>
      <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-violet">
        <span className="dot bg-violet" /> {single && rows[0].incomplete ? "Tactical plan incomplete" : "Tactical plan required"}
      </span>
      <span className="text-[12.5px] text-ink-2">
        {single
          ? rows[0].incomplete
            ? `${displayTicker(rows[0].ticker)} has its entry on file but no why-now, target or stop yet — nothing is watching it until they are in.`
            : `${displayTicker(rows[0].ticker)} is a Tactical position with no plan — no target, stop or review date is being watched.`
          : `${rows.length} Tactical position${rows.length === 1 ? " has" : "s have"} an incomplete or missing plan — no target, stop or review date is being watched.`}
      </span>
      {single ? (
        <button
          onClick={() => document.getElementById("tactical-plan-tile")?.scrollIntoView({ behavior: "smooth", block: "center" })}
          className="ml-auto inline-flex h-7 items-center rounded-control border border-violet-border bg-surface px-2.5 text-[12.5px] text-violet hover:bg-surface-hover transition-colors"
        >
          {rows[0].incomplete ? "Complete plan" : "Write plan"}
        </button>
      ) : (
        <span className="flex flex-wrap items-center gap-1.5">
          {rows.map((m) => (
            <Link key={m.ticker} href={`/stock/${encodeURIComponent(m.ticker)}`} className="inline-flex h-6 items-center rounded-control border border-violet-border bg-surface px-2 font-mono text-[11.5px] font-medium !text-violet hover:bg-surface-hover transition-colors" title={`${m.name ?? m.ticker} — open the stock page to write its tactical plan.`}>
              {displayTicker(m.ticker)}
            </Link>
          ))}
        </span>
      )}
    </div>
  );

  // Stock-page mode: only this ticker, only if it's in a gap list.
  if (ticker) {
    const me = missing.find((m) => canonicalTicker(m.ticker) === canonicalTicker(ticker));
    const myPlan = planMissing.filter((m) => canonicalTicker(m.ticker) === canonicalTicker(ticker));
    if (!me) return myPlan.length ? planBanner(myPlan, true) : null;
    // A name in both sleeves can owe both: the thesis banner AND the plan reminder.
    const planToo = myPlan.length ? planBanner(myPlan, true) : null;
    const scrollToTile = () => document.getElementById("thesis-tile")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return (
      <>
      {planToo}
      <div className={`flex flex-wrap items-center gap-3 rounded-card border border-warn-border bg-warn-soft px-3.5 py-2 ${className ?? ""}`}>
        <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-warn">
          <span className="dot bg-warn" /> Thesis required
        </span>
        <span className="text-[12.5px] text-ink-2">
          {displayTicker(ticker)} is in the Portfolio but isn&apos;t underwritten
          {me.hasProse ? " — the thesis is written but has no kill conditions, so nothing is monitoring it" : " — no thesis, no kill conditions, nothing is monitoring it"}.
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button onClick={scrollToTile} className="inline-flex h-7 items-center rounded-control border border-warn-border bg-surface px-2.5 text-[12.5px] text-warn hover:bg-warn hover:text-white transition-colors">
            {me.hasProse ? "Add kill conditions" : "Write thesis"}
          </button>
          <button
            onClick={() => { scrollToTile(); window.dispatchEvent(new CustomEvent("thesis:draft", { detail: { ticker } })); }}
            className="inline-flex h-7 items-center gap-1.5 rounded-control bg-ink px-2.5 text-[12.5px] font-medium !text-white hover:bg-ink-2 transition-colors"
            title="One AI call proposes a thesis + kill conditions from the evidence on file; you edit and sign"
          >
            <AppIcon name="spark" size={13} /> Draft with AI
          </button>
        </span>
      </div>
      </>
    );
  }

  // Dashboard mode: every gap, one line per kind.
  if (missing.length === 0) return planMissing.length ? planBanner(planMissing, false) : null;
  return (
    <>
    {planMissing.length > 0 && planBanner(planMissing, false)}
    <div className={`flex flex-wrap items-center gap-2 rounded-card border border-warn-border bg-warn-soft px-3.5 py-2 ${className ?? ""}`}>
      <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-warn">
        <span className="dot bg-warn" /> Thesis required
      </span>
      <span className="text-[12.5px] text-ink-2">
        {missing.length} position{missing.length === 1 ? "" : "s"} in the Portfolio {missing.length === 1 ? "is" : "are"} not underwritten — unmonitored until a thesis and kill conditions are on file.
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        {missing.map((m) => (
          <Link key={m.ticker} href={`/stock/${encodeURIComponent(m.ticker)}#thesis-tile`} className={BADGE} title={`${m.name ?? m.ticker}${m.hasProse ? " — written, no kill conditions" : " — no thesis"}. Open the stock page to write or draft it.`}>
            {displayTicker(m.ticker)}
            {m.hasProse && <span className="font-sans font-normal text-ink-3">prose only</span>}
          </Link>
        ))}
      </span>
      <Link href="/thesis" className="ml-auto inline-flex items-center gap-1 text-[12px] !text-accent hover:underline">Thesis desk <AppIcon name="arrowR" size={12} /></Link>
    </div>
    </>
  );
}
