"use client";

import { usePersistedOpen } from "@/app/lib/useCollapsed";
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type {
  MarketData,
  MorningBrief as MorningBriefType,
  Stock,
  ScoredStock,
  ForwardLookingBundle,
} from "@/app/lib/types";
import { SignalPill } from "./SignalPill";
import { ClampText } from "./ClampText";
import { displayTicker } from "@/app/lib/ticker";
import { formatYmd, daysUntilYmd } from "@/app/lib/date-format";
import { LoadingOverlay } from "./LoadingSpinner";
import { SentimentGauges } from "./SentimentGauges";
import { ImageUpload, LightboxModal, type BriefAttachment } from "./ImageUpload";
import { BriefCommandBar } from "./BriefCommandBar";
import { CollapsibleSection } from "./CollapsibleSection";
import { BriefGenerationModal } from "./BriefGenerationModal";
import { MacroBoard } from "./MacroBoard";
import type { MarketRegimeData } from "@/app/lib/market-regime";
import { regimeValence } from "@/app/lib/regime-transition";
import { useStocks } from "@/app/lib/StockContext";
import { AppIcon } from "./AppIcon";

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
        className={`absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-control transition-colors ${
          isDirty ? "cursor-pointer bg-accent text-white" : "text-pos"
        }`}
      >
        <AppIcon name="check" size={12} />
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
          className="absolute right-7 top-1/2 grid h-5 w-5 -translate-y-1/2 cursor-pointer place-items-center rounded-control bg-accent text-white"
        >
          <AppIcon name="check" size={12} />
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
        className="flex w-full items-center gap-1.5 rounded-control border border-dashed border-line bg-surface-2 px-3 py-2.5 text-left text-[12.5px] text-ink-3 transition-colors hover:bg-surface-hover"
      >
        <AppIcon name="plus" size={13} /> Paste {label} report
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
        className="max-h-[300px] min-h-[80px] w-full resize-y rounded-control border border-line bg-surface px-3 py-2.5 text-[12.5px] leading-relaxed outline-none transition-colors focus:border-accent-border"
      />
      <div className="flex items-center justify-between mt-1">
        <span className="text-[11px] text-ink-3">
          {wordCount > 0 ? `${wordCount} words` : "empty"}
        </span>
        <div className="flex items-center gap-2">
          {isDirty && (
            <button
              onClick={handleSave}
              className="inline-flex h-6 items-center rounded-control bg-ink px-2.5 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90"
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
              className="text-[11.5px] text-ink-3 transition-colors hover:text-neg"
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
      className={`inline-flex h-6 items-center rounded-control border px-2 text-[11px] transition-colors hover:opacity-90 ${tone}`}
    >
      {label}
    </button>
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
      <span className="inline-flex items-center gap-1 text-[11px] text-ink-3">
        <span className="dot bg-pos" aria-hidden /> Live
      </span>
    );
  }
  if (status === "not-configured") {
    return (
      <span
        title={reason ?? "Source not configured — manual value shown"}
        className="inline-flex cursor-help items-center gap-1 text-[11px] text-ink-3"
      >
        <span className="dot bg-ink-faint" aria-hidden /> Manual
      </span>
    );
  }
  return (
    <span
      title={reason ?? "Auto-fetch failed — last saved value shown"}
      className="inline-flex cursor-help items-center gap-1 text-[11px] text-warn"
    >
      <span className="dot bg-warn" aria-hidden /> Stale
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
  /**
   * "summary" (the Brief page since Sept 2026): the deterministic
   * DailySummaryView is rendered in the `summary` slot directly under the
   * command bar, and the legacy Decide / Act sections are NOT rendered —
   * their tiles (hedging, cash, earnings, do-today, risk flags) all live in
   * the summary now. Board / Horizons / Narrative folds and Daily Input mode
   * are untouched. "full" keeps the previous layout verbatim.
   */
  variant?: "full" | "summary";
  summary?: React.ReactNode;
  /** Rail entries for the command bar in summary mode. */
  sections?: { id: string; label: string }[];
};

