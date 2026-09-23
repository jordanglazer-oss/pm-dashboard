"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { displayTicker } from "@/app/lib/ticker";
import { sleevesOf, isCoreDesignated } from "@/app/lib/sleeves";
import { computeSetup } from "@/app/lib/setup-grade";
import { checkTacticalPlan, isPlanComplete, planReturn, tacticalVerdictOf, TACTICAL_VERDICT_LABEL, type TacticalPlan } from "@/app/lib/tactical-plan";

/* Tactical plans — the Tactical half of the desk. One row per held Tactical
 * name: the plan's terms, where the price sits against them, and the
 * deterministic verdict (hold trade / take profit / exit). Read-only; the
 * stock page's plan tile is the only editor. */

const px = (v: number | null | undefined) => (v != null ? v.toFixed(2) : "—");

export function TacticalPlansSection() {
  const { scoredStocks } = useStocks();
  const [plans, setPlans] = useState<Record<string, TacticalPlan | undefined>>({});
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/kv/position-theses", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return;
        const out: Record<string, TacticalPlan | undefined> = {};
        for (const [tk, t] of Object.entries((d?.theses ?? {}) as Record<string, { tacticalPlan?: TacticalPlan }>)) out[tk.toUpperCase()] = t?.tacticalPlan;
        setPlans(out);
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    return () => { alive = false; };
  }, []);

  const rows = useMemo(() => scoredStocks
    .filter((s) => s.bucket === "Portfolio" && !isCoreDesignated(s) && sleevesOf(s).tactical)
    .map((s) => {
      const plan = plans[s.ticker.toUpperCase()] ?? null;
      const price = typeof s.price === "number" ? s.price : s.healthData?.currentPrice ?? null;
      const setup = computeSetup(s);
      const flags = plan ? checkTacticalPlan(plan, { price, setupGrade: setup.grade, earningsDate: s.healthData?.earningsDate?.slice(0, 10) ?? null }) : [];
      const verdict = plan ? tacticalVerdictOf({ flags }) : null;
      return { s, plan, price, ret: plan ? planReturn(plan, price) : null, flags, verdict, complete: isPlanComplete(plan), both: sleevesOf(s).thesis };
    })
    .sort((a, b) => (a.verdict?.verdict === "exit" ? 0 : a.verdict?.verdict === "take-profit" ? 1 : 2) - (b.verdict?.verdict === "exit" ? 0 : b.verdict?.verdict === "take-profit" ? 1 : 2) || a.s.ticker.localeCompare(b.s.ticker)), [scoredStocks, plans]);

  if (rows.length === 0) return null;
  const vCls = (v: string | undefined) => (v === "exit" ? "text-neg" : v === "take-profit" ? "text-violet" : "text-ink-2");

  return (
    <section className="panel">
      <div className="panel-h">
        <span className="t">Tactical plans</span>
        <span className="m"><span className="font-mono">{rows.length}</span> · held on terms — stop, target, review date</span>
      </div>
      <div className="overflow-auto"><table className="data-table">
        <thead><tr><th className="pl-3.5">Name</th><th className="text-right">Entry</th><th className="text-right">Now</th><th className="text-right">Target</th><th className="text-right">Stop</th><th>Review by</th><th>Read</th></tr></thead>
        <tbody>
          {loaded && rows.map(({ s, plan, price, ret, flags, verdict, complete, both }) => (
            <tr key={s.ticker}>
              <td className="pl-3.5">
                <Link href={`/stock/${s.ticker.toLowerCase()}#tactical-plan-tile`} className="font-mono font-medium text-ink hover:underline">{displayTicker(s.ticker)}</Link>
                {both && <span className="ml-1.5 text-[10.5px] text-accent">overlay</span>}
              </td>
              <td className="n">{px(plan?.entryPrice)}{plan?.entryDate && <span className="ml-1 text-[10.5px] text-ink-3">{plan.entryDate.slice(5)}</span>}</td>
              <td className="n">{px(price)}{ret != null && <span className={`ml-1 text-[10.5px] ${ret >= 0 ? "text-pos" : "text-neg"}`}>{ret >= 0 ? "+" : ""}{(ret * 100).toFixed(1)}%</span>}</td>
              <td className="n">{px(plan?.target)}</td>
              <td className="n">{px(plan?.stop)}</td>
              <td className="text-[12px] text-ink-2">{plan?.reviewBy ?? "—"}</td>
              <td>
                {!plan ? <span className="text-[12px] text-warn">no plan</span>
                  : !complete ? <span className="text-[12px] text-warn" title="Entry on file; why-now, target or stop missing">plan incomplete</span>
                  : <span className={`text-[12px] ${vCls(verdict?.verdict)}`} title={flags.map((f) => f.text).join(" · ") || "within plan"}>{verdict ? TACTICAL_VERDICT_LABEL[verdict.verdict] : "—"}{flags.length ? <span className="ml-1 text-ink-3">· {flags.length} flag{flags.length === 1 ? "" : "s"}</span> : null}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </section>
  );
}
