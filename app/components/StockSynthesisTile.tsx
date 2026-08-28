"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { VERDICT_LABEL, type SynthesisVerdict, type SynthesisResult, type StaleReason } from "@/app/lib/synthesis-screen-display";
import { canonicalTicker } from "@/app/lib/ticker";

/**
 * Per-name synthesis read on the stock page (canvas: synthesis ranks above
 * everything). Read-only fetch of the same /api/synthesis-screen rows the
 * Synthesis screen renders; shows the verdict, the one-line reason, the
 * plain-English base case, and the next step. Links to Ideas › Synthesis
 * for the full record. Renders nothing while loading or when the name has
 * no synthesis yet (the screen is where generation happens).
 */

type Row = {
  ticker: string;
  stale: StaleReason[];
  entry?: { result: SynthesisResult; generatedAt?: string } | null;
};

const VERDICT_TONE: Record<string, string> = {
  advance: "bg-pos-soft text-pos",
  "thesis-intact": "bg-pos-soft text-pos",
  watch: "bg-warn-soft text-warn",
  review: "bg-warn-soft text-warn",
  pass: "bg-neg-soft text-neg",
  "exit-watch": "bg-neg-soft text-neg",
};

export function StockSynthesisTile({ ticker, className }: { ticker: string; className?: string }) {
  const [row, setRow] = useState<Row | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/synthesis-screen")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return;
        setChecked(true);
        if (!Array.isArray(d?.rows)) return;
        const want = canonicalTicker(ticker);
        const hit = (d.rows as Row[]).find((x) => canonicalTicker(x.ticker) === want);
        if (hit) setRow(hit);
      })
      .catch(() => { if (alive) setChecked(true); });
    return () => { alive = false; };
  }, [ticker]);

  if (!checked || !row?.entry?.result) return null;
  const res = row.entry.result;
  const verdict = res.verdict as SynthesisVerdict;
  const stale = row.stale.length > 0;
  const updated = row.entry.generatedAt
    ? new Date(row.entry.generatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : null;

  return (
    <div className={`overflow-hidden rounded-card border border-line bg-white shadow-sm ${className || ""}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-5 py-3">
        <h2 className="text-[15px] font-bold text-ink">Synthesis</h2>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${VERDICT_TONE[verdict] ?? "bg-surface-2 text-ink-2"}`}>
          {VERDICT_LABEL[verdict] ?? verdict}
        </span>
        {stale && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[10px] font-bold text-warn">Stale</span>}
        <span className="ml-auto flex items-center gap-2 text-[11px] text-ink-3">
          {updated && <span>updated {updated}</span>}
          <Link href="/synthesis" className="font-semibold !text-accent hover:underline">Full record →</Link>
        </span>
      </div>
      <div className="space-y-2 px-5 py-4">
        {res.verdictReason && <p className="text-[13px] font-semibold leading-5 text-ink">{res.verdictReason}</p>}
        {res.plain?.base && (
          <p className="text-[13px] leading-5 text-ink-2">
            <span className="font-semibold text-ink-3">Base: </span>
            {res.plain.base}
          </p>
        )}
        {res.nextStep && (
          <p className="rounded-lg border border-accent-border bg-accent-soft px-3 py-1.5 text-[12px] font-medium leading-5 text-accent-ink">
            → {res.nextStep}
          </p>
        )}
      </div>
    </div>
  );
}
