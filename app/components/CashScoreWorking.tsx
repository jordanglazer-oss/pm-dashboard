"use client";

/** The app-computed cash-deployment score and every number behind it (shadow mode). */

import React from "react";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import { CASH_SCORE_LIVE_SOURCE, type ComputedCashScore } from "@/app/lib/cash-score";

export function CashScoreWorking({ computed, modelScore }: { computed: ComputedCashScore; modelScore?: number }) {
  const [open, toggle] = usePersistedOpen("brief.cashScore.working", false);
  const label = computed.action === "DEPLOY_PARTIAL" ? "PARTIAL" : computed.action;
  return (
    <div className="mt-2 text-[11.5px] text-ink-2">
      <button type="button" onClick={toggle} className="text-left font-medium text-accent hover:underline">
        App-computed score{CASH_SCORE_LIVE_SOURCE === "computed" ? "" : " (in test)"}: {computed.score != null ? `${computed.score} → ${label}` : "needs Newton's state"}{typeof modelScore === "number" && computed.score != null ? ` · model said ${modelScore}` : ""} · {open ? "hide" : "show"} the math
      </button>
      {open && (
        <div className="mt-2 rounded border border-line bg-surface p-2">
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead><tr className="border-b border-line text-left text-[10px] uppercase tracking-wide text-ink-3">
                <th className="py-1 pr-2">Input</th><th className="px-2">Reading</th><th className="px-2">Reads as</th><th className="px-2 text-right">Weight</th><th className="pl-2 text-right">Points</th>
              </tr></thead>
              <tbody>
                <tr className="border-b border-line">
                  <td className="py-1 pr-2 text-ink">Newton&apos;s note</td>
                  <td className="px-2" colSpan={2}>{computed.newton ? computed.newton.label : "not classified on this run"}</td>
                  <td className="px-2 text-right tabular-nums">40</td>
                  <td className="pl-2 text-right tabular-nums">{computed.newton ? computed.newton.points : "—"}</td>
                </tr>
                {computed.components.map((c) => (
                  <tr key={c.key} className="border-b border-line">
                    <td className="py-1 pr-2 text-ink">{c.label}</td>
                    <td className="px-2 tabular-nums">{c.reading}</td>
                    <td className="px-2">{c.band}</td>
                    <td className="px-2 text-right tabular-nums">{c.weight}</td>
                    <td className="pl-2 text-right tabular-nums">{c.points.toFixed(1)}</td>
                  </tr>
                ))}
                <tr><td className="py-1 pr-2 font-medium text-ink" colSpan={3}>Total</td><td className="px-2 text-right tabular-nums">100</td><td className="pl-2 text-right tabular-nums font-medium text-ink">{computed.score ?? "—"}</td></tr>
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-ink-3">Each input earns its weight × how strongly it argues for deploying (half its weight when it has no edge). 70 or more is DEPLOY, 55–69 PARTIAL, below 55 WAIT. {CASH_SCORE_LIVE_SOURCE === "computed" ? "This computed number drives the call above; the model classifies Newton&apos;s note and writes the reasoning." : "This number is being compared with the model&apos;s own for now; the call above still follows the model&apos;s."}</p>
        </div>
      )}
    </div>
  );
}
