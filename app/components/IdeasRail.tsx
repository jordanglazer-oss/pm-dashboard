"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import TickerLink from "@/app/components/TickerLink";
import { AppIcon } from "@/app/components/AppIcon";
import { EmptyState } from "@/app/components/EmptyState";
import { useStocks } from "@/app/lib/StockContext";
import { displayTicker } from "@/app/lib/ticker";
import { SCREEN_MODES } from "@/app/components/IdeasTabs";
import type { ScoreKey } from "@/app/lib/types";
import type { RadarName, RadarPayload } from "@/app/lib/radar";
import type { PipelineData } from "@/app/components/PipelineStages";

/**
 * The Synthesis page's right column: a compact read of the OTHER idea feeds.
 *
 *   Screen        Radar's top regime-tilted names (Fit / Quant / Mom / Qual)
 *                 with the four-way mode switch linking to each screening
 *                 page, and the Setup scan's actionable count in the footer.
 *   Ready to act  the funnel's action lists, one line each.
 *
 * Read-only fetches of the same endpoints those pages already use; "Suggest"
 * promotes a name to the Watchlist exactly as Radar's own button does.
 */

/** A promoted name starts unscored — the scoring flow fills it in. */
const ZERO_SCORES: Record<ScoreKey, number> = {
  brand: 0, secular: 0, researchCoverage: 0, marketEdge: 0,
  analystConsensus: 0, researchMentions: 0,
  charting: 0, relativeStrength: 0, aiRating: 0, growth: 0,
  relativeValuation: 0, historicalValuation: 0, leverageCoverage: 0,
  cashFlowQuality: 0, competitiveMoat: 0, turnaround: 0, catalysts: 0,
  trackRecord: 0, ownershipTrends: 0,
};

const fmtZ = (z: number | undefined | null) => (z == null ? "—" : `${z > 0 ? "+" : ""}${z.toFixed(1)}`);

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ScreenPanel() {
  const { stocks, addStock } = useStocks();
  const [radar, setRadar] = useState<RadarPayload | null>(null);
  const [setupCount, setSetupCount] = useState<number | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/radar", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d && Array.isArray(d.names)) setRadar(d as RadarPayload);
      })
      .catch(() => {});
    fetch("/api/setup-scan", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && Array.isArray(d?.rows)) {
          setSetupCount(d.rows.filter((x: { base?: { score?: number } }) => (x.base?.score ?? 0) >= 3).length);
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const top = useMemo(() => (radar?.names ?? []).slice(0, 7), [radar]);
  const universe = useMemo(() => (radar?.sectors ?? []).reduce((n, s) => n + (s.n ?? 0), 0), [radar]);
  const held = (t: string) => stocks.some((s) => s.ticker.toUpperCase().replace(/-T$/, ".TO") === t.toUpperCase().replace(/-T$/, ".TO"));
  const ownedCount = top.filter((n) => held(n.ticker)).length;
  const regimeLabel = radar?.regime?.label ?? "Neutral";
  const builtDay = radar?.builtAt ? WEEKDAY[new Date(radar.builtAt).getDay()] : null;

  const promote = async (n: RadarName) => {
    setAdding(n.ticker);
    try {
      addStock({
        ticker: n.ticker.toUpperCase(),
        name: n.ticker,
        bucket: "Watchlist",
        instrumentType: "stock",
        sector: n.sector || "",
        beta: 1.0,
        weights: { portfolio: 0 },
        scores: { ...ZERO_SCORES },
        notes: `From Radar — regime fit P${n.regimeFit} (${regimeLabel}), quant P${n.quant}`,
      });
    } finally {
      setAdding(null);
    }
  };

  return (
    <section className="panel animate-panel-in flex min-w-0 flex-col">
      <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
        <span className="t-mark bg-hub-ideas" aria-hidden />
        <span className="t">Screen</span>
        <div className="seg">
          {SCREEN_MODES.map((m) => (
            <Link key={m.href} href={m.href} className={m.href === "/radar" ? "on" : ""}>
              {m.label}
            </Link>
          ))}
        </div>
        <span className="m ml-auto">
          {regimeLabel} tilt{builtDay ? ` · built ${builtDay}` : ""}
        </span>
      </div>
      {top.length === 0 ? (
        <EmptyState
          className="!py-8"
          glyph={<AppIcon name="filter" size={18} />}
          title="Radar not built yet"
          body={radar?.hint ?? "Populates after the weekly factor-universe build."}
        />
      ) : (
        <div className="min-w-0">
          <table className="data-table">
            <thead>
              <tr>
                <th className="pl-3.5">Name</th>
                <th className="n" title="Percentile under the current regime's factor tilts">Fit</th>
                <th className="n" title="Baseline quant percentile">Quant</th>
                <th className="n" title="Mean sector-neutral z, momentum">Mom</th>
                <th className="n" title="Mean sector-neutral z, quality">Qual</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {top.map((n) => {
                const mom = n.groups?.momentum;
                const qual = n.groups?.quality;
                return (
                  <tr key={n.ticker}>
                    <td className="nw pl-3.5">
                      <TickerLink ticker={n.ticker} className="font-mono font-medium text-ink hover:text-accent">
                        {displayTicker(n.ticker)}
                      </TickerLink>
                    </td>
                    <td className="n">{typeof n.regimeFit === "number" ? (n.regimeFit / 100).toFixed(2) : "—"}</td>
                    <td className="n">{n.quant ?? "—"}</td>
                    <td className={`n ${mom != null && mom > 0 ? "text-pos" : mom != null && mom < 0 ? "text-neg" : ""}`}>{fmtZ(mom)}</td>
                    <td className="n">{fmtZ(qual)}</td>
                    <td className="pr-3 text-right">
                      {held(n.ticker) ? (
                        <span className="text-[12px] text-ink-faint">Tracked</span>
                      ) : (
                        <button
                          onClick={() => void promote(n)}
                          disabled={adding === n.ticker}
                          className="text-[12px] text-accent-ink hover:underline disabled:opacity-40"
                          title="Add to the Watchlist from Radar"
                        >
                          {adding === n.ticker ? "…" : "Suggest"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-auto flex h-8 items-center gap-2.5 border-t border-line-soft px-3.5 text-[11.5px] text-ink-3">
        {top.length > 0 && <span>Universe {universe || "—"} · you own {ownedCount} of these {top.length}</span>}
        {setupCount != null && (
          <Link href="/setups" className="!text-ink-3 hover:!text-ink">
            {top.length > 0 ? "· " : ""}{setupCount} setups coiled
          </Link>
        )}
        <Link href="/radar" className="ml-auto !text-accent-ink hover:underline">Open full screen</Link>
      </div>
    </section>
  );
}

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
      <ScreenPanel />
      <ReadyToActPanel pipeline={pipeline} />
    </div>
  );
}
