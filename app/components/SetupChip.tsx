"use client";

import React from "react";
import type { Stock } from "@/app/lib/types";
import { computeSetup, setupTone, actionFor, type SetupContext } from "@/app/lib/setup-grade";

/**
 * Compact two-axis read: the setup grade (timing layer) beside the
 * conviction rating. Hover/title lists every input, its points, and any
 * flags that knocked the grade. Pure render over the Stock record — the
 * math lives in app/lib/setup-grade.ts.
 */
export function SetupChip({
  stock,
  conviction,
  ctx,
  showAction = true,
  size = "md",
}: {
  stock: Stock;
  /** The composite's rating label ("Strong Buy" …) for the action read. */
  conviction?: string;
  ctx?: SetupContext;
  showAction?: boolean;
  size?: "sm" | "md";
}) {
  const r = computeSetup(stock, ctx);
  const tone = setupTone(r.grade);
  const toneCls =
    tone === "pos" ? "bg-pos-soft text-pos" : tone === "warn" ? "bg-warn-soft text-warn" : tone === "neg" ? "bg-neg-soft text-neg" : "bg-line-soft text-ink-3";
  const title = [
    r.score != null ? `Setup ${r.rawPoints}/${r.availableMax}${r.chartingScored ? " (charting scored — /9 basis)" : " (feeds only — /6 basis; score charting to move to /9)"}` : "Setup: not enough inputs",
    ...r.inputs.map((i) => `${i.label}: ${i.present && i.points != null ? `${i.points}/${i.max}` : "—"}${i.note ? ` · ${i.note}` : ""}`),
    ...r.flags.map((f) => `${f.notch ? "▼ " : "• "}${f.label}`),
  ].join("\n");
  const pad = size === "sm" ? "px-1.5 py-0.5 text-[10.5px]" : "px-2 py-0.5 text-[11.5px]";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" title={title}>
      <span className={`inline-flex items-center gap-1 rounded font-medium ${pad} ${toneCls}`}>
        <span>Setup</span>
        <span>{r.grade ?? "n/a"}</span>
        {r.score != null && <span className="font-mono opacity-80">{r.rawPoints}/{r.availableMax}</span>}
        {r.notches > 0 && <span aria-label={`${r.notches} notch${r.notches === 1 ? "" : "es"} down`}>{"▼".repeat(r.notches)}</span>}
      </span>
      {showAction && conviction && r.grade && (
        <span className={`text-ink-2 ${size === "sm" ? "text-[10.5px]" : "text-[11.5px]"}`}>{actionFor(conviction, r.grade)}</span>
      )}
    </span>
  );
}
