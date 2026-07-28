"use client";

import React, { useMemo, useState } from "react";


/** Structural shape: the Brief passes a ForwardLookingBundle whose members are
 *  optional, so accept any object of optional points rather than tying this
 *  component to one concrete type. */
type Pt = {
  value: number | null;
  previous?: number | null;
  status?: string;
  asOf?: string;
  source?: string;       // verify URL
  sourceLabel?: string;  // e.g. "FRED SP500", "manual entry"
};
type PointBag = Partial<Record<string, Pt | undefined>>;

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
  point?: Pt | undefined;
  /** Which horizon this metric informs — shown as a small chip. */
  horizon?: "1–3M" | "3–6M" | "6–12M";
  /** Unit suffix shown small beside the value. */
  unit?: string;
  /** Decimal places; default 1. */
  dp?: number;
  /** When true a RISE is bad (spreads, vol) so the delta colours invert. */
  inverse?: boolean;
  /** Render the delta as absolute bps/pts rather than a percentage. */
  deltaAbs?: boolean;
  /** Suppress the delta entirely. Needed where `previous` is NOT a prior
   *  reading of `value` but a baseline of a different kind — e.g. spxYtd's
   *  value is a percent while its previous is the index close it is measured
   *  from, so any arithmetic between the two is meaningless. */
  noDelta?: boolean;
};

const fmtNum = (v: number, dp: number) =>
  v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

