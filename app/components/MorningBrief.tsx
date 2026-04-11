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
import { ImageUpload, type BriefAttachment } from "./ImageUpload";

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
        deltaStr = `${d >= 0 ? "+" : ""}${d.toFixed(1)}pp ${deltaPeriod}`;
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
      {deltaStr && (
        <div className={`text-xs font-semibold mt-0.5 ${deltaColor}`}>{deltaStr}</div>
      )}
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

  // Attachments (screenshots for brief sections)
  const [attachments, setAttachments] = useState<BriefAttachment[]>([]);
  const attachSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load attachments on mount
  useEffect(() => {
    fetch("/api/kv/attachments")
      .then((r) => r.json())
      .then((data) => { if (data.attachments) setAttachments(data.attachments); })
      .catch(() => {});
  }, []);

  const persistAttachments = useCallback((next: BriefAttachment[]) => {
    setAttachments(next);
    if (attachSaveTimer.current) clearTimeout(attachSaveTimer.current);
    attachSaveTimer.current = setTimeout(() => {
      fetch("/api/kv/attachments", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachments: next }),
      }).catch((e) => console.error("Failed to save attachments:", e));
    }, 500);
  }, []);

  const addAttachment = useCallback((att: BriefAttachment) => {
    persistAttachments([...attachments, att]);
  }, [attachments, persistAttachments]);

  const removeAttachment = useCallback((id: string) => {
    persistAttachments(attachments.filter((a) => a.id !== id));
  }, [attachments, persistAttachments]);

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
        if (data.vix != null) updates.vix = data.vix;
        if (data.move != null) updates.move = data.move;
        if (data.hyOas != null) updates.hyOas = data.hyOas;
        if (data.igOas != null) updates.igOas = data.igOas;
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

  // Prefer the bundle Claude just used for this brief so the UI reflects the
  // exact numbers the brief was written against. Fall back to the page-load
  // bundle otherwise.
  const activeForward = brief?.forwardLooking ?? forwardData;

  async function generateBrief() {
    setGenerating(true);
    setError("");

    try {
      const res = await fetch("/api/morning-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketData,
          holdings: stocks,
          attachments: attachments.map((a) => ({
            section: a.section,
            label: a.label,
            dataUrl: a.dataUrl,
          })),
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
      <section className="rounded-[30px] border border-slate-200 bg-white p-6 md:p-8 shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 mb-6 flex-wrap">
          <h3 className="text-lg font-semibold text-slate-800">Daily Market Input</h3>
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
            vix: "VIX",
            move: "MOVE",
            hyOas: "HY OAS",
            igOas: "IG OAS",
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

        {/* Live-fetched fields */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4 mb-6">
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">VIX</label>
              <LiveStatusBadge status={liveFields.vix} reason={liveErrors.vix} />
            </div>
            <SaveableNumericInput
              savedValue={marketData.vix}
              onSave={(n) => onUpdateMarketData({ vix: n })}
              inputClassName="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-lg font-semibold focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all outline-none"
            />
          </div>
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">MOVE Index</label>
              <LiveStatusBadge status={liveFields.move} reason={liveErrors.move} />
            </div>
            <SaveableNumericInput
              savedValue={marketData.move}
              onSave={(n) => onUpdateMarketData({ move: n })}
              inputClassName="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-lg font-semibold focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all outline-none"
            />
          </div>
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">HY OAS (bps)</label>
              <a href="https://fred.stlouisfed.org/series/BAMLH0A0HYM2" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-600 transition-colors" title="FRED HY OAS">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
              </a>
              <LiveStatusBadge status={liveFields.hyOas} reason={liveErrors.hyOas} />
            </div>
            <SaveableNumericInput
              savedValue={marketData.hyOas}
              onSave={(n) => onUpdateMarketData({ hyOas: n })}
              inputClassName="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-lg font-semibold focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all outline-none"
            />
          </div>
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">IG OAS (bps)</label>
              <a href="https://fred.stlouisfed.org/series/BAMLC0A0CM" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-600 transition-colors" title="FRED IG OAS">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
              </a>
              <LiveStatusBadge status={liveFields.igOas} reason={liveErrors.igOas} />
            </div>
            <SaveableNumericInput
              savedValue={marketData.igOas}
              onSave={(n) => onUpdateMarketData({ igOas: n })}
              inputClassName="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-lg font-semibold focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all outline-none"
            />
          </div>
        </div>

        {/* ── Breadth & Market Structure ── */}
        <div className="border-t border-slate-100 pt-5 mb-6">
          <div className="flex items-center gap-3 mb-4">
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Breadth & Market Structure</h4>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3 lg:grid-cols-5">
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">S&P % &gt; 200 DMA</label>
                <a href="https://www.marketinout.com/chart/market.php?breadth=above-sma-200" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-600 transition-colors" title="MarketInOut S&P Breadth">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
              <SaveableNumericInput
                savedValue={marketData.breadth}
                onSave={(n) => onUpdateMarketData({ breadth: n })}
                inputClassName="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-lg font-semibold focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all outline-none"
              />
            </div>
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Nasdaq % &gt; 200 DMA</label>
                <a href="https://www.marketinout.com/chart/market.php?breadth=above-sma-200" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-600 transition-colors" title="MarketInOut Nasdaq Breadth">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
              <SaveableNumericInput
                savedValue={marketData.nasdaqBreadth}
                onSave={(n) => onUpdateMarketData({ nasdaqBreadth: n })}
                inputClassName="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-lg font-semibold focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all outline-none"
              />
            </div>
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">S&P % &gt; 50 DMA</label>
                <a href="https://www.marketinout.com/chart/market.php?breadth=above-sma-50" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-600 transition-colors" title="MarketInOut 50 DMA Breadth">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
              <SaveableNumericInput
                savedValue={marketData.sp50dma}
                onSave={(n) => onUpdateMarketData({ sp50dma: n })}
                inputClassName="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-lg font-semibold focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all outline-none"
              />
            </div>
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">NYSE A/D Line</label>
                <a href="https://www.marketinout.com/chart/market.php?breadth=advance-decline-line" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-600 transition-colors" title="NYSE A/D Line">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
              <SaveableNumericInput
                savedValue={marketData.nyseAdLine}
                onSave={(n) => onUpdateMarketData({ nyseAdLine: n })}
                allowNegative
                inputClassName="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-lg font-semibold focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all outline-none"
              />
            </div>
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">New Highs - Lows</label>
                <a href="https://www.marketinout.com/chart/market.php?breadth=new-highs-new-lows" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-600 transition-colors" title="New Highs vs New Lows">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
              <SaveableNumericInput
                savedValue={marketData.newHighsLows}
                onSave={(n) => onUpdateMarketData({ newHighsLows: n })}
                allowNegative
                inputClassName="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-lg font-semibold focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all outline-none"
              />
              <p className="text-[10px] text-slate-400 mt-0.5">S&P 500</p>
            </div>
          </div>
        </div>

        {/* ── Contrarian Indicators ── */}
        <div className="border-t border-slate-100 pt-5 mb-6">
          <div className="flex items-center gap-3 mb-4">
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Contrarian Indicators</h4>
            <SignalPill tone="green">INVERTED SIGNALS</SignalPill>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
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
                <LiveStatusBadge status={liveFields.putCall} reason={liveErrors.putCall} />
              </div>
              <SaveableNumericInput
                savedValue={marketData.putCall}
                onSave={(n) => onUpdateMarketData({ putCall: n })}
                inputClassName="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-lg font-semibold focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all outline-none"
              />
              <p className="text-[10px] text-slate-400 mt-0.5">Total P/C ratio</p>
            </div>
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Fear & Greed (0-100)</label>
                <a href="https://www.cnn.com/markets/fear-and-greed" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-600 transition-colors" title="CNN Fear & Greed Index">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
              <SaveableNumericInput
                savedValue={marketData.fearGreed}
                onSave={(n) => onUpdateMarketData({ fearGreed: n })}
                inputClassName="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-lg font-semibold focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all outline-none"
              />
              <p className="text-[10px] text-slate-400 mt-0.5">CNN index</p>
            </div>
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">AAII Survey (%)</label>
                <a href="https://www.aaii.com/sentimentsurvey" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-600 transition-colors" title="AAII Sentiment Survey">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                <div>
                  <span className="text-[9px] font-semibold text-red-400 uppercase">Bull</span>
                  <SaveableNumericInput
                    savedValue={marketData.aaiiBull ?? 30}
                    onSave={(n) => {
                      const spread = parseFloat((n - (marketData.aaiiBear ?? 52)).toFixed(1));
                      onUpdateMarketData({ aaiiBull: n, aaiiBullBear: spread });
                    }}
                    inputClassName="w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-sm font-semibold focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all outline-none"
                  />
                </div>
                <div>
                  <span className="text-[9px] font-semibold text-amber-400 uppercase">Ntrl</span>
                  <SaveableNumericInput
                    savedValue={marketData.aaiiNeutral ?? 17}
                    onSave={(n) => onUpdateMarketData({ aaiiNeutral: n })}
                    inputClassName="w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-sm font-semibold focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all outline-none"
                  />
                </div>
                <div>
                  <span className="text-[9px] font-semibold text-emerald-400 uppercase">Bear</span>
                  <SaveableNumericInput
                    savedValue={marketData.aaiiBear ?? 52}
                    onSave={(n) => {
                      const spread = parseFloat(((marketData.aaiiBull ?? 30) - n).toFixed(1));
                      onUpdateMarketData({ aaiiBear: n, aaiiBullBear: spread });
                    }}
                    inputClassName="w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-sm font-semibold focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all outline-none"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Other Manual Inputs ── */}
        <div className="border-t border-slate-100 pt-5 mb-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3">
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">VIX Term Structure</label>
                <a href="http://vixcentral.com" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-600 transition-colors" title="VIX Central">
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
            <div className="col-span-2 md:col-span-1">
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">JPM Flows Report</label>
              </div>
              <ImageUpload
                section="equityFlows"
                sectionLabel="JPM Flows & Liquidity"
                attachments={attachments}
                onAdd={addAttachment}
                onRemove={removeAttachment}
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
            VIX: <strong>{marketData.vix}</strong> | MOVE: <strong>{marketData.move}</strong> | HY: <strong>{marketData.hyOas}</strong> | Osc: <strong>{marketData.spOscillator}</strong> | F&G: <strong>{marketData.fearGreed}</strong>
          </span>
        </div>
      </section>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          {error}
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
      <section className="relative rounded-[30px] bg-amber-50 border border-amber-200 p-8 shadow-sm">
        {generating && <LoadingOverlay message="Claude is analyzing markets..." />}
        <div className="text-sm font-bold uppercase tracking-[0.22em] text-amber-700 mb-4">
          Bottom line
        </div>
        <p className="max-w-6xl text-lg leading-8 text-slate-800">
          {bottomLine}
        </p>
      </section>

      {/* Forward View — Next 2 Weeks */}
      <section className="rounded-[30px] border border-blue-200 bg-gradient-to-br from-blue-50/60 to-white p-6 md:p-8 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xl">🧭</span>
            <h2 className="text-2xl font-semibold text-slate-800">Forward View — Next 2 Weeks</h2>
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
        <p className="max-w-6xl text-lg leading-8 text-slate-700 mb-6">
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

        {activeForward && (
          <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-4 mb-5">
            <ForwardTile label="S&P 500 YTD" point={activeForward.spxYtd} unit="%" />
            <ForwardTile label="S&P 500 Week" point={activeForward.spxWeek} unit="%" />
            <ForwardTile label="SPY Forward P/E" point={activeForward.spyForwardPE} />
            <ForwardTile label="SPY Trailing P/E" point={activeForward.spyTrailingPE} />
            <ForwardTile label="Implied 1Y EPS Growth (P/E)" point={activeForward.impliedEpsGrowth} unit="%" />
            <ForwardTile label="Est 3-5Y EPS Growth" point={activeForward.eps35Growth} unit="%" />
            <ForwardTile label="10Y Treasury" point={activeForward.yield10y} unit="%" deltaUnit="raw" />
            <ForwardTile label="2Y Treasury" point={activeForward.yield2y} unit="%" deltaUnit="raw" />
            <ForwardTile label="3M T-Bill" point={activeForward.yield3m} unit="%" deltaUnit="raw" />
            <ForwardTile label="10Y-2Y Curve" point={activeForward.curve10y2y} unit="bps" />
            <ForwardTile label="10Y-3M Curve" point={activeForward.curve10y3m} unit="bps" />
            <ForwardTile label="HY OAS Trend" point={activeForward.hyOasTrend} unit="bps" deltaUnit="bps" invertDeltaColor />
            <ForwardTile label="IG OAS Trend" point={activeForward.igOasTrend} unit="bps" deltaUnit="bps" invertDeltaColor />
            <ForwardTile label="VIX (wk/wk)" point={activeForward.vixWeek} deltaUnit="pct" invertDeltaColor />
            <ForwardTile label="MOVE (wk/wk)" point={activeForward.moveWeek} deltaUnit="pct" invertDeltaColor />
            <ForwardTile label="S&P >200DMA (wk)" point={activeForward.breadth200Wk} unit="%" deltaUnit="pp" deltaPeriod="wk/wk" />
            <ForwardTile label="S&P >200DMA (mo)" point={activeForward.breadth200Mo} unit="%" deltaUnit="pp" deltaPeriod="mo/mo" />
            <ForwardTile label="S&P >50DMA (wk)" point={activeForward.breadth50Wk} unit="%" deltaUnit="pp" deltaPeriod="wk/wk" />
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
      <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-2xl">🔍</span>
          <h2 className="text-2xl font-semibold">Composite Signal</h2>
          <SignalPill tone={compositeSignalTone}>{marketData.compositeSignal}</SignalPill>
          <span className="text-slate-500">
            Conviction: {marketData.conviction}
          </span>
          {brief?.marketRegime && (
            <SignalPill tone={brief.marketRegime === "Risk-Off" ? "red" : brief.marketRegime === "Risk-On" ? "green" : "amber"}>
              {brief.marketRegime}
            </SignalPill>
          )}
        </div>
        <p className="mt-4 text-lg leading-8 text-slate-700">
          {compositeAnalysis}
        </p>
      </section>

      {/* Contrarian Sentiment — all 4 indicators + Claude analysis */}
      <SentimentGauges marketData={marketData} aaiiBull={marketData.aaiiBull ?? 30} aaiiNeutral={marketData.aaiiNeutral ?? 17} aaiiBear={marketData.aaiiBear ?? 52} contrarianAnalysis={contrarianAnalysis} />

      {/* Credit & Volatility */}
      <section className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xl">📉</span>
              <h3 className="text-2xl font-semibold">Credit Spreads</h3>
            </div>
            <SignalPill tone={marketData.hyOas >= 300 ? "red" : marketData.hyOas >= 200 ? "amber" : "green"}>
              {marketData.hyOas >= 300 ? "Widening" : marketData.hyOas >= 200 ? "Neutral" : "Tight"}
            </SignalPill>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-4">
            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">HY OAS</div>
              <div className="mt-2 text-3xl font-bold">{marketData.hyOas} <span className="text-base font-normal text-slate-400">bps</span></div>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">IG OAS</div>
              <div className="mt-2 text-3xl font-bold">{marketData.igOas} <span className="text-base font-normal text-slate-400">bps</span></div>
            </div>
          </div>
          <p className="mt-4 text-sm text-slate-500">Trend: {marketData.hyOas >= 300 ? "Widening modestly" : "Stable"}</p>
          <p className="mt-2 text-lg leading-8 text-slate-600">{creditAnalysis}</p>
        </div>

        <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xl">⚡</span>
              <h3 className="text-2xl font-semibold">Volatility Regime</h3>
            </div>
            <SignalPill tone={marketData.vix >= 22 ? "red" : marketData.vix >= 16 ? "amber" : "green"}>
              {marketData.vix >= 22 ? "Elevated" : marketData.vix >= 16 ? "Moderate" : "Low"}
            </SignalPill>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-4">
            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">VIX</div>
              <div className="mt-2 text-3xl font-bold">{marketData.vix}</div>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">TERM</div>
              <div className="mt-2 text-xl font-bold">{marketData.termStructure}</div>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">MOVE</div>
              <div className="mt-2 text-3xl font-bold">{marketData.move}</div>
            </div>
          </div>
          <p className="mt-4 text-lg leading-8 text-slate-600">{volatilityAnalysis}</p>
        </div>
      </section>

      {/* Breadth & Flows */}
      <section className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xl">📊</span>
              <h3 className="text-2xl font-semibold">Breadth & Market Structure</h3>
            </div>
            <SignalPill tone={marketData.breadth <= 50 ? "red" : marketData.breadth >= 65 ? "green" : "amber"}>
              {marketData.breadth <= 50 ? "Weak" : marketData.breadth >= 65 ? "Healthy" : "Mixed"}
            </SignalPill>
          </div>
          <div className="mt-5 space-y-3">
            <div className="flex justify-between border-b border-slate-100 pb-3">
              <a href="https://www.marketinout.com/chart/market.php?breadth=above-sma-200" target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-blue-600 flex items-center gap-1.5">
                S&amp;P 500 % &gt; 200 DMA
                <svg className="w-3 h-3 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
              </a>
              <span className="font-mono font-medium">{marketData.breadth}%</span>
            </div>
            <div className="flex justify-between border-b border-slate-100 pb-3">
              <a href="https://www.marketinout.com/chart/market.php?breadth=above-sma-200" target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-blue-600 flex items-center gap-1.5">
                Nasdaq % &gt; 200 DMA
                <svg className="w-3 h-3 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
              </a>
              <span className="font-mono font-medium">{marketData.nasdaqBreadth}%</span>
            </div>
            <div className="flex justify-between border-b border-slate-100 pb-3">
              <a href="https://www.marketinout.com/chart/market.php?breadth=above-sma-50" target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-blue-600 flex items-center gap-1.5">
                S&amp;P 500 % &gt; 50 DMA
                <svg className="w-3 h-3 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
              </a>
              <span className="font-mono font-medium">{marketData.sp50dma}%</span>
            </div>
            <div className="flex justify-between border-b border-slate-100 pb-3">
              <a href="https://www.marketinout.com/chart/market.php?breadth=advance-decline-line" target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-blue-600 flex items-center gap-1.5">
                NYSE A/D Line
                <svg className="w-3 h-3 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
              </a>
              <span className="font-mono font-medium">{marketData.nyseAdLine.toLocaleString()}</span>
            </div>
            <div className="flex justify-between pb-3">
              <a href="https://www.marketinout.com/chart/market.php?breadth=new-highs-new-lows" target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-blue-600 flex items-center gap-1.5">
                New Highs - Lows
                <svg className="w-3 h-3 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
              </a>
              <span className={`font-mono font-medium ${marketData.newHighsLows > 0 ? "text-emerald-600" : marketData.newHighsLows < -50 ? "text-red-600" : "text-slate-700"}`}>
                {marketData.newHighsLows > 0 ? "+" : ""}{marketData.newHighsLows}
              </span>
            </div>
          </div>
          <p className="mt-4 text-lg leading-8 text-slate-600">{breadthAnalysis}</p>
        </div>

        <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xl">💰</span>
              <h3 className="text-2xl font-semibold">Fund Flows & Positioning</h3>
            </div>
            <SignalPill tone={
              marketData.equityFlows.includes("Outflow") ? "red"
              : marketData.equityFlows.includes("Inflow") ? "green"
              : "amber"
            }>
              {marketData.equityFlows}
            </SignalPill>
          </div>
          <div className="mt-5 space-y-3">
            <div className="flex justify-between pb-3">
              <span className="text-slate-500">Equity Flows</span>
              <span className="font-medium">{marketData.equityFlows}</span>
            </div>
          </div>
          <p className="mt-4 text-lg leading-8 text-slate-600">{flowsAnalysis}</p>

          {/* Attached screenshots displayed inline */}
          {attachments.filter((a) => a.section === "equityFlows").length > 0 && (
            <div className="mt-5 border-t border-slate-100 pt-5">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">
                JPM Flows & Liquidity Report
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {attachments
                  .filter((a) => a.section === "equityFlows")
                  .map((att) => (
                    <div key={att.id} className="rounded-xl border border-slate-200 overflow-hidden">
                      <img
                        src={att.dataUrl}
                        alt={att.label}
                        className="w-full h-auto"
                      />
                      <div className="px-3 py-1.5 bg-slate-50 text-xs text-slate-500">
                        {att.label}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Hedging Window */}
      <HedgingIndicator marketData={marketData} hedgingAnalysis={hedgingAnalysis} />

      {/* Sector Rotation */}
      {sectorRotation && (
        <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-xl">🔄</span>
            <h3 className="text-2xl font-semibold">Sector Rotation</h3>
          </div>
          <p className="text-lg leading-8 text-slate-700 mb-5">{sectorRotation.summary}</p>
          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <div className="text-sm font-bold uppercase tracking-wider text-emerald-600 mb-2">LEADING</div>
              {sectorRotation.leading.map((s, i) => (
                <div key={i} className="flex items-center gap-2 text-emerald-700 mb-1">
                  <span>▲</span> <span>{s}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-sm font-bold uppercase tracking-wider text-red-600 mb-2">LAGGING</div>
              {sectorRotation.lagging.map((s, i) => (
                <div key={i} className="flex items-center gap-2 text-red-600 mb-1">
                  <span>▼</span> <span>{s}</span>
                </div>
              ))}
            </div>
          </div>
          <p className="mt-4 text-lg italic leading-8 text-slate-500">{sectorRotation.pmImplication}</p>
        </section>
      )}

      {/* Portfolio Risk Scan */}
      {riskScan && riskScan.length > 0 && (
        <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-5">
            <span className="text-xl">🛡️</span>
            <h3 className="text-2xl font-semibold">Portfolio Risk Scan</h3>
          </div>
          <div className="space-y-3">
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
                <div key={i} className={`rounded-2xl border-l-4 p-4 ${bgClass}`}>
                  <div className="flex flex-wrap items-center gap-3 mb-1">
                    <span className="font-mono text-lg font-bold">{item.ticker}</span>
                    <SignalPill tone={tonePill}>{item.priority}</SignalPill>
                    <span className="text-slate-700">{item.summary}</span>
                  </div>
                  <div className="text-blue-600 font-medium">&rarr; {item.action}</div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Action Items */}
      {forwardActions.length > 0 && (
        <section className="rounded-[30px] border border-amber-100 bg-amber-50/30 p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-5">
            <span className="text-xl">⚡</span>
            <h3 className="text-2xl font-semibold">Action Items</h3>
          </div>
          <div className="space-y-3">
            {forwardActions.map((action, i) => {
              const bgClass =
                action.priority === "High"
                  ? "border-red-200 bg-red-50/40"
                  : action.priority === "Medium"
                  ? "border-amber-200 bg-amber-50/60"
                  : "border-emerald-200 bg-emerald-50/40";
              return (
                <div key={i} className={`rounded-2xl border p-5 ${bgClass}`}>
                  <div className="flex items-start gap-4">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-200 text-sm font-bold text-amber-800">
                      {i + 1}
                    </div>
                    <div>
                      <h4 className="text-lg font-semibold">{action.title}</h4>
                      <p className="mt-1 text-slate-600 leading-7">{action.detail}</p>
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
