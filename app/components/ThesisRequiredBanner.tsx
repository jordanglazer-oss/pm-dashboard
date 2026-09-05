"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { canonicalTicker, displayTicker } from "@/app/lib/ticker";

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

const BADGE = "inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[11px] font-mono font-bold !text-warn ring-1 ring-warn-border hover:bg-warn hover:!text-white transition-colors";

export function ThesisRequiredBanner({ ticker, className }: { ticker?: string; className?: string }) {
  const [missing, setMissing] = useState<MissingRow[] | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    let alive = true;
    fetch("/api/thesis-watch", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive) return;
        setMissing(Array.isArray(j?.coverage?.missing) ? (j.coverage.missing as MissingRow[]) : []);
      })
      .catch(() => alive && setMissing([]));
    return () => { alive = false; };
    // Re-check whenever the route changes so a Buy on /portfolio shows up on
    // the next page the PM lands on.
  }, [pathname]);

  if (!missing || missing.length === 0) return null;

  // Stock-page mode: only this ticker, only if it's in the gap list.
  if (ticker) {
    const me = missing.find((m) => canonicalTicker(m.ticker) === canonicalTicker(ticker));
    if (!me) return null;
    const scrollToTile = () => document.getElementById("thesis-tile")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return (
      <div className={`flex flex-wrap items-center gap-3 rounded-card border border-warn-border bg-warn-soft px-4 py-3 ${className ?? ""}`}>
        <span className="text-xs font-bold uppercase tracking-wide text-warn">Thesis required</span>
        <span className="text-xs text-ink-2">
          {displayTicker(ticker)} is in the Portfolio but isn&apos;t underwritten
          {me.hasProse ? " — the thesis is written but has no kill conditions, so nothing is monitoring it" : " — no thesis, no kill conditions, nothing is monitoring it"}.
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button onClick={scrollToTile} className="rounded-md border border-warn-border bg-white px-2.5 py-1 text-[11px] font-semibold text-warn hover:bg-warn hover:text-white transition-colors">
            {me.hasProse ? "Add kill conditions" : "Write thesis"}
          </button>
          <button
            onClick={() => { scrollToTile(); window.dispatchEvent(new CustomEvent("thesis:draft", { detail: { ticker } })); }}
            className="rounded-md bg-warn px-2.5 py-1 text-[11px] font-semibold !text-white hover:opacity-90 transition-opacity"
            title="One AI call proposes a thesis + kill conditions from the evidence on file; you edit and sign"
          >
            ✦ Draft with AI
          </button>
        </span>
      </div>
    );
  }

  // Dashboard mode: every gap, one line.
  return (
    <div className={`flex flex-wrap items-center gap-2 rounded-card border border-warn-border bg-warn-soft px-4 py-2.5 ${className ?? ""}`}>
      <span className="text-xs font-bold uppercase tracking-wide text-warn">Thesis required</span>
      <span className="text-xs text-ink-2">
        {missing.length} position{missing.length === 1 ? "" : "s"} in the Portfolio {missing.length === 1 ? "is" : "are"} not underwritten — unmonitored until a thesis and kill conditions are on file.
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        {missing.map((m) => (
          <Link key={m.ticker} href={`/stock/${encodeURIComponent(m.ticker)}#thesis-tile`} className={BADGE} title={`${m.name ?? m.ticker}${m.hasProse ? " — written, no kill conditions" : " — no thesis"}. Open the stock page to write or draft it.`}>
            {displayTicker(m.ticker)}
            {m.hasProse && <span className="font-sans font-normal opacity-70">prose only</span>}
          </Link>
        ))}
      </span>
      <Link href="/thesis" className="ml-auto text-[11px] font-semibold !text-warn hover:underline">Thesis desk →</Link>
    </div>
  );
}