function Tile({ spec }: { spec: TileSpec }) {
  const p = spec.point;
  if (!p || p.value == null) return null; // no blank tiles
  const dp = spec.dp ?? 1;
  const prev = p.previous;
  const delta = spec.noDelta || prev == null || !isFinite(prev) ? null : p.value - prev;
  const deltaPct = delta != null && prev ? (delta / Math.abs(prev)) * 100 : null;
  const good = delta == null ? null : spec.inverse ? delta < 0 : delta > 0;
  const stale = p.status === "stale";

  const ok = !p.status || p.status === "live" || p.status === "ok";
  const horizonTone =
    spec.horizon === "1–3M" ? "bg-accent-soft text-accent"
    : spec.horizon === "3–6M" ? "bg-pos-soft text-pos"
    : "bg-violet-soft text-violet";

  return (
    <div className="group border-b border-r border-line bg-white px-3 py-2.5 transition-colors last:border-r-0 hover:bg-surface-2">
      <div className="flex items-center gap-1.5">
        <span className="truncate text-[10px] font-semibold uppercase tracking-[0.05em] text-ink-3">
          {spec.label}
        </span>
        {spec.horizon && (
          <span className={`shrink-0 rounded-pill px-1 py-px text-[8px] font-semibold ${horizonTone}`}>
            {spec.horizon}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {/* Status: LIVE when fetched cleanly, STALE otherwise — kept from the
              old panel because knowing a number is old matters more than the
              number itself. */}
          <span
            title={p.sourceLabel ? `${p.sourceLabel}${p.asOf ? ` · ${p.asOf}` : ""}` : undefined}
            className={`rounded px-1 text-[8px] font-bold uppercase ${ok ? "bg-pos-soft text-pos" : "bg-warn-soft text-warn"}`}
          >
            {ok ? "live" : "stale"}
          </span>
          {p.source && (
            <a
              href={p.source}
              target="_blank"
              rel="noopener noreferrer"
              title={`Verify at ${p.sourceLabel ?? "source"}`}
              className="text-ink-faint opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
            >
              <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
            </a>
          )}
        </span>
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
      {p.sourceLabel && (
        <div className="mt-0.5 truncate text-[9px] text-ink-faint">{p.sourceLabel}</div>
      )}
    </div>
  );
}

export function MacroBoard({
  fwd,
  termStructure,
  vvix,
  asOf,
  regime,
}: {
  fwd: PointBag | null;
  termStructure?: string;
  vvix?: number | null;
  asOf?: string;
  /** Live regime blob, for the cross-asset chips in the summary strip. */
  regime?: { crossAsset?: { dxy?: unknown; oil?: unknown }; global?: { stoxx?: unknown; nikkei?: unknown } } | null;
}) {
  const [band, setBand] = useState<Band | "all">("all");
  const [horizon, setHorizon] = useState<"all" | "1–3M" | "3–6M" | "6–12M">("all");

  const tiles: TileSpec[] = useMemo(() => {
    if (!fwd) return [];
    const t: TileSpec[] = [
      // ── Breadth & Trend ──
      { band: "breadth", label: "S&P 500 YTD", point: fwd.spxYtd, unit: "%", noDelta: true, horizon: "3–6M" },
      { band: "breadth", label: "S&P Week", point: fwd.spxWeek, unit: "%", noDelta: true, horizon: "1–3M" },
      { band: "breadth", label: ">200DMA wk", point: fwd.breadth200Wk, deltaAbs: true, horizon: "3–6M" },
      { band: "breadth", label: ">200DMA mo", point: fwd.breadth200Mo, deltaAbs: true, horizon: "3–6M" },
      { band: "breadth", label: ">50DMA wk", point: fwd.breadth50Wk, deltaAbs: true, horizon: "1–3M" },
      { band: "breadth", label: "Broad >200 wk", point: fwd.breadthBroad_200Wk, deltaAbs: true },
      { band: "breadth", label: "Broad >200 mo", point: fwd.breadthBroad_200Mo, deltaAbs: true },
      { band: "breadth", label: "Broad >50 wk", point: fwd.breadthBroad_50Wk, deltaAbs: true },
      { band: "breadth", label: "NYSE new highs", point: fwd.newHighsWk, dp: 0, deltaAbs: true },
      { band: "breadth", label: "NYSE new lows", point: fwd.newLowsWk, dp: 0, deltaAbs: true, inverse: true },
      { band: "breadth", label: "NYSE up vol", point: fwd.upVolumePct, unit: "%", deltaAbs: true },
      // ── Valuation & Growth ──
      { band: "valuation", label: "SPY fwd P/E", point: fwd.spyForwardPE, inverse: true, horizon: "6–12M" },
      { band: "valuation", label: "SPY trail P/E", point: fwd.spyTrailingPE, inverse: true, horizon: "6–12M" },
      { band: "valuation", label: "Implied 1Y EPS", point: fwd.impliedEpsGrowth, unit: "%", horizon: "3–6M" },
      { band: "valuation", label: "Est 3-5Y EPS", point: fwd.eps35Growth, unit: "%", horizon: "6–12M" },
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

  // Headline chips. Each is sourced from a value already on the board (or the
  // regime blob) — nothing here is a separate fetch or a restatement dressed up
  // as new information. Missing inputs drop their chip.
  const summaryChips = useMemo(() => {
    const out: { label: string; value: string; note?: string; tone: "pos" | "neg" | "flat" }[] = [];
    const pick = (label: string) => tiles.find((t) => t.label === label)?.point;
    const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);

    const hy = pick("HY OAS");
    if (hy && num(hy.value) != null) {
      const hprev = num(hy.previous ?? null); const d = hprev == null ? null : num(hy.value)! - hprev;
      out.push({ label: "Credit", value: `${Math.round(num(hy.value)!)}bps`, note: d == null ? undefined : d < 0 ? "tightening" : "widening", tone: d == null ? "flat" : d < 0 ? "pos" : "neg" });
    }
    const vix = pick("VIX");
    if (vix && num(vix.value) != null) {
      out.push({ label: "Vol", value: `VIX ${num(vix.value)!.toFixed(1)}`, note: termStructure || undefined, tone: num(vix.value)! >= 25 ? "neg" : num(vix.value)! <= 18 ? "pos" : "flat" });
    }
    const br = pick(">50DMA wk");
    if (br && num(br.value) != null) {
      const bprev = num(br.previous ?? null); const d = bprev == null ? null : num(br.value)! - bprev;
      out.push({ label: "Breadth", value: `${num(br.value)!.toFixed(0)}% >50DMA`, note: d == null ? undefined : `${d > 0 ? "+" : ""}${d.toFixed(1)}pp`, tone: d == null ? "flat" : d < 0 ? "neg" : "pos" });
    }
    if (vvix != null) out.push({ label: "VVIX", value: String(vvix), tone: "flat" });

    // Cross-asset, straight off the regime blob.
    const ca = (regime?.crossAsset ?? {}) as Record<string, { price?: number; change20dPct?: number | null } | null>;
    const gl = (regime?.global ?? {}) as Record<string, { price?: number; change20dPct?: number | null } | null>;
    const xa: [string, { price?: number; change20dPct?: number | null } | null | undefined, number][] = [
      ["DXY", ca.dxy, 2], ["WTI", ca.oil, 2], ["STOXX", gl.stoxx, 0], ["Nikkei", gl.nikkei, 0],
    ];
    for (const [label, r, dp] of xa) {
      const px = num(r?.price);
      if (px == null) continue;
      const ch = num(r?.change20dPct ?? null);
      out.push({
        label,
        value: px.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }),
        note: ch == null ? "flat" : `${ch > 0 ? "+" : ""}${ch.toFixed(1)}% 20d`,
        tone: ch == null ? "flat" : ch > 0 ? "pos" : "neg",
      });
    }
    return out;
  }, [tiles, termStructure, vvix, regime]);

  if (!fwd || tiles.length === 0) return null;
  const bands: Band[] = ["breadth", "valuation", "rates", "credit"];
  // Horizon filter, as the design shows beside the provenance. Tiles with no
  // horizon tag are kept under "all" only — filtering to a horizon should show
  // what informs THAT horizon, not everything plus untagged noise.
  const shown = horizon === "all" ? tiles : tiles.filter((t) => t.horizon === horizon);
  const visible = bands.filter((b) => (band === "all" || band === b) && shown.some((t) => t.band === b));
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
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[10px] text-ink-faint">horizon</span>
          {(["1–3M", "3–6M", "6–12M"] as const)
            .filter((h) => tiles.some((t) => t.horizon === h))
            .map((h) => (
              <button
                key={h}
                onClick={() => setHorizon(horizon === h ? "all" : h)}
                className={`rounded-pill px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
                  horizon === h
                    ? h === "1–3M" ? "bg-accent-soft text-accent"
                      : h === "3–6M" ? "bg-pos-soft text-pos"
                      : "bg-violet-soft text-violet"
                    : "text-ink-3 hover:text-ink"
                }`}
              >
                {h}
              </button>
            ))}
          <span className="ml-1.5 text-[10px] text-ink-faint">
            FRED + Yahoo{time ? ` · ${time}` : ""}
          </span>
        </div>
      </div>

      {/* Summary strip — the headline read above the detail, as the design
          shows. Every chip is a real value already on the board or in the
          regime blob; chips whose data is missing are dropped rather than
          rendered blank. */}
      {summaryChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-white px-3 py-2">
          {summaryChips.map((c) => (
            <span
              key={c.label}
              className={`rounded-pill border px-2 py-0.5 text-[11px] ${
                c.tone === "pos" ? "border-pos-border bg-pos-soft text-pos"
                : c.tone === "neg" ? "border-neg-border bg-neg-soft text-neg"
                : "border-line bg-surface-2 text-ink-2"
              }`}
            >
              <span className="font-semibold">{c.label}</span>{" "}
              <span className="font-mono">{c.value}</span>
              {c.note ? <span className="ml-1 opacity-80">{c.note}</span> : null}
            </span>
          ))}
        </div>
      )}

      {visible.map((b) => {
        const rows = shown.filter((t) => t.band === b);
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
