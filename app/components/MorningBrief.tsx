"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type {
  MarketData,
  MorningBrief as MorningBriefType,
  Stock,
  ScoredStock,
  ForwardLookingBundle,
  ForwardPointBundle,
} from "@/app/lib/types";
import { SignalPill } from "./SignalPill";
import { ClampText } from "./ClampText";
import { displayTicker } from "@/app/lib/ticker";
import { LoadingOverlay } from "./LoadingSpinner";
import { SentimentGauges } from "./SentimentGauges";
import { HedgingIndicator } from "./HedgingIndicator";
import { ImageUpload, LightboxModal, type BriefAttachment } from "./ImageUpload";
import type { MarketRegimeData, RegimeDirection } from "@/app/lib/market-regime";
import { HORIZONS } from "@/app/lib/horizons";

/** Numeric input with an inline save indicator.
 *  Value only persists when the user clicks the save icon (or presses Enter).
 *  Shows a subtle checkmark when saved, a blue save icon when dirty. */
function SaveableNumericInput({
  savedValue,
  onSave,
  className = "",
  inputClassName = "",
  placeholder,
  allowNegative = false,
}: {
  savedValue: number;
  onSave: (n: number) => void;
  className?: string;
  inputClassName?: string;
  placeholder?: string;
  allowNegative?: boolean;
}) {
  const [text, setText] = React.useState(String(savedValue));
  const parsed = parseFloat(text);
  const isValid = !isNaN(parsed);
  const isDirty = isValid && parsed !== savedValue;

  // Sync when savedValue changes externally (e.g. Redis load, live fetch)
  const prevSaved = React.useRef(savedValue);
  React.useEffect(() => {
    if (prevSaved.current !== savedValue) {
      setText(String(savedValue));
      prevSaved.current = savedValue;
    }
  }, [savedValue]);

  function handleSave() {
    if (isValid && isDirty) {
      onSave(parsed);
      prevSaved.current = parsed;
    }
  }

  return (
    <div className={`relative ${className}`}>
      <input
        type="text"
        inputMode={allowNegative ? "text" : "decimal"}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
        onBlur={handleSave}
        className={`${inputClassName} pr-8`}
      />
      <button
        onClick={handleSave}
        disabled={!isDirty}
        title={isDirty ? "Save changes" : "Saved"}
        className={`absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full transition-all ${
          isDirty
            ? "bg-accent text-white hover:bg-accent shadow-sm cursor-pointer"
            : "text-pos"
        }`}
      >
        {isDirty ? (
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
        ) : (
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
        )}
      </button>
    </div>
  );
}

