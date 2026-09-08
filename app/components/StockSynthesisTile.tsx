"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { VERDICT_LABEL, type SynthesisVerdict, type SynthesisResult, type StaleReason } from "@/app/lib/synthesis-screen-display";
import { canonicalTicker } from "@/app/lib/ticker";
import { AppIcon } from "@/app/components/AppIcon";

/**
 * Per-name synthesis read on the stock page (canvas: synthesis ranks above
 * everything). Read-only fetch of the same /api/synthesis-screen rows the
 * Synthesis screen renders; shows the verdict, the one-line reason, the
 * plain-English base / bull / bear cases, and the next step. Links to
 * Ideas › Synthesis for the full record (generation happens there). Renders
 * nothing while loading or when the name has no synthesis yet.
 */

type Row = {
  ticker: string;
  stale: StaleReason[];
  entry?: { result: SynthesisResult; generatedAt?: string } | null;
};

// Verdict words are the one place a pill survives: 18px, soft tint.
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
    <section className={`panel ${className || ""}`}>
      <div className="panel-h">
        <span className="t">Synthesis</span>
        <span className={`inline-flex h-[18px] items-center rounded px-1.5 text-[11px] font-medium ${VERDICT_TONE[verdict] ?? "bg-surface-2 text-ink-2"}`}>
          {VERDICT_LABEL[verdict] ?? verdict}
        </span>
        {stale && <span className="inline-flex items-center gap-1.5 text-[11.5px] text-warn"><span className="dot bg-warn" /> Stale</span>}
        {updated && <span className="m">{updated}</span>}
        <Link
          href={`/synthesis?ticker=${encodeURIComponent(canonicalTicker(ticker))}&from=stock`}
          className="ml-auto inline-flex items-center gap-1 text-[12px] !text-accent hover:underline"
        >
          Full record <AppIcon name="arrowR" size={12} />
        </Link>
      </div>
      <div className="flex flex-col gap-1.5 px-3.5 py-2.5 text-[12.5px] leading-[1.5] text-ink-2">
        {res.verdictReason && <p className="font-medium text-ink">{res.verdictReason}</p>}
        {res.plain?.base && (
          <p><span className="font-semibold text-ink">Base</span> {res.plain.base}</p>
        )}
        {res.plain?.bull && (
          <p><span className="font-semibold text-pos">Bull</span> {res.plain.bull}</p>
        )}
        {res.plain?.bear && (
          <p><span className="font-semibold text-neg">Bear</span> {res.plain.bear}</p>
        )}
        {res.nextStep && (
          <p className="mt-0.5 flex items-start gap-1.5 text-[12.5px] text-accent-ink">
            <AppIcon name="arrowR" size={13} className="mt-[3px]" /> <span>{res.nextStep}</span>
          </p>
        )}
      </div>
    </section>
  );
}