export function MorningBrief({
  marketData,
  offensiveExposure,
  brief,
  stocks,
  scoredStocks,
  onBriefGenerated,
  onUpdateMarketData,
  variant = "full",
  summary,
  sections,
}: Props) {
  const [generating, setGenerating] = useState(false);
  // Modal visibility is separate from `generating` so "Run in background"
  // hides the dialog without cancelling the in-flight request.
  const [genModalOpen, setGenModalOpen] = useState(false);
  // Identifies THIS generation run to the progress poller — a stale
  // pm:brief-progress blob from a prior run can never match it.
  const [genRunId, setGenRunId] = useState<string | null>(null);
  // Standalone hedging refresh — re-runs ONLY the hedging read (live premiums
  // + one small model call) and merges the result into the existing brief via
  // the normal context persist path. No full-brief regeneration.
  const [hedgeRefreshing, setHedgeRefreshing] = useState(false);
  const refreshHedging = async () => {
    if (!brief || hedgeRefreshing) return;
    setHedgeRefreshing(true);
    try {
      const r = await fetch("/api/hedging-refresh", { method: "POST" });
      const j = await r.json();
      if (j?.ok && j.hedgingAnalysis && j.hedgingCall?.action) {
        onBriefGenerated({
          ...brief,
          hedgingAnalysis: j.hedgingAnalysis,
          hedgingCall: j.hedgingCall,
          hedgingRefreshedAt: j.hedgingRefreshedAt,
          ...(j.hedgeChecklist ? { hedgeChecklist: j.hedgeChecklist } : {}),
          ...(j.hedgingDetail ? { hedgingDetail: j.hedgingDetail } : {}),
        });
      } else {
        setError(j?.error || "Hedging refresh failed");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Hedging refresh failed");
    } finally {
      setHedgeRefreshing(false);
    }
  };
  // ── Hedge-position ledger (ground truth for whether protection is on) ──
  // Fetched independently of the brief so logging a hedge reflects instantly,
  // and so the tile's status is live rather than the generation-time snapshot.
  type HedgePos = {
    id: string; status: "active" | "closed"; implementedAt: string;
    expiry?: string; tenorLabel?: string; strikePctOtm?: number; strikePrice?: number;
    spotAtEntry?: number; premiumPctOfSpot?: number; premiumUsd?: number; contracts?: number; notes?: string;
  };
  const [hedges, setHedges] = useState<HedgePos[]>([]);
  const [showHedgeForm, setShowHedgeForm] = useState(false);
  const [hedgeForm, setHedgeForm] = useState<Partial<HedgePos>>({});
  const [savingHedge, setSavingHedge] = useState(false);
  const todayIsoLocal = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const activeHedgesLive = hedges.filter(
    (h) => h.status === "active" && (!h.expiry || !/^\d{4}-\d{2}-\d{2}$/.test(h.expiry) || h.expiry >= todayIsoLocal),
  );
  useEffect(() => {
    let alive = true;
    fetch("/api/kv/hedges").then((r) => r.json()).then((j) => {
      if (alive && Array.isArray(j?.hedges)) setHedges(j.hedges as HedgePos[]);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const persistHedges = async (next: HedgePos[]) => {
    setHedges(next);
    try {
      await fetch("/api/kv/hedges", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hedges: next }),
      });
    } catch { /* local state already updated; next load reconciles */ }
  };
  const openHedgeForm = () => {
    // Prefill from the current recommendation + live spot so confirming an
    // implemented hedge is a couple of fields, not a blank slate.
    const pctFromStrike = hedgingCall?.strike ? parseFloat(hedgingCall.strike) : undefined;
    const spot = brief?.hedgingDetail?.spotPrice;
    const pct = pctFromStrike != null && isFinite(pctFromStrike) ? pctFromStrike : undefined;
    setHedgeForm({
      implementedAt: todayIsoLocal,
      tenorLabel: hedgingCall?.tenor || "",
      strikePctOtm: pct,
      strikePrice: spot != null && pct != null ? Math.round(spot * (1 - pct / 100)) : undefined,
      spotAtEntry: spot,
    });
    setShowHedgeForm(true);
  };
  const saveHedge = async () => {
    if (savingHedge) return;
    setSavingHedge(true);
    const num = (v: unknown) => { const n = typeof v === "number" ? v : parseFloat(String(v)); return isFinite(n) ? n : undefined; };
    const pos: HedgePos = {
      id: `hedge-${Date.now()}`,
      status: "active",
      implementedAt: hedgeForm.implementedAt || todayIsoLocal,
      tenorLabel: hedgeForm.tenorLabel || undefined,
      expiry: hedgeForm.expiry || undefined,
      strikePctOtm: num(hedgeForm.strikePctOtm),
      strikePrice: num(hedgeForm.strikePrice),
      spotAtEntry: num(hedgeForm.spotAtEntry),
      premiumUsd: num(hedgeForm.premiumUsd),
      premiumPctOfSpot: num(hedgeForm.premiumPctOfSpot) ??
        (num(hedgeForm.premiumUsd) != null && num(hedgeForm.spotAtEntry) ? Math.round((num(hedgeForm.premiumUsd)! / num(hedgeForm.spotAtEntry)!) * 10000) / 100 : undefined),
      contracts: num(hedgeForm.contracts),
      notes: hedgeForm.notes || undefined,
    };
    await persistHedges([...hedges, pos]);
    setShowHedgeForm(false);
    setSavingHedge(false);
  };
  const closeHedge = async (id: string) => {
    await persistHedges(hedges.map((h) => (h.id === id ? { ...h, status: "closed" as const } : h)));
  };

  // Which Portfolio Risk Scan rows are expanded (by index). Summaries clamp to
  // 2 lines by default to keep the Brief short; a click reveals the full text.
  const [expandedRisk, setExpandedRisk] = useState<Set<number>>(() => new Set());
  const toggleRisk = (i: number) => setExpandedRisk((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });
  // Portfolio holdings reporting earnings within the next 7 days (today .. +7),
  // soonest first — drives the slim can't-miss banner at the top of the brief.
  // Match an action line to a holding so the row can offer a jump button.
  // Word-boundary match on the bare symbol against the book — never a guess
  // from the prose, so rows that name no holding simply get no button.
  const actionTicker = React.useCallback((text: string): string | null => {
    // CASE-SENSITIVE on purpose. Upper-casing the prose first made the English
    // word "all" in "Hold all positions" match the ticker ALL (Allstate) and
    // offer an "Open ALL" button. Tickers are written upper-case in the model's
    // prose, so matching the raw text is both correct and sufficient.
    const t = text || "";
    for (const s of stocks || []) {
      const bare = (s.ticker || "").replace(/[-.](TO|T|V)$/i, "").toUpperCase();
      if (bare.length < 2) continue;
      if (new RegExp(`\\b${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)) return s.ticker;
    }
    return null;
  }, [stocks]);


  // Two strongest and two weakest sectors today, for the Risk Flags footer.
  const sectorTilt = useMemo(() => {
    const rows = (brief?.sectorPerformance || [])
      .filter((r): r is { sector: string; etf: string; dayPct: number } => typeof r.dayPct === "number")
      .sort((a, b) => b.dayPct - a.dayPct);
    if (rows.length < 2) return [];
    return [...rows.slice(0, 2), ...rows.slice(-2)].filter(
      (r, i, arr) => arr.findIndex((x) => x.sector === r.sector) === i,
    );
  }, [brief]);

  const earningsSoon = useMemo(() => {
    return (stocks || [])
      .filter((s) => s.bucket === "Portfolio")
      .map((s) => ({ ticker: s.ticker, date: s.healthData?.earningsDate, days: daysUntilYmd(s.healthData?.earningsDate) }))
      .filter((s): s is { ticker: string; date: string; days: number } =>
        !!s.date && s.days != null && s.days >= 0 && s.days <= 7)
      .sort((a, b) => a.days - b.days);
  }, [stocks]);

  // Which view is showing: the generated "brief" (default) or the "input" form.
  const [briefMode, setBriefMode] = useState<"brief" | "input">("brief");
  // Catalyst watch — collapse a long event list to keep the brief uncluttered.
  const [catalystExpanded, toggleCatalyst] = usePersistedOpen("brief.catalyst.expanded", false);
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
    const runId = (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `run-${Date.now()}`);
    setGenRunId(runId);
    setGenerating(true);
    setGenModalOpen(true);
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
          runId,
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
      setGenModalOpen(false);
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

  // Every collapsible row in the Narrative section, so "Expand all" can drive
  // them together. Kept beside the rows it controls — if a row is added here
  // and not to this list, the button silently stops covering it.
  const NARRATIVE_KEYS = React.useMemo(() => [
    "briefNarrativeComposite",
    "briefNarrativeUnderpriced",
    "briefNarrativeBreadth",
    "briefNarrativeCredit",
    "briefNarrativeHedgeBasis",
    "briefNarrativeCash",
    "briefNarrativeRegimeTells",
  ], []);
  const { uiPrefs, setUiPref } = useStocks();
  // "1" means collapsed. Rows default to collapsed, so an unset pref counts as
  // collapsed too — otherwise the button would read "Collapse all" on a fresh
  // load when nothing is actually open.
  const allNarrativeOpen = NARRATIVE_KEYS.every((k) => uiPrefs[k] === "0");
  const toggleAllNarrative = () => {
    const next = allNarrativeOpen ? "1" : "0";
    NARRATIVE_KEYS.forEach((k) => setUiPref(k, next));
  };

  // Generation time for the Bottom Line byline, formatted once. Null on briefs
  // with no timestamp so the byline is dropped rather than showing "Invalid Date".
  const generatedTime = React.useMemo(() => {
    const raw = brief?.generatedAt;
    if (!raw) return null;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }, [brief]);

  const topActionsToday = brief?.topActionsToday || [];
  const hedgingCall = brief?.hedgingCall || null;
  const cashDeploymentCall = brief?.cashDeploymentCall || null;

  // Catalyst Calendar (Phase 01) — forward event strip + prose.
  const catalystEvents = brief?.catalystCalendar?.events ?? [];
  const catalystWatch = brief?.catalystWatch?.trim() || "";
  const CATALYST_COLLAPSED = 6;
  const visibleCatalystEvents = catalystExpanded
    ? catalystEvents
    : catalystEvents.slice(0, CATALYST_COLLAPSED);
  const catalystHiddenCount = catalystEvents.length - visibleCatalystEvents.length;

  // Regime-transition gauge (Phase 02) — forward "how close to a flip" chip.
  // Tone + wording are keyed off the shared valence so a de-risk toward Neutral
  // reads amber (not red), a thaw toward Neutral reads soft-green, a full Risk-On
  // shift reads green, and only a slide toward Risk-Off wears the red risk scale.
  const regimeTransition = brief?.regimeTransition ?? null;

  // Signal split behind the composite label, for the Decide regime tile's bar.
  // Counts come from the live regime blob (not the brief snapshot) so the bar
  // matches the Board; null when the blob hasn't loaded and the bar is skipped.
  const regimeComposite = React.useMemo(() => {
    const c = marketRegime?.composite;
    if (!c || !Array.isArray(c.signals) || c.signals.length === 0) return null;
    const count = (d: string) => c.signals.filter((s) => s.direction === d).length;
    return {
      score: c.score,
      total: c.total || c.signals.length,
      on: count("risk-on"),
      neutral: count("neutral"),
      off: count("risk-off"),
    };
  }, [marketRegime]);
  const transitionValence = regimeTransition
    ? regimeValence(regimeTransition.basedOnRegime, regimeTransition.leaning)
    : "none";
  const transitionLeanClass =
    transitionValence === "cooling-hard"
      ? "text-neg"
      : transitionValence === "cooling-soft"
      ? "text-warn"
      : transitionValence === "warming-hard" || transitionValence === "warming-soft"
      ? "text-pos"
      : "text-ink-3";
  const lk = regimeTransition?.likelihood;
  const transitionRiskClass =
    transitionValence === "warming-hard" || transitionValence === "warming-soft"
      ? "bg-pos-soft text-pos"
      : transitionValence === "cooling-soft"
      ? "bg-warn-soft text-warn"
      : transitionValence === "cooling-hard"
      ? lk === "High"
        ? "bg-neg-soft text-neg"
        : lk === "Elevated"
        ? "bg-warn-soft text-warn"
        : "bg-surface-2 text-ink-2"
      : "bg-surface-2 text-ink-2";
  const transitionBadgeText =
    transitionValence === "warming-hard"
      ? `${lk} risk-on shift`
      : transitionValence === "warming-soft"
      ? `${lk} warming`
      : transitionValence === "cooling-soft"
      ? `${lk} de-risking`
      : `${lk} transition risk`;
  // Parse a YYYY-MM-DD as a LOCAL date (avoid the UTC-midnight day-shift) and
  // format it compactly, e.g. "Wed Jul 15".
  const fmtCatalystDate = (iso: string): string => {
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return iso;
    return new Date(y, m - 1, d).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  };

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
      {/* Sticky command bar (redesign) — carries the title + date, the day's
          regime verdict, the section rail, the Brief/Daily Input toggle, the
          Regenerate action and the generated-at time. Replaces the three
          stacked header rows; every control they held lives here. */}
      <BriefGenerationModal
        open={genModalOpen && generating}
        runId={genRunId}
        onRunInBackground={() => setGenModalOpen(false)}
        hasPreviousBrief={Boolean(brief?.bottomLine)}
      />
      {/* The regime read, its score and the section rail moved into the
          decision panel + rail shell; the command bar now carries only the
          date line, the Brief / Daily-input toggle and Regenerate. */}
      <BriefCommandBar
        date={brief?.date || marketData.date}
        generatedAt={brief?.generatedAt}
        briefMode={briefMode}
        onModeChange={setBriefMode}
        onRegenerate={() => generateBrief(true)}
        generating={generating}
      />

      {variant === "summary" && briefMode === "brief" && summary}

      {briefMode === "input" && (() => {
        /* ── Daily Input, in the design's card language. Every control,
           handler and persistence path from the previous layout is preserved
           verbatim — this is reorganization plus a computed progress read,
           not a rewrite of behaviour. ── */
        const today = new Date().toISOString().slice(0, 10);
        const bo = marketData.breadthOverride ?? {};
        const editedMap = (bo.editedAt ?? {}) as Record<string, string | undefined>;
        const enteredToday = (f: string) => (editedMap[f] ?? "").slice(0, 10) === today;
        // 9 tracked fields: 6 core breadth + the up/down volume pair + 2 notes.
        const CORE: [string, string][] = [
          ["above200", "S&P > 200DMA"],
          ["above50", "S&P > 50DMA"],
          ["broadAbove200", "Broad > 200DMA"],
          ["broadAbove50", "Broad > 50DMA"],
          ["newHighs", "NYSE new highs"],
          ["newLows", "NYSE new lows"],
        ];
        const volDone = enteredToday("upVolume") && enteredToday("downVolume");
        const newtonDone = Boolean(marketData.strategistNotes?.newton) && (marketData.strategistNotes?.newtonDate ?? "") === today;
        const leeDone = Boolean(marketData.strategistNotes?.lee) && (marketData.strategistNotes?.leeDate ?? "") === today;
        const missing: string[] = [
          ...CORE.filter(([f]) => !enteredToday(f)).map(([, l]) => l),
          ...(volDone ? [] : ["up/down volume"]),
          ...(newtonDone ? [] : ["Newton note"]),
          ...(leeDone ? [] : ["Lee note"]),
        ];
        const done = 9 - missing.length;
        // "Mark all entered" = a per-day acknowledgement that the rest is
        // intentionally skipped today. Persisted via ui-prefs; auto-expires
        // because the stored value must equal today's date.
        const marked = uiPrefs["briefInputMarked"] === today;
        const effectiveMissing = marked ? [] : missing;

        const updateBreadthField = (field: string, raw: string) => {
          const v = raw === "" ? undefined : parseFloat(raw);
          const prev = marketData.breadthOverride ?? {};
          const valid = v != null && !isNaN(v);
          const nextEditedAt: Record<string, string> = { ...(prev.editedAt ?? {}) };
          if (valid) nextEditedAt[field] = new Date().toISOString();
          else delete nextEditedAt[field];
          onUpdateMarketData({
            breadthOverride: { ...prev, date: prev.date ?? today, [field]: valid ? v : undefined, editedAt: nextEditedAt },
          });
        };
        const clearAllBreadth = () => {
          if (!window.confirm("Clear all manual breadth values? You'll need to re-enter them from the source.")) return;
          onUpdateMarketData({ breadthOverride: { date: today } });
        };
        const numVal = (v: unknown): number | "" => (typeof v === "number" ? v : "");
        const BC = {
          sp200: "https://www.barchart.com/stocks/quotes/$S5TH",
          sp50: "https://www.barchart.com/stocks/quotes/$S5FI",
          broad: "https://www.barchart.com/stocks/momentum",
          nh: "https://www.barchart.com/stocks/quotes/$MAHN",
          nl: "https://www.barchart.com/stocks/quotes/$MALN",
        };
        const rowState = (f: string) => {
          if (enteredToday(f)) return { label: "saved", cls: "text-pos" };
          const ts = editedMap[f];
          return ts ? { label: ts.slice(5, 10), cls: "text-warn" } : { label: "empty", cls: "text-ink-faint" };
        };
        const Ext = ({ href, title }: { href: string; title: string }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" className="shrink-0 text-accent transition-colors" title={title}>
            <AppIcon name="external" size={13} />
          </a>
        );
        const breadthInputCls =
          "h-7 w-24 rounded-control border border-line bg-surface px-2.5 text-right font-mono text-[12.5px] text-ink outline-none transition-colors focus:border-accent-border";
        const words = (s?: string) => (s ? s.trim().split(/\s+/).filter(Boolean).length : 0);
        const ring = (2 * Math.PI * 15).toFixed(2);

        return (
          <>
            {/* Auto-fetch failure banners — unchanged behaviour. */}
            {(() => {
              const failedKeys = Object.entries(liveFields).filter(([, s]) => s === "failed").map(([k]) => k);
              const notConfiguredKeys = Object.entries(liveFields).filter(([, s]) => s === "not-configured").map(([k]) => k);
              const fieldLabel: Record<string, string> = { putCall: "Put/Call", termStructure: "VIX Term Structure" };
              if (marketDataError) {
                return (
                  <div className="rounded-card border border-warn-border bg-warn-soft px-3.5 py-2.5 text-[12px] text-warn">
                    <strong className="font-medium">Auto-fetch unavailable:</strong> {marketDataError}
                  </div>
                );
              }
              if (failedKeys.length > 0 || notConfiguredKeys.length > 0) {
                return (
                  <div className="space-y-1 rounded-card border border-warn-border bg-warn-soft px-3.5 py-2.5 text-[12px] text-warn">
                    {failedKeys.length > 0 && (
                      <div><strong className="font-semibold">Stale values shown for:</strong> {failedKeys.map((k) => fieldLabel[k] ?? k).join(", ")}. Hover each badge for the specific reason.</div>
                    )}
                    {notConfiguredKeys.length > 0 && (
                      <div><strong className="font-semibold">Manual entry required for:</strong> {notConfiguredKeys.map((k) => fieldLabel[k] ?? k).join(", ")}. Hover the Manual badge to see how to enable auto-fetch.</div>
                    )}
                  </div>
                );
              }
              return null;
            })()}

            {/* ── Progress card ── */}
            <section className="panel p-3.5">
              <div className="flex items-center gap-3.5">
                <div className="relative h-12 w-12 shrink-0">
                  <svg viewBox="0 0 36 36" className="h-12 w-12 -rotate-90">
                    <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3.5" className="stroke-line" />
                    <circle
                      cx="18" cy="18" r="15" fill="none" strokeWidth="3.5" strokeLinecap="round"
                      className={marked || done === 9 ? "stroke-pos" : "stroke-accent"}
                      strokeDasharray={ring}
                      strokeDashoffset={(Number(ring) * (1 - (marked ? 9 : done) / 9)).toFixed(2)}
                    />
                  </svg>
                  <span className="absolute inset-0 flex items-center justify-center font-mono text-[11px] font-medium text-ink">
                    {marked ? 9 : done}/9
                  </span>
                </div>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-ink">Daily input</div>
                  <div className="truncate text-[11.5px] text-ink-3">
                    {liveLoading
                      ? "Fetching live data…"
                      : marked
                        ? "Marked entered for today."
                        : done === 9
                          ? "All fields entered — ready to generate."
                          : `${missing.length} field${missing.length === 1 ? "" : "s"} left — ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}.`}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => setUiPref("briefInputMarked", marked ? "" : today)}
                  className="inline-flex h-7 flex-1 items-center justify-center rounded-control bg-ink px-4 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90"
                  title="Acknowledge today's input as complete — anything still empty is intentionally skipped. Resets automatically tomorrow."
                >
                  {marked ? "Unmark" : "Mark all entered"}
                </button>
                <button
                  onClick={() => setUiPref("briefInputMarked", "")}
                  className="inline-flex h-7 items-center rounded-control border border-line bg-surface px-4 text-[12.5px] text-ink-2 transition-colors hover:bg-surface-hover"
                >
                  Reset
                </button>
              </div>
            </section>

            <div className="grid gap-3.5 lg:grid-cols-2">
              {/* ── BREADTH ── */}
              <section className="panel">
                <div className="panel-h">
                  <span className="t">Breadth</span>
                  <span className="m">from your Barchart / BCMM read</span>
                  <span className="ml-auto font-mono text-[11px] text-ink-faint">7 fields</span>
                  <button
                    type="button"
                    onClick={clearAllBreadth}
                    className="inline-flex h-7 shrink-0 items-center rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 transition-colors hover:border-neg-border hover:text-neg"
                    title="Clear every manual breadth value and its freshness tag."
                  >
                    Clear
                  </button>
                </div>
                <div className="divide-y divide-line-soft">
                  {(
                    [
                      ["above200", "S&P > 200DMA", "%", BC.sp200, "51.2", "0.1"],
                      ["above50", "S&P > 50DMA", "%", BC.sp50, "44.6", "0.1"],
                      ["broadAbove200", "Broad > 200DMA", "%", BC.broad, "54.9", "0.1"],
                      ["broadAbove50", "Broad > 50DMA", "%", BC.broad, "59.4", "0.1"],
                      ["newHighs", "NYSE new highs", "", BC.nh, "78", "1"],
                      ["newLows", "NYSE new lows", "", BC.nl, "142", "1"],
                    ] as [string, string, string, string, string, string][]
                  ).map(([field, label, unit, href, ph, step]) => {
                    const st = rowState(field);
                    return (
                      <div key={field} className="flex items-center gap-2 px-3.5 py-2">
                        <span className="text-[12.5px] text-ink">{label}{unit && <span className="ml-1 text-ink-faint">{unit}</span>}</span>
                        <Ext href={href} title={`Open source: ${href}`} />
                        <input
                          type="number" step={step} min={0} placeholder={ph}
                          value={numVal((bo as Record<string, unknown>)[field])}
                          onChange={(e) => updateBreadthField(field, e.target.value)}
                          className={`ml-auto ${breadthInputCls}`}
                        />
                        <span className={`w-11 shrink-0 text-right text-[11px] ${st.cls}`}>{st.label}</span>
                      </div>
                    );
                  })}
                  {/* Up / down volume — one row, two boxes (only the ratio matters). */}
                  <div className="flex items-center gap-2 px-3.5 py-2">
                    <span className="text-[12.5px] text-ink">Up / down volume <span className="ml-1 text-ink-faint">bn</span></span>
                    <Ext href={BC.broad} title={`Open source: ${BC.broad}`} />
                    <input
                      type="number" step="0.01" min={0} placeholder="0.90"
                      value={numVal(bo.upVolume)}
                      onChange={(e) => updateBreadthField("upVolume", e.target.value)}
                      className={`ml-auto ${breadthInputCls} !w-[4.5rem]`}
                      title="NYSE advancing volume in billions — same unit as the down box; only the ratio matters."
                    />
                    <input
                      type="number" step="0.01" min={0} placeholder="3.45"
                      value={numVal(bo.downVolume)}
                      onChange={(e) => updateBreadthField("downVolume", e.target.value)}
                      className={`${breadthInputCls} !w-[4.5rem]`}
                      title="NYSE declining volume in billions — same unit as the up box."
                    />
                    <span className={`w-11 shrink-0 text-right text-[11px] ${volDone ? "text-pos" : bo.upVolume != null || bo.downVolume != null ? "text-warn" : "text-ink-faint"}`}>
                      {volDone ? "saved" : bo.upVolume != null || bo.downVolume != null ? "partial" : "empty"}
                    </span>
                  </div>
                  {/* Entry date — must equal today to be used by the brief. */}
                  <div className="flex items-center gap-2 px-3.5 py-2">
                    <span className="text-[12.5px] text-ink-2">Entry date</span>
                    <input
                      type="date"
                      value={bo.date ?? today}
                      onChange={(e) => onUpdateMarketData({ breadthOverride: { ...marketData.breadthOverride, date: e.target.value } })}
                      className="ml-auto h-7 rounded-control border border-line bg-surface px-2.5 font-mono text-[12.5px] text-ink-2 outline-none transition-colors focus:border-accent-border"
                      title="Must equal today's UTC date to be used. Earlier dates are treated as 'not entered today'."
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-soft px-3.5 py-2 text-[11px] text-ink-3">
                  <span>Sources (open once)</span>
                  <a href={BC.broad} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">Barchart Momentum</a>
                  <a href={BC.sp200} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">$S5TH</a>
                  <a href={BC.sp50} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">$S5FI</a>
                  <a href={BC.nh} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">$MAHN</a>
                  <a href={BC.nl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">$MALN</a>
                </div>
              </section>

              <div className="flex flex-col gap-3.5">
                {/* ── CONTRARIAN ── */}
                <section className="panel">
                  <div className="panel-h">
                    <span className="t">Contrarian</span>
                    <span className="m">inverted — a washed-out read is the bullish one</span>
                    <span className="ml-auto font-mono text-[11px] text-ink-faint">2 fields</span>
                  </div>
                  <div className="divide-y divide-line-soft">
                    <div className="flex items-center gap-2 px-3.5 py-2">
                      <span className="text-[12.5px] text-ink">S&amp;P oscillator</span>
                      <a href="https://app.marketedge.com/#!/markets" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline" title="MarketEdge S&P Oscillator">MarketEdge <AppIcon name="external" size={11} /></a>
                      <span className="text-[11px] text-ink-faint">{marketData.spOscillator < 0 ? "oversold · bullish" : marketData.spOscillator > 0 ? "overbought · bearish" : "neutral"}</span>
                      <SaveableNumericInput
                        savedValue={marketData.spOscillator}
                        onSave={(n) => onUpdateMarketData({ spOscillator: n })}
                        allowNegative
                        inputClassName={`ml-auto ${breadthInputCls}`}
                      />
                    </div>
                    <div className="flex items-center gap-2 px-3.5 py-2">
                      <span className="text-[12.5px] text-ink">Put / call</span>
                      <a href="https://www.cboe.com/us/options/market_statistics/daily/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline" title="CBOE Total Put/Call">CBOE <AppIcon name="external" size={11} /></a>
                      <SaveableNumericInput
                        savedValue={marketData.putCall}
                        onSave={(n) => onUpdateMarketData({ putCall: n })}
                        inputClassName={`ml-auto ${breadthInputCls}`}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-3 border-t border-line-soft px-3.5 py-3 sm:grid-cols-2">
                    <div>
                      <ImageUpload
                        section="spOscillator"
                        sectionLabel="S&P Oscillator chart"
                        attachments={attachments}
                        onAdd={addAttachment}
                        onRemove={removeAttachment}
                      />
                      <p className="mt-1 text-[11px] text-ink-3">Oscillator chart (optional) — Claude reads the shape, levels and recent extremes.</p>
                    </div>
                    <div>
                      <ImageUpload
                        section="newtonTechnical"
                        sectionLabel="Newton Technical Presentation"
                        attachments={attachments}
                        onAdd={addAttachment}
                        onRemove={removeAttachment}
                      />
                      <p className="mt-1 text-[11px] text-ink-3">Newton deck (PDF, optional) — parsed once, cached; relevance decays with age (&lt;14d full weight, 14–45d directional, &gt;45d context only).</p>
                    </div>
                  </div>
                  <p className="border-t border-line-soft px-3.5 py-2 text-[11px] text-ink-3">
                    CNN Fear &amp; Greed and AAII are auto-fetched — see Auto-fetched below.
                  </p>
                </section>

                {/* ── REPORTS DROPBOX ── */}
                <section className="panel">
                  <div className="panel-h">
                    <span className="t">Analyst / strategist reports</span>
                    <span className="m">optional</span>
                  </div>
                  <div className="px-3.5 py-3">
                    <ImageUpload
                      section="strategistReports"
                      sectionLabel="Analyst / Strategist Reports"
                      attachments={attachments}
                      onAdd={addAttachment}
                      onRemove={removeAttachment}
                    />
                    <p className="mt-1 text-[11px] text-ink-3">Any sell-side strategy note, economics piece or thematic deck (PDF or screenshot, multiple OK). Parsed once on upload, then cached; same age decay as the Newton deck.</p>
                  </div>
                </section>
              </div>
            </div>

            {/* ── STRATEGIST NOTES ── */}
            <section className="panel">
              <div className="panel-h">
                <span className="t">Strategist notes</span>
                <span className="m">copy-paste the daily reports — key takeaways feed the brief</span>
                <span className="ml-auto font-mono text-[11px] text-ink-faint">{(newtonDone ? 1 : 0) + (leeDone ? 1 : 0)} of 2 today</span>
              </div>
              <div className="grid gap-3.5 px-3.5 py-3 md:grid-cols-2">
                <div>
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <label className="text-[12.5px] font-medium text-ink">Mark Newton</label>
                    <span className="text-[11px] text-ink-3">(Technical Strategy)</span>
                    <StrategistTimingToggle
                      value={marketData.strategistNotes?.newtonTiming}
                      onChange={(next) =>
                        onUpdateMarketData({ strategistNotes: { ...marketData.strategistNotes, newtonTiming: next } })
                      }
                    />
                    <span className="ml-auto font-mono text-[11px] text-ink-faint">{words(marketData.strategistNotes?.newton)} words</span>
                    <input
                      type="date"
                      value={marketData.strategistNotes?.newtonDate ?? today}
                      onChange={(e) =>
                        onUpdateMarketData({ strategistNotes: { ...marketData.strategistNotes, newtonDate: e.target.value } })
                      }
                      className="h-7 rounded-control border border-line bg-surface px-2.5 text-[11.5px] text-ink-3 outline-none transition-colors focus:border-accent-border"
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
                          newtonDate: marketData.strategistNotes?.newtonDate ?? today,
                        },
                      })
                    }
                    label="Newton"
                    placeholder="Paste Mark Newton's daily technical strategy report here…"
                  />
                </div>
                <div>
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <label className="text-[12.5px] font-medium text-ink">Tom Lee</label>
                    <span className="text-[11px] text-ink-3">(Head of Research)</span>
                    <StrategistTimingToggle
                      value={marketData.strategistNotes?.leeTiming}
                      onChange={(next) =>
                        onUpdateMarketData({ strategistNotes: { ...marketData.strategistNotes, leeTiming: next } })
                      }
                    />
                    <span className="ml-auto font-mono text-[11px] text-ink-faint">{words(marketData.strategistNotes?.lee)} words</span>
                    <input
                      type="date"
                      value={marketData.strategistNotes?.leeDate ?? today}
                      onChange={(e) =>
                        onUpdateMarketData({ strategistNotes: { ...marketData.strategistNotes, leeDate: e.target.value } })
                      }
                      className="h-7 rounded-control border border-line bg-surface px-2.5 text-[11.5px] text-ink-3 outline-none transition-colors focus:border-accent-border"
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
                          leeDate: marketData.strategistNotes?.leeDate ?? today,
                        },
                      })
                    }
                    label="Tom Lee"
                    placeholder="Paste Tom Lee's daily strategy report here…"
                  />
                </div>
              </div>
            </section>

            {/* ── AUTO-FETCHED ── */}
            <section className="panel">
              <div className="panel-h">
                <span className="t">Auto-fetched</span>
                <span className="m">nothing to do — shown for confidence</span>
              </div>
              <div className="grid grid-cols-2 divide-x divide-line-soft lg:grid-cols-4">
                <div className="px-3.5 py-2.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-ink-3">
                    VIX term
                    <a href="http://vixcentral.com" target="_blank" rel="noopener noreferrer" className="text-accent" title="VIX Central"><AppIcon name="external" size={11} /></a>
                    <LiveStatusBadge status={liveFields.termStructure} reason={liveErrors.termStructure ?? "Derived from ^VIX3M / ^VIX ratio"} />
                  </div>
                  {/* Manual override select preserved — auto-fetch fills it, the PM can correct it. */}
                  <SaveableSelect
                    savedValue={marketData.termStructure}
                    onSave={(v) => onUpdateMarketData({ termStructure: v })}
                    options={[
                      { value: "Contango", label: "Contango" },
                      { value: "Flat", label: "Flat" },
                      { value: "Backwardation", label: "Backwardation" },
                    ]}
                    selectClassName="mt-1 h-7 w-full appearance-none rounded-control border border-transparent bg-transparent font-mono text-[13px] font-medium text-ink outline-none transition-colors hover:border-line focus:border-accent-border"
                  />
                </div>
                <div className="px-3.5 py-2.5">
                  <div className="text-[11px] text-ink-3">Fear &amp; Greed</div>
                  <div className="mt-1 flex items-baseline gap-1.5 font-mono text-[13px] font-medium text-ink">
                    {activeForward?.fearGreed?.value != null ? Math.round(activeForward.fearGreed.value) : "—"}
                    <span className="text-[11px] text-ink-3"><span className="dot bg-pos" aria-hidden /> Live</span>
                  </div>
                </div>
                <div className="px-3.5 py-2.5">
                  <div className="text-[11px] text-ink-3">AAII</div>
                  <div className="mt-1 flex items-baseline gap-1.5 font-mono text-[13px] font-medium text-ink">
                    {marketData.aaiiBull != null ? `${Math.round(marketData.aaiiBull)}/${Math.round(marketData.aaiiNeutral ?? 0)}/${Math.round(marketData.aaiiBear ?? 0)}` : "—"}
                    <span className="text-[11px] text-ink-3"><span className="dot bg-pos" aria-hidden /> Live</span>
                  </div>
                </div>
                <div className="px-3.5 py-2.5">
                  <div className="text-[11px] text-ink-3">HY / IG OAS</div>
                  <div className="mt-1 flex items-baseline gap-1.5 font-mono text-[13px] font-medium text-ink">
                    {activeForward?.hyOasTrend?.value != null ? Math.round(activeForward.hyOasTrend.value) : "—"}
                    {" / "}
                    {activeForward?.igOasTrend?.value != null ? Math.round(activeForward.igOasTrend.value) : "—"}
                    <span className="text-[11px] text-ink-3"><span className="dot bg-pos" aria-hidden /> Live</span>
                  </div>
                </div>
              </div>
            </section>

            {/* ── Generate bar ── */}
            <div className="flex flex-wrap items-center gap-3 rounded-card bg-ink px-3.5 py-3">
              <div className="min-w-0 text-white">
                <div className="text-[13px] font-semibold">
                  {effectiveMissing.length === 0 ? "Ready to generate" : `${effectiveMissing.length} still missing`}
                </div>
                <div className="truncate text-[11.5px] opacity-70">
                  {effectiveMissing.length === 0
                    ? marked && missing.length > 0
                      ? "marked entered — remaining gaps intentionally skipped"
                      : "all tracked inputs entered today"
                    : "You can generate anyway — gaps are flagged in the brief"}
                </div>
              </div>
              <button
                onClick={() => generateBrief(true)}
                disabled={generating}
                className="ml-auto inline-flex h-7 shrink-0 items-center rounded-control bg-white px-4 text-[12.5px] font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {generating ? "Generating…" : "Generate brief"}
              </button>
            </div>
          </>
        );
      })()}

      {error && (
        <div className="rounded-card border border-neg-border bg-neg-soft px-3.5 py-2.5 text-[12.5px] text-neg">
          {error}
        </div>
      )}

      {attachmentsSaveError && (
        <div className="rounded-card border border-warn-border bg-warn-soft px-3.5 py-2.5 text-[12.5px] text-warn">
          <strong className="font-medium">Screenshots not saved:</strong> {attachmentsSaveError}
        </div>
      )}

      {briefMode === "brief" && (
      <>
      {variant === "full" && (
      <>
      {/* ── Decide: the verdict on the left, four compact decision tiles on the right ── */}
      <div style={{ scrollMarginTop: "var(--brief-scroll-mt, 132px)" }} className="mb-2 mt-2 flex items-baseline gap-2.5" id="s-decide">
        <h2 className="text-xs font-bold uppercase tracking-[0.22em] text-ink-3">Decide</h2>
        <span className="text-[11px] text-ink-faint">the day&apos;s call, and the four reads behind it</span>
      </div>
      <section className="overflow-hidden rounded-card border border-line bg-white shadow-card">
      <div className="grid grid-cols-1 lg:grid-cols-[1.55fr_1fr] lg:divide-x lg:divide-line-soft">
        <div className="min-w-0">
      {/* Bottom Line — the design's white card: label with the model + time
          right-aligned, the call in full, the posture line as an inset cream
          callout, and "since last brief" folded INSIDE the card rather than
          floating below it as a separate blue panel. */}
      <section className="relative p-5">
        {generating && <LoadingOverlay message="Claude is analyzing markets..." />}
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <span className="text-xs font-bold uppercase tracking-[0.22em] text-ink-3">Bottom line</span>
          {generatedTime && (
            <span className="shrink-0 font-mono text-[11px] text-ink-faint">claude · {generatedTime}</span>
          )}
        </div>
        <p className="max-w-6xl text-sm leading-6 text-ink">
          {bottomLine}
        </p>
        {regimeVerdict && (
          <p className="mt-3 rounded-lg border border-warn-border bg-warn-soft px-3 py-2 text-sm font-semibold leading-6 text-ink">
            {regimeVerdict}
          </p>
        )}
        {brief?.whatChanged && brief.whatChanged.trim() && (
          <div className="mt-3 border-t border-line pt-3">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-3">
              Since last brief
            </div>
            <p className="text-[13px] leading-5 text-ink-2">{brief.whatChanged}</p>
          </div>
        )}
      </section>


        </div>
        {/* items-start is load-bearing: without it every tile stretches to the
            tallest in its row, so a verbose Cash tile left the calendar tile as
            a tall empty box. Each tile is now only as tall as its content. */}
        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 content-start items-stretch min-w-0 bg-surface-2/40">
      {/* Regime-transition gauge (Phase 02) — how close the current regime is
          to flipping + the early tells. A compact one-liner; the tells sit
          below as small pills. Hidden on briefs generated before Phase 02. */}
      {regimeTransition && (
        <section className="flex h-full flex-col rounded-xl border border-line bg-white px-4 py-3">
          {/* Mock form: label pill + distance-to-flip on one row, the composite
              read big, a proportional 3-segment bar, then the signal counts.
              Replaces the old 5-element wrapping header, which cost 3 lines at
              this column width. The transition tells are kept below — they are
              the early warning and are not shown anywhere else. */}
          <div className="flex items-center justify-between gap-2">
            <span className="rounded-md bg-ink px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">Regime</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${transitionRiskClass}`}>
              {transitionBadgeText}
            </span>
          </div>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className="text-xl font-semibold tracking-tight text-ink">{regimeTransition.basedOnRegime}</span>
            {regimeComposite && (
              <span className="font-mono text-sm text-ink-2">
                {regimeComposite.score}/{regimeComposite.total}
              </span>
            )}
            <span className={`ml-auto text-[10px] font-bold uppercase tracking-wide ${transitionLeanClass}`}>
              {regimeTransition.leaning}
            </span>
          </div>
          {regimeComposite && regimeComposite.total > 0 && (
            <>
              {/* Proportional split of the signals actually evaluated. */}
              <div className="mt-2 flex h-1.5 overflow-hidden rounded-pill bg-line">
                {([["on","bg-pos"],["neutral","bg-warn"],["off","bg-neg"]] as const).map(([k, tone]) => {
                  const n = k === "on" ? regimeComposite.on : k === "neutral" ? regimeComposite.neutral : regimeComposite.off;
                  if (!n) return null;
                  return <div key={k} className={tone} style={{ width: `${(n / regimeComposite.total) * 100}%` }} />;
                })}
              </div>
              <div className="mt-1.5 font-mono text-[10px] text-ink-3">
                {regimeComposite.on} risk-on · {regimeComposite.neutral} neutral · {regimeComposite.off} risk-off
              </div>
            </>
          )}
          {regimeTransition.tells.length > 0 && (
            <a href="#s-narrative" className="mt-2 inline-block text-[11px] font-medium text-accent hover:underline">
              {regimeTransition.tells.length} tell{regimeTransition.tells.length === 1 ? "" : "s"} ↓
            </a>
          )}
        </section>
      )}

          {hedgingCall && (
            <div className={`flex h-full flex-col rounded-card border p-5 ${
              hedgingCall.action === "ADD"
                ? "border-neg-border bg-neg-soft"
                : hedgingCall.action === "SKIP"
                  ? "border-pos-border bg-pos-soft"
                  : "border-line bg-surface-2"
            }`}>
              <div className="mb-3 flex items-center justify-between gap-2">
                <span className={`text-xs font-bold uppercase tracking-[0.22em] ${
                  hedgingCall.action === "ADD"
                    ? "text-neg"
                    : hedgingCall.action === "SKIP"
                      ? "text-pos"
                      : "text-ink-2"
                }`}>
                  Hedging
                </span>
                <button
                  onClick={refreshHedging}
                  disabled={hedgeRefreshing}
                  title="Re-run only the hedging read from live premiums — does not regenerate the brief"
                  className="rounded-full border border-line bg-white/70 px-1.5 py-0.5 text-[11px] text-ink-3 hover:text-ink disabled:opacity-50"
                >
                  {hedgeRefreshing ? "…" : "↻"}
                </button>
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
                {/* The number that defines "reasonable premium" sits on the
                    action row rather than in its own chip strip below — same
                    figure, one row instead of two. */}
                {brief?.hedgeChecklist?.midOtm5Percentile != null && (
                  <span
                    className={`ml-auto font-mono text-xs font-semibold ${
                      brief.hedgeChecklist.midOtm5Percentile <= 35
                        ? "text-pos"
                        : brief.hedgeChecklist.midOtm5Percentile >= 80
                          ? "text-neg"
                          : "text-ink-2"
                    }`}
                    title={`5% OTM premium percentile${brief.hedgeChecklist.vvix != null ? ` · VVIX ${brief.hedgeChecklist.vvix}` : ""}`}
                  >
                    {brief.hedgeChecklist.midOtm5Percentile}th pct
                  </span>
                )}
              </div>
              <p className="line-clamp-2 text-sm leading-5 text-ink-2" title={hedgingCall.reason}>
                {hedgingCall.reason}
              </p>
              {brief?.hedgeChecklist && brief.hedgeChecklist.midOtm5Percentile == null && (
                <p className="mt-2 text-[11px] text-ink-3">
                  premiums unranked
                  {typeof brief.hedgeChecklist.sessions === "number" ? ` (${brief.hedgeChecklist.sessions} sessions)` : ""}
                </p>
              )}

              {/* ── Position status: ground truth for HOLD, and the logger ── */}
              <div className="mt-3 border-t border-line/60 pt-2.5">
                {activeHedgesLive.length > 0 ? (
                  <div className="space-y-1">
                    {activeHedgesLive.map((h) => {
                      const dte = h.expiry && /^\d{4}-\d{2}-\d{2}$/.test(h.expiry)
                        ? Math.round((Date.parse(`${h.expiry}T00:00:00Z`) - Date.parse(`${todayIsoLocal}T00:00:00Z`)) / 86400000)
                        : null;
                      return (
                        <div key={h.id} className="flex items-start justify-between gap-2 text-[11px]">
                          <span className="text-ink">
                            <span className="text-pos font-semibold">On:</span>{" "}
                            {[h.tenorLabel, h.strikePctOtm != null ? `${h.strikePctOtm}% OTM` : null].filter(Boolean).join(" ")} SPY put
                            {h.premiumUsd != null ? ` · $${h.premiumUsd.toFixed(2)}` : ""}
                            {h.premiumPctOfSpot != null ? ` (${h.premiumPctOfSpot.toFixed(2)}% of spot)` : ""}
                            {h.implementedAt ? ` · since ${h.implementedAt.slice(0, 10)}` : ""}
                            {dte != null ? <span className={dte <= 14 ? "text-neg" : "text-ink-3"}> · {dte}d to expiry</span> : ""}
                          </span>
                          <button onClick={() => closeHedge(h.id)} className="shrink-0 text-[10px] text-ink-3 hover:text-neg" title="Mark this hedge closed">close</button>
                        </div>
                      );
                    })}
                    <button onClick={openHedgeForm} className="text-[11px] font-medium text-accent hover:underline">＋ Log another</button>
                    <a href="#s-narrative" className="ml-2 text-[11px] font-medium text-accent hover:underline">basis ↓</a>
                  </div>
                ) : (
                  <div className="text-[11px] text-ink-3">
                    Book <span className="font-semibold text-ink-2">unhedged</span>
                    {" · "}
                    <button onClick={openHedgeForm} className="font-medium text-accent hover:underline">
                      log a hedge
                    </button>
                    {" · "}
                    {/* The tile no longer carries its own "Full data basis" row;
                        the link rides here so the evidence stays one click away. */}
                    <a href="#s-narrative" className="font-medium text-accent hover:underline">basis ↓</a>
                  </div>
                )}

                {showHedgeForm && (
                  <div className="mt-2 rounded-lg border border-line bg-white/80 p-2.5">
                    <div className="mb-1.5 text-[11px] font-semibold text-ink">Log an implemented hedge</div>
                    <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                      {([
                        ["implementedAt", "Date implemented", "date"],
                        ["tenorLabel", "Tenor (e.g. 3 months)", "text"],
                        ["strikePctOtm", "Strike % OTM", "number"],
                        ["strikePrice", "Strike price $", "number"],
                        ["premiumUsd", "Premium $ / contract", "number"],
                        ["premiumPctOfSpot", "Premium % of spot", "number"],
                        ["contracts", "# Contracts", "number"],
                        ["expiry", "Expiry (YYYY-MM-DD)", "date"],
                      ] as [keyof HedgePos, string, string][]).map(([key, label, type]) => (
                        <label key={key} className="flex flex-col gap-0.5">
                          <span className="text-ink-3">{label}</span>
                          <input
                            type={type}
                            value={(hedgeForm[key] as string | number | undefined) ?? ""}
                            onChange={(e) => setHedgeForm((f) => ({ ...f, [key]: e.target.value }))}
                            className="rounded border border-line bg-white px-1.5 py-1 text-ink outline-none focus:border-accent-border"
                          />
                        </label>
                      ))}
                      <label className="col-span-2 flex flex-col gap-0.5">
                        <span className="text-ink-3">Notes</span>
                        <input
                          type="text"
                          value={hedgeForm.notes ?? ""}
                          onChange={(e) => setHedgeForm((f) => ({ ...f, notes: e.target.value }))}
                          className="rounded border border-line bg-white px-1.5 py-1 text-ink outline-none focus:border-accent-border"
                        />
                      </label>
                    </div>
                    <div className="mt-2 flex gap-2">
                      <button onClick={saveHedge} disabled={savingHedge} className="rounded-full bg-ink px-3 py-1 text-[11px] font-semibold text-white disabled:opacity-50">
                        {savingHedge ? "Saving…" : "Save hedge"}
                      </button>
                      <button onClick={() => setShowHedgeForm(false)} className="rounded-full border border-line px-3 py-1 text-[11px] text-ink-2 hover:text-ink">Cancel</button>
                    </div>
                    <p className="mt-1.5 text-[10px] leading-4 text-ink-3">Confirming a hedge here is what tells the brief protection is on — it will only say HOLD while an active position exists.</p>
                  </div>
                )}
              </div>

              {brief?.hedgingRefreshedAt && (
                <p className="mt-2 text-[10px] text-ink-3">
                  hedging refreshed {new Date(brief.hedgingRefreshedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} · rest of brief unchanged
                </p>
              )}
            </div>
          )}
      {/* Cash Deployment — full-width row below (it carries the most text, so
          stretching it across the page instead of a narrow column cuts scroll). */}
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
              : deploymentWindowStatus.tone === "orange" ? "bg-warn-soft text-warn"
              : deploymentWindowStatus.tone === "rose" ? "bg-neg-soft text-neg"
              : "bg-surface-2 text-ink-2";
            return (
              <div className={`flex h-full flex-col rounded-card border p-5 ${tone.border} ${tone.bg}`}>
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
                {/* Mock form: a segment per trigger the call evaluates, filled
                    for the ones met. Replaces the free-text window banner, which
                    wrapped to two lines and repeated the window already shown
                    above. Full reasoning stays in the Narrative row. */}
                {(() => {
                  const met = cashDeploymentCall.triggersMet?.length ?? 0;
                  const total = met + (cashDeploymentCall.triggersMissing?.length ?? 0);
                  if (total === 0) return null;
                  return (
                    <>
                      <div className="mt-2 flex gap-1">
                        {Array.from({ length: total }, (_, i) => (
                          <div
                            key={i}
                            className={`h-1.5 flex-1 rounded-pill ${i < met ? "bg-pos" : "bg-line"}`}
                          />
                        ))}
                      </div>
                      <div className="mt-1.5 font-mono text-[10px] text-ink-3">
                        {met} of {total} triggers · {deploymentWindowStatus.label}
                      </div>
                    </>
                  );
                })()}
                <a href="#s-narrative" className="mt-1.5 inline-block text-[11px] font-medium text-accent hover:underline">
                  Why · triggers ↓
                </a>
              </div>
            );
          })()}
      {/* Earnings tile — the mock's "next sessions" card rather than the old
          one-line strip, which rendered 37px tall and read as a rule between
          tiles instead of a peer of Hedging/Regime/Cash. Same data (portfolio
          holdings reporting within 7 days), given the count-first form the
          other Decide tiles use, with the dated macro events as a footer. */}
      {earningsSoon.length > 0 && (
        <div className="flex h-full flex-col rounded-card border border-warn-border bg-warn-soft p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="text-xs font-bold uppercase tracking-[0.22em] text-warn">Earnings</span>
            <span className="text-[10px] font-bold text-ink-3">next 7 sessions</span>
          </div>
          <div className="mb-2 flex items-baseline gap-2">
            <span className="text-2xl font-semibold tracking-tight text-warn">{earningsSoon.length}</span>
            <span className="text-xs text-ink-2">
              held name{earningsSoon.length === 1 ? "" : "s"} report
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {earningsSoon.map((e) => (
              <span key={e.ticker} className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-warn-border bg-white/70 px-1.5 py-0.5 text-[10px]">
                <span className="font-mono font-bold text-ink">{displayTicker(e.ticker)}</span>
                <span className="font-semibold text-warn">{e.days === 0 ? "today" : e.days === 1 ? "tmrw" : formatYmd(e.date)}</span>
              </span>
            ))}
          </div>
          {/* Macro footer: the dated non-earnings catalysts inside the same
              window, so the tile answers "what else lands this week". */}
          {(() => {
            const macro = catalystEvents.filter((e) => e.kind !== "earnings").slice(0, 3);
            if (!macro.length) return null;
            return (
              <div className="mt-2.5 border-t border-warn-border pt-2">
                <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-ink-3">
                  Also this week
                </div>
                <ul className="space-y-1">
                  {macro.map((e, i) => (
                    <li key={`${e.date}-${e.title}-${i}`} className="flex items-start gap-1.5 text-xs leading-4">
                      <span
                        className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${e.importance === "high" ? "bg-warn" : "bg-ink-faint"}`}
                        aria-hidden
                      />
                      <span className="text-ink-2">{e.title}</span>
                      <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-3">
                        {fmtCatalystDate(e.date)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}
        </div>
      )}

        </div>
      </div>
      </section>
      {/* ── Act: what to do today, with the risk flags that justify it ── */}
      <div style={{ scrollMarginTop: "var(--brief-scroll-mt, 132px)" }} className="mb-2 mt-2 flex items-baseline gap-2.5" id="s-act">
        <h2 className="text-xs font-bold uppercase tracking-[0.22em] text-ink-3">Act</h2>
        <span className="text-[11px] text-ink-faint">what to do today, and the risks that justify it</span>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.55fr_1fr] ">
        <div className="min-w-0">
          {topActionsToday.length > 0 && (
            <div className="rounded-card border border-line bg-white shadow-sm">
              <div className="flex items-center gap-2 border-b border-line px-5 py-3">
                <span className="text-xs font-bold uppercase tracking-[0.22em] text-ink-3">Do today</span>
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-ink px-1.5 text-[11px] font-bold text-white">
                  {topActionsToday.length}
                </span>
              </div>
              <ul className="divide-y divide-line-soft">
                {topActionsToday.map((action, i) => {
                  // Per-row jump button, as the design shows. The ticker is
                  // matched against the book rather than guessed from the
                  // prose, so a row only gets a button when it genuinely
                  // names a holding; otherwise it renders without one.
                  const hit = actionTicker(action);
                  return (
                    <li key={i} className="flex items-start gap-3 px-5 py-3">
                      <span className="mt-[3px] inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-surface-2 text-[11px] font-bold text-ink-3">
                        {i + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <span className="text-sm leading-6 text-ink">{action}</span>
                        {/* Evidence chips, matched by position then verified by
                            text so a mis-ordered model response can't attach
                            one action's evidence to another. */}
                        {(() => {
                          const d = brief?.topActionsDetail?.[i];
                          const tags = d && d.text === action ? d.tags : undefined;
                          if (!tags || tags.length === 0) return null;
                          return (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {tags.map((t, k) => (
                                <span key={k} className="rounded border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3">
                                  {t}
                                </span>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                      {hit && (
                        <a
                          href={`/stock/${encodeURIComponent(hit)}`}
                          className="shrink-0 rounded-control border border-line bg-white px-2.5 py-1 text-xs font-semibold text-ink-2 hover:text-ink"
                        >
                          Open {displayTicker(hit)}
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
        <div className="min-w-0">
      {/* Portfolio Risk Scan — full width. The Hedging Window card that
          used to sit beside it was a duplicate of the Decide hedging tile;
          its full detail (strike ladder, checklist, premium percentiles)
          lives in the Narrative "Hedging data basis" row. */}
      <section className="grid gap-4 grid-cols-1 items-start">
        {riskScan && riskScan.length > 0 ? (
          <div className="rounded-card border border-line bg-white shadow-sm">
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <h3 className="text-xs font-bold uppercase tracking-[0.22em] text-ink-3">Risk flags</h3>
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-neg px-1.5 text-[11px] font-bold text-white">
                {riskScan.length}
              </span>
              <a href="/risk" className="ml-auto text-xs font-medium text-ink-3 hover:text-ink">X-ray ↗</a>
            </div>
            <div className="divide-y divide-line-soft">
              {riskScan.map((item, i) => {
                const dot =
                  item.priority === "High" ? "bg-neg"
                  : item.priority === "Low-Medium" ? "bg-ink-faint"
                  : "bg-warn";
                const expanded = expandedRisk.has(i);
                return (
                  <div
                    key={i}
                    className="cursor-pointer px-4 py-2.5"
                    onClick={() => toggleRisk(i)}
                    title={expanded ? "Click to collapse" : "Click to expand"}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
                      <span className="w-[52px] shrink-0 font-mono text-[13px] font-bold text-ink">
                        {displayTicker(item.ticker)}
                      </span>
                      <span className={`min-w-0 flex-1 text-[13px] text-ink-2 ${expanded ? "" : "truncate"}`}>
                        {item.summary}
                      </span>
                      {/* The quantified driver, as the design shows. Briefs
                          generated before this field existed fall back to the
                          priority so nothing renders blank. */}
                      <span className={`shrink-0 font-mono text-[11px] font-semibold ${
                        item.priority === "High" ? "text-neg" : item.priority === "Low-Medium" ? "text-ink-3" : "text-warn"
                      }`} title={item.metric ? item.priority : undefined}>
                        {item.metric || item.priority}
                      </span>
                    </div>
                    {expanded && item.action && (
                      <p className="mt-1 pl-[68px] text-[13px] leading-snug text-ink-3">{item.action}</p>
                    )}
                  </div>
                );
              })}
            </div>
            {/* Sector tilt — real per-sector day moves from sectorPerformance,
                the two strongest and two weakest. Omitted when the brief
                predates that field rather than shown empty. */}
            {sectorTilt.length > 0 && (
              <div className="flex items-center gap-2 border-t border-line bg-surface-2/50 px-4 py-2">
                <span className="text-[11px] text-ink-3">Sector tilt</span>
                <div className="ml-auto flex flex-wrap justify-end gap-1">
                  {sectorTilt.map((t) => (
                    <span
                      key={t.sector}
                      className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${
                        t.dayPct >= 0
                          ? "border-pos-border bg-pos-soft text-pos"
                          : "border-neg-border bg-neg-soft text-neg"
                      }`}
                    >
                      {t.sector} {t.dayPct >= 0 ? "+" : ""}{t.dayPct.toFixed(1)}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="hidden" />
        )}

      </section>
        </div>
      </div>
      </>
      )}
      {/* ── Board: contrarian gauges + macro tiles ── */}
      {/* ── The board, as ONE panel with a tab row (canvas step 4): Macro board ·
          Sector rotation · Sentiment · Horizons · Narrative. These used to be a
          stack of five separate folds. Nothing inside them changed hands — each
          tab renders exactly the content its fold did. The active tab persists
          in pm:ui-prefs ("brief.tabs"); reading an unset pref never writes, so
          "Macro board" stays a presentational default until the PM picks one.
          The anchor ids the old section headers carried live on — s-board on
          the panel, s-horizon / s-narrative on their tab buttons — so existing
          deep links still land. ── */}
      {(() => {
        const TABS: { id: string; label: string; meta: string; anchor?: string }[] = [
          { id: "board", label: "Macro board", meta: "the macro read, in numbers" },
          {
            id: "sector",
            label: "Sector rotation",
            meta: brief?.sectorPerformance?.length ? `${brief.sectorPerformance.length} sectors` : "best → worst",
          },
          { id: "sentiment", label: "Sentiment", meta: "counter-signal read + catalysts" },
          { id: "horizons", label: "Horizons", meta: "tactical · cyclical · structural", anchor: "s-horizon" },
          { id: "narrative", label: "Narrative", meta: "the long-form model prose", anchor: "s-narrative" },
        ];
        const stored = uiPrefs["brief.tabs"];
        const tab = TABS.some((t) => t.id === stored) ? stored : "board";
        const meta = TABS.find((t) => t.id === tab)?.meta;
        const anchorStyle = { scrollMarginTop: "var(--brief-scroll-mt, 132px)" };
        return (
          <section id="s-board" style={anchorStyle} className="panel">
            <div className="panel-h flex-wrap">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  id={t.anchor}
                  style={t.anchor ? anchorStyle : undefined}
                  onClick={() => setUiPref("brief.tabs", t.id)}
                  aria-pressed={tab === t.id}
                  className={`-mb-px shrink-0 border-b-2 py-1 text-[13px] transition-colors ${
                    tab === t.id ? "border-ink font-semibold text-ink" : "border-transparent text-ink-2 hover:text-ink"
                  }`}
                >
                  {t.label}
                </button>
              ))}
              {meta && <span className="m ml-auto hidden min-w-0 truncate lg:inline">{meta}</span>}
              {tab === "narrative" && (
                <button
                  type="button"
                  onClick={toggleAllNarrative}
                  className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 transition-colors hover:bg-surface-hover ${meta ? "" : "ml-auto"}`}
                >
                  <AppIcon name={allNarrativeOpen ? "chevU" : "chevD"} size={13} />
                  {allNarrativeOpen ? "Collapse all" : "Expand all"}
                </button>
              )}
            </div>

            {/* ── Macro board: the condensed band/tile grid, carrying its own
                band + horizon filters, LIVE/stale status, verify links and
                source attribution per tile. ── */}
            {tab === "board" && (
              <MacroBoard
                fwd={(activeForward ?? null) as never}
                termStructure={marketData.termStructure}
                vvix={brief?.hedgeChecklist?.vvix ?? null}
                regime={marketRegime}
              />
            )}

            {/* ── Sector rotation: summary, the live per-sector heatmap (or the
                leading/lagging fallback), then the PM implication. ── */}
            {tab === "sector" &&
              (sectorRotation ? (
                <div className="px-3.5 py-3">
                  <ClampText text={sectorRotation.summary} className="mb-3.5" />
                  {brief?.sectorPerformance && brief.sectorPerformance.length > 0 ? (
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-11">
                      {[...brief.sectorPerformance]
                        .sort((a, b) => (b.dayPct ?? -Infinity) - (a.dayPct ?? -Infinity))
                        .map((s) => {
                          const pos = (s.dayPct ?? 0) >= 0;
                          return (
                            <div key={s.etf} className="rounded-control border border-line-soft bg-surface-2 p-2">
                              <div className="flex items-baseline justify-between gap-1">
                                <span className="font-mono text-[11.5px] font-medium text-ink">{s.etf}</span>
                                <span className={`font-mono text-[12px] ${s.dayPct == null ? "text-ink-3" : pos ? "text-pos" : "text-neg"}`}>
                                  {s.dayPct == null ? "—" : `${pos ? "+" : ""}${s.dayPct.toFixed(1)}`}
                                </span>
                              </div>
                              <div className="mt-0.5 truncate text-[11px] text-ink-3" title={s.sector}>{s.sector}</div>
                            </div>
                          );
                        })}
                    </div>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <div className="mb-1.5 text-[11px] text-ink-3">Leading</div>
                        {sectorRotation.leading.map((s, i) => (
                          <div key={i} className="mb-1 flex items-center gap-2 text-[12.5px] text-ink">
                            <span className="dot bg-pos" /> <span>{s}</span>
                          </div>
                        ))}
                      </div>
                      <div>
                        <div className="mb-1.5 text-[11px] text-ink-3">Lagging</div>
                        {sectorRotation.lagging.map((s, i) => (
                          <div key={i} className="mb-1 flex items-center gap-2 text-[12.5px] text-ink">
                            <span className="dot bg-neg" /> <span>{s}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <ClampText text={sectorRotation.pmImplication} className="mt-3" textClassName="text-[12.5px] leading-relaxed text-ink-2" />
                </div>
              ) : (
                <p className="px-3.5 py-6 text-center text-[12px] text-ink-3">This brief carries no sector-rotation read.</p>
              ))}

            {/* ── Sentiment: the four contrarian gauges beside the dated
                calendar they have to survive. ── */}
            {tab === "sentiment" && (
              <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:divide-x lg:divide-line-soft">
                <div className="min-w-0 px-3.5 py-3">
                  <SentimentGauges
                    marketData={marketData}
                    aaiiBull={marketData.aaiiBull ?? 30}
                    aaiiNeutral={marketData.aaiiNeutral ?? 17}
                    aaiiBear={marketData.aaiiBear ?? 52}
                    contrarianAnalysis={contrarianAnalysis}
                    forwardData={activeForward}
                  />
                </div>
                <div className="min-w-0 px-3.5 py-3">
                  {/* Catalyst watch — the next ~2 weeks (Phase 01). Deterministic
                      dated event strip (earnings for the book + econ + FOMC) plus
                      the model's exposure read. Hidden when there's neither prose
                      nor events (old briefs pre-date this). */}
                  {catalystWatch || catalystEvents.length > 0 ? (
                    <>
                      <div className="mb-2.5 flex items-center gap-2">
                        <span className="text-[13px] font-semibold text-ink">Catalyst watch</span>
                        <span className="ml-auto text-[11.5px] text-ink-3">next 2 weeks</span>
                      </div>
                      {catalystWatch && <p className="mb-3 text-[12.5px] leading-relaxed text-ink-2">{catalystWatch}</p>}
                      {catalystEvents.length > 0 && (
                        <>
                          <ul className="flex flex-col gap-1.5">
                            {visibleCatalystEvents.map((e, i) => (
                              <li key={`${e.date}-${e.title}-${i}`} className="flex items-center gap-2.5 text-[12.5px]">
                                <span className="w-[92px] shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums text-ink-3">
                                  {fmtCatalystDate(e.date)}
                                </span>
                                <span className={`dot ${e.importance === "high" ? "bg-warn" : "bg-ink-faint"}`} aria-hidden />
                                <span className="min-w-0 flex-1 truncate text-ink">{e.title}</span>
                                {e.kind === "earnings" && e.bucket === "Portfolio" && (
                                  <span className="shrink-0 text-[11px] text-ink-3">held</span>
                                )}
                              </li>
                            ))}
                          </ul>
                          {(catalystHiddenCount > 0 || catalystExpanded) && catalystEvents.length > CATALYST_COLLAPSED && (
                            <button
                              onClick={toggleCatalyst}
                              className="mt-2 text-[11.5px] text-accent transition-colors hover:text-accent-ink"
                            >
                              {catalystExpanded ? "Show less" : `Show ${catalystHiddenCount} more`}
                            </button>
                          )}
                        </>
                      )}
                    </>
                  ) : (
                    <p className="py-6 text-center text-[12px] text-ink-3">No dated catalysts in the next two weeks.</p>
                  )}
                </div>
              </div>
            )}

            {/* ── Horizons: tactical / cyclical / structural, each with its
                deterministic composite and its invalidator. ── */}
            {tab === "horizons" && (
              <div>
                <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3.5 py-2">
                  <span className="text-[11px] text-ink-3">Forward view · multi-horizon</span>
                  {forwardLoading && <span className="animate-pulse text-[11px] text-accent">Fetching live data…</span>}
                  {activeForward && (
                    <span
                      className={`text-[11px] ${activeForward.fredEnabled ? "text-pos" : "text-ink-3"}`}
                      title={
                        activeForward.fredEnabled
                          ? "FRED API connected — rates and credit use official end-of-day series"
                          : "FRED API key not configured — rates use Yahoo ^TNX/^IRX. Add FRED_API_KEY to .env.local for DGS10/DGS2/DGS3MO/HY OAS/IG OAS."
                      }
                    >
                      {activeForward.fredEnabled ? "FRED + Yahoo" : "Yahoo only"}
                    </span>
                  )}
                  {brief?.marketRegime && (
                    <span className="ml-auto flex items-center gap-2">
                      <span className="text-[11px] text-ink-3">Regime</span>
                      <SignalPill tone={brief.marketRegime === "Risk-Off" ? "red" : brief.marketRegime === "Risk-On" ? "green" : "amber"}>
                        {brief.marketRegime}
                      </SignalPill>
                      {typeof brief.regimeScore === "number" && (
                        <span className="font-mono text-[11.5px] text-ink-3">
                          score {brief.regimeScore >= 0 ? "+" : ""}{brief.regimeScore}
                        </span>
                      )}
                    </span>
                  )}
                </div>

                {/* Visible banner when the forward-looking fetch fails or returns
                    no tiles at all — so the user knows the panel is unavailable
                    rather than silently blank. */}
                {(forwardError || (!activeForward && !forwardLoading)) && (
                  <div className="border-b border-line-soft bg-warn-soft px-3.5 py-2 text-[11.5px] text-warn">
                    <span className="font-medium">Forward-looking data unavailable:</span>{" "}
                    {forwardError ??
                      "The /api/forward-looking endpoint returned no data. Tile values will fill in on the next successful refresh."}
                  </div>
                )}

                {/* Three-horizon outlook cards. Each pairs the AI text with the
                    deterministic horizon composite from pm:market-regime so the
                    PM sees both reads side by side. */}
                {(() => {
                  const horizonsData = marketRegime?.horizons;
                  const cards: { id: "tactical" | "cyclical" | "structural"; label: string; weight: string; text: string; invalidator?: string }[] = [
                    { id: "tactical", label: "Tactical · 1–3M", weight: "50%", text: tacticalView, invalidator: brief?.tacticalInvalidator },
                    { id: "cyclical", label: "Cyclical · 3–6M", weight: "30%", text: cyclicalView, invalidator: brief?.cyclicalInvalidator },
                    { id: "structural", label: "Structural · 6–12M", weight: "20%", text: structuralView, invalidator: brief?.structuralInvalidator },
                  ];
                  return (
                    <div className="grid grid-cols-1 divide-y divide-line-soft md:grid-cols-3 md:divide-x md:divide-y-0">
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
                          <div key={c.id} className="min-w-0 px-3.5 py-3">
                            <div className="mb-2 flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <span className="text-[11px] text-ink-3">{c.label}</span>
                                <span className="font-mono text-[11px] text-ink-faint">×{c.weight}</span>
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
                              {(!b || empty) && <span className="text-[11px] text-ink-3">no signals</span>}
                            </div>
                            <p className="text-[12.5px] leading-relaxed text-ink-2">{c.text}</p>
                            {c.invalidator && (
                              <div className="mt-2 flex items-start gap-1.5 border-t border-line-soft pt-2">
                                {/* Labelled KILL per the design — same field, the
                                    name the PM uses for "this thesis is broken". */}
                                <span className="mt-px flex-none text-[11px] text-ink-3">Kill</span>
                                <span className="text-[11.5px] leading-relaxed text-ink-2">{c.invalidator}</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}

                {/* Synthesis block retired (2026-07): it was the legacy
                    "forwardView" tie-together paragraph, which overlapped the
                    Bottom Line + the three horizon cards. forwardView is still
                    generated for backward-compat but no longer rendered. */}

                {activeForward?.fetchedAt && (
                  <p className="border-t border-line-soft px-3.5 py-2 text-[11.5px] text-ink-3">
                    Data fetched {new Date(activeForward.fetchedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}
                    {" · "}Click any icon to verify the source.
                  </p>
                )}
              </div>
            )}

            {/* ── Narrative: the long-form model prose, as flush rows. ── */}
            {tab === "narrative" && (
              <div className="divide-y divide-line-soft">
              {/* Composite Signal — the weighted regime read that DETERMINES the regime,
                  surfaced high on the page (right under the at-a-glance actions) rather
                  than buried below the Forward View. */}
              {/* Hedging data basis — the full ✓/✗ checklist, live premium table,
                  percentile history and regime inputs. Moved out of the Decide
                  tile so that tile stays a 4-line summary; nothing was dropped. */}
              {/* Regime tells — the early-warning signals behind the Decide regime
                  tile. They live here, not on the tile, so the tile stays a four-line
                  read; the tile's "N tells" link jumps to this row. */}
              {regimeTransition && regimeTransition.tells.length > 0 && (
                <CollapsibleSection
                  prefKey="briefNarrativeRegimeTells"
                  flush
                  defaultCollapsed
                  title={
                    <span className="flex items-center gap-2">
                      <span className="dot bg-ink-3" aria-hidden />
                      <span className="text-[13px] font-semibold">Regime tells</span>
                    </span>
                  }
                  subtitle={
                    <span className="text-[11.5px] text-ink-3">
                      {regimeTransition.tells.filter((t) => t.momentum === "deteriorating").length} deteriorating ·{" "}
                      {regimeTransition.boundaryGap} signal{regimeTransition.boundaryGap === 1 ? "" : "s"} from a flip
                    </span>
                  }
                >
                  <div className="mt-1.5 space-y-1.5">
                    {regimeTransition.tells.map((t, i) => (
                      <div key={`${t.name}-${i}`} className="flex gap-2 text-[11px] leading-4">
                        <span className={`dot mt-1.5 ${t.momentum === "deteriorating" ? "bg-neg" : "bg-pos"}`} aria-hidden />
                        <span className="font-semibold text-ink">{t.name}</span>
                        <span className="text-ink-2">{t.detail}</span>
                      </div>
                    ))}
                  </div>
                </CollapsibleSection>
              )}
              {breadthAnalysis && (
                <CollapsibleSection
                  prefKey="briefNarrativeBreadth"
                  flush
                  defaultCollapsed
                  title={
                    <span className="flex items-center gap-2">
                      <span className="dot bg-neg" aria-hidden />
                      <span className="text-[13px] font-semibold">Breadth & internals</span>
                    </span>
                  }
                  subtitle={<span className="text-[11.5px] text-ink-3">participation behind the index move</span>}
                >
                  <ClampText text={breadthAnalysis} />
                </CollapsibleSection>
              )}
              {volatilityAnalysis && (
                <CollapsibleSection
                  prefKey="briefNarrativeCredit"
                  flush
                  defaultCollapsed
                  title={
                    <span className="flex items-center gap-2">
                      <span className="dot bg-pos" aria-hidden />
                      <span className="text-[13px] font-semibold">Credit & volatility</span>
                    </span>
                  }
                  subtitle={<span className="text-[11.5px] text-ink-3">where stress shows up before it hits price</span>}
                >
                  <ClampText text={volatilityAnalysis} />
                  {creditAnalysis && <ClampText text={creditAnalysis} className="mt-3" />}
                </CollapsibleSection>
              )}
              {brief?.hedgeChecklist && (
                <CollapsibleSection
                  prefKey="briefNarrativeHedgeBasis"
                  flush
                  defaultCollapsed
                  title={
                    <span className="flex items-center gap-2">
                      <span className="dot bg-accent" aria-hidden />
                      <span className="text-[13px] font-semibold">Hedging data basis</span>
                    </span>
                  }
                  subtitle={
                    <span className="text-[11.5px] text-ink-3">
                      {brief.hedgeChecklist.items.filter((i) => i.ok === true).length} met ·{" "}
                      {brief.hedgeChecklist.items.filter((i) => i.ok === false).length} not · live SPY premiums
                    </span>
                  }
                >
                  <div className="mt-1.5 space-y-3 text-[11px] leading-4">
                    {/* 1 · Entry checklist */}
                    <div className="space-y-1">
                      {(["risk-off", "cheap"] as const).map((path) => (
                        <div key={path}>
                          <div className="font-semibold text-ink-2">
                            {path === "risk-off" ? "Path 1 · Classic Risk-Off" : "Path 2 · Cheap insurance + late-cycle"}
                          </div>
                          {brief.hedgeChecklist!.items.filter((i) => i.path === path).map((i, idx) => (
                            <div key={idx} className="flex gap-1.5 text-ink-2">
                              <span className={`mt-0.5 shrink-0 ${i.ok === true ? "text-pos" : "text-ink-3"}`}>
                                <AppIcon name={i.ok == null ? "help" : i.ok ? "check" : "x"} size={12} />
                              </span>
                              <span className={i.ok === true ? "text-ink" : "text-ink-3"}>{i.label}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>

                    {/* 2 · Live premiums the call was priced against */}
                    {brief.hedgingDetail && (
                      <div>
                        <div className="font-semibold text-ink-2">
                          Live SPY put premiums · spot ${brief.hedgingDetail.spotPrice.toFixed(2)} · CBOE {new Date(brief.hedgingDetail.fetchedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} (15-min delay)
                        </div>
                        <div className="mt-1.5 overflow-x-auto">
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>Expiry</th>
                                <th className="n">ATM</th>
                                <th className="n">5% OTM</th>
                                <th className="n">10% OTM</th>
                              </tr>
                            </thead>
                            <tbody>
                              {brief.hedgingDetail.anchors.map((a) => {
                                const f = (p: number | null, pct: number | null) =>
                                  p != null ? `$${p.toFixed(2)}${pct != null ? ` (${pct.toFixed(2)}%)` : ""}` : "—";
                                return (
                                  <tr key={a.expiryLabel}>
                                    <td>{a.expiryLabel} · {a.daysToExpiry}d</td>
                                    <td className="n">{f(a.atmPremium, a.atmPctOfSpot)}</td>
                                    <td className="n">{f(a.otm5Premium, a.otm5PctOfSpot)}</td>
                                    <td className="n">{f(a.otm10Premium, a.otm10PctOfSpot)}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {/* 3 · Premium history: percentile rank + trend */}
                    {brief.hedgingDetail && (
                      <div>
                        <div className="font-semibold text-ink-2">
                          Premium history · {brief.hedgingDetail.sessions} sessions{brief.hedgingDetail.firstDate ? ` since ${brief.hedgingDetail.firstDate}` : ""} (low percentile = cheap WITHIN this window)
                        </div>
                        {brief.hedgingDetail.buckets.map((b) => (
                          <div key={b.bucket} className="text-ink-2">
                            {b.bucket}: 5%OTM {b.otm5Percentile != null ? `${b.otm5Percentile}th pct` : "unranked"} · 10%OTM {b.otm10Percentile != null ? `${b.otm10Percentile}th pct` : "unranked"} · skew {b.skewRatio != null ? b.skewRatio.toFixed(2) : "—"}{b.skewPercentile != null ? ` (${b.skewPercentile}th)` : ""}
                          </div>
                        ))}
                        {brief.hedgingDetail.volAnchor && (brief.hedgingDetail.volAnchor.vix || brief.hedgingDetail.volAnchor.vix3m) && (
                          <div className="mt-0.5 text-ink-2">
                            Long-horizon anchor:{" "}
                            {brief.hedgingDetail.volAnchor.vix3m && (
                              <span className={brief.hedgingDetail.volAnchor.vix3m.percentile <= 40 ? "text-pos" : brief.hedgingDetail.volAnchor.vix3m.percentile >= 75 ? "text-neg" : ""}>
                                VIX3M {brief.hedgingDetail.volAnchor.vix3m.level} = {brief.hedgingDetail.volAnchor.vix3m.percentile}th pct of ~{brief.hedgingDetail.volAnchor.vix3m.years}y
                              </span>
                            )}
                            {brief.hedgingDetail.volAnchor.vix3m && brief.hedgingDetail.volAnchor.vix && " · "}
                            {brief.hedgingDetail.volAnchor.vix && (
                              <span>VIX {brief.hedgingDetail.volAnchor.vix.level} = {brief.hedgingDetail.volAnchor.vix.percentile}th of ~{brief.hedgingDetail.volAnchor.vix.years}y</span>
                            )}
                            <span className="text-ink-3"> — whether the whole window above is itself a cheap or expensive vol regime</span>
                          </div>
                        )}
                        {(brief.hedgingDetail.wow || brief.hedgingDetail.mom) && (
                          <div className="mt-0.5 text-ink-3">
                            {brief.hedgingDetail.wow && (
                              <div>
                                WoW (vs {brief.hedgingDetail.wow.vsDate}): {brief.hedgingDetail.wow.rows.map((r) => `${r.expiryLabel} 5%OTM ${r.otm5DeltaPct != null ? `${r.otm5DeltaPct > 0 ? "+" : ""}${r.otm5DeltaPct}%` : "—"}`).join(" · ")}
                              </div>
                            )}
                            {brief.hedgingDetail.mom && (
                              <div>
                                MoM (vs {brief.hedgingDetail.mom.vsDate}): {brief.hedgingDetail.mom.rows.map((r) => `${r.expiryLabel} 5%OTM ${r.otm5DeltaPct != null ? `${r.otm5DeltaPct > 0 ? "+" : ""}${r.otm5DeltaPct}%` : "—"}`).join(" · ")}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* 4 · Regime / vol / sentiment inputs */}
                    {brief.hedgeChecklist.inputs && (
                      <div>
                        <div className="font-semibold text-ink-2">Regime, vol & sentiment inputs</div>
                        <div className="text-ink-2">
                          Regime {brief.hedgeChecklist.inputs.consolidatedRegime}
                          {brief.hedgeChecklist.inputs.transitionLeaning ? ` · transition ${brief.hedgeChecklist.inputs.transitionLeaning} (${brief.hedgeChecklist.inputs.transitionLikelihood})` : ""}
                          {brief.hedgeChecklist.inputs.riskOffSignalCount != null ? ` · ${brief.hedgeChecklist.inputs.riskOffSignalCount} risk-off signals` : ""}
                        </div>
                        <div className="text-ink-2">
                          {brief.hedgeChecklist.inputs.vix != null ? `VIX ${brief.hedgeChecklist.inputs.vix}` : "VIX —"}
                          {brief.hedgeChecklist.inputs.termStructure ? ` (${brief.hedgeChecklist.inputs.termStructure})` : ""}
                          {brief.hedgeChecklist.vvix != null ? ` · VVIX ${brief.hedgeChecklist.vvix}` : ""}
                          {brief.hedgeChecklist.inputs.fearGreed != null ? ` · F&G ${brief.hedgeChecklist.inputs.fearGreed}` : ""}
                          {brief.hedgeChecklist.inputs.oscillator != null ? ` · Oscillator ${brief.hedgeChecklist.inputs.oscillator >= 0 ? "+" : ""}${brief.hedgeChecklist.inputs.oscillator}%` : ""}
                        </div>
                      </div>
                    )}

                    {/* 5 · Method note — the rules the model operates under */}
                    <div className="border-t border-line-soft pt-1.5 text-[11px] leading-4 text-ink-3">
                      Method: protective SPY puts only · strikes 5–10% OTM (ATM only for acute ≤30d tail risk) · tenor 2–9M mapped to whichever horizon is Risk-Off · ADD needs Path 1 (≥2/3) or Path 2 (premium ✓ + ≥1 late-cycle sign) · skip-first philosophy — the model may override any checklist line but must name it. Percentiles rank each tenor against its own trailing ledger.
                    </div>
                  </div>
                </CollapsibleSection>
              )}

              {/* Cash deployment reasoning — the tile up in Decide shows the call;
                  the why and the trigger checklist live here. */}
              {cashDeploymentCall && (
                <CollapsibleSection
                  prefKey="briefNarrativeCash"
                  flush
                  defaultCollapsed
                  title={<span className="flex items-center gap-2"><span className="dot bg-warn" aria-hidden /><span className="text-[13px] font-semibold">Cash deployment</span></span>}
                  subtitle={<span className="text-[11.5px] text-ink-3">{cashDeploymentCall.action}{typeof cashDeploymentCall.score === "number" ? ` · ${cashDeploymentCall.score}/100` : ""}</span>}
                >
                {/* Clamped: this tile now sits in the Decide column, and the
                    full reasoning + Newton note ran long enough to dwarf the
                    other three tiles. Nothing is lost — ClampText keeps the
                    whole text one click away. */}
                <ClampText
                  text={cashDeploymentCall.reason}
                  className="mb-2.5"
                  textClassName="text-[12.5px] leading-relaxed text-ink-2"
                  lines={4}
                />
                {cashDeploymentCall.newtonPersistence && (
                  <ClampText
                    text={`Newton: ${cashDeploymentCall.newtonPersistence}`}
                    className="mb-2.5"
                    textClassName="text-[11.5px] italic leading-relaxed text-ink-2"
                    lines={3}
                  />
                )}
                {(cashDeploymentCall.triggersMet?.length || cashDeploymentCall.triggersMissing?.length) ? (
                  <div className="grid grid-cols-1 gap-y-1 mb-2.5 text-[11px] leading-4">
                    <div className="space-y-1">
                      {cashDeploymentCall.triggersMet?.slice(0, 4).map((t, i) => (
                        <div key={`m${i}`} className="flex items-start gap-1.5 text-pos">
                          <span className="mt-0.5 flex-none"><AppIcon name="check" size={12} /></span>
                          <span>{t}</span>
                        </div>
                      ))}
                    </div>
                    <div className="space-y-1">
                      {cashDeploymentCall.triggersMissing?.slice(0, 4).map((t, i) => (
                        <div key={`x${i}`} className="flex items-start gap-1.5 text-ink-3">
                          <span className="dot mt-1.5 flex-none bg-ink-faint" aria-hidden />
                          <span>{t}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                </CollapsibleSection>
              )}

              {/* Accordion rows (redesign): the long-form prose is reference reading,
                  so each row collapses to a title + one-line summary and opens on
                  click. Collapsed by DEFAULT — this is what stops the narrative from
                  dominating the page. State persists via pm:ui-prefs, so a row the PM
                  keeps open stays open across reloads. */}
              <CollapsibleSection
                prefKey="briefNarrativeComposite"
                  flush
                defaultCollapsed
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="dot bg-warn" aria-hidden />
                    <span className="text-[13px] font-semibold">Composite Signal</span>
                  </span>
                }
                subtitle={
                  <span className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-3">
                    <SignalPill tone={compositeSignalTone}>{marketData.compositeSignal}</SignalPill>
                    <span>Conviction: {marketData.conviction}</span>
                    {brief?.marketRegime && (
                      <SignalPill tone={brief.marketRegime === "Risk-Off" ? "red" : brief.marketRegime === "Risk-On" ? "green" : "amber"}>
                        {brief.marketRegime}
                      </SignalPill>
                    )}
                  </span>
                }
              >
                <p className="text-[11.5px] text-ink-3">
                  The deterministic regime read — what the tape and macro data say the market <strong className="text-ink-2">is</strong> doing, and what to focus on.
                </p>
                <ClampText text={compositeAnalysis} className="mt-2" />
              </CollapsibleSection>

              {/* Non-consensus edge — what the tape may be under-pricing. Distilled
                  across all integrated sources; hidden when the model returns blank. */}
              {brief?.underpriced && brief.underpriced.trim() && (
                <CollapsibleSection
                  prefKey="briefNarrativeUnderpriced"
                  flush
                  defaultCollapsed
                  className="border-violet-soft bg-violet-soft/40"
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="dot bg-violet" aria-hidden />
                      <span className="text-[13px] font-semibold">What the tape may be under-pricing</span>
                    </span>
                  }
                  subtitle={<span className="text-[11px] text-violet">Non-consensus</span>}
                >
                  <p className="text-[12.5px] leading-relaxed text-ink-2">{brief.underpriced}</p>
                </CollapsibleSection>
              )}
              </div>
            )}
          </section>
        );
      })()}

      {/* Action Items section retired (2026-07): it duplicated the
          Top Actions Today one-liners near the top of the brief. forwardActions
          is still generated (and still feeds topActionsToday) — just no longer
          rendered as a separate lengthy panel. */}
      </>
      )}
    </>
  );
}