/** Dropdown select with an inline save indicator. */
function SaveableSelect({
  savedValue,
  onSave,
  options,
  className = "",
  selectClassName = "",
}: {
  savedValue: string;
  onSave: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
  selectClassName?: string;
}) {
  const [value, setValue] = React.useState(savedValue);
  const isDirty = value !== savedValue;

  const prevSaved = React.useRef(savedValue);
  React.useEffect(() => {
    if (prevSaved.current !== savedValue) {
      setValue(savedValue);
      prevSaved.current = savedValue;
    }
  }, [savedValue]);

  return (
    <div className={`relative ${className}`}>
      <select
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={`${selectClassName} pr-9`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {isDirty && (
        <button
          onClick={() => onSave(value)}
          title="Save changes"
          className="absolute right-7 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-accent text-white hover:bg-accent shadow-sm cursor-pointer transition-all"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
        </button>
      )}
    </div>
  );
}

/** Collapsible multi-line textarea with save-on-blur. Used for pasting
 *  strategist daily reports (Newton, Lee). The textarea auto-grows to fit
 *  its content and collapses to a single "Paste…" placeholder when empty. */
function SaveableTextarea({
  savedValue,
  onSave,
  placeholder = "Paste report text here…",
  label,
}: {
  savedValue: string;
  onSave: (v: string) => void;
  placeholder?: string;
  label: string;
}) {
  const [text, setText] = React.useState(savedValue);
  const [open, setOpen] = React.useState(!!savedValue);
  const isDirty = text !== savedValue;

  const prevSaved = React.useRef(savedValue);
  React.useEffect(() => {
    if (prevSaved.current !== savedValue) {
      setText(savedValue);
      prevSaved.current = savedValue;
      if (savedValue) setOpen(true);
    }
  }, [savedValue]);

  function handleSave() {
    if (isDirty) {
      onSave(text);
      prevSaved.current = text;
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full rounded-xl border border-dashed border-line bg-surface-2 px-3 py-2.5 text-left text-sm text-ink-3 hover:bg-white hover:border-line transition-all"
      >
        + Paste {label} report
      </button>
    );
  }

  const charCount = text.length;
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div className="relative">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={handleSave}
        placeholder={placeholder}
        rows={4}
        className="w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm leading-relaxed focus:bg-white focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all outline-none resize-y min-h-[80px] max-h-[300px]"
      />
      <div className="flex items-center justify-between mt-1">
        <span className="text-[10px] text-ink-3">
          {wordCount > 0 ? `${wordCount} words` : "empty"}
        </span>
        <div className="flex items-center gap-2">
          {isDirty && (
            <button
              onClick={handleSave}
              className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold text-white hover:bg-accent transition-all"
            >
              Save
            </button>
          )}
          {text && (
            <button
              onClick={() => {
                setText("");
                onSave("");
                setOpen(false);
              }}
              className="text-[10px] text-ink-3 hover:text-neg transition-colors"
              title="Clear report"
            >
              Clear
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Section wrapper for the Forward View macro-tile categories.
 * Provides a strong, unambiguous visual break between groups:
 *   - Colored left accent bar
 *   - Bold title + one-line subtitle
 *   - Divider between the header and the tile grid
 *   - Subtle panel tint so each bucket reads as its own card
 *
 * Keeps ForwardTile styling unchanged.
 */
/** One-click "information horizon" toggle for a strategist note. Cycles
 *  unset → Prior close → Pre-mkt on click. Module-scope so it isn't a
 *  render-defined component. */
function StrategistTimingToggle({
  value,
  onChange,
}: {
  value?: "prior-close" | "pre-market";
  onChange: (next: "prior-close" | "pre-market" | undefined) => void;
}) {
  const cycle: ("prior-close" | "pre-market" | undefined)[] = [undefined, "prior-close", "pre-market"];
  const idx = value == null ? 0 : Math.max(0, cycle.indexOf(value));
  const label = value === "prior-close" ? "Prior close" : value === "pre-market" ? "Pre-mkt" : "Timing?";
  const tone =
    value === "pre-market"
      ? "bg-pos-soft text-pos border-pos-border"
      : value === "prior-close"
        ? "bg-warn-soft text-warn border-warn-border"
        : "bg-surface-2 text-ink-3 border-line";
  return (
    <button
      type="button"
      onClick={() => onChange(cycle[(idx + 1) % cycle.length])}
      title="Information horizon of this note. Click to cycle: unset → Prior close (reflects yesterday's close, has NOT seen the overnight move) → Pre-mkt (published this morning, already digests the overnight tape). The Brief down-weights a prior-close read on a gap day and prefers the fresher horizon when notes conflict."
      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors hover:opacity-90 ${tone}`}
    >
      {label}
    </button>
  );
}

function BriefSection({
  title,
  subtitle,
  accent,
  children,
}: {
  title: string;
  subtitle: string;
  accent: "blue" | "emerald" | "amber" | "rose";
  children: React.ReactNode;
}) {
  const dotMap: Record<typeof accent, string> = {
    blue: "bg-accent",
    emerald: "bg-pos",
    amber: "bg-warn",
    rose: "bg-neg",
  };
  return (
    <section className="rounded-2xl border border-line bg-white shadow-sm overflow-hidden">
      <header className="flex items-baseline gap-2 px-4 pt-3 pb-2">
        <span className={`inline-block h-2 w-2 rounded-full ${dotMap[accent]}`} />
        <h3 className="text-sm font-bold tracking-tight text-ink">{title}</h3>
        <span className="text-xs text-ink-3 truncate">· {subtitle}</span>
      </header>
      <div className="border-t border-line-soft px-4 py-3">{children}</div>
    </section>
  );
}

/** Composite pill tone helper for the Market Regime strip. */
function regimePillClasses(direction: RegimeDirection): string {
  if (direction === "risk-on") return "border-pos-border bg-pos-soft text-pos";
  if (direction === "risk-off") return "border-neg-border bg-neg-soft text-neg";
  return "border-line bg-surface-2 text-ink-2";
}

/** Format a signed pct number as "+X.X%" / "-X.X%" (or "—" when null). */
function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

/**
 * Compact Market Regime strip shown above the forward-looking tile grid.
 * Driven entirely by pm:market-regime (Yahoo-derived, deterministic).
 * Composite label on the left, individual signal pills in the middle,
 * cross-asset + global spot/20d moves on the bottom row.
 */
function MarketRegimeStrip({ regime }: { regime: MarketRegimeData }) {
  const comp = regime.composite;
  const label = comp.label;
  const labelTone: "green" | "red" | "amber" =
    label === "Risk-On" ? "green" : label === "Risk-Off" ? "red" : "amber";
  const cross = regime.crossAsset;
  const global = regime.global;
  const crossRow: { label: string; body: string }[] = [];
  if (cross.dxy) crossRow.push({ label: "DXY", body: `${cross.dxy.price.toFixed(2)} · 20d ${fmtPct(cross.dxy.change20dPct)}` });
  if (cross.tnx) crossRow.push({ label: "10Y", body: `${cross.tnx.price.toFixed(2)}% · 20d ${fmtPct(cross.tnx.change20dPct)}` });
  if (cross.oil) crossRow.push({ label: "WTI", body: `$${cross.oil.price.toFixed(2)} · 20d ${fmtPct(cross.oil.change20dPct)}` });
  if (global.stoxx) crossRow.push({ label: "STOXX", body: `${global.stoxx.price.toFixed(0)} · 20d ${fmtPct(global.stoxx.change20dPct)}` });
  if (global.nikkei) crossRow.push({ label: "Nikkei", body: `${global.nikkei.price.toFixed(0)} · 20d ${fmtPct(global.nikkei.change20dPct)}` });

  return (
    <div className="mb-5 overflow-hidden rounded-2xl border border-line bg-white/80 p-3 sm:p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2 sm:gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-ink-3">Market Regime</span>
          <SignalPill tone={labelTone}>{label}</SignalPill>
          <span className="text-xs text-ink-3">
            {comp.score}/{comp.total} risk-on signals
          </span>
        </div>
        <span
          className="text-[10px] text-ink-3"
          title={`Computed from Yahoo Finance at ${regime.computedAt}`}
        >
          Yahoo-derived · cached 30m
        </span>
      </div>

      {comp.signals.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1 sm:gap-1.5">
          {comp.signals.map((s, i) => (
            <span
              key={i}
              className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] sm:gap-1.5 sm:px-2.5 sm:py-1 sm:text-[11px] ${regimePillClasses(s.direction)}`}
              title={s.detail}
            >
              <span className="truncate font-semibold">{s.name}</span>
              <span className="truncate opacity-70">· {s.detail}</span>
            </span>
          ))}
        </div>
      )}

      {/* Horizon-projected composites (1-3M / 3-6M / 6-12M, weighted 50/30/20).
          Renders only when the cached blob has the new `horizons` field; older
          snapshots silently skip and the rest of the strip is unaffected. */}
      {regime.horizons && (
        <div className="mb-3 border-t border-line-soft pt-2">
          <div className="flex flex-wrap items-center gap-1 sm:gap-1.5">
            <span className="mr-1 text-[10px] font-bold uppercase tracking-wider text-ink-3">By Horizon</span>
            {HORIZONS.map((h) => {
              const b = regime.horizons!.byHorizon[h.id];
              const empty = b.total === 0;
              const tone: "green" | "red" | "amber" = empty
                ? "amber"
                : b.label_ === "Risk-On" ? "green" : b.label_ === "Risk-Off" ? "red" : "amber";
              return (
                <span
                  key={h.id}
                  className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] sm:gap-1.5 sm:px-2.5 sm:py-1 sm:text-[11px] ${
                    empty ? "border-line bg-surface-2 text-ink-3" : regimePillClasses(
                      tone === "green" ? "risk-on" : tone === "red" ? "risk-off" : "neutral"
                    )
                  }`}
                  title={
                    empty
                      ? `${h.description} · No signals available yet.`
                      : `${h.description}\n\n${b.signals.map((s) => `• ${s.name}: ${s.detail}`).join("\n")}`
                  }
                >
                  <span className="font-semibold">{h.shortLabel}</span>
                  <span className="opacity-70">·</span>
                  <span className="font-bold">{empty ? "—" : b.label_}</span>
                  {!empty && (
                    <span className="font-mono opacity-70">{b.riskOn}↑ {b.riskOff}↓ <span className="opacity-60">/ {b.total}</span></span>
                  )}
                  <span className="text-[10px] opacity-50">×{Math.round(h.weight * 100)}%</span>
                </span>
              );
            })}
          </div>
          {isFinite(regime.horizons.weightedScore) && (
            <div className="mt-2 text-[10px] text-ink-3 sm:text-right">
              Weighted: <span className="font-semibold text-ink-2">{regime.horizons.weightedLabel}</span>{" "}
              <span className="font-mono opacity-70">
                ({regime.horizons.weightedScore >= 0 ? "+" : ""}
                {regime.horizons.weightedScore.toFixed(2)})
              </span>
            </div>
          )}
        </div>
      )}

      {crossRow.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2 border-t border-line-soft text-[11px] text-ink-3">
          {crossRow.map((r, i) => (
            <span key={i}>
              <span className="font-semibold text-ink-2">{r.label}</span>{" "}
              <span className="font-mono">{r.body}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Compact tile for a single forward-looking data point with source link.
 *  Shows value, a week-over-week delta if `previous` is set, the source
 *  badge that opens the underlying page in a new tab, and a methodology
 *  note the user can hover for full provenance. */
// Horizon chip metadata for ForwardTile. Colors mirror the Forward View
// horizon cards (tactical=blue, cyclical=emerald, structural=violet) so
// the same visual language carries across the Brief.
const HORIZON_CHIP: Record<"tactical" | "cyclical" | "structural", { label: string; cls: string; full: string }> = {
  tactical:  { label: "1–3M",  cls: "border-accent-border bg-accent-soft text-accent",       full: "Tactical · 1–3M" },
  cyclical:  { label: "3–6M",  cls: "border-pos-border bg-pos-soft text-pos", full: "Cyclical · 3–6M" },
  structural:{ label: "6–12M", cls: "border-violet-soft bg-violet-soft text-violet",   full: "Structural · 6–12M" },
};

function ForwardTile({
  label,
  point,
  unit = "",
  deltaUnit,
  deltaPeriod = "wk/wk",
  invertDeltaColor = false,
  horizon,
}: {
  label: string;
  point: ForwardPointBundle | undefined;
  unit?: string;
  deltaUnit?: "bps" | "pct" | "raw" | "pp";
  deltaPeriod?: "wk/wk" | "mo/mo";
  invertDeltaColor?: boolean;
  horizon?: "tactical" | "cyclical" | "structural";
}) {
  const available = point && point.value != null;
  let deltaStr: string | null = null;
  let deltaPositive: boolean | null = null;
  if (available && point!.previous != null) {
    const cur = Number(point!.value);
    const prev = Number(point!.previous);
    if (!isNaN(cur) && !isNaN(prev)) {
      if (deltaUnit === "pct") {
        if (prev !== 0) {
          const d = ((cur - prev) / prev) * 100;
          deltaPositive = d >= 0;
          deltaStr = `${d >= 0 ? "+" : ""}${d.toFixed(1)}% ${deltaPeriod}`;
        }
      } else if (deltaUnit === "bps") {
        const d = cur - prev;
        deltaPositive = d >= 0;
        deltaStr = `${d >= 0 ? "+" : ""}${d.toFixed(0)}bps ${deltaPeriod}`;
      } else if (deltaUnit === "raw") {
        const d = cur - prev;
        deltaPositive = d >= 0;
        deltaStr = `${d >= 0 ? "+" : ""}${d.toFixed(2)} ${deltaPeriod}`;
      } else if (deltaUnit === "pp") {
        // Percentage-point change — used for breadth where both current
        // and prior are themselves percentages of the index.
        const d = cur - prev;
        deltaPositive = d >= 0;
        deltaStr = `${d >= 0 ? "+" : ""}${d.toFixed(1)}% ${deltaPeriod}`;
      }
    }
  }
  const deltaColor =
    deltaPositive == null
      ? "text-ink-3"
      : (invertDeltaColor ? !deltaPositive : deltaPositive)
      ? "text-pos"
      : "text-neg";

  // Map the ForwardPoint status to a LiveStatusBadge status. "stale" also
  // renders as the amber Stale badge so the user sees at a glance that a
  // FRED series hasn't refreshed. A helpful reason tooltip is attached in
  // each case so the user knows WHY the tile is in that state.
  const badgeStatus: LiveStatus | undefined = !point
    ? undefined
    : point.status === "stale"
    ? "failed"
    : point.status;
  const badgeReason = !point
    ? undefined
    : point.status === "stale"
    ? `${point.sourceLabel} data is older than 5 days (latest observation ${point.asOf}). The source may not have refreshed yet.`
    : point.status === "not-configured"
    ? point.note ?? "Source requires additional configuration — showing manual value."
    : point.status === "failed"
    ? point.note ?? `${point.sourceLabel} fetch failed — value is unavailable.`
    : `${point.sourceLabel} · fetched successfully${point.asOf ? " (" + point.asOf + ")" : ""}`;

  return (
    <div className="rounded-2xl border border-line-soft bg-surface-2/60 p-3 md:p-4">
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
            {label}
          </span>
          {horizon && (
            <span
              className={`inline-flex items-center rounded-full border px-1.5 py-px text-[9px] font-bold uppercase tracking-wider ${HORIZON_CHIP[horizon].cls}`}
              title={HORIZON_CHIP[horizon].full}
            >
              {HORIZON_CHIP[horizon].label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <LiveStatusBadge status={badgeStatus} reason={badgeReason} />
          {point?.source && (
            <a
              href={point.source}
              target="_blank"
              rel="noopener noreferrer"
              title={`${point.sourceLabel}${point.note ? " — " + point.note : ""}`}
              className="text-accent hover:text-accent transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          )}
        </div>
      </div>
      <div className="text-2xl font-bold text-ink leading-tight">
        {available ? (
          <>
            {point!.value}
            {unit && <span className="text-sm font-normal text-ink-3 ml-1">{unit}</span>}
          </>
        ) : (
          <span className="text-base font-normal text-ink-3">N/A</span>
        )}
      </div>
      {deltaStr ? (
        <div className={`text-xs font-semibold mt-0.5 ${deltaColor}`}>{deltaStr}</div>
      ) : available && deltaUnit && point?.previous == null ? (
        <div
          className="text-xs font-medium mt-0.5 text-ink-3"
          title="Prior snapshot not yet in history cache. Deltas will populate as subsequent refreshes accumulate."
        >
          {deltaPeriod ?? "wk/wk"} building…
        </div>
      ) : null}
      {point?.sourceLabel && (
        <div className="text-[10px] text-ink-3 mt-1 truncate" title={point.note}>
          {point.sourceLabel}
        </div>
      )}
    </div>
  );
}

// Per-field live-fetch status. "live" = freshly fetched; "failed" = auto-fetch
// attempted but the source was unreachable (showing last saved value as a
// graceful fallback); "not-configured" = source needs setup the user hasn't
// done yet (e.g. missing FRED_API_KEY), so the field stays manual.
type LiveStatus = "live" | "failed" | "not-configured";

/** Small pill shown next to an input label so the user can see at a glance
 *  whether the field is live-fetched, stale (fetch failed), or manual
 *  (source not configured). Hover reveals the specific reason. */
function LiveStatusBadge({
  status,
  reason,
}: {
  status?: LiveStatus;
  reason?: string;
}) {
  if (!status) return null;
  if (status === "live") {
    return (
      <span className="rounded-full bg-pos-soft px-1.5 py-0.5 text-[9px] font-bold text-pos uppercase leading-none">
        Live
      </span>
    );
  }
  if (status === "not-configured") {
    return (
      <span
        title={reason ?? "Source not configured — manual value shown"}
        className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[9px] font-bold text-ink-3 uppercase leading-none cursor-help"
      >
        Manual
      </span>
    );
  }
  return (
    <span
      title={reason ?? "Auto-fetch failed — last saved value shown"}
      className="rounded-full bg-warn-soft px-1.5 py-0.5 text-[9px] font-bold text-warn uppercase leading-none cursor-help"
    >
      Stale
    </span>
  );
}

type Props = {
  marketData: MarketData;
  offensiveExposure: number;
  brief: MorningBriefType | null;
  stocks: Stock[];
  scoredStocks: ScoredStock[];
  onBriefGenerated: (brief: MorningBriefType) => void;
  onUpdateMarketData: (updates: Partial<MarketData>) => void;
};

export function MorningBrief({
  marketData,
  offensiveExposure,
  brief,
  stocks,
  scoredStocks,
  onBriefGenerated,
  onUpdateMarketData,
}: Props) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveFields, setLiveFields] = useState<Record<string, LiveStatus>>({});
  const [liveErrors, setLiveErrors] = useState<Record<string, string>>({});
  const [marketDataError, setMarketDataError] = useState<string | null>(null);

  // Forward-looking data (SPX YTD, forward P/E, yield curve, credit trend, etc.)
  // fetched automatically with direct source links for user verification.
  const [forwardData, setForwardData] = useState<ForwardLookingBundle | null>(null);
  const [forwardLoading, setForwardLoading] = useState(false);
  const [forwardError, setForwardError] = useState<string | null>(null);

  // Deterministic regime snapshot from /api/market-regime (pm:market-regime).
  // Rendered as a compact strip at the top of the Forward View so the PM
  // sees the Yahoo-derived cross-asset read before the macro tiles. If the
  // fetch fails the strip silently hides — the rest of the brief is
  // unaffected.
  const [marketRegime, setMarketRegime] = useState<MarketRegimeData | null>(null);

  // Attachments (screenshots for brief sections). Storage is split:
  //   - /api/kv/attachments           → manifest only (id/label/section/addedAt)
  //   - /api/kv/attachments/[id]      → the per-image base64 dataUrl
  // This keeps every individual Redis write small so we never hit the
  // per-value or Next.js body size limits, which was silently dropping
  // attachments across refreshes when many screenshots were attached.
  const [attachments, setAttachments] = useState<BriefAttachment[]>([]);
  const [attachmentsHydrated, setAttachmentsHydrated] = useState(false);
  const [attachmentsSaveError, setAttachmentsSaveError] = useState<string | null>(null);
  const manifestSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Lightbox state for the Fund Flows inline thumbnails (after brief
  // (flowsLightboxId state removed in 2026-05 alongside the JPM Flows
  // section retirement — there's no longer a separate lightbox for
  // flows attachments since the section itself is gone.)

  // Load manifest on mount, then fetch each image's dataUrl in parallel.
  // Missing per-image keys (e.g. a legacy manifest entry without a backing
  // image) are filtered out so the UI never shows a broken thumbnail.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/kv/attachments");
        const data = await res.json();
        const manifest: Omit<BriefAttachment, "dataUrl">[] = data.attachments || [];
        const hydrated = await Promise.all(
          manifest.map(async (m) => {
            try {
              const imgRes = await fetch(`/api/kv/attachments/${m.id}`);
              if (!imgRes.ok) return null;
              const imgData = await imgRes.json();
              if (!imgData.dataUrl) return null;
              return { ...m, dataUrl: imgData.dataUrl } as BriefAttachment;
            } catch {
              return null;
            }
          })
        );
        if (!cancelled) {
          setAttachments(hydrated.filter((x): x is BriefAttachment => x !== null));
        }
      } catch {
        // Silent — the upload widgets will still work for new additions.
      } finally {
        if (!cancelled) setAttachmentsHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Debounced manifest save. Only writes the lightweight list (no dataUrls)
  // — the per-image payloads are written synchronously in addAttachment.
  // We keep the latest snapshot in a ref so the beforeunload handler below
  // can fire a synchronous keepalive flush without re-registering on every
  // attachment change.
  const latestManifestRef = useRef<Array<{ id: string; label: string; section: string; addedAt: string }>>([]);
  useEffect(() => {
    if (!attachmentsHydrated) return;
    if (manifestSaveTimer.current) clearTimeout(manifestSaveTimer.current);
    const snapshot = attachments.map((a) => ({
      id: a.id,
      label: a.label,
      section: a.section,
      addedAt: a.addedAt,
    }));
    latestManifestRef.current = snapshot;
    manifestSaveTimer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/kv/attachments", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attachments: snapshot }),
        });
        if (!res.ok) {
          const msg = `Manifest save failed (HTTP ${res.status}).`;
          console.error(msg);
          setAttachmentsSaveError(msg);
        } else {
          setAttachmentsSaveError(null);
        }
      } catch (e) {
        const msg = `Manifest save network error: ${e instanceof Error ? e.message : String(e)}`;
        console.error(msg);
        setAttachmentsSaveError(msg);
      }
    }, 400);
    return () => {
      if (manifestSaveTimer.current) clearTimeout(manifestSaveTimer.current);
    };
  }, [attachments, attachmentsHydrated]);

  // Flush pending manifest save on tab close / refresh / nav. Without this,
  // an image uploaded within 400ms of the user hitting refresh would have
  // its per-image dataUrl key written to Redis (immediate, in addAttachment)
  // but its manifest entry dropped — leaving the upload effectively invisible
  // on next load even though the bytes survived. The fetch uses `keepalive`
  // so the browser doesn't cancel it on unload (sendBeacon would be cleaner
  // but has a 64KB limit; the manifest is tiny so either would work — we
  // pick keepalive for consistency with the useDebouncedPersist pattern).
  useEffect(() => {
    if (!attachmentsHydrated) return;
    const handler = () => {
      if (!manifestSaveTimer.current) return;
      clearTimeout(manifestSaveTimer.current);
      manifestSaveTimer.current = null;
      try {
        fetch("/api/kv/attachments", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attachments: latestManifestRef.current }),
          keepalive: true,
        }).catch((e) => console.error("Manifest flush on unload failed:", e));
      } catch (e) {
        console.error("Manifest flush on unload threw:", e);
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [attachmentsHydrated]);

  // Adding persists the image immediately to its own Redis key, then updates
  // state (which triggers the debounced manifest save above). This way the
  // image is durable the moment it's dropped — even if the user refreshes
  // the page seconds later, the per-image key is already written.
  const addAttachment = useCallback(async (att: BriefAttachment) => {
    try {
      const res = await fetch(`/api/kv/attachments/${att.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl: att.dataUrl }),
      });
      if (!res.ok) {
        const msg = `Screenshot save failed (HTTP ${res.status}) for "${att.label}". ${
          res.status === 413 ? "Image too large — try a smaller screenshot." : ""
        }`.trim();
        setAttachmentsSaveError(msg);
        return; // don't add to state; the save failed
      }
      setAttachmentsSaveError(null);
      setAttachments((prev) => [...prev, att]);
    } catch (e) {
      setAttachmentsSaveError(`Screenshot save network error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const removeAttachment = useCallback(async (id: string) => {
    // Remove from state optimistically; the /[id] DELETE can fail silently
    // (Redis will orphan the key but the manifest no longer references it).
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    try {
      await fetch(`/api/kv/attachments/${id}`, { method: "DELETE" });
    } catch {
      // Intentionally ignored — orphan key cleanup is not user-visible.
    }
  }, []);

  // Auto-fetch live market data on mount:
  //   VIX, MOVE          — Yahoo ^VIX, ^MOVE
  //   HY OAS, IG OAS     — FRED BAMLH0A0HYM2 / BAMLC0A0CM (when FRED_API_KEY set)
  //   VIX Term Structure — derived from ^VIX3M / ^VIX ratio
  //   Put/Call Ratio     — CBOE daily CSV
  // Any field that comes back null is left untouched so the user's prior
  // manual entry or the last persisted value remains visible. Per-field
  // status + error reasons drive visible Live/Stale/Manual badges so the
  // user never has to guess whether a value was freshly fetched.
  useEffect(() => {
    let cancelled = false;
    async function fetchLiveData() {
      setLiveLoading(true);
      try {
        const res = await fetch("/api/market-data");
        if (!res.ok) {
          if (!cancelled) {
            setMarketDataError(
              `Auto-fetch unavailable (HTTP ${res.status}). All live fields show your last saved values.`
            );
          }
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        setMarketDataError(null);
        const updates: Partial<MarketData> = {};
        if (
          data.termStructure === "Contango" ||
          data.termStructure === "Flat" ||
          data.termStructure === "Backwardation"
        ) {
          updates.termStructure = data.termStructure;
        }
        if (data.putCall != null) updates.putCall = data.putCall;
        if (Object.keys(updates).length > 0) {
          onUpdateMarketData(updates);
        }
        setLiveFields((data.status as Record<string, LiveStatus>) ?? {});
        setLiveErrors((data.errors as Record<string, string>) ?? {});
      } catch (err) {
        if (!cancelled) {
          setMarketDataError(
            `Auto-fetch network error: ${
              err instanceof Error ? err.message : String(err)
            }. All live fields show your last saved values.`
          );
        }
      } finally {
        if (!cancelled) setLiveLoading(false);
      }
    }
    fetchLiveData();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fetch forward-looking data (SPX YTD, forward P/E, yield curve, etc.)
  // so the user sees it immediately and can click sources to verify. Fetch
  // failures surface as a visible banner inside the Forward View section
  // rather than silently leaving the tiles blank.
  useEffect(() => {
    let cancelled = false;
    async function fetchForward() {
      setForwardLoading(true);
      try {
        const res = await fetch("/api/forward-looking");
        if (!res.ok) {
          if (!cancelled) {
            setForwardError(
              `Forward-looking fetch failed (HTTP ${res.status}). Tile values will be unavailable until the next refresh.`
            );
          }
          return;
        }
        const data: ForwardLookingBundle = await res.json();
        if (!cancelled) {
          setForwardData(data);
          setForwardError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setForwardError(
            `Forward-looking network error: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      } finally {
        if (!cancelled) setForwardLoading(false);
      }
    }
    fetchForward();
    return () => { cancelled = true; };
  }, []);

  // Fetch the deterministic market regime snapshot in parallel. The
  // endpoint hits the pm:market-regime Redis cache; a cold cache takes
  // a few seconds (~15 parallel Yahoo fetches), subsequent loads are
  // instant. Silent-fail — if this doesn't return we simply hide the
  // strip rather than blocking the brief.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/market-regime");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data?.regime) setMarketRegime(data.regime as MarketRegimeData);
      } catch {
        // Intentionally silent — the rest of the brief renders fine.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Prefer the bundle Claude just used for this brief so the UI reflects the
  // exact numbers the brief was written against. Fall back to the page-load
  // bundle otherwise.
  //
  // PER-FIELD FALLBACK: if a saved brief's field has no value (status
  // "failed" or value null) but the live fetch produced one, use the live
  // value instead. Otherwise a single fetch failure at brief-generation
  // time gets "frozen in" — the tile shows N/A all day even after the
  // upstream source recovers. This came up after Finviz changed their
  // screener URL: briefs generated during the outage carried null breadth
  // values, and the tiles kept showing N/A even once the fetcher was
  // fixed because we were reading the cached brief's bundle.
  const activeForward = useMemo(() => {
    if (!brief?.forwardLooking) return forwardData;
    if (!forwardData) return brief.forwardLooking;
    const merged: ForwardLookingBundle = { ...brief.forwardLooking };
    const briefBundle = brief.forwardLooking as unknown as Record<string, unknown>;
    const liveBundle = forwardData as unknown as Record<string, unknown>;
    for (const key of Object.keys(liveBundle)) {
      const briefField = briefBundle[key];
      const liveField = liveBundle[key];
      // Only patch ForwardPointBundle objects — skip scalar fields like
      // `fredEnabled` and `fetchedAt` (those stay from the brief).
      if (
        liveField &&
        typeof liveField === "object" &&
        "value" in (liveField as Record<string, unknown>)
      ) {
        const briefVal = (briefField as { value?: unknown } | null | undefined)?.value;
        const briefStatus = (briefField as { status?: unknown } | null | undefined)?.status;
        const liveVal = (liveField as { value?: unknown }).value;
        // Replace when the saved brief's field is missing/failed AND the
        // live fetch produced a real value. Don't otherwise touch the
        // brief's data (so the narrative stays consistent with the tiles).
        if (
          (briefVal == null || briefStatus === "failed") &&
          liveVal != null
        ) {
          (merged as unknown as Record<string, unknown>)[key] = liveField;
        }
      }
    }
    return merged;
  }, [brief?.forwardLooking, forwardData]);

  async function generateBrief(force = true) {
    setGenerating(true);
    setError("");

    try {
      // Send only attachment *references* (id/section/label) — the server
      // fetches each image's dataUrl directly from its per-image Redis key.
      // Sending the full base64 payloads inline was blowing past the
      // platform's request body limit and surfacing as the opaque
      // DOMException "The string did not match the expected pattern."
      const attachmentRefs = attachments
        .filter((a) => a.id && a.section)
        .map((a) => ({ id: a.id, section: a.section, label: a.label }));

      // `force: true` bypasses the server-side day-cache and pays for a
      // fresh Anthropic call. Default true here because the only call
      // site is the Generate / Regenerate button — the PM explicitly
      // wants a refreshed brief when they click. Pass force=false from
      // background/auto-refresh paths to take the cache fast-path.
      const res = await fetch("/api/morning-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketData,
          holdings: stocks,
          attachmentRefs,
          force,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to generate brief");
      }

      const data = await res.json();
      onBriefGenerated(data);
      // Update market regime based on Claude's assessment
      const marketUpdates: Partial<MarketData> = {};
      if (data.marketRegime) {
        marketUpdates.riskRegime = data.marketRegime;
      }
      if (Object.keys(marketUpdates).length > 0) {
        onUpdateMarketData(marketUpdates);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate brief");
    } finally {
      setGenerating(false);
    }
  }

  const bottomLine =
    brief?.bottomLine ||
    "Click \"Refresh Brief\" to have Claude analyze current market conditions and produce your morning brief.";
  // One-line regime verdict — objective quant regime + whether the Brief
  // concurs/cautions/diverges. Pinned in bold under the Bottom Line so the
  // agreement (or divergence) between the tape and the synthesis isn't buried.
  const regimeVerdict = brief?.regimeVerdict || null;

  // Three-horizon outlook (Phase 3). Falls back to a hint string per
  // horizon when the brief hasn't been generated yet, or when an old
  // pm:brief blob predates these fields. Keeps the section useful even
  // with no AI text — the horizon composite chip from `marketRegime`
  // is still informative on its own.
  const tacticalView =
    brief?.tacticalView ||
    "Tactical (1-3M) outlook will appear here after generating the brief. The horizon composite below is live regardless.";
  const cyclicalView =
    brief?.cyclicalView ||
    "Cyclical (3-6M) outlook will appear here after generating the brief. The horizon composite below is live regardless.";
  const structuralView =
    brief?.structuralView ||
    "Structural (6-12M) outlook will appear here after generating the brief. The horizon composite below is live regardless.";

  const compositeAnalysis =
    brief?.compositeAnalysis ||
    "Composite analysis will appear here after generating the brief.";

  const creditAnalysis =
    brief?.creditAnalysis ||
    "Credit spread analysis will appear here after generating the brief.";

  const volatilityAnalysis =
    brief?.volatilityAnalysis ||
    "Volatility regime analysis will appear here after generating the brief.";

  const breadthAnalysis =
    brief?.breadthAnalysis ||
    "Breadth & internals analysis will appear here after generating the brief.";

  // flowsAnalysis was retired in 2026-05 — flows are inherently
  // backward-looking and contrarianAnalysis covers
  // sentiment/positioning extremes already.

  const hedgingAnalysis = brief?.hedgingAnalysis || "";

  const contrarianAnalysis = brief?.contrarianAnalysis || "";

  const sectorRotation = brief?.sectorRotation || null;

  const riskScan = brief?.riskScan || null;

  const topActionsToday = brief?.topActionsToday || [];
  const hedgingCall = brief?.hedgingCall || null;
  const cashDeploymentCall = brief?.cashDeploymentCall || null;

  // Days-left-in-window calendar logic for the Cash Deployment tile.
  // Normal monthly deployment window is the 1st-20th of each month. After
  // the 15th we surface a soft-urgency cue; after the 20th the window is
  // technically past. We never block the recommendation — this is advisory,
  // and the PM can deploy whenever — but the calendar context goes on the
  // card so timing decisions account for the runway left.
  const deploymentWindowStatus = useMemo(() => {
    const now = new Date();
    const day = now.getDate(); // 1-31, local time — close enough for a soft cue
    if (day <= 14) return { phase: "open" as const, label: `Day ${day} — window open through 20th`, tone: "slate" as const };
    if (day <= 17) return { phase: "closing" as const, label: `Day ${day} — ${20 - day} day(s) left in window`, tone: "amber" as const };
    if (day <= 20) return { phase: "late" as const, label: `Day ${day} — late window, ${20 - day} day(s) to deploy`, tone: "orange" as const };
    return { phase: "past" as const, label: `Day ${day} — past normal window; document if deferred further`, tone: "rose" as const };
  }, []);

  const compositeSignalTone = marketData.compositeSignal.toLowerCase().includes("bear")
    ? "red" as const
    : marketData.compositeSignal.toLowerCase().includes("bull")
    ? "green" as const
    : "amber" as const;

  return (
    <>
      {/* Editable Market & Sentiment Inputs */}
      <section className="rounded-2xl border border-line bg-white p-4 md:p-5 shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <h3 className="text-base font-semibold text-ink">Daily Market Input</h3>
          {liveLoading && <span className="text-xs text-accent animate-pulse">Fetching live data...</span>}
        </div>

        {/* Surface any fetch-level or per-field auto-fetch failure as a visible
            banner so the user never has to guess-and-check whether a field was
            freshly pulled or is showing a stale saved value. */}
        {(() => {
          const failedKeys = Object.entries(liveFields)
            .filter(([, s]) => s === "failed")
            .map(([k]) => k);
          const notConfiguredKeys = Object.entries(liveFields)
            .filter(([, s]) => s === "not-configured")
            .map(([k]) => k);
          const fieldLabel: Record<string, string> = {
            putCall: "Put/Call",
            termStructure: "VIX Term Structure",
          };
          if (marketDataError) {
            return (
              <div className="mb-5 rounded-xl border border-warn-border bg-warn-soft px-4 py-3 text-xs text-warn">
                <strong className="font-semibold">Auto-fetch unavailable:</strong> {marketDataError}
              </div>
            );
          }
          if (failedKeys.length > 0 || notConfiguredKeys.length > 0) {
            return (
              <div className="mb-5 rounded-xl border border-warn-border bg-warn-soft px-4 py-3 text-xs text-warn space-y-1">
                {failedKeys.length > 0 && (
                  <div>
                    <strong className="font-semibold">Stale values shown for:</strong>{" "}
                    {failedKeys.map((k) => fieldLabel[k] ?? k).join(", ")}. Hover each badge for the specific reason.
                  </div>
                )}
                {notConfiguredKeys.length > 0 && (
                  <div>
                    <strong className="font-semibold">Manual entry required for:</strong>{" "}
                    {notConfiguredKeys.map((k) => fieldLabel[k] ?? k).join(", ")}. Hover the Manual badge to see how to enable auto-fetch.
                  </div>
                )}
              </div>
            );
          }
          return null;
        })()}

        {/* VIX, MOVE, HY/IG OAS and breadth tiles are now sourced from the
            Forward View auto-fetch — see the Forward View section at the top
            of this page for live values, history-aware deltas, and source
            links. Manual fields below are only the inputs that have no
            reliable free auto-source. */}

        {/* Two manual-input sub-sections rendered side-by-side on lg+ to halve
            vertical space — the contrarian inputs (left) and the other manual
            fields (right) are independent groupings, so the 2-col split keeps
            their visual identity while reducing scroll. Stacks on mobile. */}
        <div className="grid gap-6 lg:grid-cols-2 lg:gap-x-8 mb-6 border-t border-line-soft pt-5">

        {/* ── Contrarian Indicators ── */}
        <div>
          <div className="flex items-center gap-3 mb-4">
            <h4 className="text-xs font-semibold text-ink-3 uppercase tracking-widest">Contrarian Indicators</h4>
            <SignalPill tone="green">INVERTED SIGNALS</SignalPill>
          </div>
          {/* Two text inputs in a 2-col row, then the optional chart uploader
              spans the full half-width below — keeps inputs uniform and gives
              the screenshot drop zone enough room to show its drop label inline
              with the Browse button instead of wrapping into a tall column. */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-xs font-semibold text-ink-3 uppercase tracking-wider">S&P Oscillator</label>
                <a href="https://app.marketedge.com/#!/markets" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent transition-colors" title="MarketEdge S&P Oscillator">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
              <SaveableNumericInput
                savedValue={marketData.spOscillator}
                onSave={(n) => onUpdateMarketData({ spOscillator: n })}
                allowNegative
                inputClassName="w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-lg font-semibold focus:bg-white focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all outline-none"
              />
              <p className="text-[10px] text-ink-3 mt-0.5">{marketData.spOscillator < 0 ? "Oversold (bullish)" : marketData.spOscillator > 0 ? "Overbought (bearish)" : "Neutral"}</p>
            </div>
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-xs font-semibold text-ink-3 uppercase tracking-wider">Put/Call Ratio</label>
                <a href="https://www.cboe.com/us/options/market_statistics/daily/" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent transition-colors" title="CBOE Total Put/Call">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
              <SaveableNumericInput
                savedValue={marketData.putCall}
                onSave={(n) => onUpdateMarketData({ putCall: n })}
                inputClassName="w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-lg font-semibold focus:bg-white focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all outline-none"
              />
              <p className="text-[10px] text-ink-3 mt-0.5">Total P/C ratio</p>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-xs font-semibold text-ink-3 uppercase tracking-wider">Oscillator Chart (optional)</label>
              </div>
              <ImageUpload
                section="spOscillator"
                sectionLabel="S&P Oscillator chart"
                attachments={attachments}
                onAdd={addAttachment}
                onRemove={removeAttachment}
              />
              <p className="text-[10px] text-ink-3 mt-1">Drop a MarketEdge chart screenshot — Claude will read the shape, levels, and recent extremes for the contrarian section.</p>
            </div>
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-xs font-semibold text-ink-3 uppercase tracking-wider">Newton Technical Presentation (optional)</label>
              </div>
              <ImageUpload
                section="newtonTechnical"
                sectionLabel="Newton Technical Presentation"
                attachments={attachments}
                onAdd={addAttachment}
                onRemove={removeAttachment}
              />
              <p className="text-[10px] text-ink-3 mt-1">Drop Mark Newton&apos;s monthly/quarterly technical deck (PDF). Parsed once on upload, then cached — the brief reuses the same analysis on every refresh and only re-parses when you replace the file. Relevance decays with age: fresh (&lt;14d) full weight, 14-45d directional only, &gt;45d high-level context only.</p>
            </div>
          </div>
          <p className="mt-3 text-[11px] text-ink-3">
            CNN Fear &amp; Greed and AAII Sentiment are now auto-fetched on every load
            (with full history) — see the live tiles in the Contrarian Sentiment
            section below.
          </p>
        </div>

        {/* ── Other Manual Inputs ── */}
        <div>
          <div className="flex items-center gap-3 mb-4">
            <h4 className="text-xs font-semibold text-ink-3 uppercase tracking-widest">Other Manual Inputs</h4>
          </div>
          {/* Equity Flows + JPM Flows screenshot section was retired
              in 2026-05. Flows are inherently backward-looking and
              contrarianAnalysis already covers sentiment / positioning
              extremes. Only VIX Term Structure remains here. */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <div>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 mb-1">
                <label className="text-xs font-semibold text-ink-3 uppercase tracking-wider">VIX Term Structure</label>
                <a href="http://vixcentral.com" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent transition-colors shrink-0" title="VIX Central">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
                <LiveStatusBadge
                  status={liveFields.termStructure}
                  reason={liveErrors.termStructure ?? "Derived from ^VIX3M / ^VIX ratio"}
                />
              </div>
              <SaveableSelect
                savedValue={marketData.termStructure}
                onSave={(v) => onUpdateMarketData({ termStructure: v })}
                options={[
                  { value: "Contango", label: "Contango" },
                  { value: "Flat", label: "Flat" },
                  { value: "Backwardation", label: "Backwardation" },
                ]}
                selectClassName="w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-lg font-semibold focus:bg-white focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all outline-none appearance-none"
              />
            </div>
          </div>
          {/* Analyst / Strategist Reports dropbox lives in the right column
              to use the empty space under VIX Term Structure rather than
              lengthening the left column. */}
          <div className="mt-4">
            <div className="flex items-center gap-1.5 mb-1">
              <label className="text-xs font-semibold text-ink-3 uppercase tracking-wider">Analyst / Strategist Reports (optional)</label>
            </div>
            <ImageUpload
              section="strategistReports"
              sectionLabel="Analyst / Strategist Reports"
              attachments={attachments}
              onAdd={addAttachment}
              onRemove={removeAttachment}
            />
            <p className="text-[10px] text-ink-3 mt-1">Drop any analyst or strategist research (PDF or screenshot) — a sell-side strategy note, an economics piece, a thematic deck. Multiple files OK. Parsed once on upload, then cached — the brief reuses the same analysis on every refresh and only re-parses when you change the files. Same age decay as the Newton deck.</p>
          </div>
        </div>

        </div>{/* /lg:grid-cols-2 wrapper for the two manual-input sub-sections */}

        {/* ── Breadth (manual entry) ──
            After the Finviz/Yahoo scrape became unreliable from Vercel,
            the PM types today's % above 200/50 DMA directly here. Stored
            in marketData.breadthOverride and persisted to pm:breadth-history
            with source: "manual" so wk/wk and mo/mo comparisons compound.
            Sources: Mark Newton's note, StockCharts $SPXA200R/$SPXA50R, WSJ. */}
        <div className="border-t border-line-soft pt-5 mb-4">
          <div className="flex items-center gap-3 mb-3">
            <h4 className="text-xs font-semibold text-ink-3 uppercase tracking-widest">Breadth (manual entry)</h4>
            <span className="text-[10px] text-ink-3">% above 200/50 DMA + NYSE new H/L — sources: Mark Newton&apos;s note, your Claude skill, Barchart ($BCMM / $S5TH / $MAHN), StockCharts, WSJ. When date = today, used directly. Partial entry is fine.</span>
          </div>
          {/* Helper to keep the date in sync whenever the PM types a value.
              All six fields share the same date — partial entry is fine. */}
          {(() => {
            const today = new Date().toISOString().slice(0, 10);
            const updateBreadthField = (field: string, raw: string) => {
              const v = raw === "" ? undefined : parseFloat(raw);
              const prev = marketData.breadthOverride ?? {};
              const valid = v != null && !isNaN(v);
              // Stamp this box's last-edited time so the freshness tag can
              // flag stale fields; clear the stamp when the box is emptied.
              const nextEditedAt: Record<string, string> = { ...(prev.editedAt ?? {}) };
              if (valid) nextEditedAt[field] = new Date().toISOString();
              else delete nextEditedAt[field];
              onUpdateMarketData({
                breadthOverride: {
                  ...prev,
                  date: prev.date ?? today,
                  [field]: valid ? v : undefined,
                  editedAt: nextEditedAt,
                },
              });
            };
            // Wipe every manual breadth value + its freshness stamp in one
            // click. Persists to pm:market (so the clear syncs across devices).
            const clearAllBreadth = () => {
              if (!window.confirm("Clear all manual breadth values? You'll need to re-enter them from the source.")) return;
              onUpdateMarketData({ breadthOverride: { date: today } });
            };
            const numVal = (v: unknown): number | "" =>
              typeof v === "number" ? v : "";
            // Tiny per-box freshness tag: green "today" when the value was
            // entered on the current date, amber + the edit date when it's
            // older (stale — a value left from a prior session that may have
            // been missed in today's update). Renders nothing for empty boxes.
            const editedMap = marketData.breadthOverride?.editedAt;
            const FreshnessTag = ({ ts }: { ts?: string }) => {
              if (!ts) return null;
              const day = ts.slice(0, 10);
              const isToday = day === today;
              return (
                <span
                  className={`text-[8px] leading-none px-1 py-0.5 rounded font-semibold border ${
                    isToday
                      ? "bg-pos-soft text-pos border-pos-border"
                      : "bg-warn-soft text-warn border-warn-border"
                  }`}
                  title={isToday ? "Edited today" : `Last edited ${day} — may be stale`}
                >
                  {isToday ? "today" : day.slice(5)}
                </span>
              );
            };
            // Barchart source pages — clicking the icon next to each label
            // opens the page where the PM finds that indicator. Mirrors the
            // S&P Oscillator input's source-link pattern. Kept in sync with
            // the BARCHART constant in forward-looking.ts.
            const BC = {
              sp200: "https://www.barchart.com/stocks/quotes/$S5TH",
              sp50: "https://www.barchart.com/stocks/quotes/$S5FI",
              broad: "https://www.barchart.com/stocks/momentum",
              nh: "https://www.barchart.com/stocks/quotes/$MAHN",
              nl: "https://www.barchart.com/stocks/quotes/$MALN",
            };
            const LabelLink = ({ text, href, editedAt }: { text: string; href?: string; editedAt?: string }) => (
              <div className="flex items-center gap-1 mb-1">
                <label className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider">{text}</label>
                {href && (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent transition-colors" title={`Open source: ${href}`}>
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                  </a>
                )}
                <FreshnessTag ts={editedAt} />
              </div>
            );
            return (
              <>
                {/* Toolbar: Clear all manual breadth values in one click. */}
                <div className="flex justify-end mb-2">
                  <button
                    type="button"
                    onClick={clearAllBreadth}
                    className="text-[10px] font-semibold text-ink-3 hover:text-neg border border-line hover:border-neg-border rounded px-2 py-0.5 transition-colors"
                    title="Clear every manual breadth value and its freshness tag. Persists to pm:market, so it syncs across refreshes and devices."
                  >
                    Clear all
                  </button>
                </div>
                {/* Row 1: Date + SP500 200/50 */}
                <div className="grid gap-4 md:grid-cols-3 mb-3">
                  <div>
                    <LabelLink text="Date" />
                    <input
                      type="date"
                      value={marketData.breadthOverride?.date ?? today}
                      onChange={(e) =>
                        onUpdateMarketData({
                          breadthOverride: {
                            ...marketData.breadthOverride,
                            date: e.target.value,
                          },
                        })
                      }
                      className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2 outline-none focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all"
                      title="Must equal today's UTC date to be used. Earlier dates are treated as 'not entered today'."
                    />
                  </div>
                  <div>
                    <LabelLink text="SP500 >200DMA (%)" href={BC.sp200} editedAt={editedMap?.above200} />
                    <input
                      type="number" step="0.1" min={0} max={100} placeholder="51.2"
                      value={numVal(marketData.breadthOverride?.above200)}
                      onChange={(e) => updateBreadthField("above200", e.target.value)}
                      className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2 outline-none focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all"
                    />
                  </div>
                  <div>
                    <LabelLink text="SP500 >50DMA (%)" href={BC.sp50} editedAt={editedMap?.above50} />
                    <input
                      type="number" step="0.1" min={0} max={100} placeholder="44.6"
                      value={numVal(marketData.breadthOverride?.above50)}
                      onChange={(e) => updateBreadthField("above50", e.target.value)}
                      className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2 outline-none focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all"
                    />
                  </div>
                </div>
                {/* Row 2: Broad Market 200/50 + (blank slot for grid alignment) */}
                <div className="grid gap-4 md:grid-cols-3 mb-3">
                  <div>
                    <LabelLink text="Broad Market >200DMA (%)" href={BC.broad} editedAt={editedMap?.broadAbove200} />
                    <input
                      type="number" step="0.1" min={0} max={100} placeholder="54.9"
                      value={numVal(marketData.breadthOverride?.broadAbove200)}
                      onChange={(e) => updateBreadthField("broadAbove200", e.target.value)}
                      className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2 outline-none focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all"
                      title="% of broad-market universe above 200-day MA. Source: Barchart BCMM ~5,168 names, Russell 3000 ~3,000 names, or whichever broader-than-SPX measure your Claude skill returns. Materially lower than SP500 = broad-market divergence."
                    />
                  </div>
                  <div>
                    <LabelLink text="Broad Market >50DMA (%)" href={BC.broad} editedAt={editedMap?.broadAbove50} />
                    <input
                      type="number" step="0.1" min={0} max={100} placeholder="59.4"
                      value={numVal(marketData.breadthOverride?.broadAbove50)}
                      onChange={(e) => updateBreadthField("broadAbove50", e.target.value)}
                      className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2 outline-none focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all"
                      title="% of broad-market universe above 50-day MA — broader-than-SPX faster momentum gauge."
                    />
                  </div>
                  <div /> {/* empty cell for grid alignment */}
                </div>
                {/* Row 3: NYSE new highs / new lows */}
                <div className="grid gap-4 md:grid-cols-3">
                  <div>
                    <LabelLink text="NYSE New Highs (count)" href={BC.nh} editedAt={editedMap?.newHighs} />
                    <input
                      type="number" step="1" min={0} placeholder="78"
                      value={numVal(marketData.breadthOverride?.newHighs)}
                      onChange={(e) => updateBreadthField("newHighs", e.target.value)}
                      className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2 outline-none focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all"
                      title="Daily count of NYSE 52-week new highs. Expansion above 100 = healthy thrust."
                    />
                  </div>
                  <div>
                    <LabelLink text="NYSE New Lows (count)" href={BC.nl} editedAt={editedMap?.newLows} />
                    <input
                      type="number" step="1" min={0} placeholder="142"
                      value={numVal(marketData.breadthOverride?.newLows)}
                      onChange={(e) => updateBreadthField("newLows", e.target.value)}
                      className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2 outline-none focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all"
                      title="Daily count of NYSE 52-week new lows. Spike above 200 = capitulation signal."
                    />
                  </div>
                  <div /> {/* empty cell for grid alignment */}
                </div>
                {/* Row 4: NYSE up/down volume (conviction / thrust). Only the
                    ratio matters, so enter in billions or raw shares — just
                    keep both fields in the same unit. */}
                <div className="grid gap-4 md:grid-cols-3 mt-3">
                  <div>
                    <LabelLink text="NYSE Up Volume (billions)" href={BC.broad} editedAt={editedMap?.upVolume} />
                    <input
                      type="number" step="0.01" min={0} placeholder="0.90"
                      value={numVal(marketData.breadthOverride?.upVolume)}
                      onChange={(e) => updateBreadthField("upVolume", e.target.value)}
                      className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2 outline-none focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all"
                      title="NYSE advancing (up) share volume, in BILLIONS — e.g. 900,520,000 shares → 0.90. Only the ratio vs down-volume matters, so just keep both fields in the same unit (billions is easiest: drop the last 9 digits). Raw shares (900520000) also work if you use raw in both."
                    />
                  </div>
                  <div>
                    <LabelLink text="NYSE Down Volume (billions)" href={BC.broad} editedAt={editedMap?.downVolume} />
                    <input
                      type="number" step="0.01" min={0} placeholder="3.45"
                      value={numVal(marketData.breadthOverride?.downVolume)}
                      onChange={(e) => updateBreadthField("downVolume", e.target.value)}
                      className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2 outline-none focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all"
                      title="NYSE declining (down) share volume, in BILLIONS — e.g. 3,446,500,000 shares → 3.45. Must use the SAME unit as Up Volume. Up % = up / (up + down): >85% = thrust, <15% = capitulation."
                    />
                  </div>
                  <div /> {/* empty cell for grid alignment */}
                </div>
                {/* Consolidated source legend — each distinct page listed ONCE
                    so the PM opens it a single time rather than clicking the
                    same momentum page from four different field icons. */}
                <div className="mt-4 pt-3 border-t border-line-soft flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] text-ink-3">
                  <span className="font-semibold uppercase tracking-wider">Sources (open once):</span>
                  <a href={BC.broad} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:text-accent transition-colors">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                    Barchart Momentum <span className="text-ink-3 normal-case">— Broad Market 200/50 + Up/Down Volume</span>
                  </a>
                  <a href={BC.sp200} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:text-accent transition-colors">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                    $S5TH <span className="text-ink-3">— SP500 &gt;200</span>
                  </a>
                  <a href={BC.sp50} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:text-accent transition-colors">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                    $S5FI <span className="text-ink-3">— SP500 &gt;50</span>
                  </a>
                  <a href={BC.nh} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:text-accent transition-colors">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                    $MAHN <span className="text-ink-3">— New Highs</span>
                  </a>
                  <a href={BC.nl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:text-accent transition-colors">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                    $MALN <span className="text-ink-3">— New Lows</span>
                  </a>
                </div>
              </>
            );
          })()}
        </div>

        {/* ── Strategist Notes (Fundstrat) ── */}
        <div className="border-t border-line-soft pt-5 mb-4">
          <div className="flex items-center gap-3 mb-3">
            <h4 className="text-xs font-semibold text-ink-3 uppercase tracking-widest">Strategist Notes</h4>
            <span className="text-[10px] text-ink-3">Copy-paste daily reports — Claude will incorporate key takeaways into the brief</span>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="flex flex-wrap items-center gap-1.5 mb-1">
                <label className="text-xs font-semibold text-ink-3 uppercase tracking-wider">Mark Newton</label>
                <span className="text-[10px] text-ink-3">(Technical Strategy)</span>
                <StrategistTimingToggle
                  value={marketData.strategistNotes?.newtonTiming}
                  onChange={(next) =>
                    onUpdateMarketData({
                      strategistNotes: { ...marketData.strategistNotes, newtonTiming: next },
                    })
                  }
                />
                <input
                  type="date"
                  value={marketData.strategistNotes?.newtonDate ?? new Date().toISOString().slice(0, 10)}
                  onChange={(e) =>
                    onUpdateMarketData({
                      strategistNotes: {
                        ...marketData.strategistNotes,
                        newtonDate: e.target.value,
                      },
                    })
                  }
                  className="ml-auto rounded-lg border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-ink-3 outline-none focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all"
                  title="Date this report pertains to"
                />
              </div>
              <SaveableTextarea
                savedValue={marketData.strategistNotes?.newton ?? ""}
                onSave={(v) =>
                  onUpdateMarketData({
                    strategistNotes: {
                      ...marketData.strategistNotes,
                      newton: v || undefined,
                      newtonDate: marketData.strategistNotes?.newtonDate ?? new Date().toISOString().slice(0, 10),
                    },
                  })
                }
                label="Newton"
                placeholder="Paste Mark Newton's daily technical strategy report here…"
              />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-1.5 mb-1">
                <label className="text-xs font-semibold text-ink-3 uppercase tracking-wider">Tom Lee</label>
                <span className="text-[10px] text-ink-3">(Head of Research)</span>
                <StrategistTimingToggle
                  value={marketData.strategistNotes?.leeTiming}
                  onChange={(next) =>
                    onUpdateMarketData({
                      strategistNotes: { ...marketData.strategistNotes, leeTiming: next },
                    })
                  }
                />
                <input
                  type="date"
                  value={marketData.strategistNotes?.leeDate ?? new Date().toISOString().slice(0, 10)}
                  onChange={(e) =>
                    onUpdateMarketData({
                      strategistNotes: {
                        ...marketData.strategistNotes,
                        leeDate: e.target.value,
                      },
                    })
                  }
                  className="ml-auto rounded-lg border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-ink-3 outline-none focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all"
                  title="Date this report pertains to"
                />
              </div>
              <SaveableTextarea
                savedValue={marketData.strategistNotes?.lee ?? ""}
                onSave={(v) =>
                  onUpdateMarketData({
                    strategistNotes: {
                      ...marketData.strategistNotes,
                      lee: v || undefined,
                      leeDate: marketData.strategistNotes?.leeDate ?? new Date().toISOString().slice(0, 10),
                    },
                  })
                }
                label="Tom Lee"
                placeholder="Paste Tom Lee's daily strategy report here…"
              />
            </div>
          </div>
        </div>

        <div className="mt-5 flex items-center gap-4">
          <button
            onClick={() => generateBrief(true)}
            disabled={generating}
            className="rounded-2xl bg-accent px-5 py-3 text-sm font-semibold text-white hover:bg-accent disabled:opacity-50 transition-colors"
          >
            {generating ? "Generating..." : "\u21BB Refresh Brief"}
          </button>
        </div>
      </section>

      {error && (
        <div className="rounded-xl border border-neg-border bg-neg-soft px-4 py-3 text-sm text-neg">
          {error}
        </div>
      )}

      {attachmentsSaveError && (
        <div className="rounded-xl border border-warn-border bg-warn-soft px-4 py-3 text-sm text-warn">
          <strong>Screenshots not saved:</strong> {attachmentsSaveError}
        </div>
      )}

      {/* Header */}
      <header>
        <h1 className="text-2xl sm:text-4xl font-semibold tracking-tight">Morning Brief</h1>
        <p className="mt-2 text-base sm:text-xl text-ink-3 flex flex-wrap items-baseline gap-x-3">
          <span>{brief?.date || marketData.date}</span>
          {brief?.generatedAt && (
            <span className="text-sm sm:text-base text-ink-faint">
              Generated {new Date(brief.generatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}
            </span>
          )}
        </p>
      </header>

      {/* Bottom Line */}
      <section className="relative rounded-2xl bg-warn-soft border border-warn-border p-5 shadow-sm">
        {generating && <LoadingOverlay message="Claude is analyzing markets..." />}
        <div className="text-xs font-bold uppercase tracking-[0.22em] text-warn mb-3">
          Bottom line
        </div>
        <p className="max-w-6xl text-sm leading-6 text-ink">
          {bottomLine}
        </p>
        {regimeVerdict && (
          <p className="mt-3 border-t border-warn-border pt-3 max-w-6xl text-sm font-bold text-ink">
            {regimeVerdict}
          </p>
        )}
      </section>

      {/* What changed since the prior brief — running-narrative continuity.
          Hidden when blank (first-ever brief, or nothing material changed). */}
      {brief?.whatChanged && brief.whatChanged.trim() && (
        <section className="flex items-start gap-2.5 rounded-xl border border-accent-border bg-accent-soft/50 px-4 py-3">
          <span className="mt-0.5 shrink-0 rounded-md bg-accent px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">Since last brief</span>
          <p className="text-sm leading-6 text-ink-2">{brief.whatChanged}</p>
        </section>
      )}

      {/* Top Actions Today + Hedging Call + Cash Deployment — at-a-glance
          executive summary. Renders only when the brief has the new fields
          populated (old briefs in pm:brief pre-date these and fall through
          gracefully).

          Layout: Top Actions spans 2 cols on wide screens; Hedging and Cash
          Deployment each take 1 col. On narrow screens everything stacks
          single-column. */}
      {(topActionsToday.length > 0 || hedgingCall || cashDeploymentCall) && (
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {topActionsToday.length > 0 && (
            <div className="md:col-span-2 rounded-2xl border border-line bg-white p-5 shadow-sm">
              <div className="text-xs font-bold uppercase tracking-[0.22em] text-ink-3 mb-3">
                Top actions today
              </div>
              <ul className="space-y-2">
                {topActionsToday.map((action, i) => (
                  <li key={i} className="flex items-start gap-3 text-sm leading-6 text-ink">
                    <span className="mt-[3px] inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-ink text-[10px] font-bold text-white">
                      {i + 1}
                    </span>
                    <span>{action}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {hedgingCall && (
            <div className={`rounded-2xl border p-5 shadow-sm ${
              hedgingCall.action === "ADD"
                ? "border-neg-border bg-neg-soft"
                : hedgingCall.action === "SKIP"
                  ? "border-pos-border bg-pos-soft"
                  : "border-line bg-surface-2"
            }`}>
              <div className={`text-xs font-bold uppercase tracking-[0.22em] mb-3 ${
                hedgingCall.action === "ADD"
                  ? "text-neg"
                  : hedgingCall.action === "SKIP"
                    ? "text-pos"
                    : "text-ink-2"
              }`}>
                Hedging
              </div>
              <div className="flex items-baseline gap-2 mb-2">
                <span className={`text-2xl font-semibold tracking-tight ${
                  hedgingCall.action === "ADD"
                    ? "text-neg"
                    : hedgingCall.action === "SKIP"
                      ? "text-pos"
                      : "text-ink"
                }`}>
                  {hedgingCall.action}
                </span>
                {hedgingCall.action === "ADD" && (hedgingCall.strike || hedgingCall.tenor) && (
                  <span className="text-sm text-ink-2">
                    {[hedgingCall.tenor, hedgingCall.strike].filter(Boolean).join(" · ")}
                  </span>
                )}
              </div>
              <p className="text-sm leading-5 text-ink-2">
                {hedgingCall.reason}
              </p>
            </div>
          )}
          {cashDeploymentCall && (() => {
            const action = cashDeploymentCall.action;
            const tone =
              action === "DEPLOY"
                ? { border: "border-pos-border", bg: "bg-pos-soft", label: "text-pos", value: "text-pos" }
                : action === "WAIT"
                  ? { border: "border-warn-border", bg: "bg-warn-soft", label: "text-warn", value: "text-warn" }
                  : { border: "border-accent-border", bg: "bg-accent-soft", label: "text-accent", value: "text-accent" };
            const windowToneClass =
              deploymentWindowStatus.tone === "amber" ? "bg-warn-soft text-warn"
              : deploymentWindowStatus.tone === "orange" ? "bg-orange-100 text-orange-800"
              : deploymentWindowStatus.tone === "rose" ? "bg-neg-soft text-neg"
              : "bg-surface-2 text-ink-2";
            return (
              <div className={`rounded-2xl border p-5 shadow-sm ${tone.border} ${tone.bg}`}>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className={`text-xs font-bold uppercase tracking-[0.22em] ${tone.label}`}>
                    Cash Deployment
                  </div>
                  {typeof cashDeploymentCall.score === "number" && (
                    <span className="text-[10px] font-bold text-ink-3" title="Composite score 0-100">
                      {cashDeploymentCall.score}/100
                    </span>
                  )}
                </div>
                <div className="flex items-baseline gap-2 mb-2 flex-wrap">
                  <span className={`text-2xl font-semibold tracking-tight ${tone.value}`}>
                    {action === "DEPLOY_PARTIAL" ? "PARTIAL" : action}
                  </span>
                  <span className="text-xs text-ink-2">{cashDeploymentCall.window}</span>
                </div>
                <p className="text-sm leading-5 text-ink-2 mb-2.5">
                  {cashDeploymentCall.reason}
                </p>
                {cashDeploymentCall.newtonPersistence && (
                  <p className="text-xs leading-5 text-ink-2 italic mb-2.5">
                    Newton: {cashDeploymentCall.newtonPersistence}
                  </p>
                )}
                {(cashDeploymentCall.triggersMet?.length || cashDeploymentCall.triggersMissing?.length) ? (
                  <div className="space-y-1 mb-2.5 text-[11px] leading-4">
                    {cashDeploymentCall.triggersMet?.slice(0, 4).map((t, i) => (
                      <div key={`m${i}`} className="flex items-start gap-1 text-pos">
                        <span className="flex-none mt-[1px]">✓</span>
                        <span>{t}</span>
                      </div>
                    ))}
                    {cashDeploymentCall.triggersMissing?.slice(0, 4).map((t, i) => (
                      <div key={`x${i}`} className="flex items-start gap-1 text-ink-3">
                        <span className="flex-none mt-[1px]">·</span>
                        <span>{t}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className={`mt-2 -mx-2 -mb-1 px-2 py-1 rounded-md text-[10px] font-semibold ${windowToneClass}`}>
                  {deploymentWindowStatus.label}
                </div>
              </div>
            );
          })()}
        </section>
      )}

      {/* Composite Signal — the weighted regime read that DETERMINES the regime,
          surfaced high on the page (right under the at-a-glance actions) rather
          than buried below the Forward View. */}
      <section className="rounded-2xl border border-line bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base">🔍</span>
          <h2 className="text-base font-semibold">Composite Signal</h2>
          <SignalPill tone={compositeSignalTone}>{marketData.compositeSignal}</SignalPill>
          <span className="text-xs text-ink-3">
            Conviction: {marketData.conviction}
          </span>
          {brief?.marketRegime && (
            <SignalPill tone={brief.marketRegime === "Risk-Off" ? "red" : brief.marketRegime === "Risk-On" ? "green" : "amber"}>
              {brief.marketRegime}
            </SignalPill>
          )}
        </div>
        <p className="mt-1 text-xs text-ink-3">
          The deterministic regime read — what the tape and macro data say the market <strong className="text-ink-2">is</strong> doing, and what to focus on.
        </p>
        <ClampText text={compositeAnalysis} className="mt-2" />
      </section>

      {/* Non-consensus edge — what the tape may be under-pricing. Distilled
          across all integrated sources; hidden when the model returns blank. */}
      {brief?.underpriced && brief.underpriced.trim() && (
        <section className="rounded-2xl border border-violet-soft bg-violet-soft/40 p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="text-base">💡</span>
            <h2 className="text-base font-semibold">What the tape may be under-pricing</h2>
            <span className="text-[10px] font-bold uppercase tracking-wider text-violet">Non-consensus</span>
          </div>
          <p className="text-sm leading-6 text-ink-2">{brief.underpriced}</p>
        </section>
      )}

      {/* Forward View — Next 2 Weeks */}
      <section className="rounded-2xl border border-accent-border bg-gradient-to-br from-accent-soft/60 to-white p-4 md:p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base">🧭</span>
            <h2 className="text-base font-semibold text-ink">Forward View — Multi-Horizon</h2>
            {forwardLoading && <span className="text-xs text-accent animate-pulse">Fetching live data...</span>}
            {activeForward && (
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase leading-none ${
                  activeForward.fredEnabled
                    ? "bg-pos-soft text-pos"
                    : "bg-surface-2 text-ink-3"
                }`}
                title={
                  activeForward.fredEnabled
                    ? "FRED API connected — rates and credit use official end-of-day series"
                    : "FRED API key not configured — rates use Yahoo ^TNX/^IRX. Add FRED_API_KEY to .env.local for DGS10/DGS2/DGS3MO/HY OAS/IG OAS."
                }
              >
                {activeForward.fredEnabled ? "FRED + Yahoo" : "Yahoo only"}
              </span>
            )}
          </div>
          {brief?.marketRegime && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-ink-3">Regime</span>
              <SignalPill tone={brief.marketRegime === "Risk-Off" ? "red" : brief.marketRegime === "Risk-On" ? "green" : "amber"}>
                {brief.marketRegime}
              </SignalPill>
              {typeof brief.regimeScore === "number" && (
                <span className="text-xs text-ink-3">
                  score {brief.regimeScore >= 0 ? "+" : ""}{brief.regimeScore}
                </span>
              )}
            </div>
          )}
        </div>
        {/* Three-horizon outlook cards. Each card pairs the AI text with the
            deterministic horizon composite from pm:market-regime so the PM
            sees both qualitative and quantitative reads side-by-side. Stacks
            vertically on mobile, 3 columns from md upward. The legacy single
            "forwardView" synthesis sits in a slim row below the cards. */}
        {(() => {
          const horizonsData = marketRegime?.horizons;
          const cards: { id: "tactical" | "cyclical" | "structural"; label: string; weight: string; text: string; invalidator?: string; accent: string }[] = [
            { id: "tactical", label: "Tactical · 1–3M", weight: "50%", text: tacticalView, invalidator: brief?.tacticalInvalidator, accent: "border-accent-border bg-accent-soft/40" },
            { id: "cyclical", label: "Cyclical · 3–6M", weight: "30%", text: cyclicalView, invalidator: brief?.cyclicalInvalidator, accent: "border-pos-border bg-pos-soft/40" },
            { id: "structural", label: "Structural · 6–12M", weight: "20%", text: structuralView, invalidator: brief?.structuralInvalidator, accent: "border-violet-soft bg-violet-soft/40" },
          ];
          return (
            <div className="mb-5 grid gap-3 grid-cols-1 md:grid-cols-3">
              {cards.map((c) => {
                const b = horizonsData?.byHorizon[c.id];
                const empty = !b || b.total === 0;
                const tone: "green" | "red" | "amber" = empty
                  ? "amber"
                  : b!.label_ === "Risk-On"
                  ? "green"
                  : b!.label_ === "Risk-Off"
                  ? "red"
                  : "amber";
                return (
                  <div key={c.id} className={`rounded-xl border p-3 ${c.accent}`}>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-ink-2">{c.label}</span>
                        <span className="text-[9px] font-semibold text-ink-3">×{c.weight}</span>
                      </div>
                      {b && !empty && (
                        <SignalPill tone={tone}>
                          <span title={`${b.riskOn} risk-on, ${b.riskOff} risk-off, of ${b.total} signal${b.total === 1 ? "" : "s"} in this horizon`}>
                            {b.label_}
                            <span className="mx-1.5 opacity-50">·</span>
                            <span className="font-mono opacity-80">
                              {b.riskOn}↑ {b.riskOff}↓ <span className="opacity-60">/ {b.total}</span>
                            </span>
                          </span>
                        </SignalPill>
                      )}
                      {(!b || empty) && (
                        <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] text-ink-3">
                          no signals
                        </span>
                      )}
                    </div>
                    <p className="text-sm leading-6 text-ink-2">{c.text}</p>
                    {c.invalidator && (
                      <div className="mt-2 pt-2 border-t border-line/70 flex items-start gap-1.5">
                        <span className="text-[9px] font-bold uppercase tracking-wider text-ink-3 mt-[1px] flex-none">
                          Invalidator
                        </span>
                        <span className="text-xs leading-5 text-ink-2 italic">
                          {c.invalidator}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}

        {/* Synthesis block retired (2026-07): it was the legacy "forwardView"
            tie-together paragraph, which overlapped the Bottom Line + the three
            horizon cards (the redundancy that watered down all three). The
            weighted-composite readout still lives in the By-Horizon rollup row
            above; forwardView is still generated for backward-compat but no
            longer rendered. */}

        {/* Visible banner when the forward-looking fetch fails or returns
            no tiles at all — so the user knows the panel is unavailable
            rather than silently blank. */}
        {(forwardError || (!activeForward && !forwardLoading)) && (
          <div className="mb-5 rounded-xl border border-warn-border bg-warn-soft px-4 py-3 text-xs text-warn">
            <strong className="font-semibold">Forward-looking data unavailable:</strong>{" "}
            {forwardError ??
              "The /api/forward-looking endpoint returned no data. Tile values will fill in on the next successful refresh."}
          </div>
        )}

        {/* Deterministic Market Regime strip — derived from pm:market-regime.
            Sits above the macro tiles so the PM can anchor on the composite
            read before scanning individual indicators. */}
        {marketRegime && <MarketRegimeStrip regime={marketRegime} />}

        {activeForward && (
          <div className="space-y-6 mb-5">
            {/* Horizon legend — explains the small color chips on each
                tile. Mirrors the Forward View horizon palette. */}
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line-soft bg-surface-2/60 px-3 py-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-ink-3">Horizon</span>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${HORIZON_CHIP.tactical.cls}`}>
                Tactical · 1–3M
              </span>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${HORIZON_CHIP.cyclical.cls}`}>
                Cyclical · 3–6M
              </span>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${HORIZON_CHIP.structural.cls}`}>
                Structural · 6–12M
              </span>
              <span className="text-[11px] text-ink-3">
                · Each indicator is tagged with the horizon it speaks to most directly.
              </span>
            </div>

            {/* Macro tile-grid cards in a 2×2 layout (matches the mockup). */}
            <div className="grid gap-5 md:grid-cols-2 items-start">
            {/* Breadth & Trend — SPX trajectory plus % of index above
                key DMAs. Tells you whether a move is broad or narrow. */}
            <BriefSection
              title="Breadth & Trend"
              subtitle="SPX trajectory and how broadly the move is participating."
              accent="blue"
            >
              <div className="grid gap-3 grid-cols-2 md:grid-cols-3">
                <ForwardTile label="S&P 500 YTD" point={activeForward.spxYtd} unit="%" horizon="cyclical" />
                <ForwardTile label="S&P 500 Week" point={activeForward.spxWeek} unit="%" horizon="tactical" />
                <ForwardTile label="S&P >200DMA (wk)" point={activeForward.breadth200Wk} unit="%" deltaUnit="pp" deltaPeriod="wk/wk" horizon="cyclical" />
                <ForwardTile label="S&P >200DMA (mo)" point={activeForward.breadth200Mo} unit="%" deltaUnit="pp" deltaPeriod="mo/mo" horizon="cyclical" />
                <ForwardTile label="S&P >50DMA (wk)" point={activeForward.breadth50Wk} unit="%" deltaUnit="pp" deltaPeriod="wk/wk" horizon="tactical" />
                {activeForward.breadthBroad_200Wk && (
                  <ForwardTile label="Broad >200DMA (wk)" point={activeForward.breadthBroad_200Wk} unit="%" deltaUnit="pp" deltaPeriod="wk/wk" horizon="cyclical" />
                )}
                {activeForward.breadthBroad_200Mo && (
                  <ForwardTile label="Broad >200DMA (mo)" point={activeForward.breadthBroad_200Mo} unit="%" deltaUnit="pp" deltaPeriod="mo/mo" horizon="cyclical" />
                )}
                {activeForward.breadthBroad_50Wk && (
                  <ForwardTile label="Broad >50DMA (wk)" point={activeForward.breadthBroad_50Wk} unit="%" deltaUnit="pp" deltaPeriod="wk/wk" horizon="tactical" />
                )}
                {activeForward.newHighsWk && (
                  <ForwardTile label="NYSE New Highs" point={activeForward.newHighsWk} unit="" deltaPeriod="wk/wk" horizon="tactical" />
                )}
                {activeForward.newLowsWk && (
                  <ForwardTile label="NYSE New Lows" point={activeForward.newLowsWk} unit="" deltaPeriod="wk/wk" horizon="tactical" />
                )}
                {activeForward.upVolumePct && (
                  <ForwardTile label="NYSE Up Volume" point={activeForward.upVolumePct} unit="%" deltaUnit="pp" deltaPeriod="wk/wk" horizon="tactical" />
                )}
              </div>
            </BriefSection>

            {/* Valuation — SPY multiples and implied growth. Where
                the tape is priced relative to earnings. */}
            <BriefSection
              title="Valuation & Growth"
              subtitle="SPY multiples and the growth priced in at today's level."
              accent="emerald"
            >
              <div className="grid gap-3 grid-cols-2">
                <ForwardTile label="SPY Forward P/E" point={activeForward.spyForwardPE} horizon="structural" />
                <ForwardTile label="SPY Trailing P/E" point={activeForward.spyTrailingPE} horizon="structural" />
                <ForwardTile label="Implied 1Y EPS Growth (P/E)" point={activeForward.impliedEpsGrowth} unit="%" horizon="cyclical" />
                <ForwardTile label="Est 3-5Y EPS Growth" point={activeForward.eps35Growth} unit="%" horizon="structural" />
              </div>
            </BriefSection>

            {/* Rates & Curve — Treasury yields and two curve measures.
                Drives discount-rate + growth expectations. */}
            <BriefSection
              title="Rates & Curve"
              subtitle="Treasury yields and curve shape — the discount rate backdrop."
              accent="amber"
            >
              <div className="grid gap-3 grid-cols-2 md:grid-cols-3">
                <ForwardTile label="10Y Treasury" point={activeForward.yield10y} unit="%" deltaUnit="raw" horizon="structural" />
                <ForwardTile label="2Y Treasury" point={activeForward.yield2y} unit="%" deltaUnit="raw" horizon="cyclical" />
                <ForwardTile label="3M T-Bill" point={activeForward.yield3m} unit="%" deltaUnit="raw" horizon="tactical" />
                <ForwardTile label="10Y-2Y Curve" point={activeForward.curve10y2y} unit="bps" horizon="structural" />
                <ForwardTile label="10Y-3M Curve" point={activeForward.curve10y3m} unit="bps" horizon="structural" />
              </div>
            </BriefSection>

            {/* Risk & Volatility — credit spreads + vol surface.
                First place stress shows up before it hits price. */}
            <BriefSection
              title="Credit & Volatility"
              subtitle="Credit spreads and vol surface — where stress shows up first."
              accent="rose"
            >
              <div className="grid gap-3 grid-cols-2">
                <ForwardTile label="HY OAS Trend" point={activeForward.hyOasTrend} unit="bps" deltaUnit="bps" invertDeltaColor horizon="cyclical" />
                <ForwardTile label="IG OAS Trend" point={activeForward.igOasTrend} unit="bps" deltaUnit="bps" invertDeltaColor horizon="cyclical" />
                <ForwardTile label="VIX (wk/wk)" point={activeForward.vixWeek} deltaUnit="pct" invertDeltaColor horizon="tactical" />
                <ForwardTile label="MOVE (wk/wk)" point={activeForward.moveWeek} deltaUnit="pct" invertDeltaColor horizon="tactical" />
              </div>
            </BriefSection>
            </div>{/* /2×2 tile-grid */}
          </div>
        )}

        {brief?.regimeSignals && brief.regimeSignals.length > 0 && (
          <div className="rounded-2xl border border-line-soft bg-white/70 p-4">
            <div className="text-[10px] font-bold uppercase tracking-wider text-ink-3 mb-2">
              Regime Drivers (deterministic)
            </div>
            <div className="flex flex-wrap gap-2">
              {brief.regimeSignals.map((signal, i) => (
                <span
                  key={i}
                  className="rounded-full bg-surface-2 px-3 py-1 text-xs font-medium text-ink-2"
                >
                  {signal}
                </span>
              ))}
            </div>
          </div>
        )}

        {activeForward?.fetchedAt && (
          <p className="text-[10px] text-ink-3 mt-3">
            Data fetched {new Date(activeForward.fetchedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}
            {" · "}Click any icon to verify the source.
          </p>
        )}
      </section>

      {/* Contrarian Sentiment — all 4 indicators + Claude analysis */}
      <SentimentGauges
        marketData={marketData}
        aaiiBull={marketData.aaiiBull ?? 30}
        aaiiNeutral={marketData.aaiiNeutral ?? 17}
        aaiiBear={marketData.aaiiBear ?? 52}
        contrarianAnalysis={contrarianAnalysis}
        forwardData={activeForward}
      />

      {/* Credit & Volatility — values pulled from auto-fetched ForwardLookingData */}
      {(() => {
        const fmtNum = (v: number | null | undefined): string =>
          v == null ? "—" : String(v);
        const hyVal = activeForward?.hyOasTrend?.value ?? null;
        const igVal = activeForward?.igOasTrend?.value ?? null;
        const vixVal = activeForward?.vixWeek?.value ?? null;
        const moveVal = activeForward?.moveWeek?.value ?? null;
        const breadth200Val = activeForward?.breadth200Wk?.value ?? null;
        const breadth50Val = activeForward?.breadth50Wk?.value ?? null;
        return (
      <>
      <section className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-line bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-base">📉</span>
              <h3 className="text-base font-semibold">Credit Spreads</h3>
            </div>
            <SignalPill tone={hyVal != null && hyVal >= 300 ? "red" : hyVal != null && hyVal >= 200 ? "amber" : "green"}>
              {hyVal != null && hyVal >= 300 ? "Widening" : hyVal != null && hyVal >= 200 ? "Neutral" : "Tight"}
            </SignalPill>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="rounded-xl bg-surface-2 p-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">HY OAS</div>
              <div className="mt-1 text-xl font-bold">{fmtNum(hyVal)} <span className="text-xs font-normal text-ink-3">bps</span></div>
            </div>
            <div className="rounded-xl bg-surface-2 p-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">IG OAS</div>
              <div className="mt-1 text-xl font-bold">{fmtNum(igVal)} <span className="text-xs font-normal text-ink-3">bps</span></div>
            </div>
          </div>
          <p className="mt-2 text-xs text-ink-3">Trend: {hyVal != null && hyVal >= 300 ? "Widening modestly" : "Stable"}</p>
          <ClampText text={creditAnalysis} className="mt-1.5" />
        </div>

        <div className="rounded-2xl border border-line bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-base">⚡</span>
              <h3 className="text-base font-semibold">Volatility Regime</h3>
            </div>
            <SignalPill tone={vixVal != null && vixVal >= 22 ? "red" : vixVal != null && vixVal >= 16 ? "amber" : "green"}>
              {vixVal != null && vixVal >= 22 ? "Elevated" : vixVal != null && vixVal >= 16 ? "Moderate" : "Low"}
            </SignalPill>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <div className="rounded-xl bg-surface-2 p-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">VIX</div>
              <div className="mt-1 text-xl font-bold">{fmtNum(vixVal)}</div>
            </div>
            <div className="rounded-xl bg-surface-2 p-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">TERM</div>
              <div className="mt-1 text-sm font-bold">{marketData.termStructure}</div>
            </div>
            <div className="rounded-xl bg-surface-2 p-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">MOVE</div>
              <div className="mt-1 text-xl font-bold">{fmtNum(moveVal)}</div>
            </div>
          </div>
          <ClampText text={volatilityAnalysis} className="mt-3" />
        </div>

        {/* Breadth & Structure — third card in the row (mockup). */}
        <div className="rounded-2xl border border-line bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-base">📊</span>
              <h3 className="text-base font-semibold">Breadth &amp; Structure</h3>
            </div>
            <SignalPill tone={breadth200Val != null && breadth200Val <= 50 ? "red" : breadth200Val != null && breadth200Val >= 65 ? "green" : "amber"}>
              {breadth200Val != null && breadth200Val <= 50 ? "Weak" : breadth200Val != null && breadth200Val >= 65 ? "Healthy" : "Mixed"}
            </SignalPill>
          </div>
          <div className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between border-b border-line-soft pb-2">
              <span className="text-ink-3">S&amp;P 500 % &gt; 200 DMA</span>
              <span className="font-mono font-medium">{breadth200Val != null ? `${breadth200Val}%` : "—"}</span>
            </div>
            <div className="flex justify-between pb-1">
              <span className="text-ink-3">S&amp;P 500 % &gt; 50 DMA</span>
              <span className="font-mono font-medium">{breadth50Val != null ? `${breadth50Val}%` : "—"}</span>
            </div>
          </div>
          <ClampText text={breadthAnalysis} className="mt-3" />
        </div>

        {/* Fund Flows & Positioning tile retired in 2026-05. Flows
            are inherently backward-looking and contrarianAnalysis
            already covers sentiment / positioning extremes. The
            attached JPM screenshots upload section was also removed
            with this change. */}
      </section>
      </>
        );
      })()}

      {/* Portfolio Risk Scan (left, wider) + Hedging Window (right) — 2-col
          row matching the mockup. Risk Scan hides when empty; the Hedging
          Window always renders. */}
      <section className="grid gap-4 lg:grid-cols-5 items-start">
        {riskScan && riskScan.length > 0 ? (
          <div className="lg:col-span-3 rounded-2xl border border-line bg-white p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-base font-semibold">Portfolio Risk Scan</h3>
              <span className="text-xs font-semibold text-neg">{riskScan.length} flagged</span>
            </div>
            <div className="divide-y divide-line-soft">
              {riskScan.map((item, i) => {
                const badge =
                  item.priority === "High"
                    ? { label: "HIGH", cls: "bg-neg text-white" }
                    : item.priority === "Medium-High"
                    ? { label: "MED", cls: "bg-warn text-white" }
                    : item.priority === "Medium"
                    ? { label: "MED", cls: "bg-warn text-white" }
                    : { label: "LOW", cls: "bg-ink-3 text-white" };
                return (
                  <div key={i} className="flex items-start gap-3 py-3 first:pt-2">
                    <span className={`mt-0.5 shrink-0 rounded-md px-2 py-0.5 text-[10px] font-bold tracking-wide ${badge.cls}`}>
                      {badge.label}
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm">
                        <span className="font-mono font-bold text-ink">{displayTicker(item.ticker)}</span>
                        {item.action && <span className="text-ink-2"> · {item.action}</span>}
                      </div>
                      <p className="mt-0.5 text-sm leading-6 text-ink-3">{item.summary}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="lg:col-span-3" />
        )}

        {/* Hedging Window */}
        <div className="lg:col-span-2">
          <HedgingIndicator
            vix={activeForward?.vixWeek?.value ?? 20}
            termStructure={marketData.termStructure}
            fearGreed={activeForward?.fearGreed?.value ?? marketData.fearGreed}
            hedgingAnalysis={hedgingAnalysis}
            horizons={marketRegime?.horizons}
            compact
          />
        </div>
      </section>

      {/* Sector Rotation */}
      {sectorRotation && (
        <section className="rounded-2xl border border-line bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-base">🔄</span>
            <h3 className="text-base font-semibold">Sector Rotation</h3>
          </div>
          <ClampText text={sectorRotation.summary} className="mb-4" />
          {brief?.sectorPerformance && brief.sectorPerformance.length > 0 ? (
            /* Live per-sector heatmap tiles, sorted best→worst (mockup). */
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {[...brief.sectorPerformance]
                .sort((a, b) => (b.dayPct ?? -Infinity) - (a.dayPct ?? -Infinity))
                .map((s) => {
                  const pos = (s.dayPct ?? 0) >= 0;
                  return (
                    <div key={s.etf} className="rounded-xl border border-line-soft bg-surface-2/50 p-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-mono text-sm font-bold text-ink">{s.etf}</span>
                        <span className={`font-mono text-sm font-semibold ${s.dayPct == null ? "text-ink-3" : pos ? "text-pos" : "text-neg"}`}>
                          {s.dayPct == null ? "—" : `${pos ? "+" : ""}${s.dayPct.toFixed(2)}%`}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-ink-3 truncate">{s.sector}</div>
                    </div>
                  );
                })}
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <div className="text-xs font-bold uppercase tracking-wider text-pos mb-1.5">LEADING</div>
                {sectorRotation.leading.map((s, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm text-pos mb-1">
                    <span>▲</span> <span>{s}</span>
                  </div>
                ))}
              </div>
              <div>
                <div className="text-xs font-bold uppercase tracking-wider text-neg mb-1.5">LAGGING</div>
                {sectorRotation.lagging.map((s, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm text-neg mb-1">
                    <span>▼</span> <span>{s}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <ClampText text={sectorRotation.pmImplication} className="mt-3" textClassName="text-sm italic leading-6 text-ink-3" lines={2} />
        </section>
      )}

      {/* Action Items section retired (2026-07): it duplicated the
          Top Actions Today one-liners near the top of the brief. forwardActions
          is still generated (and still feeds topActionsToday) — just no longer
          rendered as a separate lengthy panel. */}
    </>
  );
}
