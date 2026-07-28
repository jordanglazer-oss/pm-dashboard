"use client";

import React, { useMemo, useState } from "react";


/** Structural shape: the Brief passes a ForwardLookingBundle whose members are
 *  optional, so accept any object of optional points rather than tying this
 *  component to one concrete type. */
type PointBag = Partial<Record<string, { value: number | null; previous?: number | null; status?: string; asOf?: string } | undefined>>;

/**
 * Macro Board — the dense metric grid from the "sticky command bar" redesign.
 *
 * Four labeled bands (Breadth & Trend · Valuation & Growth · Rates & Curve ·
 * Credit & Volatility), six tiles per row, with group filter pills above.
 * Replaces three loosely-packed cards that showed a handful of the same
 * numbers.
 *
 * NO EMPTY TILES (Jordan's rule): a tile whose ForwardPoint has no value is
 * dropped entirely rather than rendered blank, and a band with no surviving
 * tiles disappears with it. Every metric here is one the app already fetches.
 */

type Band = "breadth" | "valuation" | "rates" | "credit";

const BAND_META: Record<Band, { label: string; blurb: string; dot: string }> = {
  breadth:   { label: "Breadth & Trend",     blurb: "SPX trajectory and how broadly the move participates", dot: "bg-accent" },
  valuation: { label: "Valuation & Growth",  blurb: "SPY multiples and the growth priced in at today's level", dot: "bg-pos" },
  rates:     { label: "Rates & Curve",       blurb: "Treasury yields and curve shape — the discount-rate backdrop", dot: "bg-warn" },
  credit:    { label: "Credit & Volatility", blurb: "Where stress shows up before it hits price", dot: "bg-neg" },
};

type TileSpec = {
  band: Band;
  label: string;
  point?: { value: number | null; previous?: number | null; status?: string } | undefined;
  /** Unit suffix shown small beside the value. */
  unit?: string;
  /** Decimal places; default 1. */
  dp?: number;
  /** When true a RISE is bad (spreads, vol) so the delta colours invert. */
  inverse?: boolean;
  /** Render the delta as absolute bps/pts rather than a percentage. */
  deltaAbs?: boolean;
};

const fmtNum = (v: number, dp: number) =>
  v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

function Tile({ spec }: { spec: TileSpec }) {
  const p = spec.point;
  if (!p || p.value == null) return null; // no blank tiles
  const dp = spec.dp ?? 1;
  const prev = p.previous;
  const delta = prev != null && isFinite(prev) ? p.value - prev : null;
  const deltaPct = delta != null && prev ? (delta / Math.abs(prev)) * 100 : null;
  const good = delta == null ? null : spec.inverse ? delta < 0 : delta > 0;
  const stale = p.status === "stale";

  return (
    <div className="tile-hover border-b border-r border-line bg-white px-3 py-2.5 last:border-r-0">
      <div className="flex items-center gap-1.5">
        <span className="truncate text-[10px] font-semibold uppercase tracking-[0.05em] text-ink-3">
          {spec.label}
        </span>
        {stale && (
          <span className="rounded bg-warn-soft px-1 text-[9px] font-bold uppercase text-warn">stale</span>
        )}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="font-mono text-[19px] font-semibold tracking-[-0.02em] text-ink">
          {fmtNum(p.value, dp)}
        </span>
        {spec.unit && <span className="text-[11px] text-ink-3">{spec.unit}</span>}
        {delta != null && (
          <span className={`font-mono text-[11px] font-semibold ${good ? "text-pos" : "text-neg"}`}>
            {delta > 0 ? "+" : "−"}
            {spec.deltaAbs
              ? fmtNum(Math.abs(delta), 0)
              : `${fmtNum(Math.abs(deltaPct ?? delta), 1)}${deltaPct != null ? "%" : ""}`}
          </span>
        )}
      </div>
    </div>
  );
}

