"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import type {
  MarketData,
  MorningBrief as MorningBriefType,
  Stock,
  ScoredStock,
  ForwardLookingBundle,
  ForwardPointBundle,
} from "@/app/lib/types";
import { SignalPill } from "./SignalPill";
import { LoadingOverlay } from "./LoadingSpinner";
import { SentimentGauges } from "./SentimentGauges";
import { HedgingIndicator } from "./HedgingIndicator";
import { ImageUpload, LightboxModal, type BriefAttachment } from "./ImageUpload";
import type { MarketRegimeData, RegimeDirection } from "@/app/lib/market-regime";

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
            ? "bg-blue-600 text-white hover:bg-blue-700 shadow-sm cursor-pointer"
            : "text-emerald-400"
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
          className="absolute right-7 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-blue-600 text-white hover:bg-blue-700 shadow-sm cursor-pointer transition-all"
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
        className="w-full rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-2.5 text-left text-sm text-slate-400 hover:bg-white hover:border-slate-300 transition-all"
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
        className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm leading-relaxed focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all outline-none resize-y min-h-[80px] max-h-[300px]"
      />
      <div className="flex items-center justify-between mt-1">
        <span className="text-[10px] text-slate-400">
          {wordCount > 0 ? `${wordCount} words` : "empty"}
        </span>
        <div className="flex items-center gap-2">
          {isDirty && (
            <button
              onClick={handleSave}
              className="rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-bold text-white hover:bg-blue-700 transition-all"
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
              className="text-[10px] text-slate-400 hover:text-red-500 transition-colors"
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
  const accentMap: Record<typeof accent, { bar: string; text: string; dot: string; panel: string }> = {
    blue:    { bar: "bg-blue-500",    text: "text-blue-700",    dot: "bg-blue-400",    panel: "border-l-blue-500" },
    emerald: { bar: "bg-emerald-500", text: "text-emerald-700", dot: "bg-emerald-400", panel: "border-l-emerald-500" },
    amber:   { bar: "bg-amber-500",   text: "text-amber-700",   dot: "bg-amber-400",   panel: "border-l-amber-500" },
    rose:    { bar: "bg-rose-500",    text: "text-rose-700",    dot: "bg-rose-400",    panel: "border-l-rose-500" },
  };
  const a = accentMap[accent];
  return (
    <section className={`rounded-2xl border border-slate-200 border-l-4 ${a.panel} bg-white/60 shadow-sm overflow-hidden`}>
      <header className="flex items-baseline gap-2 px-4 pt-3 pb-2">
        <span className={`inline-block h-2 w-2 rounded-full ${a.dot}`} />
        <h3 className={`text-sm font-bold tracking-tight ${a.text}`}>{title}</h3>
        <span className="text-xs text-slate-400 truncate">· {subtitle}</span>
      </header>
      <div className="border-t border-slate-100 px-4 py-3">{children}</div>
    </section>
  );
}

/** Composite pill tone helper for the Market Regime strip. */
function regimePillClasses(direction: RegimeDirection): string {
  if (direction === "risk-on") return "border-emerald-300 bg-emerald-50 text-emerald-700";
  if (direction === "risk-off") return "border-red-300 bg-red-50 text-red-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
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
    <div className="mb-5 rounded-2xl border border-slate-200 bg-white/80 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Market Regime</span>
          <SignalPill tone={labelTone}>{label}</SignalPill>
          <span className="text-xs text-slate-400">
            {comp.score}/{comp.total} risk-on signals
          </span>
        </div>
        <span
          className="text-[10px] text-slate-400"
          title={`Computed from Yahoo Finance at ${regime.computedAt}`}
        >
          Yahoo-derived · cached 30m
        </span>
      </div>

      {comp.signals.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {comp.signals.map((s, i) => (
            <span
              key={i}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${regimePillClasses(s.direction)}`}
              title={s.detail}
            >
              <span className="font-semibold">{s.name}</span>
              <span className="opacity-70">· {s.detail}</span>
            </span>
          ))}
        </div>
      )}

      {crossRow.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2 border-t border-slate-100 text-[11px] text-slate-500">
          {crossRow.map((r, i) => (
            <span key={i}>
              <span className="font-semibold text-slate-600">{r.label}</span>{" "}
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
function ForwardTile({
  label,
  point,
  unit = "",
  deltaUnit,
  deltaPeriod = "wk/wk",
  invertDeltaColor = false,
}: {
  label: string;
  point: ForwardPointBundle | undefined;
  unit?: string;
  deltaUnit?: "bps" | "pct" | "raw" | "pp";
  deltaPeriod?: "wk/wk" | "mo/mo";
  invertDeltaColor?: boolean;
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
      ? "text-slate-400"
      : (invertDeltaColor ? !deltaPositive : deltaPositive)
      ? "text-emerald-600"
      : "text-red-600";

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
    <div className="rounded-2xl border border-slate-100 bg-slate-50/60 p-3 md:p-4">
      <div className="flex items-start justify-between gap-2 mb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          {label}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          <LiveStatusBadge status={badgeStatus} reason={badgeReason} />
          {point?.source && (
            <a
              href={point.source}
              target="_blank"
              rel="noopener noreferrer"
              title={`${point.sourceLabel}${point.note ? " — " + point.note : ""}`}
              className="text-blue-400 hover:text-blue-600 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          )}
        </div>
      </div>
      <div className="text-2xl font-bold text-slate-800 leading-tight">
        {available ? (
          <>
            {point!.value}
            {unit && <span className="text-sm font-normal text-slate-400 ml-1">{unit}</span>}
          </>
        ) : (
          <span className="text-base font-normal text-slate-400">N/A</span>
        )}
      </div>
      {deltaStr ? (
        <div className={`text-xs font-semibold mt-0.5 ${deltaColor}`}>{deltaStr}</div>
      ) : available && deltaUnit && point?.previous == null ? (
        <div
          className="text-xs font-medium mt-0.5 text-slate-400"
          title="Prior snapshot not yet in history cache. Deltas will populate as subsequent refreshes accumulate."
        >
          {deltaPeriod ?? "wk/wk"} building…
        </div>
      ) : null}
      {point?.sourceLabel && (
        <div className="text-[10px] text-slate-400 mt-1 truncate" title={point.note}>
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
      <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700 uppercase leading-none">
        Live
      </span>
    );
  }
  if (status === "not-configured") {
    return (
      <span
        title={reason ?? "Source not configured — manual value shown"}
        className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-500 uppercase leading-none cursor-help"
      >
        Manual
      </span>
    );
  }
  return (
    <span
      title={reason ?? "Auto-fetch failed — last saved value shown"}
      className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-700 uppercase leading-none cursor-help"
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
  // generation). The upload widgets have their own internal lightbox;
  // this separate state is only for the rendered-brief display.
  const [flowsLightboxId, setFlowsLightboxId] = useState<string | null>(null);

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
  useEffect(() => {
    if (!attachmentsHydrated) return;
    if (manifestSaveTimer.current) clearTimeout(manifestSaveTimer.current);
    const snapshot = attachments.map((a) => ({
      id: a.id,
      label: a.label,
      section: a.section,
      addedAt: a.addedAt,
    }));
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
  const activeForward = brief?.forwardLooking ?? forwardData;

  async function generateBrief() {
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

      const res = await fetch("/api/morning-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketData,
          holdings: stocks,
          attachmentRefs,
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
      // Auto-set equity flows from JPM screenshot analysis
      if (data.autoEquityFlows) {
        marketUpdates.equityFlows = data.autoEquityFlows;
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

  const forwardView =
    brief?.forwardView ||
    "The Forward View (next 2 weeks) will appear here after generating the brief. Automated forward-looking data below is already live and verifiable.";

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

  const flowsAnalysis =
    brief?.flowsAnalysis ||
    "Fund flows & positioning analysis will appear here after generating the brief.";

  const hedgingAnalysis = brief?.hedgingAnalysis || "";

  const contrarianAnalysis = brief?.contrarianAnalysis || "";

  const sectorRotation = brief?.sectorRotation || null;

  const riskScan = brief?.riskScan || null;

  const forwardActions = brief?.forwardActions || [];

  const compositeSignalTone = marketData.compositeSignal.toLowerCase().includes("bear")
    ? "red" as const
    : marketData.compositeSignal.toLowerCase().includes("bull")
    ? "green" as const
    : "amber" as const;

  return (
    <>
      {/* Editable Market & Sentiment Inputs */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 md:p-5 shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <h3 className="text-base font-semibold text-slate-800">Daily Market Input</h3>
          {liveLoading && <span className="text-xs text-blue-500 animate-pulse">Fetching live data...</span>}
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
              <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                <strong className="font-semibold">Auto-fetch unavailable:</strong> {marketDataError}
              </div>
            );
          }
          if (failedKeys.length > 0 || notConfiguredKeys.length > 0) {
            return (
              <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 space-y-1">
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
        <div className="grid gap-6 lg:grid-cols-2 lg:gap-x-8 mb-6 border-t border-slate-100 pt-5">

        {/* ── Contrarian Indicators ── */}
        <div>
          <div className="flex items-center gap-3 mb-4">
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Contrarian Indicators</h4>
            <SignalPill tone="green">INVERTED SIGNALS</SignalPill>
          </div>
          {/* Two text inputs in a 2-col row, then the optional chart uploader
              spans the full half-width below — keeps inputs uniform and gives
              the screenshot drop zone enough room to show its drop label inline
              with the Browse button instead of wrapping into a tall column. */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">S&P Oscillator</label>
                <a href="https://app.marketedge.com/#!/markets" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-600 transition-colors" title="MarketEdge S&P Oscillator">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
              <SaveableNumericInput
                savedValue={marketData.spOscillator}
                onSave={(n) => onUpdateMarketData({ spOscillator: n })}
                allowNegative
                inputClassName="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-lg font-semibold focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all outline-none"
              />
              <p className="text-[10px] text-slate-400 mt-0.5">{marketData.spOscillator < 0 ? "Oversold (bullish)" : marketData.spOscillator > 0 ? "Overbought (bearish)" : "Neutral"}</p>
            </div>
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Put/Call Ratio</label>
                <a href="https://www.cboe.com/us/options/market_statistics/daily/" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-600 transition-colors" title="CBOE Total Put/Call">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
              <SaveableNumericInput
                savedValue={marketData.putCall}
                onSave={(n) => onUpdateMarketData({ putCall: n })}
                inputClassName="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-lg font-semibold focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all outline-none"
              />
              <p className="text-[10px] text-slate-400 mt-0.5">Total P/C ratio</p>
            </div>
          </div>
          <div className="mt-3">
            <div className="flex items-center gap-1.5 mb-1">
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Oscillator Chart (optional)</label>
            </div>
            <ImageUpload
              section="spOscillator"
              sectionLabel="S&P Oscillator chart"
              attachments={attachments}
              onAdd={addAttachment}
              onRemove={removeAttachment}
            />
            <p className="text-[10px] text-slate-400 mt-1">Drop a MarketEdge chart screenshot — Claude will read the shape, levels, and recent extremes for the contrarian section.</p>
          </div>
          <p className="mt-3 text-[11px] text-slate-400">
            CNN Fear &amp; Greed and AAII Sentiment are now auto-fetched on every load
            (with full history) — see the live tiles in the Contrarian Sentiment
            section below.
          </p>
        </div>

        {/* ── Other Manual Inputs ── */}
        <div>
          <div className="flex items-center gap-3 mb-4">
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Other Manual Inputs</h4>
          </div>
          {/* Same pattern as Contrarian Indicators: 2-col input row, then the
              JPM Flows screenshot uploader spans full half-width below. */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <div>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 mb-1">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">VIX Term Structure</label>
                <a href="http://vixcentral.com" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-600 transition-colors shrink-0" title="VIX Central">
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
                selectClassName="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-lg font-semibold focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all outline-none appearance-none"
              />
            </div>
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Equity Flows</label>
              </div>
              <SaveableSelect
                savedValue={marketData.equityFlows}
                onSave={(v) => onUpdateMarketData({ equityFlows: v })}
                options={[
                  { value: "Strong Inflows", label: "Strong Inflows" },
                  { value: "Moderate Inflows", label: "Moderate Inflows" },
                  { value: "Mixed", label: "Mixed" },
                  { value: "Moderate Outflows", label: "Moderate Outflows" },
                  { value: "Heavy Outflows", label: "Heavy Outflows" },
                ]}
                selectClassName="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all outline-none appearance-none"
              />
            </div>
          </div>
          <div className="mt-3">
            <div className="flex items-center gap-1.5 mb-1">
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">JPM Flows Report</label>
            </div>
            <ImageUpload
              section="equityFlows"
              sectionLabel="JPM Flows & Liquidity"
              attachments={attachments}
              onAdd={addAttachment}
              onRemove={removeAttachment}
              collapsibleThumbs
            />
          </div>
        </div>

        </div>{/* /lg:grid-cols-2 wrapper for the two manual-input sub-sections */}

        {/* ── Strategist Notes (Fundstrat) ── */}
        <div className="border-t border-slate-100 pt-5 mb-4">
          <div className="flex items-center gap-3 mb-3">
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Strategist Notes</h4>
            <span className="text-[10px] text-slate-400">Copy-paste daily reports — Claude will incorporate key takeaways into the brief</span>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="flex flex-wrap items-center gap-1.5 mb-1">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Mark Newton</label>
                <span className="text-[10px] text-slate-400">(Technical Strategy)</span>
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
                  className="ml-auto rounded-lg border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-500 outline-none focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all"
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
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Tom Lee</label>
                <span className="text-[10px] text-slate-400">(Head of Research)</span>
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
                  className="ml-auto rounded-lg border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-500 outline-none focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all"
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
            onClick={generateBrief}
            disabled={generating}
            className="rounded-2xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {generating ? "Generating..." : "\u21BB Refresh Brief"}
          </button>
          <span className="text-sm text-slate-400">
            VIX: <strong>{activeForward?.vixWeek?.value ?? "—"}</strong> | MOVE: <strong>{activeForward?.moveWeek?.value ?? "—"}</strong> | HY: <strong>{activeForward?.hyOasTrend?.value ?? "—"}</strong> | Osc: <strong>{marketData.spOscillator}</strong> | F&G: <strong>{marketData.fearGreed}</strong>
          </span>
        </div>
      </section>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          {error}
        </div>
      )}

      {attachmentsSaveError && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <strong>Screenshots not saved:</strong> {attachmentsSaveError}
        </div>
      )}

      {/* Header */}
      <header>
        <h1 className="text-4xl font-semibold tracking-tight">Morning Brief</h1>
        <p className="mt-2 text-xl text-slate-400">
          {brief?.date || marketData.date}
          {brief?.generatedAt && (
            <span className="ml-3 text-base text-slate-300">
              Generated {new Date(brief.generatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}
            </span>
          )}
        </p>
      </header>

      {/* Bottom Line */}
      <section className="relative rounded-2xl bg-amber-50 border border-amber-200 p-5 shadow-sm">
        {generating && <LoadingOverlay message="Claude is analyzing markets..." />}
        <div className="text-xs font-bold uppercase tracking-[0.22em] text-amber-700 mb-3">
          Bottom line
        </div>
        <p className="max-w-6xl text-sm leading-6 text-slate-800">
          {bottomLine}
        </p>
      </section>

      {/* Forward View — Next 2 Weeks */}
      <section className="rounded-2xl border border-blue-200 bg-gradient-to-br from-blue-50/60 to-white p-4 md:p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base">🧭</span>
            <h2 className="text-base font-semibold text-slate-800">Forward View — Next 2 Weeks</h2>
            {forwardLoading && <span className="text-xs text-blue-500 animate-pulse">Fetching live data...</span>}
            {activeForward && (
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase leading-none ${
                  activeForward.fredEnabled
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-slate-100 text-slate-500"
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
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Regime</span>
              <SignalPill tone={brief.marketRegime === "Risk-Off" ? "red" : brief.marketRegime === "Risk-On" ? "green" : "amber"}>
                {brief.marketRegime}
              </SignalPill>
              {typeof brief.regimeScore === "number" && (
                <span className="text-xs text-slate-400">
                  score {brief.regimeScore >= 0 ? "+" : ""}{brief.regimeScore}
                </span>
              )}
            </div>
          )}
        </div>
        <p className="max-w-6xl text-sm leading-6 text-slate-700 mb-5">
          {forwardView}
        </p>

        {/* Visible banner when the forward-looking fetch fails or returns
            no tiles at all — so the user knows the panel is unavailable
            rather than silently blank. */}
        {(forwardError || (!activeForward && !forwardLoading)) && (
          <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
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
            {/* Momentum & Breadth — SPX trajectory plus % of index above
                key DMAs. Tells you whether a move is broad or narrow. */}
            <BriefSection
              title="Momentum & Breadth"
              subtitle="SPX trajectory and how broadly the move is participating."
              accent="blue"
            >
              <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
                <ForwardTile label="S&P 500 YTD" point={activeForward.spxYtd} unit="%" />
                <ForwardTile label="S&P 500 Week" point={activeForward.spxWeek} unit="%" />
                <ForwardTile label="S&P >200DMA (wk)" point={activeForward.breadth200Wk} unit="%" deltaUnit="pp" deltaPeriod="wk/wk" />
                <ForwardTile label="S&P >200DMA (mo)" point={activeForward.breadth200Mo} unit="%" deltaUnit="pp" deltaPeriod="mo/mo" />
                <ForwardTile label="S&P >50DMA (wk)" point={activeForward.breadth50Wk} unit="%" deltaUnit="pp" deltaPeriod="wk/wk" />
              </div>
            </BriefSection>

            {/* Valuation — SPY multiples and implied growth. Where
                the tape is priced relative to earnings. */}
            <BriefSection
              title="Valuation"
              subtitle="SPY multiples and the growth priced in at today's level."
              accent="emerald"
            >
              <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                <ForwardTile label="SPY Forward P/E" point={activeForward.spyForwardPE} />
                <ForwardTile label="SPY Trailing P/E" point={activeForward.spyTrailingPE} />
                <ForwardTile label="Implied 1Y EPS Growth (P/E)" point={activeForward.impliedEpsGrowth} unit="%" />
                <ForwardTile label="Est 3-5Y EPS Growth" point={activeForward.eps35Growth} unit="%" />
              </div>
            </BriefSection>

            {/* Rates & Curve — Treasury yields and two curve measures.
                Drives discount-rate + growth expectations. */}
            <BriefSection
              title="Rates & Curve"
              subtitle="Treasury yields and curve shape — the discount rate backdrop."
              accent="amber"
            >
              <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
                <ForwardTile label="10Y Treasury" point={activeForward.yield10y} unit="%" deltaUnit="raw" />
                <ForwardTile label="2Y Treasury" point={activeForward.yield2y} unit="%" deltaUnit="raw" />
                <ForwardTile label="3M T-Bill" point={activeForward.yield3m} unit="%" deltaUnit="raw" />
                <ForwardTile label="10Y-2Y Curve" point={activeForward.curve10y2y} unit="bps" />
                <ForwardTile label="10Y-3M Curve" point={activeForward.curve10y3m} unit="bps" />
              </div>
            </BriefSection>

            {/* Risk & Volatility — credit spreads + vol surface.
                First place stress shows up before it hits price. */}
            <BriefSection
              title="Risk & Volatility"
              subtitle="Credit spreads and vol surface — where stress shows up first."
              accent="rose"
            >
              <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                <ForwardTile label="HY OAS Trend" point={activeForward.hyOasTrend} unit="bps" deltaUnit="bps" invertDeltaColor />
                <ForwardTile label="IG OAS Trend" point={activeForward.igOasTrend} unit="bps" deltaUnit="bps" invertDeltaColor />
                <ForwardTile label="VIX (wk/wk)" point={activeForward.vixWeek} deltaUnit="pct" invertDeltaColor />
                <ForwardTile label="MOVE (wk/wk)" point={activeForward.moveWeek} deltaUnit="pct" invertDeltaColor />
              </div>
            </BriefSection>
          </div>
        )}

        {brief?.regimeSignals && brief.regimeSignals.length > 0 && (
          <div className="rounded-2xl border border-slate-100 bg-white/70 p-4">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">
              Regime Drivers (deterministic)
            </div>
            <div className="flex flex-wrap gap-2">
              {brief.regimeSignals.map((signal, i) => (
                <span
                  key={i}
                  className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600"
                >
                  {signal}
                </span>
              ))}
            </div>
          </div>
        )}

        {activeForward?.fetchedAt && (
          <p className="text-[10px] text-slate-400 mt-3">
            Data fetched {new Date(activeForward.fetchedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}
            {" · "}Click any icon to verify the source.
          </p>
        )}
      </section>

      {/* Composite Signal */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base">🔍</span>
          <h2 className="text-base font-semibold">Composite Signal</h2>
          <SignalPill tone={compositeSignalTone}>{marketData.compositeSignal}</SignalPill>
          <span className="text-xs text-slate-500">
            Conviction: {marketData.conviction}
          </span>
          {brief?.marketRegime && (
            <SignalPill tone={brief.marketRegime === "Risk-Off" ? "red" : brief.marketRegime === "Risk-On" ? "green" : "amber"}>
              {brief.marketRegime}
            </SignalPill>
          )}
        </div>
        <p className="mt-3 text-sm leading-6 text-slate-700">
          {compositeAnalysis}
        </p>
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
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
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
            <div className="rounded-xl bg-slate-50 p-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">HY OAS</div>
              <div className="mt-1 text-xl font-bold">{fmtNum(hyVal)} <span className="text-xs font-normal text-slate-400">bps</span></div>
            </div>
            <div className="rounded-xl bg-slate-50 p-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">IG OAS</div>
              <div className="mt-1 text-xl font-bold">{fmtNum(igVal)} <span className="text-xs font-normal text-slate-400">bps</span></div>
            </div>
          </div>
          <p className="mt-2 text-xs text-slate-500">Trend: {hyVal != null && hyVal >= 300 ? "Widening modestly" : "Stable"}</p>
          <p className="mt-1.5 text-sm leading-6 text-slate-600">{creditAnalysis}</p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
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
            <div className="rounded-xl bg-slate-50 p-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">VIX</div>
              <div className="mt-1 text-xl font-bold">{fmtNum(vixVal)}</div>
            </div>
            <div className="rounded-xl bg-slate-50 p-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">TERM</div>
              <div className="mt-1 text-sm font-bold">{marketData.termStructure}</div>
            </div>
            <div className="rounded-xl bg-slate-50 p-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">MOVE</div>
              <div className="mt-1 text-xl font-bold">{fmtNum(moveVal)}</div>
            </div>
          </div>
          <p className="mt-3 text-sm leading-6 text-slate-600">{volatilityAnalysis}</p>
        </div>
      </section>

      {/* Breadth & Flows */}
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-base">📊</span>
              <h3 className="text-base font-semibold">Breadth & Market Structure</h3>
            </div>
            <SignalPill tone={breadth200Val != null && breadth200Val <= 50 ? "red" : breadth200Val != null && breadth200Val >= 65 ? "green" : "amber"}>
              {breadth200Val != null && breadth200Val <= 50 ? "Weak" : breadth200Val != null && breadth200Val >= 65 ? "Healthy" : "Mixed"}
            </SignalPill>
          </div>
          <div className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between border-b border-slate-100 pb-2">
              <span className="text-slate-500">S&amp;P 500 % &gt; 200 DMA</span>
              <span className="font-mono font-medium">{breadth200Val != null ? `${breadth200Val}%` : "—"}</span>
            </div>
            <div className="flex justify-between pb-1">
              <span className="text-slate-500">S&amp;P 500 % &gt; 50 DMA</span>
              <span className="font-mono font-medium">{breadth50Val != null ? `${breadth50Val}%` : "—"}</span>
            </div>
          </div>
          <p className="mt-3 text-sm leading-6 text-slate-600">{breadthAnalysis}</p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-base">💰</span>
              <h3 className="text-base font-semibold">Fund Flows & Positioning</h3>
            </div>
            <SignalPill tone={
              marketData.equityFlows.includes("Outflow") ? "red"
              : marketData.equityFlows.includes("Inflow") ? "green"
              : "amber"
            }>
              {marketData.equityFlows}
            </SignalPill>
          </div>
          <div className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between pb-1">
              <span className="text-slate-500">Equity Flows</span>
              <span className="font-medium">{marketData.equityFlows}</span>
            </div>
          </div>
          <p className="mt-3 text-sm leading-6 text-slate-600">{flowsAnalysis}</p>

          {/* Attached screenshots — compact thumbnails that open a centered
              lightbox on click. Previously rendered full-width in a 2-col
              grid, which forced a lot of scrolling when 11 JPM flows images
              were attached. The data is still accessible (click any thumb to
              see the full image); it just no longer dominates the brief. */}
          {(() => {
            const flowsAttachments = attachments.filter((a) => a.section === "equityFlows");
            if (flowsAttachments.length === 0) return null;
            return (
              <div className="mt-5 border-t border-slate-100 pt-5">
                <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">
                  JPM Flows & Liquidity Report
                  <span className="ml-2 font-normal normal-case text-slate-400">
                    ({flowsAttachments.length} {flowsAttachments.length === 1 ? "image" : "images"} — click to expand)
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {flowsAttachments.map((att) => (
                    <button
                      key={att.id}
                      type="button"
                      onClick={() => setFlowsLightboxId(att.id)}
                      className="block h-16 w-16 rounded-md border border-slate-200 overflow-hidden hover:border-blue-400 focus:border-blue-400 focus:outline-none transition-colors"
                      title={`View ${att.label}`}
                    >
                      <img src={att.dataUrl} alt={att.label} className="h-full w-full object-cover" />
                    </button>
                  ))}
                </div>
                {flowsLightboxId && (
                  <LightboxModal
                    attachments={flowsAttachments}
                    currentId={flowsLightboxId}
                    onClose={() => setFlowsLightboxId(null)}
                  />
                )}
              </div>
            );
          })()}
        </div>
      </section>
      </>
        );
      })()}

      {/* Hedging Window */}
      <HedgingIndicator
        vix={activeForward?.vixWeek?.value ?? 20}
        termStructure={marketData.termStructure}
        fearGreed={activeForward?.fearGreed?.value ?? marketData.fearGreed}
        hedgingAnalysis={hedgingAnalysis}
      />

      {/* Sector Rotation */}
      {sectorRotation && (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-base">🔄</span>
            <h3 className="text-base font-semibold">Sector Rotation</h3>
          </div>
          <p className="text-sm leading-6 text-slate-700 mb-4">{sectorRotation.summary}</p>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-emerald-600 mb-1.5">LEADING</div>
              {sectorRotation.leading.map((s, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-emerald-700 mb-1">
                  <span>▲</span> <span>{s}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-red-600 mb-1.5">LAGGING</div>
              {sectorRotation.lagging.map((s, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-red-600 mb-1">
                  <span>▼</span> <span>{s}</span>
                </div>
              ))}
            </div>
          </div>
          <p className="mt-3 text-sm italic leading-6 text-slate-500">{sectorRotation.pmImplication}</p>
        </section>
      )}

      {/* Portfolio Risk Scan */}
      {riskScan && riskScan.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-base">🛡️</span>
            <h3 className="text-base font-semibold">Portfolio Risk Scan</h3>
          </div>
          <div className="space-y-2">
            {riskScan.map((item, i) => {
              const bgClass =
                item.priority === "High"
                  ? "border-l-red-400 bg-red-50/30"
                  : item.priority === "Medium-High"
                  ? "border-l-amber-400 bg-amber-50/30"
                  : "border-l-slate-300 bg-slate-50/30";
              const tonePill =
                item.priority === "High"
                  ? "red" as const
                  : item.priority === "Medium-High"
                  ? "amber" as const
                  : "gray" as const;
              return (
                <div key={i} className={`rounded-xl border-l-4 p-3 ${bgClass}`}>
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className="font-mono text-sm font-bold">{item.ticker}</span>
                    <SignalPill tone={tonePill}>{item.priority}</SignalPill>
                    <span className="text-sm text-slate-700">{item.summary}</span>
                  </div>
                  <div className="text-sm text-blue-600 font-medium">&rarr; {item.action}</div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Action Items */}
      {forwardActions.length > 0 && (
        <section className="rounded-2xl border border-amber-100 bg-amber-50/30 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-base">⚡</span>
            <h3 className="text-base font-semibold">Action Items</h3>
          </div>
          <div className="space-y-2">
            {forwardActions.map((action, i) => {
              const bgClass =
                action.priority === "High"
                  ? "border-red-200 bg-red-50/40"
                  : action.priority === "Medium"
                  ? "border-amber-200 bg-amber-50/60"
                  : "border-emerald-200 bg-emerald-50/40";
              return (
                <div key={i} className={`rounded-xl border p-3 ${bgClass}`}>
                  <div className="flex items-start gap-3">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-200 text-xs font-bold text-amber-800">
                      {i + 1}
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold">{action.title}</h4>
                      <p className="mt-0.5 text-sm text-slate-600 leading-6">{action.detail}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}
