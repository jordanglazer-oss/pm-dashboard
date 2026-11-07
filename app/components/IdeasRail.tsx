"use client";

import { useMemo, type CSSProperties } from "react";
import Link from "next/link";
import TickerLink from "@/app/components/TickerLink";
import { AppIcon } from "@/app/components/AppIcon";
import { EmptyState } from "@/app/components/EmptyState";
import { displayTicker } from "@/app/lib/ticker";
import type { PipelineData } from "@/app/components/PipelineStages";

/**
 * The Synthesis page's right column: a compact read of the OTHER idea feeds.
 *
 *   Ready to act  the funnel's action lists, one line each.
 *
 * Read-only fetches of the same endpoints those pages already use; "Suggest"
 * promotes a name to the Watchlist exactly as Radar's own button does.
 */


type ActRow = { key: string; tone: "pos" | "warn" | "neg" | "faint"; ticker: string; state: string; meta: string; href: string };

const DOT: Record<ActRow["tone"], string> = { pos: "bg-pos", warn: "bg-warn", neg: "bg-neg", faint: "bg-ink-faint" };

export function ReadyToActPanel({ pipeline }: { pipeline: PipelineData }) {
  const rows = useMemo<ActRow[]>(() => {
    const out: ActRow[] = [];
    for (const r of pipeline.readyRows) {
      out.push({ key: `buy-${r.ticker}`, tone: "pos", ticker: r.ticker, state: "Ready to buy", meta: `${r.met}/${r.known} signals met · ${r.bucket}`, href: "/funnel" });
    }
    for (const r of pipeline.readyToAdvance) {
      out.push({ key: `adv-${r.ticker}`, tone: "pos", ticker: r.ticker, state: "Ready to advance", meta: r.entry?.result.verdictReason ?? "synthesis Advance", href: `/synthesis?ticker=${encodeURIComponent(r.ticker)}` });
    }
    for (const r of pipeline.awaitingSynthesis.slice(0, 3)) {
      out.push({ key: `await-${r.ticker}`, tone: "warn", ticker: r.ticker, state: "Awaiting synthesis", meta: `${r.listCount} lists`, href: `/synthesis?ticker=${encodeURIComponent(r.ticker)}` });
    }
    for (const r of pipeline.review.slice(0, 3)) {
      out.push({ key: `rev-${r.ticker}`, tone: r.tone, ticker: r.ticker, state: "Review", meta: r.reasons[0] ?? "", href: "/funnel#review" });
    }
    return out.slice(0, 8);
  }, [pipeline]);

  return (
    <section className="panel animate-panel-in min-w-0">
      <div className="panel-h">
        <span className="t-mark bg-hub-ideas" aria-hidden />
        <span className="t">Ready to act</span>
        <span className="m">from the funnel</span>
        <Link href="/funnel" className="ml-auto text-[11.5px] !text-accent-ink hover:underline">Open pipeline</Link>
      </div>
      {pipeline.loading ? (
        <div className="px-3.5 py-3 text-[12px] text-ink-3">Loading stages…</div>
      ) : rows.length === 0 ? (
        <EmptyState className="!py-6" glyph={<AppIcon name="check" size={18} />} title="Nothing waiting" body="No name is ready to buy, advance, or under review." />
      ) : (
        <div className="stagger flex flex-col gap-2 px-3.5 pb-2.5 pt-1.5 text-[12.5px]">
          {rows.map((r, i) => (
            <div
              key={r.key}
              style={{ "--i": i } as CSSProperties}
              className="flex min-w-0 items-start gap-2.5"
            >
              <span className={`dot mt-[7px] ${DOT[r.tone]}`} />
              <TickerLink ticker={r.ticker} className="mt-px shrink-0 font-mono font-medium text-ink hover:text-accent">
                {displayTicker(r.ticker)}
              </TickerLink>
              {/* Label above its value, and the meta wraps rather than
                  truncating — long reasons stay readable in a narrow rail. */}
              <div className="min-w-0 flex-1">
                <Link href={r.href} className="break-words hover:text-accent">{r.state}</Link>
                {r.meta && <div className="min-w-0 break-words text-[12px] leading-[1.4] text-ink-3">{r.meta}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Right column of /synthesis: Screen + Ready to act stacked. */
export function IdeasRail({ pipeline }: { pipeline: PipelineData }) {
  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      <ReadyToActPanel pipeline={pipeline} />
    </div>
  );
}
