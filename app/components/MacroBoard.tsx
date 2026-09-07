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
 * Macro board — the Board tab of the Brief's bottom panel, to the canvas:
 * four bands (Breadth & trend · Valuation & growth · Rates & curve · Credit &
 * volatility) side by side, each a compact 3-column grid of label / value
 * cells. Band and horizon filters sit in a row above the grid; the LIVE
 * count and provenance go in the tab row (`macroStatus`).
 *
 * NO EMPTY TILES (Jordan's rule): a tile whose ForwardPoint has no value is
 * dropped entirely rather than rendered blank, and a band with no surviving
 * tiles disappears with it. Every metric here is one the app already fetches.
 */

type Band = "breadth" | "valuation" | "rates" | "credit";

const BAND_META: Record<Band, { label: string; blurb: string }> = {
  breadth:   { label: "Breadth & trend",     blurb: "SPX trajectory and how broadly the move participates" },
  valuation: { label: "Valuation & growth",  blurb: "SPY multiples and the growth priced in at today's level" },
  rates:     { label: "Rates & curve",       blurb: "Treasury yields and curve shape — the discount-rate backdrop" },
  credit:    { label: "Credit & volatility", blurb: "Where stress shows up before it hits price" },
};

type Horizon = "1–3M" | "3–6M" | "6–12M";

export type MacroTileSpec = {
  band: Band;
  label: string;
  point?: Pt | undefined;
  /** Which horizon this metric informs — shown as a small suffix. */
  horizon?: Horizon;
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

function isLive(p: Pt): boolean {
  return !p.status || p.status === "live" || p.status === "ok";
}

/** Every tile the board can show, with the valueless ones already dropped. */
export function buildMacroTiles(fwd: PointBag | null): MacroTileSpec[] {
  if (!fwd) return [];
  const t: MacroTileSpec[] = [
    // ── Breadth & trend ──
    { band: "breadth", label: "S&P 500 YTD", point: fwd.spxYtd, unit: "%", noDelta: true, horizon: "3–6M" },
    { band: "breadth", label: "S&P week", point: fwd.spxWeek, unit: "%", noDelta: true, horizon: "1–3M" },
    { band: "breadth", label: "> 200d wk", point: fwd.breadth200Wk, deltaAbs: true, horizon: "3–6M" },
    { band: "breadth", label: "> 200d mo", point: fwd.breadth200Mo, deltaAbs: true, horizon: "3–6M" },
    { band: "breadth", label: "> 50d wk", point: fwd.breadth50Wk, deltaAbs: true, horizon: "1–3M" },
    { band: "breadth", label: "Broad > 200 wk", point: fwd.breadthBroad_200Wk, deltaAbs: true },
    { band: "breadth", label: "Broad > 200 mo", point: fwd.breadthBroad_200Mo, deltaAbs: true },
    { band: "breadth", label: "Broad > 50 wk", point: fwd.breadthBroad_50Wk, deltaAbs: true },
    { band: "breadth", label: "NYSE new highs", point: fwd.newHighsWk, dp: 0, deltaAbs: true },
    { band: "breadth", label: "NYSE new lows", point: fwd.newLowsWk, dp: 0, deltaAbs: true, inverse: true },
    { band: "breadth", label: "NYSE up vol", point: fwd.upVolumePct, unit: "%", deltaAbs: true },
    // ── Valuation & growth ──
    { band: "valuation", label: "SPY fwd P/E", point: fwd.spyForwardPE, inverse: true, horizon: "6–12M" },
    { band: "valuation", label: "SPY trail P/E", point: fwd.spyTrailingPE, inverse: true, horizon: "6–12M" },
    { band: "valuation", label: "Implied 1Y EPS", point: fwd.impliedEpsGrowth, unit: "%", horizon: "3–6M" },
    { band: "valuation", label: "Est 3-5Y EPS", point: fwd.eps35Growth, unit: "%", horizon: "6–12M" },
    // ── Rates & curve ──
    { band: "rates", label: "10Y", point: fwd.yield10y, dp: 2, deltaAbs: false },
    { band: "rates", label: "2Y", point: fwd.yield2y, dp: 2 },
    { band: "rates", label: "3M bill", point: fwd.yield3m, dp: 2 },
    { band: "rates", label: "2s10s", point: fwd.curve10y2y, dp: 0, unit: "bp" },
    { band: "rates", label: "3m10s", point: fwd.curve10y3m, dp: 0, unit: "bp" },
    // ── Credit & volatility ──
    { band: "credit", label: "HY OAS", point: fwd.hyOasTrend, dp: 0, inverse: true, deltaAbs: true },
    { band: "credit", label: "IG OAS", point: fwd.igOasTrend, dp: 0, inverse: true, deltaAbs: true },
    { band: "credit", label: "VIX", point: fwd.vixWeek, inverse: true },
    { band: "credit", label: "MOVE", point: fwd.moveWeek, inverse: true },
  ];
  return t.filter((x) => x.point && x.point.value != null);
}

/** "LIVE · 24 of 24 · FRED + Yahoo · 6:40" for the tab row. */
export function macroStatus(tiles: MacroTileSpec[], asOf?: string, fredEnabled?: boolean): string | null {
  if (tiles.length === 0) return null;
  const live = tiles.filter((t) => t.point && isLive(t.point)).length;
  const time = asOf ? new Date(asOf).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : null;
  return [live === tiles.length ? "LIVE" : "STALE", `${live} of ${tiles.length}`, fredEnabled === false ? "Yahoo" : "FRED + Yahoo", time]
    .filter(Boolean)
    .join(" · ");
}

/** Hairlines between band cells: stacked → a rule under each; 2-up at md
 *  (when all four show) → rules under the top pair and right of the odd
 *  cells; 4-up at xl → rules to the right only. */
function cellBorder(i: number, n: number): string {
  const last = i === n - 1;
  const out: string[] = [last ? "" : "border-b"];
  if (n >= 4) {
    out.push(i >= 2 ? "md:border-b-0" : "md:border-b", i % 2 === 0 ? "md:border-r" : "md:border-r-0");
    out.push("xl:border-b-0", last ? "xl:border-r-0" : "xl:border-r");
  } else if (n > 1) {
    out.push("md:border-b-0", last ? "" : "md:border-r");
  }
  return out.filter(Boolean).join(" ");
}

function Tile({ spec }: { spec: MacroTileSpec }) {
  const p = spec.point;
  if (!p || p.value == null) return null; // no blank tiles
  const dp = spec.dp ?? 1;
  const prev = p.previous;
  const delta = spec.noDelta || prev == null || !isFinite(prev) ? null : p.value - prev;
  const deltaPct = delta != null && prev ? (delta / Math.abs(prev)) * 100 : null;
  const good = delta == null ? null : spec.inverse ? delta < 0 : delta > 0;
  const live = isLive(p);
  const tone = good == null ? "text-ink" : good ? "text-pos" : "text-neg";
  const title = [
    p.sourceLabel,
    p.asOf,
    live ? "live" : `${p.status} — the source may not have refreshed`,
    spec.horizon ? `informs the ${spec.horizon} horizon` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const label = (
    <>
      {spec.label}
      {spec.horizon && <span className="ml-1 text-ink-faint">{spec.horizon}</span>}
    </>
  );
  return (
    <div className="min-w-0" title={title}>
      <div className={`flex items-center gap-1 whitespace-nowrap text-[10.5px] ${live ? "text-ink-3" : "text-warn"}`}>
        {!live && <span className="dot bg-warn" />}
        {p.source ? (
          <a href={p.source} target="_blank" rel="noopener noreferrer" className="truncate hover:text-accent" title={`Verify at ${p.sourceLabel ?? "source"}`}>
            {label}
          </a>
        ) : (
          <span className="truncate">{label}</span>
        )}
      </div>
      <div className={`flex items-baseline gap-1 font-mono text-[12.5px] font-medium tabular-nums ${tone}`}>
        {fmtNum(p.value, dp)}
        {spec.unit && <span className="text-[10.5px] font-normal text-ink-3">{spec.unit}</span>}
        {delta != null && (
          <span className="text-[10.5px] font-normal">
            {delta > 0 ? "+" : "−"}
            {spec.deltaAbs ? fmtNum(Math.abs(delta), 0) : `${fmtNum(Math.abs(deltaPct ?? delta), 1)}${deltaPct != null ? "%" : ""}`}
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
  regime,
}: {
  fwd: PointBag | null;
  termStructure?: string;
  vvix?: number | null;
  /** Live regime blob, for the cross-asset line under the grid. */
  regime?: { crossAsset?: { dxy?: unknown; oil?: unknown }; global?: { stoxx?: unknown; nikkei?: unknown } } | null;
}) {
  // Filters are a view of the same data, not a fold — transient by design.
  const [band, setBand] = useState<Band | "all">("all");
  const [horizon, setHorizon] = useState<"all" | Horizon>("all");

  const tiles = useMemo(() => buildMacroTiles(fwd), [fwd]);

  // The headline reads. Each is sourced from a value already on the board (or
  // the regime blob) — nothing here is a separate fetch. Missing inputs drop.
  const summary = useMemo(() => {
    const out: { label: string; value: string; note?: string; tone: "pos" | "neg" | "flat" }[] = [];
    const pick = (label: string) => tiles.find((t) => t.label === label)?.point;
    const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);

    const hy = pick("HY OAS");
    if (hy && num(hy.value) != null) {
      const hprev = num(hy.previous ?? null); const d = hprev == null ? null : num(hy.value)! - hprev;
      out.push({ label: "Credit", value: `${Math.round(num(hy.value)!)}bp`, note: d == null ? undefined : d < 0 ? "tightening" : "widening", tone: d == null ? "flat" : d < 0 ? "pos" : "neg" });
    }
    const vix = pick("VIX");
    if (vix && num(vix.value) != null) {
      out.push({ label: "Vol", value: `VIX ${num(vix.value)!.toFixed(1)}`, note: termStructure || undefined, tone: num(vix.value)! >= 25 ? "neg" : num(vix.value)! <= 18 ? "pos" : "flat" });
    }
    const br = pick("> 50d wk");
    if (br && num(br.value) != null) {
      const bprev = num(br.previous ?? null); const d = bprev == null ? null : num(br.value)! - bprev;
      out.push({ label: "Breadth", value: `${num(br.value)!.toFixed(0)}% > 50d`, note: d == null ? undefined : `${d > 0 ? "+" : ""}${d.toFixed(1)}pp`, tone: d == null ? "flat" : d < 0 ? "neg" : "pos" });
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

  if (!fwd || tiles.length === 0) {
    return <p className="px-3.5 py-5 text-center text-[12px] text-ink-3">No macro data yet — the forward-looking fetch fills the board.</p>;
  }
  const bands: Band[] = ["breadth", "valuation", "rates", "credit"];
  // Tiles with no horizon tag are kept under "all" only — filtering to a
  // horizon should show what informs THAT horizon, not everything plus noise.
  const shown = horizon === "all" ? tiles : tiles.filter((t) => t.horizon === horizon);
  const visible = bands.filter((b) => (band === "all" || band === b) && shown.some((t) => t.band === b));
  const colCls =
    visible.length >= 4 ? "md:grid-cols-2 xl:grid-cols-4"
    : visible.length === 3 ? "md:grid-cols-3"
    : visible.length === 2 ? "md:grid-cols-2"
    : "";

  return (
    <div>
      {/* Filters: band seg · horizon seg */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3.5 py-2">
        <div className="seg">
          {([["all", "All"], ["breadth", "Breadth"], ["valuation", "Valuation"], ["rates", "Rates"], ["credit", "Credit & vol"]] as [Band | "all", string][])
            .filter(([k]) => k === "all" || tiles.some((t) => t.band === k))
            .map(([k, lbl]) => (
              <button key={k} type="button" className={band === k ? "on" : ""} onClick={() => setBand(k)}>
                {lbl}
                {k === "all" && <span className="c">{tiles.length}</span>}
              </button>
            ))}
        </div>
        <span className="ml-1 text-[11px] text-ink-3">horizon</span>
        <div className="seg">
          <button type="button" className={horizon === "all" ? "on" : ""} onClick={() => setHorizon("all")}>
            Any
          </button>
          {(["1–3M", "3–6M", "6–12M"] as const)
            .filter((h) => tiles.some((t) => t.horizon === h))
            .map((h) => (
              <button key={h} type="button" className={horizon === h ? "on" : ""} onClick={() => setHorizon(h)}>
                {h}
              </button>
            ))}
        </div>
      </div>

      {/* Four bands across, compact 3-col cells inside each. */}
      {visible.length === 0 ? (
        <p className="px-3.5 py-5 text-center text-[12px] text-ink-3">Nothing on the board informs that horizon.</p>
      ) : (
        <div className={`grid grid-cols-1 ${colCls}`}>
          {visible.map((b, i) => {
            const rows = shown.filter((t) => t.band === b);
            return (
              <div key={b} className={`min-w-0 border-line-soft px-3.5 pb-3 pt-2.5 ${cellBorder(i, visible.length)}`}>
                <div className="mb-2 text-[11px] text-ink-3" title={BAND_META[b].blurb}>
                  {BAND_META[b].label}
                </div>
                <div className="grid grid-cols-3 gap-x-2.5 gap-y-2">
                  {rows.map((t) => <Tile key={`${t.band}-${t.label}`} spec={t} />)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* The headline reads + the values that aren't ForwardPoints but belong
          on the board (term structure, VVIX, cross-asset). */}
      {(summary.length > 0 || termStructure) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line-soft px-3.5 py-2 text-[11.5px] text-ink-2">
          {summary.map((c) => (
            <span key={c.label} className="inline-flex items-baseline gap-1">
              <span className="text-ink-3">{c.label}</span>
              <span className={`font-mono ${c.tone === "pos" ? "text-pos" : c.tone === "neg" ? "text-neg" : "text-ink"}`}>{c.value}</span>
              {c.note && <span className="text-ink-3">{c.note}</span>}
            </span>
          ))}
          {termStructure && !summary.some((c) => c.label === "Vol") && (
            <span className="inline-flex items-baseline gap-1">
              <span className="text-ink-3">Term structure</span>
              <span className="text-ink">{termStructure}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