export function MacroBoard({
  fwd,
  termStructure,
  vvix,
  asOf,
}: {
  fwd: PointBag | null;
  termStructure?: string;
  vvix?: number | null;
  asOf?: string;
}) {
  const [band, setBand] = useState<Band | "all">("all");

  const tiles: TileSpec[] = useMemo(() => {
    if (!fwd) return [];
    const t: TileSpec[] = [
      // ── Breadth & Trend ──
      { band: "breadth", label: "S&P 500 YTD", point: fwd.spxYtd, unit: "%" },
      { band: "breadth", label: "S&P Week", point: fwd.spxWeek, unit: "%" },
      { band: "breadth", label: ">200DMA wk", point: fwd.breadth200Wk, deltaAbs: true },
      { band: "breadth", label: ">200DMA mo", point: fwd.breadth200Mo, deltaAbs: true },
      { band: "breadth", label: ">50DMA wk", point: fwd.breadth50Wk, deltaAbs: true },
      { band: "breadth", label: "Broad >200 wk", point: fwd.breadthBroad_200Wk, deltaAbs: true },
      { band: "breadth", label: "Broad >200 mo", point: fwd.breadthBroad_200Mo, deltaAbs: true },
      { band: "breadth", label: "Broad >50 wk", point: fwd.breadthBroad_50Wk, deltaAbs: true },
      { band: "breadth", label: "NYSE new highs", point: fwd.newHighsWk, dp: 0, deltaAbs: true },
      { band: "breadth", label: "NYSE new lows", point: fwd.newLowsWk, dp: 0, deltaAbs: true, inverse: true },
      { band: "breadth", label: "NYSE up vol", point: fwd.upVolumePct, unit: "%" },
      // ── Valuation & Growth ──
      { band: "valuation", label: "SPY fwd P/E", point: fwd.spyForwardPE, inverse: true },
      { band: "valuation", label: "SPY trail P/E", point: fwd.spyTrailingPE, inverse: true },
      { band: "valuation", label: "Implied 1Y EPS", point: fwd.impliedEpsGrowth, unit: "%" },
      { band: "valuation", label: "Est 3-5Y EPS", point: fwd.eps35Growth, unit: "%" },
      // ── Rates & Curve ──
      { band: "rates", label: "10Y Treasury", point: fwd.yield10y, dp: 2, deltaAbs: false },
      { band: "rates", label: "2Y Treasury", point: fwd.yield2y, dp: 2 },
      { band: "rates", label: "3M T-Bill", point: fwd.yield3m, dp: 2 },
      { band: "rates", label: "10Y−2Y", point: fwd.curve10y2y, dp: 0, unit: "bps" },
      { band: "rates", label: "10Y−3M", point: fwd.curve10y3m, dp: 0, unit: "bps" },
      // ── Credit & Volatility ──
      { band: "credit", label: "HY OAS", point: fwd.hyOasTrend, dp: 0, inverse: true, deltaAbs: true },
      { band: "credit", label: "IG OAS", point: fwd.igOasTrend, dp: 0, inverse: true, deltaAbs: true },
      { band: "credit", label: "VIX", point: fwd.vixWeek, inverse: true },
      { band: "credit", label: "MOVE", point: fwd.moveWeek, inverse: true },
    ];
    return t.filter((x) => x.point && x.point.value != null);
  }, [fwd]);

  if (!fwd || tiles.length === 0) return null;

  const bands: Band[] = ["breadth", "valuation", "rates", "credit"];
  const visible = bands.filter((b) => (band === "all" || band === b) && tiles.some((t) => t.band === b));
  const time = asOf ? new Date(asOf).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : null;

  return (
    <section className="overflow-hidden rounded-card border border-line bg-surface-2 shadow-sm">
      {/* Filter pills + provenance */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-white px-3 py-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.22em] text-ink-3">Macro board</span>
        <div className="inline-flex items-center gap-0.5 rounded-control border border-line bg-surface-2 p-0.5">
          {([["all", `All ${tiles.length}`], ["breadth", "Breadth"], ["valuation", "Valuation"], ["rates", "Rates"], ["credit", "Credit & Vol"]] as [Band | "all", string][])
            .filter(([k]) => k === "all" || tiles.some((t) => t.band === k))
            .map(([k, lbl]) => (
              <button
                key={k}
                onClick={() => setBand(k)}
                className={`rounded-[6px] px-2.5 py-1 text-xs font-medium transition-colors ${
                  band === k ? "bg-white text-ink shadow-sm" : "text-ink-2 hover:text-ink"
                }`}
              >
                {lbl}
              </button>
            ))}
        </div>
        <span className="ml-auto text-[10px] text-ink-faint">
          FRED + Yahoo{time ? ` · ${time}` : ""}
        </span>
      </div>

      {visible.map((b) => {
        const rows = tiles.filter((t) => t.band === b);
        return (
          <div key={b}>
            <div className="flex items-baseline gap-2 border-b border-line bg-white px-3 py-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${BAND_META[b].dot}`} />
              <span className="text-[11px] font-semibold text-ink">{BAND_META[b].label}</span>
              <span className="truncate text-[10px] text-ink-faint">{BAND_META[b].blurb}</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
              {rows.map((t) => <Tile key={`${t.band}-${t.label}`} spec={t} />)}
            </div>
          </div>
        );
      })}

      {/* Values that aren't ForwardPoints but belong on the board. */}
      {(termStructure || vvix != null) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-white px-3 py-2 text-[11px]">
          {termStructure && (
            <span className="rounded-pill border border-line px-2 py-0.5 text-ink-2">
              Term structure <span className="font-semibold text-ink">{termStructure}</span>
            </span>
          )}
          {vvix != null && (
            <span className="rounded-pill border border-line px-2 py-0.5 text-ink-2">
              VVIX <span className="font-mono font-semibold text-ink">{vvix}</span>
            </span>
          )}
        </div>
      )}
    </section>
  );
}
