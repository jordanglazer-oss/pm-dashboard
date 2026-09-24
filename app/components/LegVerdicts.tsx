"use client";

import React, { useEffect, useState } from "react";
import { THESIS_VERDICT_LABEL } from "@/app/lib/thesis-verdict";
import { TACTICAL_VERDICT_LABEL } from "@/app/lib/tactical-plan";
import type { LegVerdicts as Legs } from "@/app/api/sleeve-verdicts/route";

/* Per-leg verdict chips for a held Alpha name: the Thesis leg is judged on its
 * pillars (intact / challenged / broken), the Tactical leg on its plan
 * (hold trade / take profit / exit). One shared fetch per page load. */

let inflight: Promise<Record<string, Legs>> | null = null;
function loadVerdicts(): Promise<Record<string, Legs>> {
  if (!inflight) {
    inflight = fetch("/api/sleeve-verdicts", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { verdicts: {} }))
      .then((d) => (d?.verdicts ?? {}) as Record<string, Legs>)
      .catch(() => ({}));
    // Let a later mount (navigation, a saved plan) re-read rather than pin the first answer forever.
    inflight.finally(() => setTimeout(() => { inflight = null; }, 30_000));
  }
  return inflight;
}

export function useSleeveVerdicts(): Record<string, Legs> {
  const [v, setV] = useState<Record<string, Legs>>({});
  useEffect(() => {
    let alive = true;
    loadVerdicts().then((d) => alive && setV(d));
    return () => { alive = false; };
  }, []);
  return v;
}

const CHIP = "inline-flex h-[18px] items-center gap-1 rounded px-1.5 text-[11px] font-medium whitespace-nowrap";

export function LegVerdictChips({ legs }: { legs: Legs | undefined }) {
  if (!legs) return null;
  const t = legs.thesis;
  const k = legs.tactical;
  return (
    <>
      {t && (
        <span
          className={`${CHIP} ${t.verdict === "broken" ? "bg-neg-soft text-neg" : t.verdict === "challenged" ? "bg-warn-soft text-warn" : t.verdict === "intact" ? "bg-pos-soft text-pos" : "bg-line-soft text-ink-3"}`}
          title={t.verdict ? `Thesis leg — roll-up of the pillar review${t.generatedAt ? ` of ${t.generatedAt.slice(0, 10)}` : ""}. Judged on the thesis, never on price.` : "Thesis leg — no pillar review yet. One is generated after the name is underwritten and new evidence arrives."}
        >
          {t.verdict ? THESIS_VERDICT_LABEL[t.verdict] : "Thesis · no read"}
        </span>
      )}
      {k && (
        <span
          className={`${CHIP} ${k.verdict === "exit" ? "bg-neg-soft text-neg" : k.verdict === "take-profit" ? "bg-violet-soft text-violet" : k.verdict === "hold-trade" ? "bg-pos-soft text-pos" : "bg-line-soft text-ink-3"}`}
          title={k.hasPlan ? `Tactical leg — judged against its plan.${k.reasons.length ? ` ${k.reasons.join(" · ")}` : " Within plan."}` : "Tactical leg — no plan on file, so there is nothing to judge it against. Write one on the stock page."}
        >
          {k.verdict ? TACTICAL_VERDICT_LABEL[k.verdict] : "Tactical · no plan"}
        </span>
      )}
    </>
  );
}
