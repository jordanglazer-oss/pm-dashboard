"use client";

import React, { useEffect, useState } from "react";
import { THESIS_VERDICT_LABEL } from "@/app/lib/thesis-verdict";
import type { ThesisVerdictEntry } from "@/app/api/thesis-verdicts/route";

/* Thesis verdict chip for a held, underwritten name: the roll-up of its pillar
 * review (intact / challenged / broken). One shared fetch per page load. */

let inflight: Promise<Record<string, ThesisVerdictEntry>> | null = null;
function loadVerdicts(): Promise<Record<string, ThesisVerdictEntry>> {
  if (!inflight) {
    inflight = fetch("/api/thesis-verdicts", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { verdicts: {} }))
      .then((d) => (d?.verdicts ?? {}) as Record<string, ThesisVerdictEntry>)
      .catch(() => ({}));
    // Let a later mount re-read rather than pin the first answer forever.
    inflight.finally(() => setTimeout(() => { inflight = null; }, 30_000));
  }
  return inflight;
}

export function useThesisVerdicts(): Record<string, ThesisVerdictEntry> {
  const [v, setV] = useState<Record<string, ThesisVerdictEntry>>({});
  useEffect(() => {
    let alive = true;
    loadVerdicts().then((d) => alive && setV(d));
    return () => { alive = false; };
  }, []);
  return v;
}

const CHIP = "inline-flex h-[18px] items-center gap-1 rounded px-1.5 text-[11px] font-medium whitespace-nowrap";

export function ThesisVerdictChip({ entry }: { entry: ThesisVerdictEntry | undefined }) {
  if (!entry) return null;
  return (
    <span
      className={`${CHIP} ${entry.verdict === "broken" ? "bg-neg-soft text-neg" : entry.verdict === "challenged" ? "bg-warn-soft text-warn" : entry.verdict === "intact" ? "bg-pos-soft text-pos" : "bg-line-soft text-ink-3"}`}
      title={entry.verdict ? `Thesis — roll-up of the pillar review${entry.generatedAt ? ` of ${entry.generatedAt.slice(0, 10)}` : ""}. Judged on the thesis, never on price.` : "Thesis — no pillar review yet. One is generated after the name is underwritten and new evidence arrives."}
    >
      {entry.verdict ? THESIS_VERDICT_LABEL[entry.verdict] : "Thesis · no read"}
    </span>
  );
}
