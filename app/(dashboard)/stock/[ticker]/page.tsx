"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { StatStrip } from "@/app/components/StatStrip";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { resolveUsEquityPct } from "@/app/lib/us-equity-exposure";
import { SCORE_GROUPS, MAX_SCORE, INSTRUMENT_LABELS } from "@/app/lib/types";
import type { ScoreKey, Scores, FundData, ScoreDataPoint, ScoreDataPointSource, ExternalSourceNote } from "@/app/lib/types";
import { groupTotal, isScoreable, normalizeSector, marketEdgeApplies, boostedAiApplies, siaApplies, ownershipTrendsApplies } from "@/app/lib/scoring";
import { computeAnalystConsensus, buildConsensusExplanation } from "@/app/lib/analyst-snapshots";
import { displayTicker } from "@/app/lib/ticker";
import { AnalystSnapshotPanel } from "@/app/components/AnalystSnapshotPanel";
import StockHealthMonitor from "@/app/components/StockHealthMonitor";
import RiskAlertPanel from "@/app/components/RiskAlertPanel";
import ScoreHistory from "@/app/components/ScoreHistory";
import ThesisTile from "@/app/components/ThesisTile";
import { ThesisRequiredBanner } from "@/app/components/ThesisRequiredBanner";
import FactorLensTile from "@/app/components/FactorLensTile";
import StreetTakeawaysTile from "@/app/components/StreetTakeawaysTile";
import { StockSynthesisTile } from "@/app/components/StockSynthesisTile";
import { AppIcon } from "@/app/components/AppIcon";
import { usePrevPage } from "@/app/lib/nav-history";
import { ScoreDelta } from "@/app/components/ScoreDelta";
import { CollapsibleSection } from "@/app/components/CollapsibleSection";
import { colorForSector } from "@/app/lib/sectorColors";
import { useNotifications } from "@/app/lib/NotificationsContext";
import { EditableNumberCell, ConsensusButton } from "@/app/components/EditableScoreInputs";
import { mapBoostedAiToAiRating, mapSmaxToRelativeStrength, mapPowerRatingToMarketEdge, marketEdgeWarning, type MarketEdgeOpinion } from "@/app/lib/external-scoring";

// Same threshold as the Score All flow in PortfolioOverview — a
// composite move >5 pts is worth a "Score variance" warning so the PM
// can confirm it reflects real news rather than an AI artifact.
const VARIANCE_ALERT_THRESHOLD = 5;
import StockChart from "@/app/components/StockChart";
import QuickStockView from "@/app/components/QuickStockView";

// ── Helpers ──
function formatAUM(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(1)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  return `$${value.toLocaleString()}`;
}

function formatReturn(value: number | undefined): string {
  if (value == null) return "--";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function returnColor(value: number | undefined): string {
  if (value == null) return "text-ink-3";
  return value >= 0 ? "text-pos" : "text-neg";
}

// ── Donut segment colours ──
// The only place a per-group hue survives: a single-hue donut would render
// six adjacent arcs as one indistinguishable ring. Everything else on the
// page is coloured by job (ink / accent / pos / neg / warn), per the design
// vocabulary. Values are the @theme token hexes (canvas painting needs
// literals, the SVG stroke here mirrors that constraint).
const GROUP_RING: Record<string, string> = {
  blue: "#2d5bd0",
  purple: "#6f55c4",
  teal: "#12805c",
  green: "#4b5563",
  amber: "#b0741c",
  red: "#cc3f57",
};

// Shared control classes (28px, 6px radius — the workspace control ladder).
const BTN = "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover transition-colors disabled:opacity-50";
const BTN_PRIMARY = "inline-flex h-7 items-center gap-1.5 rounded-control bg-ink px-2.5 text-[12.5px] font-medium text-white hover:bg-ink-2 transition-colors disabled:opacity-50";
const MENU_ITEM = "flex h-7 w-full items-center gap-2 rounded-control px-2 text-left text-[12.5px] text-ink-2 hover:bg-surface-hover hover:text-ink transition-colors";
const INPUT = "h-7 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink outline-none focus:border-accent-border focus:ring-1 focus:ring-accent-border";


// Route a Yahoo-sourced data point to the most relevant Yahoo Finance
// subpage so the chip can be a click-through to verify the value. We use
// label keyword heuristics — not every label maps perfectly, but the
// fallback is the main /quote page which has tabs to every subview.
function yahooUrlForLabel(ticker: string, label: string): string {
  const lower = label.toLowerCase();
  const base = `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}`;
  if (/(revenue|net income|ebit|ebitda|earnings|eps |operating cash|free cash|fcf|capex|margin|cogs|opex|cash flow)/i.test(lower)) {
    return `${base}/financials`;
  }
  if (/(balance|debt|assets|liabilit|equity|cash on hand|current ratio|leverage)/i.test(lower)) {
    return `${base}/balance-sheet`;
  }
  if (/(cash flow|operating cash|free cash|fcf|capex)/i.test(lower)) {
    return `${base}/cash-flow`;
  }
  if (/(p\/e|peg|p\/b|p\/s|ev\/|enterprise value|forward p|trailing p|valuation|book value|market cap|short interest|short %|short percent|float|shares out|beta)/i.test(lower)) {
    return `${base}/key-statistics`;
  }
  if (/(target price|analyst|consensus|recommendation|estimate|forecast)/i.test(lower)) {
    return `${base}/analysis`;
  }
  if (/(institutional|holders|ownership|insider)/i.test(lower)) {
    return `${base}/holders`;
  }
  if (/(profile|sector|industry|description|business)/i.test(lower)) {
    return `${base}/profile`;
  }
  return base;
}

// Source-attribution chip rendered next to each scoring data point. Maps
// the abstract source enum to a colored badge so the analyst can see at a
// glance whether a number came from EDGAR (authoritative SEC filing), Yahoo
// (third-party feed), web search (cited URL/date), or a model inference.
// Chips render as clickable <a> tags when a URL is available so the
// analyst can verify the underlying source in one click.
/**
 * The dominant structured data source across a category's data points (ignores
 * "model" inferences, which aren't a feed). Drives the category-header source
 * chip so the analyst sees at a glance that e.g. growth was scored from FactSet
 * — distinct from the confidence chip, which conveys how sure the model is.
 */
function categoryDataSource(dps: ScoreDataPoint[]): ScoreDataPointSource | undefined {
  const counts: Partial<Record<ScoreDataPointSource, number>> = {};
  for (const dp of dps) {
    if (!dp?.source || dp.source === "model") continue;
    counts[dp.source] = (counts[dp.source] ?? 0) + 1;
  }
  const order: ScoreDataPointSource[] = ["factset", "edgar", "edgar-form4", "report", "yahoo", "web"];
  let best: ScoreDataPointSource | undefined;
  let bestN = 0;
  for (const s of order) {
    const n = counts[s] ?? 0;
    if (n > bestN) {
      bestN = n;
      best = s;
    }
  }
  return best;
}

const CATEGORY_SOURCE_META: Partial<Record<ScoreDataPointSource, { label: string }>> = {
  factset: { label: "FactSet" },
  edgar: { label: "EDGAR" },
  "edgar-form4": { label: "Form 4" },
  yahoo: { label: "Yahoo" },
  report: { label: "Report" },
  web: { label: "Web" },
};

function SourceChip({ source, detail, url, label, ticker }: { source: ScoreDataPointSource; detail?: string; url?: string; label: string; ticker: string }) {
  const style: Record<ScoreDataPointSource, { label: string; cls: string; title: string }> = {
    factset: { label: "FactSet", cls: "text-ink-3", title: "FactSet Formula API — primary, current, confirmed fundamentals / valuation / estimates." },
    edgar: { label: "EDGAR", cls: "text-ink-3", title: "SEC EDGAR XBRL — audited as-reported from 10-K/Q filings. Click to open the company's EDGAR filings page." },
    "edgar-form4": { label: "Form 4", cls: "text-ink-3", title: "SEC Form 4 — insider transactions (open-market only). Click to open the company's Form 4 filings on EDGAR." },
    yahoo: { label: "Yahoo", cls: "text-ink-3", title: "Yahoo Finance data feed. Click to open the relevant Yahoo Finance page." },
    report: { label: "Report", cls: "text-ink-3", title: "PM-ingested analyst report (RBC / JPM / Morningstar PDF filed through the inbox). Not a web search — no public URL; the firm and report date are shown alongside." },
    web: { label: "Web", cls: "text-accent", title: "Anthropic web_search result (verified during this rescore). Click to open the cited source." },
    model: { label: "Model", cls: "text-warn", title: "Qualitative inference by the model — no specific data source." },
  };
  const s = style[source] ?? style.model;

  // Compute the click-through URL based on source type. EDGAR uses the
  // SEC's browse-by-CIK redirect-by-ticker path; Yahoo uses our label-based
  // routing; Web uses the URL the model cited (if any).
  let href: string | undefined;
  if (source === "web") {
    href = url;
  } else if (source === "yahoo") {
    href = yahooUrlForLabel(ticker, label);
  } else if (source === "edgar") {
    // SEC EDGAR — direct CIK-by-ticker browse URL.
    href = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(ticker)}&type=10&dateb=&owner=include&count=40`;
  } else if (source === "edgar-form4") {
    href = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(ticker)}&type=4&dateb=&owner=include&count=40`;
  }

  const inner = (
    <>
      {s.label}
      {detail && <span className="max-w-[180px] truncate">· {detail}</span>}
    </>
  );
  const cls = `inline-flex items-center gap-1 whitespace-nowrap text-[11px] ${s.cls}`;

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={detail ? `${s.title}\n${detail}\n\n→ ${href}` : `${s.title}\n\n→ ${href}`}
        className={`${cls} cursor-pointer hover:text-ink transition-colors`}
      >
        {inner}
      </a>
    );
  }
  return (
    <span title={detail ? `${s.title}\n${detail}` : s.title} className={cls}>
      {inner}
    </span>
  );
}

/**
 * Notes editor for the "External sources" scoring category (manual scoring).
 * Each row is a single source: a date input + a free-text field + delete
 * button. The PM clicks "+ Add source" to add rows. All changes are
 * debounced and pushed back through the parent's onChange so the host
 * stock context can persist them to pm:stocks (round-trips through Redis
 * and syncs across devices).
 *
 * Local state is kept in sync with the incoming `notes` prop. Typing
 * doesn't wait on the network — it updates the local view immediately,
 * then fires a debounced save 500ms after the last keystroke.
 */
function ExternalSourcesEditor({ notes, onChange, headerLabel = "External Sources Log", emptyHint, placeholder = "Source (e.g. RBC Capital Markets — Upgraded to Outperform, PT $245)" }: { notes: ExternalSourceNote[]; onChange: (next: ExternalSourceNote[]) => void; headerLabel?: string; emptyHint?: string; placeholder?: string }) {
  const [local, setLocal] = useState<ExternalSourceNote[]>(() => notes ?? []);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Sync local state when the incoming notes change (e.g. data loaded from
  // a different device, or the stock was just swapped). We guard against
  // overwriting in-flight edits by skipping when the local list already
  // matches the incoming one structurally.
  useEffect(() => {
    const incoming = notes ?? [];
    // Cheap equality: compare lengths + JSON. The notes list is small so
    // this is fine; avoids a fight between the debounced save and an
    // unrelated context update.
    const a = JSON.stringify(local);
    const b = JSON.stringify(incoming);
    if (a !== b) setLocal(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  // Debounced auto-save: 500ms after the last keystroke, fire onChange so
  // the parent can persist to pm:stocks. Cancels prior timer on each edit.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSave = useCallback((next: ExternalSourceNote[]) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      onChangeRef.current(next);
      saveTimerRef.current = null;
    }, 500);
  }, []);
  // Flush pending save on unmount so a half-typed note isn't lost when the
  // user navigates to a different ticker.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        onChangeRef.current(local);
      }
    };
    // Only run the cleanup on unmount, not on every `local` change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Flush pending save on tab close / page refresh / browser nav so a
  // half-typed note in the 500ms debounce window doesn't get lost. We
  // synchronously call onChange so the parent (StockContext)'s state
  // updates immediately; the StockContext useDebouncedPersist already
  // installs its own beforeunload handler that fires a keepalive fetch
  // for any pending /api/kv/stocks write. Combined, the worst-case
  // window for character loss is collapsed to ~zero.
  //
  // We use a ref to `local` so the handler always reads the freshest
  // typed content without re-registering on every keystroke.
  const localRef = useRef(local);
  localRef.current = local;
  useEffect(() => {
    const handler = () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        onChangeRef.current(localRef.current);
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const updateRow = (id: string, patch: Partial<ExternalSourceNote>) => {
    const next = local.map((n) => (n.id === id ? { ...n, ...patch } : n));
    setLocal(next);
    scheduleSave(next);
  };
  const addRow = () => {
    const next = [...local, { id: Math.random().toString(36).slice(2, 11) + Date.now().toString(36), date: "", text: "" }];
    setLocal(next);
    scheduleSave(next);
  };
  const removeRow = (id: string) => {
    const next = local.filter((n) => n.id !== id);
    setLocal(next);
    scheduleSave(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-ink-3">{headerLabel}</p>
      {local.length === 0 && (
        <p className="text-[11.5px] text-ink-3">{emptyHint ?? "No sources logged. Click “Add source” to track analyst reports, news, podcasts, or other external research feeding this score."}</p>
      )}
      <div className="flex flex-col gap-1.5">
        {local.map((note) => (
          <div key={note.id} className="flex items-center gap-1.5">
            <input
              type="date"
              value={note.date}
              onChange={(e) => updateRow(note.id, { date: e.target.value })}
              className={`${INPUT} shrink-0`}
              title="Date of the source (publication or read date)"
            />
            <input
              type="text"
              value={note.text}
              onChange={(e) => updateRow(note.id, { text: e.target.value })}
              placeholder={placeholder}
              className={`${INPUT} min-w-0 flex-1 placeholder:text-ink-3`}
            />
            <button
              type="button"
              onClick={() => removeRow(note.id)}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-control text-ink-3 hover:bg-surface-hover hover:text-neg transition-colors"
              title="Remove this source"
              aria-label="Remove source"
            >
              <AppIcon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={addRow} className={BTN}>
          <AppIcon name="plus" size={13} /> Add source
        </button>
        <span className="text-[11px] text-ink-3">Auto-saves 0.5s after you stop typing; syncs across refreshes and devices.</span>
      </div>
    </div>
  );
}

// Per-model weight input with local string state (supports backspace/clearing)
function ModelWeightInput({ groupId, modelWeight, isOverride, onCommit }: {
  groupId: string;
  modelWeight: number;
  isOverride: boolean;
  onCommit: (val: number) => void;
}) {
  const [text, setText] = useState(String(modelWeight));
  const [focused, setFocused] = useState(false);
  // No sync-from-parent effect: when not focused the <input> displays
  // `String(modelWeight)` directly via the value prop below, and on
  // focus we reset `text` from the latest parent value. So keeping
  // `text` in sync with `modelWeight` between focus events is
  // unnecessary (and triggered a cascading-render lint error).

  const commit = (raw: string) => {
    const val = parseFloat(raw);
    if (!isNaN(val) && val >= 0) {
      onCommit(val);
    } else {
      setText(String(modelWeight));
    }
  };

  return (
    <div className="flex items-center gap-1.5 px-2.5 pb-2">
      <input
        type="text"
        inputMode="decimal"
        aria-label={`Weight for model ${groupId}`}
        value={focused ? text : String(modelWeight)}
        onFocus={() => { setFocused(true); setText(String(modelWeight)); }}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => { commit(e.target.value); setFocused(false); }}
        onKeyDown={(e) => { if (e.key === "Enter") { commit(text); (e.target as HTMLInputElement).blur(); } }}
        className={`${INPUT} w-16 text-right font-mono`}
      />
      <span className="text-[11.5px] text-ink-3">%</span>
      {isOverride && (
        <span className="text-[11px] text-warn" title="Overrides default weight">override</span>
      )}
    </div>
  );
}

// Donut chart SVG
function ScoreDonut({ score, max, groups, stock }: { score: number; max: number; groups: typeof SCORE_GROUPS; stock: { scores: Record<string, number> } }) {
  const radius = 80;
  const strokeWidth = 16;
  const circumference = 2 * Math.PI * radius;
  const center = 100;
  const gap = 4; // degrees gap between segments

  // Precompute each segment's start-angle (`rotation`) up-front so we
  // don't mutate a running accumulator inside the .map() below — that
  // tripped the react-hooks/immutability lint rule. Start at -90° so
  // the first segment begins at 12 o'clock.
  const segments = groups.map((g) => {
    const value = groupTotal(stock as never, g);
    return {
      color: GROUP_RING[g.color] || "#8a93a2",
      value,
      maxVal: g.maxTotal,
      segDeg: (value / max) * 360,
    };
  });
  const rotations: number[] = [];
  {
    let acc = -90;
    for (const s of segments) {
      rotations.push(acc);
      acc += s.segDeg;
    }
  }

  // Rating label
  let ratingLabel = "Hold";
  if (score >= 30) ratingLabel = "Strong Buy";
  else if (score >= 26) ratingLabel = "Moderate Buy";
  else if (score >= 22) ratingLabel = "Hold";
  else if (score >= 18) ratingLabel = "Underweight";
  else ratingLabel = "Sell";

  const ratingTextCls = score >= 26 ? "text-pos" : score >= 22 ? "text-warn" : "text-neg";

  return (
    <div className="animate-scale-in flex shrink-0 flex-col items-center">
      <svg viewBox="0 0 200 200" className="h-24 w-24" aria-hidden="true">
        <circle cx={center} cy={center} r={radius} fill="none" style={{ stroke: "var(--color-line-soft)" }} strokeWidth={strokeWidth} />
        {segments.map((seg, i) => {
          const segPct = seg.value / max;
          const segLen = segPct * circumference;
          const gapLen = (gap / 360) * circumference;
          const dashArray = `${Math.max(segLen - gapLen, 0)} ${circumference - Math.max(segLen - gapLen, 0)}`;
          const rotation = rotations[i];
          if (seg.value === 0) return null;
          return (
            <circle
              key={i}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={seg.color}
              strokeWidth={strokeWidth}
              strokeDasharray={dashArray}
              strokeDashoffset={0}
              strokeLinecap="round"
              transform={`rotate(${rotation} ${center} ${center})`}
              className="transition-all duration-500"
            />
          );
        })}
        <text x={center} y={center + 2} textAnchor="middle" style={{ fontSize: "40px", fontWeight: 600 }} className="fill-ink font-mono">
          {Number.isInteger(score) ? score : score.toFixed(1)}
        </text>
        <text x={center} y={center + 28} textAnchor="middle" style={{ fontSize: "18px" }} className="fill-ink-faint font-mono">
          /{max}
        </text>
      </svg>
      <span className={`mt-1 text-[12px] font-medium ${ratingTextCls}`}>{ratingLabel}</span>
    </div>
  );
}

// ── Fund Data Panels ──

/**
 * Expand fund-of-funds holdings so ETF/MF positions are replaced by
 * their underlying equity (or bond) constituents, weighted by the
 * parent's weight in this fund.
 *
 * Example: XSP.TO → IVV at 98.6%. If IVV's topHoldings include AAPL at
 * 7.5%, the look-through view shows AAPL at 98.6% × 7.5% = 7.4%.
 *
 * - Only expands when the child fund's `topHoldings` are already
 *   cached on our stock list — we don't trigger network fetches during
 *   render.
 * - Combines direct + via-fund exposure to the same symbol (e.g. if
 *   the parent holds AAPL directly AND via IVV).
 * - Recurses up to `maxDepth` levels deep to handle ETF-of-ETF-of-ETF.
 * - Falls back to the original holding if no underlying data is
 *   available (so the view degrades gracefully).
 *
 * `lookedThrough` accumulates the set of symbols that were expanded so
 * the UI can tell the user which funds it looked through.
 */
type LookThroughLookup = (symbol: string) => FundData["topHoldings"] | undefined;

function expandLookThrough(
  holdings: NonNullable<FundData["topHoldings"]>,
  lookup: LookThroughLookup,
  lookedThrough: Set<string>,
  maxDepth = 3,
  depth = 0,
): NonNullable<FundData["topHoldings"]> {
  const acc = new Map<string, { symbol: string; name: string; weight: number }>();

  const add = (sym: string, name: string, weight: number) => {
    const key = (sym || name).toUpperCase();
    if (!key) return;
    const prev = acc.get(key);
    if (prev) {
      prev.weight += weight;
    } else {
      acc.set(key, { symbol: sym, name, weight });
    }
  };

  for (const h of holdings) {
    const sym = (h.symbol || "").toUpperCase();
    const childHoldings = sym && depth < maxDepth ? lookup(sym) : undefined;

    if (childHoldings && childHoldings.length > 0) {
      // Recurse so an ETF-of-ETFs also gets expanded.
      const expandedChildren = depth + 1 < maxDepth
        ? expandLookThrough(childHoldings, lookup, lookedThrough, maxDepth, depth + 1)
        : childHoldings;
      lookedThrough.add(sym);
      // Scale each child by the parent weight as a fraction.
      // (Child weights already sum ≤ 100 in percent terms.)
      const scale = h.weight / 100;
      for (const c of expandedChildren) {
        add(c.symbol || "", c.name, c.weight * scale);
      }
    } else {
      add(sym, h.name, h.weight);
    }
  }

  return Array.from(acc.values())
    .sort((a, b) => b.weight - a.weight)
    .map((r) => ({
      symbol: r.symbol,
      name: r.name,
      weight: parseFloat(r.weight.toFixed(2)),
    }));
}

function FundDataPanels({ fundData, ticker, onHoldingsUpdate }: { fundData: FundData; ticker: string; onHoldingsUpdate?: (holdings: FundData["topHoldings"], sectors: FundData["sectorWeightings"], url: string) => void }) {
  const { scoredStocks } = useStocks();
  const [holdingsUrl, setHoldingsUrl] = useState(fundData.holdingsUrl || "");
  const [scrapingHoldings, setScrapingHoldings] = useState(false);
  const [scrapeError, setScrapeError] = useState("");
  const [scrapeSuccess, setScrapeSuccess] = useState(false);
  const [lookThroughEnabled, setLookThroughEnabled] = useState(true);
  // Cache for holdings fetched on-the-fly for look-through expansion.
  // Seeded on mount from the shared pm:fund-data-cache (populated by
  // Refresh All crawling heavy sub-funds), then augmented with any
  // on-the-fly fetches done here. We also PATCH back into the shared
  // cache when an on-the-fly fetch succeeds, so visiting one fund's
  // page can populate look-through data for others without having to
  // pollute the main stock list KV with arbitrary ETF constituents.
  const [extraCache, setExtraCache] = useState<Record<string, FundData["topHoldings"]>>({});

  // Mount-time: pull the shared fund-data-cache and seed extraCache so
  // look-through works immediately without waiting for the on-the-fly
  // 20%-weight auto-fetch below.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/kv/fund-data-cache")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const entries = data?.entries as Record<string, { topHoldings?: FundData["topHoldings"] }> | undefined;
        if (!entries) return;
        const seed: Record<string, FundData["topHoldings"]> = {};
        for (const [sym, entry] of Object.entries(entries)) {
          if (entry?.topHoldings?.length) seed[sym.toUpperCase()] = entry.topHoldings;
        }
        if (Object.keys(seed).length) {
          setExtraCache((prev) => ({ ...seed, ...prev }));
        }
      })
      .catch(() => { /* best effort */ });
    return () => { cancelled = true; };
  }, []);

  // Build a symbol → cached topHoldings lookup. Combines stocks the
  // user has already visited (persisted) with the on-the-fly cache we
  // populate below. Excludes the current ticker to avoid self-recursion.
  const lookup = React.useMemo<LookThroughLookup>(() => {
    const map = new Map<string, FundData["topHoldings"]>();
    for (const s of scoredStocks) {
      if (s.ticker.toUpperCase() === ticker.toUpperCase()) continue;
      if (s.fundData?.topHoldings?.length) {
        map.set(s.ticker.toUpperCase(), s.fundData.topHoldings);
      }
    }
    for (const [sym, h] of Object.entries(extraCache)) {
      if (sym.toUpperCase() === ticker.toUpperCase()) continue;
      if (h?.length && !map.has(sym.toUpperCase())) {
        map.set(sym.toUpperCase(), h);
      }
    }
    return (sym: string) => map.get(sym.toUpperCase());
  }, [scoredStocks, ticker, extraCache]);

  // Auto-fetch underlying holdings for any heavily-weighted (≥20%)
  // constituent that we don't already have cached. A 20%+ weight is
  // almost always a sub-fund (e.g. XSP.TO → IVV at 98.6%), not an
  // individual stock, so this doesn't fire fetches for normal stock
  // holdings in diversified ETFs.
  useEffect(() => {
    if (!lookThroughEnabled) return;
    const hs = fundData.topHoldings;
    if (!hs?.length) return;
    const already = new Set<string>(scoredStocks
      .filter((s) => s.fundData?.topHoldings?.length)
      .map((s) => s.ticker.toUpperCase()));
    Object.keys(extraCache).forEach((k) => already.add(k.toUpperCase()));
    already.add(ticker.toUpperCase());

    for (const h of hs) {
      if (!h.symbol || h.weight < 20) continue;
      const sym = h.symbol.toUpperCase();
      if (already.has(sym)) continue;
      already.add(sym); // prevent duplicate fires while fetch is in flight
      fetch(`/api/fund-data?ticker=${encodeURIComponent(sym)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          const fd = data?.fundData as FundData | undefined;
          const holdings = fd?.topHoldings;
          if (holdings?.length) {
            setExtraCache((prev) => ({ ...prev, [sym]: holdings }));
            // Write through to the shared KV cache so other pages /
            // the Client Report X-ray pick this up without having to
            // re-fetch. Best-effort — failure here doesn't break
            // anything user-visible.
            fetch("/api/kv/fund-data-cache", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                entries: {
                  [sym]: {
                    topHoldings: holdings,
                    sectorWeightings: fd?.sectorWeightings,
                    holdingsSource: fd?.holdingsSource,
                    fundFamily: fd?.fundFamily,
                    lastUpdated: new Date().toISOString(),
                  },
                },
              }),
            }).catch(() => { /* best effort */ });
          }
        })
        .catch(() => { /* best effort */ });
    }
  }, [lookThroughEnabled, fundData.topHoldings, scoredStocks, extraCache, ticker]);

  // Apply look-through (when enabled). `lookedThroughSymbols` reflects
  // which fund tickers were actually expanded, for the UI hint.
  const { displayedHoldings, lookedThroughSymbols } = React.useMemo(() => {
    const symbols = new Set<string>();
    if (!fundData.topHoldings?.length) {
      return { displayedHoldings: [] as NonNullable<FundData["topHoldings"]>, lookedThroughSymbols: symbols };
    }
    if (!lookThroughEnabled) {
      return { displayedHoldings: fundData.topHoldings, lookedThroughSymbols: symbols };
    }
    const expanded = expandLookThrough(fundData.topHoldings, lookup, symbols);
    return { displayedHoldings: expanded.slice(0, 10), lookedThroughSymbols: symbols };
  }, [fundData.topHoldings, lookThroughEnabled, lookup]);

  const handleScrapeHoldings = async () => {
    if (!holdingsUrl.trim()) return;
    setScrapingHoldings(true);
    setScrapeError("");
    setScrapeSuccess(false);
    try {
      const res = await fetch("/api/fund-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: holdingsUrl.trim(), ticker }),
      });
      const data = await res.json();
      if (!res.ok) {
        setScrapeError(data.error || "Failed to scrape holdings");
        return;
      }
      if (data.topHoldings?.length) {
        onHoldingsUpdate?.(data.topHoldings, data.sectorWeightings, holdingsUrl.trim());
        setScrapeSuccess(true);
        setTimeout(() => setScrapeSuccess(false), 3000);
      }
    } catch (err) {
      setScrapeError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setScrapingHoldings(false);
    }
  };
  return (
    <div className="flex flex-col gap-3.5">
      {/* Row 1: Performance + Risk */}
      <div className="grid gap-3.5 md:grid-cols-2">
        {/* Performance */}
        {fundData.performance && (
          <section className="panel">
            <div className="panel-h"><span className="t">Performance</span><span className="m">trailing returns</span></div>
            <div className="p-2.5">
            <StatStrip
              cols={4}
              items={[
                { label: "1M", val: fundData.performance.oneMonth },
                { label: "3M", val: fundData.performance.threeMonth },
                { label: "YTD", val: fundData.performance.ytd },
                { label: "1Y", val: fundData.performance.oneYear },
                { label: "3Y", val: fundData.performance.threeYear },
                { label: "5Y", val: fundData.performance.fiveYear },
                { label: "10Y", val: fundData.performance.tenYear },
              ]
                .filter((r) => r.val != null)
                .map((r) => ({
                  label: r.label,
                  value: <span className={returnColor(r.val)}>{formatReturn(r.val)}</span>,
                }))}
            />
            </div>
          </section>
        )}

        {/* Risk & Key Stats */}
        <section className="panel">
          <div className="panel-h"><span className="t">Key statistics</span><span className="m">risk &amp; profile</span></div>
          <div className="p-2.5">
          <StatStrip
            cols={2}
            items={[
              fundData.fundFamily ? { label: "Fund Family", value: fundData.fundFamily } : null,
              fundData.inceptionDate ? { label: "Inception", value: fundData.inceptionDate } : null,
              fundData.turnover != null ? { label: "Turnover", value: `${fundData.turnover.toFixed(0)}%` } : null,
              fundData.riskStats?.beta != null ? { label: "Beta (3Y)", value: fundData.riskStats.beta.toFixed(2) } : null,
              fundData.riskStats?.sharpeRatio != null ? { label: "Sharpe (3Y)", value: fundData.riskStats.sharpeRatio.toFixed(2) } : null,
              fundData.riskStats?.stdDev != null ? { label: "Std Dev (3Y)", value: `${fundData.riskStats.stdDev.toFixed(2)}%` } : null,
              fundData.riskStats?.alpha != null
                ? {
                    label: "Alpha (3Y)",
                    value: (
                      <span className={fundData.riskStats.alpha >= 0 ? "text-pos" : "text-neg"}>
                        {fundData.riskStats.alpha >= 0 ? "+" : ""}{fundData.riskStats.alpha.toFixed(2)}
                      </span>
                    ),
                  }
                : null,
              fundData.riskStats?.rSquared != null ? { label: "R-Squared", value: fundData.riskStats.rSquared.toFixed(2) } : null,
            ].filter((x) => x != null)}
          />
          </div>
        </section>
      </div>

      {/* Row 2: Top Holdings + Sector Breakdown */}
      <div className="grid gap-3.5 md:grid-cols-2">
        {/* Top Holdings */}
        <section className="panel">
          <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
            <span className="t">Top holdings</span>
            {fundData.topHoldings && fundData.topHoldings.length > 0 && (
              <div className="seg ml-auto">
                <button
                  type="button"
                  onClick={() => setLookThroughEnabled(true)}
                  className={lookThroughEnabled ? "on" : ""}
                  title="Expand ETF / fund holdings to their underlying positions, scaled proportionally"
                >
                  Look-through
                </button>
                <button
                  type="button"
                  onClick={() => setLookThroughEnabled(false)}
                  className={!lookThroughEnabled ? "on" : ""}
                  title="Show holdings exactly as the fund reports them"
                >
                  As reported
                </button>
              </div>
            )}
          </div>
          <div className="p-3.5">
          {lookThroughEnabled && lookedThroughSymbols.size > 0 && (
            <p className="text-[11px] text-ink-3 mb-2">
              Looked through{" "}
              <span className="font-semibold text-ink-2">
                {Array.from(lookedThroughSymbols).join(", ")}
              </span>{" "}
              to show underlying positions. Switch to <em>As reported</em> to see the raw holdings.
            </p>
          )}
          {displayedHoldings.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {displayedHoldings.map((h, i) => (
                <div key={i} className="flex items-center gap-2 sm:gap-3">
                  <span className="w-5 shrink-0 text-right font-mono text-[11px] text-ink-3">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {h.symbol && <span className="shrink-0 font-mono text-[12.5px] text-ink">{displayTicker(h.symbol)}</span>}
                      <span className="truncate text-[12px] text-ink-3">{h.name}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <div className="h-1 w-12 overflow-hidden rounded-sm bg-line-soft sm:w-20">
                      <div
                        className="h-full bg-ink-2"
                        style={{ width: `${Math.min(h.weight * 3, 100)}%` }}
                      />
                    </div>
                    <span className="w-12 text-right font-mono text-[12px] text-ink">{h.weight.toFixed(1)}%</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* Missing holdings alert */
            <div className="mb-3 flex items-start gap-2 rounded-card border border-warn-border bg-warn-soft p-3">
              <span className="mt-0.5 shrink-0 text-warn"><AppIcon name="warn" size={14} /></span>
              <div>
                <p className="text-[12.5px] font-medium text-warn">Holdings data not available</p>
                <p className="mt-0.5 text-[11.5px] text-warn">
                  Automatic sources could not find holdings for this fund. Paste a link to the fund&apos;s holdings page below.
                </p>
              </div>
            </div>
          )}

          {/* Holdings source info + URL input */}
          {onHoldingsUpdate && (
            <div className="mt-3 pt-3 border-t border-line-soft">
              {(() => {
                const hasHoldings = Boolean(fundData.topHoldings?.length);
                const fromUrl = Boolean(fundData.holdingsUrl);
                const sourceLabel = fundData.holdingsSource || (fromUrl ? "Custom URL" : "Embedded scraper");
                const whenStr = fundData.holdingsLastUpdated
                  ? new Date(fundData.holdingsLastUpdated).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
                  : null;
                if (!hasHoldings) {
                  return (
                    <div className="mb-2 inline-flex items-center gap-1.5 text-[11.5px] text-warn">
                      <span className="dot bg-warn" />
                      No holdings found — paste a URL below
                    </div>
                  );
                }
                return (
                  <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]">
                    <span className={`inline-flex items-center gap-1.5 ${fromUrl ? "text-accent" : "text-pos"}`}>
                      <span className={`dot ${fromUrl ? "bg-accent" : "bg-pos"}`} />
                      {fromUrl ? "Fetched from your URL" : "Auto-found by embedded scraper"}
                    </span>
                    <span className="text-ink-3">
                      Source: <span className="text-ink-2">{sourceLabel}</span>
                    </span>
                    {whenStr && (
                      <span className="text-ink-3">· {whenStr}</span>
                    )}
                  </div>
                );
              })()}
              <label className="text-[11px] text-ink-3" htmlFor={`holdings-url-${ticker}`}>
                Holdings source URL
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  id={`holdings-url-${ticker}`}
                  type="url"
                  value={holdingsUrl}
                  onChange={(e) => { setHoldingsUrl(e.target.value); setScrapeError(""); }}
                  placeholder="https://provider.com/etf/holdings"
                  className={`${INPUT} min-w-0 flex-1 placeholder:text-ink-3`}
                />
                <button
                  onClick={handleScrapeHoldings}
                  disabled={scrapingHoldings || !holdingsUrl.trim()}
                  className={BTN_PRIMARY}
                >
                  {scrapingHoldings ? "Loading…" : "Fetch"}
                </button>
              </div>
              {scrapeError && (
                <p className="mt-1 text-[11.5px] text-neg">{scrapeError}</p>
              )}
              {scrapeSuccess && (
                <p className="mt-1 text-[11.5px] text-pos">Holdings updated successfully.</p>
              )}
            </div>
          )}
          </div>
        </section>

        {/* Sector Breakdown */}
        {fundData.sectorWeightings && fundData.sectorWeightings.length > 0 && (() => {
          // Normalize provider sector names (Yahoo / Morningstar / Globe
          // and Mail all emit their own variants) so e.g. "Financial
          // Services" and "Financials" roll into a single bucket instead
          // of rendering as two bars with mismatched colors.
          const bySector = new Map<string, number>();
          for (const s of fundData.sectorWeightings) {
            const key = normalizeSector(s.sector);
            bySector.set(key, (bySector.get(key) ?? 0) + s.weight);
          }
          const normalizedSectors = Array.from(bySector.entries())
            .map(([sector, weight]) => ({ sector, weight }))
            .sort((a, b) => b.weight - a.weight);
          return (
          <section className="panel">
            <div className="panel-h"><span className="t">Sector breakdown</span><span className="m">{normalizedSectors.length} sectors</span></div>
            <div className="p-3.5">
            {/* Stacked bar */}
            <div className="mb-3 flex h-6 overflow-hidden rounded-card">
              {normalizedSectors.map((s) => (
                <div
                  key={s.sector}
                  className="flex items-center justify-center font-mono text-[10px] text-white"
                  style={{ width: `${s.weight}%`, backgroundColor: colorForSector(s.sector) }}
                  title={`${s.sector} ${s.weight.toFixed(1)}%`}
                >
                  {s.weight >= 8 && `${s.weight.toFixed(0)}%`}
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-1.5">
              {normalizedSectors.map((s) => (
                <div key={s.sector} className="flex min-w-0 items-center gap-2">
                  <span className="dot" style={{ backgroundColor: colorForSector(s.sector) }} />
                  <span className="flex-1 truncate text-[12px] text-ink-2">{s.sector}</span>
                  <span className="shrink-0 font-mono text-[12px] text-ink">{s.weight.toFixed(1)}%</span>
                </div>
              ))}
            </div>

            {/* Asset Allocation */}
            {fundData.assetAllocation && (
              <div className="mt-3.5 border-t border-line-soft pt-3">
                <div className="mb-2 text-[11px] text-ink-3">Asset allocation</div>
                <StatStrip
                  cols={4}
                  items={[
                    fundData.assetAllocation.stock != null ? { label: "Stocks", value: `${fundData.assetAllocation.stock.toFixed(1)}%` } : null,
                    fundData.assetAllocation.bond != null ? { label: "Bonds", value: `${fundData.assetAllocation.bond.toFixed(1)}%` } : null,
                    fundData.assetAllocation.cash != null ? { label: "Cash", value: `${fundData.assetAllocation.cash.toFixed(1)}%` } : null,
                    fundData.assetAllocation.other != null ? { label: "Other", value: `${fundData.assetAllocation.other.toFixed(1)}%` } : null,
                  ].filter((x) => x != null)}
                />
              </div>
            )}
            </div>
          </section>
          );
        })()}
      </div>

      {/* Row 3: Equity Metrics (P/E, P/B, etc.) */}
      {fundData.equityMetrics && (
        <section className="panel">
          <div className="panel-h"><span className="t">Underlying equity metrics</span><span className="m">look-through valuation</span></div>
          <div className="p-2.5">
          <StatStrip
            cols={4}
            items={[
              fundData.equityMetrics.priceToEarnings != null ? { label: "P/E Ratio", value: fundData.equityMetrics.priceToEarnings.toFixed(1) } : null,
              fundData.equityMetrics.priceToBook != null ? { label: "P/B Ratio", value: fundData.equityMetrics.priceToBook.toFixed(2) } : null,
              fundData.equityMetrics.priceToSales != null ? { label: "P/S Ratio", value: fundData.equityMetrics.priceToSales.toFixed(2) } : null,
              fundData.equityMetrics.priceToCashflow != null ? { label: "P/CF Ratio", value: fundData.equityMetrics.priceToCashflow.toFixed(2) } : null,
            ].filter((x) => x != null)}
          />
          </div>
        </section>
      )}
    </div>
  );
}

export default function StockDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get("from");
  const ticker = (params.ticker as string)?.toUpperCase();

  // Universal back link: label from the tracked in-app history, navigation
  // via history.back() so the origin page's scroll position restores. Falls
  // back to the legacy ?from param, then Dashboard, when there's no history
  // (direct link / new tab).
  const prevPage = usePrevPage();
  const backHref = prevPage?.path ?? (from === "pim-model" ? "/pim-model" : "/");
  const backLabel = prevPage?.label ?? (from === "pim-model" ? "Models" : "Dashboard");
  const goBack = (e: React.MouseEvent) => {
    if (prevPage) {
      e.preventDefault();
      window.history.back();
    }
  };
  const fromSuffix = from ? `?from=${from}` : "";

  // Preserve the horizontal scroll position of the ticker nav bar across
  // ticker → ticker navigations. Each click is a full client-side route
  // transition that remounts this page component and resets the bar to
  // scrollLeft=0, which threw the PM back to the first ticker every time.
  // We stash the last scrollLeft in sessionStorage (per-tab, cleared when
  // the tab closes) and rehydrate on mount before the browser paints.
  const tickerBarRef = useRef<HTMLDivElement | null>(null);
  const TICKER_BAR_SCROLL_KEY = "stock-ticker-bar-scroll";
  useEffect(() => {
    const el = tickerBarRef.current;
    if (!el) return;
    try {
      const raw = sessionStorage.getItem(TICKER_BAR_SCROLL_KEY);
      if (raw) {
        const n = Number(raw);
        if (Number.isFinite(n)) el.scrollLeft = n;
      }
    } catch {
      /* sessionStorage disabled — accept the reset, no-op */
    }
    const onScroll = () => {
      try {
        sessionStorage.setItem(TICKER_BAR_SCROLL_KEY, String(el.scrollLeft));
      } catch {
        /* quota / privacy mode — silently drop */
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  const { loading: stocksLoading, getStock, scoredStocks, marketData, updateScore, updateExplanations, updateLastScored, updatePrice, updateHealthData, updateTechnicals, updateStockFields, updateWeight, updateFundData, moveBucket, removeStock, pimModels, toggleModelEligibility, updateModelWeight, getAnalystSnapshot, updateAnalystSnapshot, getAnalystReports, uploadAnalystReport, removeAnalystReport, convertAnalystTarget, tickerCurrency, uiPrefs, setUiPref } = useStocks();
  const { notify } = useNotifications();
  const stock = getStock(ticker);
  const [scoring, setScoring] = useState(false);
  // Captures verification metadata from the last successful rescore so the
  // score-history append effect (below) can tag the entry. Mirrors the
  // pendingScoreAppendRef pattern. Web-search verification is always ON for
  // every rescore — the model issues up to 4 searches to cross-check cached
  // fundamentals against the company's latest filings / press releases /
  // named-firm analyst notes. This is the only scoring mode in the UI.
  const lastVerificationRef = useRef<{
    verifiedSearch: boolean;
    searchQueries: string[];
    searchCitations: Array<{ url: string; title?: string }>;
  } | null>(null);
  const [scoreError, setScoreError] = useState("");
  // Narrative bullets for each scorable category can be long; collapse
  // them by default. Open/closed state persists in pm:ui-prefs
  // (stock.cat.<key>) so it survives refreshes and syncs across devices.
  const expandedCategories = useMemo(() => {
    const open = new Set<string>();
    for (const k of Object.keys(uiPrefs)) {
      if (k.startsWith("stock.cat.") && uiPrefs[k] === "1") open.add(k.slice("stock.cat.".length));
    }
    return open;
  }, [uiPrefs]);
  const toggleCategory = useCallback((key: string) => {
    setUiPref(`stock.cat.${key}`, expandedCategories.has(key) ? "0" : "1");
  }, [expandedCategories, setUiPref]);
  // Score groups collapse to one table row each; the expanded body holds
  // every per-category control. Same pm:ui-prefs store as the categories,
  // so a group left open stays open across refreshes and devices.
  const expandedGroups = useMemo(() => {
    const open = new Set<string>();
    for (const k of Object.keys(uiPrefs)) {
      if (k.startsWith("stock.grp.") && uiPrefs[k] === "1") open.add(k.slice("stock.grp.".length));
    }
    return open;
  }, [uiPrefs]);
  const toggleGroup = useCallback((name: string) => {
    setUiPref(`stock.grp.${name}`, expandedGroups.has(name) ? "0" : "1");
  }, [expandedGroups, setUiPref]);
  // When handleRescore finishes it flips this ref so the effect below
  // posts an append-only entry to pm:score-history once the updated
  // `stock.adjusted` / `stock.raw` values have propagated through
  // context. We can't POST inside handleRescore because those values
  // are derived from context state set asynchronously.
  const pendingScoreAppendRef = useRef(false);

  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [editingWeight, setEditingWeight] = useState(false);
  const [weightInput, setWeightInput] = useState("");
  const [loadingFundData, setLoadingFundData] = useState(false);
  // Signed day move for the identity row — reported by StockChart from bars
  // it already fetched (no extra request).
  const [dayChangePct, setDayChangePct] = useState<number | null>(null);
  // Overflow action menu (Delete + secondary actions). A dropdown menu is
  // deliberately transient — exempt from the persisted-fold rule.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [menuOpen]);

  const scoreable = stock ? isScoreable(stock) : true;

  // ?action=rescore (from the command palette): kick off the same rescore the
  // Score button runs, once, then strip the param so refresh/back can't
  // re-trigger a paid call.
  const paletteRescoreFired = useRef(false);
  useEffect(() => {
    if (paletteRescoreFired.current || !stock || !scoreable) return;
    const p = new URLSearchParams(window.location.search);
    if (p.get("action") !== "rescore") return;
    paletteRescoreFired.current = true;
    p.delete("action");
    router.replace(`${window.location.pathname}${p.toString() ? `?${p}` : ""}`, { scroll: false });
    void handleRescore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stock, scoreable]);

  // Watches stock.scores changes and writes to pm:score-history. Two
  // branches:
  //
  // A) Rescore: pendingScoreAppendRef was flipped by handleRescore →
  //    POST a NEW entry (append). The pill on the page top reflects
  //    this entry once it lands.
  //
  // B) Manual tweak: scores changed but no rescore was just triggered
  //    (e.g. PM bumps `charting` from 0 → 2 a day after the weekly
  //    rescore). PATCH the most-recent entry IF it's within the 72h
  //    revision window. Outside the window, the server returns
  //    { patched: false } and nothing happens — manual edits do NOT
  //    create new entries on their own.
  //
  // Debounced so that flipping a 0-3 slider in quick succession only
  // posts once after the user stops. Cancelled when (A) wins on the
  // same render so a rescore doesn't get followed by a stale patch.
  const patchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevScoresRef = useRef<Scores | null>(null);

  useEffect(() => {
    if (!stock || !scoreable) {
      pendingScoreAppendRef.current = false;
      prevScoresRef.current = stock?.scores ?? null;
      return;
    }

    // Branch A — rescore append.
    if (pendingScoreAppendRef.current) {
      pendingScoreAppendRef.current = false;
      // A rescore supersedes any pending manual-edit patch; drop it.
      if (patchTimerRef.current) {
        clearTimeout(patchTimerRef.current);
        patchTimerRef.current = null;
      }
      const today = new Date().toISOString().slice(0, 10);
      const vmeta = lastVerificationRef.current;
      lastVerificationRef.current = null;
      const entry = {
        date: today,
        timestamp: new Date().toISOString(),
        total: stock.adjusted,
        raw: stock.raw,
        adjusted: stock.adjusted,
        scores: stock.scores,
        ...(vmeta
          ? {
              verifiedSearch: vmeta.verifiedSearch,
              searchQueries: vmeta.searchQueries,
              searchCitations: vmeta.searchCitations,
            }
          : {}),
      };
      // The POST returns { delta, priorTotal, newTotal }. When the
      // composite moved by more than VARIANCE_ALERT_THRESHOLD points,
      // fire a warn notification so the PM is prompted to verify the
      // change reflects real news rather than an AI artifact.
      fetch("/api/kv/score-history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: stock.ticker, entry, mode: "append" }),
      })
        .then((r) => r.ok ? r.json() : null)
        .then((result) => {
          if (!result || typeof result.delta !== "number") return;
          if (Math.abs(result.delta) > VARIANCE_ALERT_THRESHOLD) {
            const sign = result.delta > 0 ? "+" : "";
            notify({
              level: "warn",
              title: `${stock.ticker}: composite moved ${sign}${result.delta.toFixed(1)} pts`,
              message: `${typeof result.priorTotal === "number" ? result.priorTotal.toFixed(1) : "?"} → ${typeof result.newTotal === "number" ? result.newTotal.toFixed(1) : "?"} — confirm this reflects real new data rather than an AI artifact.`,
              source: "Score variance",
            });
          }
        })
        .catch(() => { /* non-fatal — history is informational */ });
      prevScoresRef.current = stock.scores;
      return;
    }

    // Branch B — manual tweak: schedule a debounced patch-recent.
    // We diff against the previously-seen scores so we only fire when
    // something actually changed. On first render (no prev) we just
    // seed the ref and bail.
    const prev = prevScoresRef.current;
    prevScoresRef.current = stock.scores;
    if (!prev) return;
    const keys = Object.keys(stock.scores) as ScoreKey[];
    const changed = keys.some((k) => prev[k] !== stock.scores[k]);
    if (!changed) return;

    if (patchTimerRef.current) clearTimeout(patchTimerRef.current);
    patchTimerRef.current = setTimeout(() => {
      patchTimerRef.current = null;
      const entry = {
        // patch-recent ignores date/timestamp on the server side, but
        // we send placeholders so the type contract stays satisfied.
        date: new Date().toISOString().slice(0, 10),
        timestamp: new Date().toISOString(),
        total: stock.adjusted,
        raw: stock.raw,
        adjusted: stock.adjusted,
        scores: stock.scores,
      };
      fetch("/api/kv/score-history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: stock.ticker, entry, mode: "patch-recent" }),
      }).catch(() => { /* non-fatal */ });
    }, 1500);
  }, [stock, scoreable]);

  const fetchFundData = useCallback(async () => {
    if (!stock || scoreable) return;
    setLoadingFundData(true);
    try {
      const res = await fetch(`/api/fund-data?ticker=${encodeURIComponent(ticker)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.fundData) {
          const existing = stock.fundData;
          // Merge: API data is base, but preserve user-provided holdings
          // (from URL scraping) if the API didn't return any
          const merged = { ...data.fundData };
          if (!merged.topHoldings?.length && existing?.topHoldings?.length) {
            merged.topHoldings = existing.topHoldings;
            merged.sectorWeightings = existing.sectorWeightings;
            merged.holdingsLastUpdated = existing.holdingsLastUpdated;
            merged.holdingsSource = existing.holdingsSource;
          }
          // Always preserve the holdings URL
          if (existing?.holdingsUrl && !merged.holdingsUrl) {
            merged.holdingsUrl = existing.holdingsUrl;
          }
          // Preserve holdingsLastUpdated for URL-sourced holdings
          if (existing?.holdingsLastUpdated && !merged.holdingsLastUpdated) {
            merged.holdingsLastUpdated = existing.holdingsLastUpdated;
          }
          // Stamp a fresh timestamp whenever the embedded scraper populated
          // holdings but didn't yet have a last-updated marker — otherwise the
          // UI can't tell the user "we found these live".
          if (merged.topHoldings?.length && !merged.holdingsLastUpdated && !existing?.holdingsLastUpdated) {
            merged.holdingsLastUpdated = new Date().toISOString();
          }
          updateFundData(ticker, merged);
        }
        // Update price from Morningstar for mutual funds (Yahoo doesn't have FUNDSERV prices)
        if (data.price != null && typeof data.price === "number") {
          updatePrice(ticker, data.price);
        }
        // Update name from Morningstar for Canadian funds if we got a better name
        if (data.name && (!stock.name || stock.name === ticker)) {
          updateStockFields(ticker, { name: data.name });
        }
      }
    } catch { /* best effort */ }
    finally { setLoadingFundData(false); }
  }, [ticker, stock, scoreable, updateFundData, updateStockFields, updatePrice]);

  // Auto-fetch fund data on mount if missing
  useEffect(() => {
    if (stock && !scoreable && !stock.fundData) {
      fetchFundData();
    }
  }, [stock, scoreable, fetchFundData]);

  // Keyboard navigation: ← / → cycle through holdings in the same
  // order as the top ticker bar (Portfolio Stocks → Portfolio Funds →
  // Watchlist Stocks → Watchlist Funds, each alpha-sorted). Skips when
  // focus is on a text input so search/notes/forms aren't hijacked.
  // The ticker list is recomputed inside the effect so this hook stays
  // unconditional even when the page falls through to the "not found"
  // early return below.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      // Alt/Option+Arrow switches between stocks; Cmd/Win+Arrow switches tabs
      // (handled by Navigation). Plain arrows are left for normal use.
      // Ctrl+Arrow is reserved by macOS (Mission Control desktop switching).
      if (!e.altKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return;

      const alpha = (a: string, b: string) => a.localeCompare(b);
      const port = scoredStocks.filter((s) => s.bucket === "Portfolio");
      const watch = scoredStocks.filter((s) => s.bucket === "Watchlist");
      const ordered = [
        ...port.filter((s) => isScoreable(s)).map((s) => s.ticker).sort(alpha),
        ...port.filter((s) => !isScoreable(s)).map((s) => s.ticker).sort(alpha),
        ...watch.filter((s) => isScoreable(s)).map((s) => s.ticker).sort(alpha),
        ...watch.filter((s) => !isScoreable(s)).map((s) => s.ticker).sort(alpha),
      ];
      if (ordered.length <= 1) return;
      const idx = ordered.findIndex((t) => t === ticker);
      if (idx < 0) return;
      const nextIdx = e.key === "ArrowRight"
        ? (idx + 1) % ordered.length
        : (idx - 1 + ordered.length) % ordered.length;
      e.preventDefault();
      router.push(`/stock/${ordered[nextIdx].toLowerCase()}${fromSuffix}`);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scoredStocks, ticker, router, fromSuffix]);

  if (!stock) {
    // While the book is still hydrating from Redis we don't yet know whether
    // this is a held name — hold off so a Portfolio/Watchlist ticker doesn't
    // flash the lite view (and fire its quote/chart fetches) before the full
    // page mounts.
    if (stocksLoading) {
      return (
        <main className="flex flex-col gap-3.5 text-ink">
          <section className="panel animate-pulse p-3.5">
            <div className="h-6 w-40 rounded bg-surface-2" />
            <div className="mt-3 h-4 w-64 rounded bg-surface-2" />
          </section>
        </main>
      );
    }
    // Not in the book: lightweight quote view (name + price + chart, nothing
    // persisted) so any ticker clicked anywhere in the app opens something
    // useful instead of a dead "not found" page.
    return <QuickStockView ticker={ticker} backHref={backHref} backLabel={backLabel} goBack={goBack} />;
  }

  const portfolioAll = scoredStocks.filter((s) => s.bucket === "Portfolio");
  const watchlistAll = scoredStocks.filter((s) => s.bucket === "Watchlist");
  const alpha = (a: string, b: string) => a.localeCompare(b);
  const portfolioStockTickers = portfolioAll.filter((s) => isScoreable(s)).map((s) => s.ticker).sort(alpha);
  const portfolioFundTickers = portfolioAll.filter((s) => !isScoreable(s)).map((s) => s.ticker).sort(alpha);
  const watchlistStockTickers = watchlistAll.filter((s) => isScoreable(s)).map((s) => s.ticker).sort(alpha);
  const watchlistFundTickers = watchlistAll.filter((s) => !isScoreable(s)).map((s) => s.ticker).sort(alpha);

  const handleRescore = async () => {
    setScoring(true);
    setScoreError("");
    try {
      const res = await fetch("/api/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Web-search verification is always enabled for UI-triggered rescores.
        // The model issues up to 4 searches to verify quarterly results,
        // pre-announcements, analyst changes, and (for Canadian listings)
        // any fundamentals at all since EDGAR is US-only.
        //
        // PM-logged notes are passed through so the scoring prompt can
        // factor them into researchCoverage and catalysts. They're stored
        // on the Stock blob in pm:stocks via the External Sources / Research
        // Coverage notes editors on this page.
        body: JSON.stringify({
          ticker: stock.ticker,
          verifyWithWebSearch: true,
          externalSourceNotes: stock.externalSourceNotes ?? [],
          researchCoverageNotes: stock.researchCoverageNotes ?? [],
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setScoreError(errData.error || `Scoring failed (${res.status})`);
        return;
      }
      const data = await res.json();
      // Capture verification metadata for the score-history append below.
      lastVerificationRef.current = {
        verifiedSearch: Boolean(data.verifiedSearch),
        searchQueries: Array.isArray(data.searchQueries) ? data.searchQueries : [],
        searchCitations: Array.isArray(data.searchCitations) ? data.searchCitations : [],
      };
      if (data.scores) {
        for (const [key, val] of Object.entries(data.scores)) {
          updateScore(ticker, key as ScoreKey, val as number);
        }
      }
      if (data.explanations) {
        updateExplanations(ticker, data.explanations);
      }
      // Live-refresh the FactSet analyst-consensus row: the score route wrote
      // it to Redis; mirror it into client state so the Coverage panel + Analyst
      // Consensus category update without a manual page reload.
      if (
        data.factsetConsensus &&
        (typeof data.factsetConsensus.averageTarget === "number" || typeof data.factsetConsensus.analystCount === "number")
      ) {
        const cur = getAnalystSnapshot(ticker) || {};
        updateAnalystSnapshot(ticker, { ...cur, factset: data.factsetConsensus });
      }
      if (data.price != null) {
        updatePrice(ticker, data.price);
      }
      if (data.healthData) {
        updateHealthData(ticker, data.healthData);
      }
      if (data.technicals && data.riskAlert) {
        updateTechnicals(ticker, data.technicals, data.riskAlert);
      }
      if (data.companySummary || data.investmentThesis || data.bearCase || data.sector || data.name) {
        updateStockFields(ticker, {
          ...(data.companySummary ? { companySummary: data.companySummary } : {}),
          ...(data.investmentThesis ? { investmentThesis: data.investmentThesis } : {}),
          ...(data.bearCase ? { bearCase: data.bearCase } : {}),
          // data.sector is FactSet-sourced (normalized to the app vocabulary)
          // when the name-guard passed, else the model echo. Authoritative.
          ...(data.sector ? { sector: data.sector } : {}),
          ...(data.name && data.name !== "Unknown" ? { name: data.name } : {}),
        });
      }
      // Persist FactSet's beta dashboard-wide, but ONLY for individual stocks —
      // ETFs/mutual funds keep their Morningstar BetaM36 (never overwrite a
      // fund's beta with a Yahoo/FactSet number, per the beta-source rule).
      if (
        typeof data.factsetBeta === "number" &&
        (stock.instrumentType === "stock" || stock.instrumentType == null)
      ) {
        updateStockFields(ticker, { beta: data.factsetBeta });
      }
      updateLastScored(ticker, new Date().toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true,
      }));
      // Flag that once React commits the updated scores into the derived
      // `stock.adjusted` / `stock.raw`, the effect below should persist
      // a new entry to the append-only pm:score-history log.
      pendingScoreAppendRef.current = true;
    } catch (err) {
      setScoreError(err instanceof Error ? err.message : "Scoring failed");
    } finally {
      setScoring(false);
    }
  };

  const handleRefreshData = async () => {
    setRefreshing(true);
    setRefreshError("");
    try {
      const res = await fetch("/api/refresh-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers: [stock.ticker] }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setRefreshError(errData.error || `Refresh failed (${res.status})`);
        return;
      }
      const data = await res.json();
      const result = data.results?.[0];
      if (result) {
        if (result.price != null) updatePrice(ticker, result.price);
        if (result.healthData) updateHealthData(ticker, result.healthData);
        if (result.technicals && result.riskAlert) updateTechnicals(ticker, result.technicals, result.riskAlert);
        if (result.name || result.sector) {
          updateStockFields(ticker, {
            ...(result.name ? { name: result.name } : {}),
            ...(result.sector ? { sector: result.sector } : {}),
          });
        }
      }
      // Also refresh fund data for ETFs/mutual funds
      if (!scoreable) {
        await fetchFundData();
      }
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  };

  const handleDelete = () => {
    removeStock(ticker);
    router.push("/");
  };
  // ── Identity-row derived facts ──
  const exchangeLabel = ticker.endsWith(".TO") || ticker.endsWith("-T") ? "TSX" : /^[A-Z]{2,4}\d{2,5}$/i.test(ticker) ? "FundServ" : "US";
  const identityMeta = [
    exchangeLabel,
    tickerCurrency(ticker),
    stock.instrumentType && stock.instrumentType !== "stock" ? INSTRUMENT_LABELS[stock.instrumentType] : null,
    stock.bucket,
  ].filter(Boolean).join(" · ");

  const consensus = scoreable ? computeAnalystConsensus(getAnalystSnapshot(ticker), stock.price) : null;
  const factsetSnap = getAnalystSnapshot(ticker)?.factset;

  // Ticker rail group — a quiet strip of mono chips; the current name is
  // selected. Alt+←/→ walks the same order (see the keydown effect above).
  const railGroup = (label: string, list: string[]) =>
    list.length === 0 ? null : (
      <React.Fragment key={label}>
        <span className="h-4 w-px shrink-0 bg-line" />
        <span className="shrink-0 text-[11px] text-ink-3">{label}</span>
        {list.map((t) => (
          <Link
            key={t}
            href={`/stock/${t.toLowerCase()}${fromSuffix}`}
            className={`inline-flex h-7 shrink-0 items-center rounded-control px-2 font-mono text-[12px] transition-colors ${
              t === ticker ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:bg-surface-hover hover:text-ink"
            }`}
          >
            {t}
          </Link>
        ))}
      </React.Fragment>
    );

  // Fund MER precedence (manual override wins) — same rule the Client
  // Report's blended-fee calculation uses.
  const validMer = (v: number | null | undefined) => typeof v === "number" && Number.isFinite(v) && v > 0;
  const manualMer = stock.manualExpenseRatio;
  const autoMer = stock.fundData?.expenseRatio;
  const effectiveMer = validMer(manualMer) ? (manualMer as number) : validMer(autoMer) ? (autoMer as number) : null;
  const autoIsZero = typeof autoMer === "number" && Number.isFinite(autoMer) && autoMer === 0;
  const merIsManual = validMer(manualMer);
  const merLabel = stock.instrumentType === "mutual-fund" ? "MER" : "Expense ratio";

  // Default-weight editor (funds) — rendered inside the stat strip so the
  // fund's weight sits in the same hairline row as its other facts.
  const defaultWeightCell = editingWeight ? (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const val = parseFloat(weightInput);
        if (!isNaN(val) && val >= 0) updateWeight(ticker, val);
        setEditingWeight(false);
      }}
      className="flex items-center gap-1"
    >
      <input
        value={weightInput}
        onChange={(e) => setWeightInput(e.target.value)}
        type="number"
        step="0.01"
        min="0"
        autoFocus
        aria-label="Default weight (%)"
        className={`${INPUT} w-16 text-right font-mono`}
      />
      <button type="submit" className={BTN_PRIMARY}>Save</button>
      <button type="button" onClick={() => setEditingWeight(false)} className="text-[11.5px] text-ink-3 hover:text-ink">Cancel</button>
    </form>
  ) : (
    <button
      onClick={() => { setWeightInput(String(stock.weights.portfolio)); setEditingWeight(true); }}
      className="font-mono text-[13px] font-medium text-ink hover:text-accent transition-colors"
      title="Fallback weight used when no per-model override is set — click to edit"
    >
      {stock.weights.portfolio}%
    </button>
  );

  return (
    <main className="flex flex-col gap-3.5 text-ink">
      {/* ── Ticker rail: back control + every name in the book, current one
          selected. Horizontal scroll position is preserved across ticker →
          ticker navigations by the sessionStorage effect above. ── */}
      <div ref={tickerBarRef} className="flex items-center gap-1.5 overflow-x-auto">
        <Link
          href={backHref}
          onClick={goBack}
          className={`${BTN} shrink-0`}
          title="Return to where you came from (restores your place)"
        >
          <AppIcon name="arrowL" size={13} /> {backLabel}
        </Link>
        {railGroup("Portfolio", portfolioStockTickers)}
        {railGroup("Funds & ETFs", portfolioFundTickers)}
        {railGroup("Watchlist", watchlistStockTickers)}
        {railGroup("WL funds & ETFs", watchlistFundTickers)}
      </div>

      {stock.bucket === "Portfolio" && scoreable && (
        <ThesisRequiredBanner ticker={stock.ticker} />
      )}

      {/* ── Identity row ── */}
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
        <span className="font-mono text-[20px] font-semibold tracking-tight text-ink">{displayTicker(stock.ticker)}</span>
        <span className="min-w-0 truncate text-[14px] text-ink-2">{stock.name}</span>
        {stock.price != null && (
          <span className="inline-flex items-baseline gap-2">
            <span className="font-mono text-[18px] font-semibold tabular-nums text-ink">{stock.price.toFixed(2)}</span>
            {dayChangePct != null && (
              <span className={`font-mono text-[13px] tabular-nums ${dayChangePct >= 0 ? "text-pos" : "text-neg"}`} title="Latest bar vs the prior close">
                {dayChangePct >= 0 ? "+" : ""}{dayChangePct.toFixed(2)}%
              </span>
            )}
          </span>
        )}
        <span className="text-[12px] text-ink-3">{identityMeta}</span>
        <div className="ml-auto flex items-center gap-2">
          {scoreable && (
            <button
              onClick={handleRescore}
              disabled={scoring}
              className={BTN_PRIMARY}
              title="Score with web-search verification: model cross-checks cached fundamentals against the company's latest filings, press releases, and named-firm analyst notes (~5-10s, ~$0.03-0.05/stock)"
            >
              {scoring ? <><AppIcon name="refresh" size={13} className="animate-spin" /> Verifying…</> : "Rescore"}
            </button>
          )}
          <button onClick={handleRefreshData} disabled={refreshing} className={BTN}>
            <AppIcon name="refresh" size={13} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Refreshing…" : "Refresh data"}
          </button>
          {/* Move-to-Portfolio is intentionally hidden — promoting a Watchlist
              name into the Portfolio is only allowed via the Buy / Sell flow on
              the Positioning tab so every Portfolio entry carries a real buy
              price + cost basis. Demoting is still one click here. */}
          {stock.bucket === "Portfolio" && (
            <button onClick={() => moveBucket(ticker)} className={BTN}>Move to watchlist</button>
          )}
          <div ref={menuRef} className="relative">
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              aria-expanded={menuOpen}
              aria-label="More actions"
              className="grid h-7 w-7 place-items-center rounded-control border border-line bg-surface text-ink-2 hover:bg-surface-hover hover:text-ink transition-colors"
            >
              <AppIcon name="more" size={14} />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-9 z-30 w-56 rounded-card border border-line bg-surface p-1 shadow-[var(--shadow-pop)]">
                {!scoreable && !stock.fundData && !loadingFundData && (
                  <button onClick={() => { setMenuOpen(false); fetchFundData(); }} className={MENU_ITEM}>
                    <AppIcon name="download" size={13} /> Load fund data
                  </button>
                )}
                {!scoreable && (
                  <button onClick={() => { setMenuOpen(false); fetchFundData(); }} className={MENU_ITEM}>
                    <AppIcon name="refresh" size={13} /> Refresh fund data
                  </button>
                )}
                <button
                  onClick={() => { setMenuOpen(false); handleDelete(); }}
                  className={`${MENU_ITEM} text-neg hover:text-neg`}
                  title={`Remove ${displayTicker(stock.ticker)} from the book`}
                >
                  <AppIcon name="trash" size={13} /> Delete
                </button>
              </div>
            )}
          </div>
        </div>
        {(scoreError || refreshError) && (
          <span className="w-full text-[11.5px] text-neg">
            {[scoreError, refreshError].filter(Boolean).join(" · ")}
          </span>
        )}
      </div>

      {/* ── Hairline stat strip ── */}
      {scoreable ? (
        <StatStrip
          cols={8}
          items={[
            { label: "Score", value: <>{Number(stock.adjusted.toFixed(1))}<span className="text-ink-faint">/{MAX_SCORE}</span></> },
            { label: "Rating", value: stock.ratingLabel || stock.rating || "—" },
            { label: "Sector", value: stock.sector || "—", title: stock.sector || undefined },
            { label: "Weight", value: stock.bucket === "Portfolio" ? (stock.weights.portfolio > 0 ? `${stock.weights.portfolio}%` : "—") : "Watchlist" },
            { label: "Beta", value: typeof stock.beta === "number" ? stock.beta.toFixed(2) : "—" },
            { label: "Fwd P/E", value: stock.healthData?.forwardPE != null ? `${stock.healthData.forwardPE.toFixed(1)}x` : "—" },
            {
              label: "Consensus",
              value: consensus ? <>{Number(consensus.score.toFixed(2))}<span className="text-ink-faint">/3</span></> : "—",
              title: factsetSnap
                ? `FactSet${factsetSnap.analystCount != null ? ` · ${factsetSnap.analystCount} analysts` : ""}${factsetSnap.averageTarget != null ? ` · avg target ${factsetSnap.averageTarget}` : ""}`
                : "Analyst-consensus category score (RBC / JPM ratings, FactSet target upside, estimate revisions, Morningstar stars).",
            },
            { label: "Last scored", value: stock.lastScored || "never", title: stock.lastScored || undefined },
          ]}
        />
      ) : (
        <StatStrip
          cols={6}
          items={[
            {
              label: merIsManual ? `${merLabel} (manual)` : merLabel,
              value: effectiveMer != null ? `${effectiveMer.toFixed(2)}%` : "—",
              title: merIsManual ? "Manual override — takes precedence over the auto-fetched value" : undefined,
            },
            { label: "AUM", value: stock.fundData?.totalAssets != null ? formatAUM(stock.fundData.totalAssets) : "—" },
            { label: "Yield", value: stock.fundData?.yield != null ? `${stock.fundData.yield.toFixed(2)}%` : "—" },
            {
              label: "Morningstar",
              value: stock.fundData?.starRating != null ? (
                <span className="inline-flex items-center gap-0.5" title={`${stock.fundData.starRating} of 5 stars`}>
                  {Array.from({ length: 5 }, (_, i) => (
                    <span key={i} className={i < (stock.fundData?.starRating ?? 0) ? "text-warn" : "text-ink-faint"}>
                      <AppIcon name="star" size={11} />
                    </span>
                  ))}
                </span>
              ) : "—",
            },
            { label: "Category", value: stock.fundData?.category || "—", title: stock.fundData?.category },
            { label: "Default weight", value: defaultWeightCell },
          ]}
        />
      )}

      {/* ── What they do / why we own it / bear case ── */}
      {(stock.companySummary || stock.investmentThesis || stock.bearCase) && (
        <div className="flex flex-col gap-2">
          {stock.companySummary && (
            <p className="text-[12.5px] leading-[1.5] text-ink-2">{stock.companySummary}</p>
          )}
          {stock.investmentThesis && (
            <p className="text-[12.5px] leading-[1.5] text-ink-2">{stock.investmentThesis}</p>
          )}
          {stock.bearCase && (
            <div className="rounded-card bg-neg-soft px-3 py-2">
              <div className="text-[11px] text-neg">Bear case · thesis-breakers to watch</div>
              <p className="mt-0.5 text-[12.5px] leading-[1.5] text-neg">{stock.bearCase}</p>
            </div>
          )}
        </div>
      )}

      {/* ── Two columns: the decision material left, the context right. ── */}
      <div className="grid grid-cols-1 items-start gap-3.5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* LEFT */}
        <div className="flex min-w-0 flex-col gap-3.5">
          {/* Price (not available for mutual funds) */}
          {stock.instrumentType !== "mutual-fund" && (
            <StockChart ticker={stock.ticker} technicals={stock.technicals} onDayChange={setDayChangePct} />
          )}

          {/* ── Score: one row per group, each expanding to its categories ── */}
          {scoreable && (
            <section className="panel">
              <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
                <span className="t">Score</span>
                <span className="m">
                  {MAX_SCORE}-point · regime {marketData.riskRegime || "—"} · raw {Number(stock.raw.toFixed(1))} → adjusted {Number(stock.adjusted.toFixed(1))}
                </span>
                <span className="m ml-auto">{stock.lastScored ? `Scored ${stock.lastScored}` : "Never scored"}</span>
              </div>

              {/* Header area: the donut, the regime caption, the delta. */}
              <div className="flex flex-wrap items-center gap-4 border-b border-line-soft px-3.5 py-3">
                <ScoreDonut score={stock.adjusted} max={MAX_SCORE} groups={SCORE_GROUPS} stock={stock} />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  {/* Regime-adjustment caption: how much the current market
                      regime is helping or hurting this name's rating. */}
                  {(() => {
                    const delta = stock.adjusted - stock.raw;
                    const absDelta = Math.abs(delta);
                    if (absDelta < 0.05) {
                      return <div className="text-[12.5px] text-ink-2">Regime neutral · raw <span className="font-mono">{stock.raw.toFixed(1)}</span></div>;
                    }
                    const positive = delta >= 0;
                    return (
                      <div className="text-[12.5px] text-ink-2">
                        <span className={positive ? "text-pos" : "text-neg"}>
                          Regime {positive ? "+" : ""}{delta.toFixed(1)} pt{absDelta === 1 ? "" : "s"}
                        </span>
                        <span className="text-ink-3"> · raw </span>
                        <span className="font-mono">{stock.raw.toFixed(1)}</span>
                        <span className="text-ink-3"> → adjusted </span>
                        <span className="font-mono">{stock.adjusted.toFixed(1)}</span>
                      </div>
                    );
                  })()}
                  {/* Renders nothing until pm:score-history has >=2 entries. */}
                  <ScoreDelta ticker={stock.ticker} />
                  <div className="text-[11.5px] text-ink-3">Open a group to edit its categories, read the evidence and reach the source panels.</div>
                </div>
              </div>

              <table className="data-table">
                <thead>
                  <tr>
                    <th className="pl-3.5">Group</th>
                    <th style={{ width: 200 }} />
                    <th className="n">Pts</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {SCORE_GROUPS.map((group) => {
                    const total = groupTotal(stock, group);
                    const pct = (total / group.maxTotal) * 100;
                    const groupOpen = expandedGroups.has(group.name);

                    // Notes column: anything that changed the composite comes
                    // first (N/A exclusions, DATA GAP parks, the value-trap
                    // haircut); otherwise the first available AI summary.
                    const flags: string[] = [];
                    const naLabels = group.categories
                      .filter((c) =>
                        (c.key === "ownershipTrends" && !ownershipTrendsApplies(stock)) ||
                        (c.key === "marketEdge" && !marketEdgeApplies(stock)) ||
                        (c.key === "aiRating" && !boostedAiApplies(stock)) ||
                        (c.key === "relativeStrength" && !siaApplies(stock)))
                      .map((c) => c.label);
                    if (naLabels.length) flags.push(`N/A: ${naLabels.join(", ")}`);
                    const gapLabels = group.categories
                      .filter((c) => stock.gapExcluded?.includes(c.key as ScoreKey))
                      .map((c) => c.label);
                    if (gapLabels.length) flags.push(`Data gap: ${gapLabels.join(", ")}`);
                    if (stock.valueTrap && group.categories.some((c) => c.key === "relativeValuation" || c.key === "historicalValuation")) {
                      flags.push("Value-trap ×0.5");
                    }
                    let firstSummary = "";
                    for (const c of group.categories) {
                      const e = stock.explanations?.[c.key as ScoreKey];
                      const s = Array.isArray(e) ? e.join(" ") : e && typeof e === "object" ? e.summary ?? "" : "";
                      if (s) { firstSummary = s; break; }
                    }
                    const note = flags.length ? flags.join(" · ") : firstSummary;

                    return (
                      <React.Fragment key={group.name}>
                        <tr
                          className="cursor-pointer"
                          onClick={() => toggleGroup(group.name)}
                        >
                          <td className="pl-3.5">
                            <span className="inline-flex items-center gap-1.5">
                              <span className="text-ink-3"><AppIcon name={groupOpen ? "chevD" : "chevR"} size={13} /></span>
                              <span className="font-medium">{group.name}</span>
                            </span>
                          </td>
                          <td>
                            <div className="h-1 w-[180px] overflow-hidden rounded-sm bg-line-soft">
                              <div className="h-full bg-ink-2" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
                            </div>
                          </td>
                          <td className="n">
                            {Number.isInteger(total) ? total : total.toFixed(1)}
                            <span className="text-ink-faint">/{group.maxTotal}</span>
                          </td>
                          <td className="text-[12px] text-ink-2" style={{ whiteSpace: "normal" }}>
                            <span className="line-clamp-1" title={note || undefined}>{note || "—"}</span>
                          </td>
                        </tr>
                        {groupOpen && (
                          <tr>
                            <td colSpan={4} style={{ height: "auto", whiteSpace: "normal", padding: 0 }}>
                              <div className="flex flex-col gap-4 bg-surface-2 px-3.5 py-3.5">
                                {group.categories.map((cat) => {
                                  // For computed categories, ALWAYS use the live-derived score
                                  // rather than the persisted value — the persisted value may be
                                  // stale (e.g. old rounded analystConsensus of 3 when the true
                                  // value is 2.75). This ensures the category chip, group subtotal,
                                  // and overall score all reflect current data without re-scoring.
                                  let val = stock.scores[cat.key as ScoreKey] || 0;
                                  let rawExp = stock.explanations?.[cat.key as ScoreKey];
                                  if (cat.key === "analystConsensus") {
                                    const c = computeAnalystConsensus(getAnalystSnapshot(ticker), stock.price);
                                    val = c.score;
                                    rawExp = buildConsensusExplanation(c);
                                  }
                                  // Normalize legacy (string[]) vs new ({summary, dataPoints, confidence?}) shapes.
                                  let summary = "";
                                  let dataPoints: ScoreDataPoint[] = [];
                                  let confidence: "high" | "medium" | "low" | undefined;
                                  if (Array.isArray(rawExp)) {
                                    summary = rawExp.join(" ");
                                  } else if (rawExp && typeof rawExp === "object") {
                                    summary = rawExp.summary ?? "";
                                    dataPoints = Array.isArray(rawExp.dataPoints) ? rawExp.dataPoints : [];
                                    confidence = rawExp.confidence;
                                  }
                                  const isComputed = cat.inputType === "computed";
                                  const inputWord =
                                    cat.inputType === "auto" ? "Auto"
                                    : cat.inputType === "semi" ? "Semi"
                                    : cat.inputType === "computed" ? "Computed"
                                    : "Manual";

                                  const hasContent = summary.length > 0 || dataPoints.length > 0;
                                  // "External sources" and "Research coverage" both get a notes
                                  // editor in the expanded body so the PM can log analyst reports /
                                  // source URLs / dates that feed back into the scoring prompt. The
                                  // toggle always appears for these two, even with no AI content.
                                  const isExternalSources = cat.key === "externalSources";
                                  const isResearchCoverage = cat.key === "researchCoverage";
                                  const isAnalystConsensus = cat.key === "analystConsensus";
                                  const hasNotesEditor = isExternalSources || isResearchCoverage;
                                  const externalNotes = stock.externalSourceNotes ?? [];
                                  const researchNotes = stock.researchCoverageNotes ?? [];
                                  const notesForThis = isExternalSources ? externalNotes : isResearchCoverage ? researchNotes : [];
                                  // aiRating + relativeStrength + marketEdge have inline
                                  // BoostedAI / SIA / MarketEdge editors in their expanded body.
                                  // Always offer the toggle for them so the PM can enter those raw
                                  // scores here — even before a Claude re-score produced an
                                  // explanation.
                                  const hasExternalEditor = cat.key === "aiRating" || cat.key === "relativeStrength" || cat.key === "marketEdge";
                                  const showToggle = hasContent || hasNotesEditor || isAnalystConsensus || hasExternalEditor;
                                  const isExpanded = expandedCategories.has(cat.key);
                                  return (
                                    <div key={cat.key}>
                                      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                                          <span className="text-[12.5px] font-medium text-ink">{cat.label}</span>
                                          <span className="font-mono text-[11px] text-ink-3">/{cat.max}</span>
                                          <span className="text-[11px] text-ink-3" title={`Input type: ${cat.inputType}`}>{inputWord}</span>
                                          {(() => {
                                            const src = categoryDataSource(dataPoints);
                                            const meta = src ? CATEGORY_SOURCE_META[src] : undefined;
                                            if (!meta) return null;
                                            return (
                                              <span
                                                className="text-[11px] text-ink-3"
                                                title={`Primary data source for this category: ${meta.label}`}
                                              >
                                                {meta.label}
                                              </span>
                                            );
                                          })()}
                                          {/* Value-trap haircut — never applied silently. */}
                                          {(cat.key === "relativeValuation" || cat.key === "historicalValuation") && stock.valueTrap && (
                                            <span
                                              className="inline-flex items-center gap-1.5 text-[11px] text-warn"
                                              title={`Value-trap haircut ×0.5: FY+1 estimates are being cut (net revisions ${stock.valueTrap.net}). Cheap + falling estimates reads as a trap, not an entry — ${stock.valueTrap.pointsRemoved} pts removed across the two valuation categories. Lifts automatically when revisions recover.`}
                                            >
                                              <span className="dot bg-warn" /> Value-trap ×0.5
                                            </span>
                                          )}
                                          {/* Manual-score age — manual entries never expire on their
                                              own; flag anything old (or undated) so a months-old
                                              charting score can't pass as fresh. */}
                                          {cat.inputType === "manual" && (stock.scores[cat.key as ScoreKey] ?? 0) > 0 && (() => {
                                            const at = stock.manualScoredAt?.[cat.key as ScoreKey];
                                            const ageDays = at ? Math.round((Date.now() - new Date(`${at}T00:00:00Z`).getTime()) / 86400000) : null;
                                            if (ageDays != null && ageDays <= 60) return null;
                                            return (
                                              <span
                                                className="inline-flex items-center gap-1.5 text-[11px] text-warn"
                                                title={ageDays != null
                                                  ? `Manual entry last updated ${at} (${ageDays} days ago). Manual scores never age out of the composite — re-check whether this still holds.`
                                                  : "No edit date recorded for this manual entry (predates age tracking). Re-enter the score to stamp it."}
                                              >
                                                <span className="dot bg-warn" /> {ageDays != null ? `Stale ${ageDays}d` : "Age unknown"}
                                              </span>
                                            );
                                          })()}
                                          {/* DATA GAP composite exclusion — never silent. */}
                                          {stock.gapExcluded?.includes(cat.key as ScoreKey) && (
                                            <span
                                              className="inline-flex items-center gap-1.5 text-[11px] text-ink-3"
                                              title="Parked with the DATA GAP default: no source covered this category's inputs. Excluded from the composite (numerator and denominator; score renormalized to /41) — the displayed value is informational only."
                                            >
                                              <span className="dot bg-ink-faint" /> Gap · excluded
                                            </span>
                                          )}
                                          {confidence && (
                                            <span
                                              className={`inline-flex items-center gap-1.5 text-[11px] ${
                                                confidence === "high" ? "text-pos" : confidence === "medium" ? "text-warn" : "text-neg"
                                              }`}
                                              title={
                                                confidence === "high"
                                                  ? "High confidence: current authoritative data for all material inputs"
                                                  : confidence === "medium"
                                                  ? "Medium confidence: partial / mixed data — worth a second look"
                                                  : "Low confidence: stale / contradictory / missing data — treat score as a starting point"
                                              }
                                            >
                                              <span className={`dot ${confidence === "high" ? "bg-pos" : confidence === "medium" ? "bg-warn" : "bg-neg"}`} />
                                              {confidence}
                                            </span>
                                          )}
                                          {showToggle && (
                                            <button
                                              onClick={() => toggleCategory(cat.key)}
                                              className="inline-flex h-6 items-center gap-1 rounded-control px-1.5 text-[11.5px] text-ink-3 hover:bg-surface-hover hover:text-ink transition-colors"
                                              aria-expanded={isExpanded}
                                              aria-label={isExpanded ? "Hide explanation" : "Show explanation"}
                                            >
                                              {isExpanded ? "Hide" : "Show"}
                                              {hasNotesEditor && notesForThis.length > 0 && (
                                                <span className="font-mono text-[11px] text-ink-3">{notesForThis.length}</span>
                                              )}
                                              <AppIcon name={isExpanded ? "chevU" : "chevD"} size={12} />
                                            </button>
                                          )}
                                        </div>
                                        <div className="flex gap-1">
                                          {cat.key === "ownershipTrends" && !ownershipTrendsApplies(stock) ? (
                                            /* Form 4 insider data is US-only (SEDI not integrated), so
                                               for Canadian listings the category is N/A and excluded
                                               from the composite (normalized back to the full scale in
                                               computeScores) — a fixed DATA GAP 1/2 on every TSX name
                                               was a constant, non-discriminating offset. */
                                            <span
                                              className="inline-flex h-7 items-center rounded-control border border-line bg-surface px-2 font-mono text-[11.5px] text-ink-3"
                                              title="Insider-trend data (SEC Form 4) covers US listings only — SEDI is not integrated. For this Canadian listing the category is N/A and excluded from the composite (score normalized so the stock isn't penalized)."
                                            >
                                              N/A
                                            </span>
                                          ) : cat.key === "marketEdge" && !marketEdgeApplies(stock) ? (
                                            /* MarketEdge covers US listings only. For a pure-Canadian
                                               name it can't reach, the category is N/A and excluded
                                               from the composite (which is normalized back to the full
                                               scale in computeScores) — show N/A so it doesn't read as
                                               a real 0. */
                                            <span
                                              className="inline-flex h-7 items-center rounded-control border border-line bg-surface px-2 font-mono text-[11.5px] text-ink-3"
                                              title="MarketEdge covers US-listed stocks only. This Canadian name isn't dual-listed, so the category is N/A and excluded from the composite (the score is normalized so the stock isn't penalized)."
                                            >
                                              N/A
                                            </span>
                                          ) : !boostedAiApplies(stock) && cat.key === "aiRating" ? (
                                            /* Absent ≠ bearish: no BoostedAI rating/consensus imported
                                               yet (fresh add). N/A + excluded from the composite until
                                               the next BoostedAI import lands, then it snaps in. */
                                            <span
                                              className="inline-flex h-7 items-center rounded-control border border-line bg-surface px-2 font-mono text-[11.5px] text-ink-3"
                                              title="No BoostedAI data imported for this name yet. The category is N/A and excluded from the composite (score normalized so the stock isn't penalized for missing data). It activates automatically on the next BoostedAI import."
                                            >
                                              N/A
                                            </span>
                                          ) : !siaApplies(stock) && cat.key === "relativeStrength" ? (
                                            <span
                                              className="inline-flex h-7 items-center rounded-control border border-line bg-surface px-2 font-mono text-[11.5px] text-ink-3"
                                              title="No SIA SMAX imported for this name yet. The category is N/A and excluded from the composite (score normalized so the stock isn't penalized for missing data). It activates automatically on the next SIA import."
                                            >
                                              N/A
                                            </span>
                                          ) : isComputed ? (
                                            /* Computed categories show a single static value (may be
                                               fractional, e.g. 2.5). No toggle buttons — the Coverage
                                               Checklist / research feeds are the only input path. */
                                            <span
                                              className={`inline-flex h-7 items-center rounded-control border border-line bg-surface px-2 font-mono text-[12px] ${val < 0 ? "text-neg" : "text-ink"}`}
                                              title={`Auto-derived: ${val}/${cat.max}`}
                                            >
                                              {Number.isInteger(val) ? val : val.toFixed(2)}
                                              <span className="text-ink-faint">/{cat.max}</span>
                                            </span>
                                          ) : (
                                            Array.from({ length: cat.max + 1 }, (_, i) => (
                                              <button
                                                key={i}
                                                onClick={() => updateScore(ticker, cat.key as ScoreKey, i)}
                                                className={`grid h-7 w-7 place-items-center rounded-control font-mono text-[12px] transition-colors ${
                                                  i === val
                                                    ? "bg-ink text-white"
                                                    : "border border-line bg-surface text-ink-3 hover:bg-surface-hover hover:text-ink"
                                                }`}
                                                title={`Set ${cat.label} to ${i}`}
                                              >
                                                {i}
                                              </button>
                                            ))
                                          )}
                                        </div>
                                      </div>
                                      {isExpanded && hasNotesEditor && (
                                        <ExternalSourcesEditor
                                          notes={notesForThis}
                                          onChange={(next) => updateStockFields(ticker, isExternalSources ? { externalSourceNotes: next } : { researchCoverageNotes: next })}
                                          headerLabel={isExternalSources ? "External sources log" : "Research coverage log"}
                                          emptyHint={isExternalSources
                                            ? "No sources logged. Click “Add source” to track analyst reports, news, podcasts, or other external research feeding this score."
                                            : "No coverage logged. Log named-firm activity (Morgan Stanley initiation, Goldman PT change, etc.) here as evidence of an active information environment. RBC and JPM go in the Analyst consensus panel; this is for everyone else."}
                                          placeholder={isExternalSources
                                            ? "Source (e.g. RBC Capital Markets — Upgraded to Outperform, PT $245)"
                                            : "Coverage event (e.g. Wells Fargo initiated Buy, PT $52, Apr 18)"}
                                        />
                                      )}
                                      {isExpanded && !isExternalSources && hasContent && (
                                        <div className="flex flex-col gap-2.5">
                                          {summary && (
                                            <p className="text-[12.5px] leading-[1.5] text-ink-2">{summary}</p>
                                          )}
                                          {dataPoints.length > 0 && (
                                            <div>
                                              <p className="mb-1.5 text-[11px] text-ink-3">Data points</p>
                                              <ul className="flex flex-col gap-1">
                                                {dataPoints.map((dp, i) => (
                                                  <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px] leading-relaxed">
                                                    <span className="flex items-baseline gap-2">
                                                      <span className="dot mt-[5px] bg-line" />
                                                      <span className="text-ink-3">{dp.label}:</span>
                                                      <span className="text-ink">{dp.value}</span>
                                                    </span>
                                                    <SourceChip source={dp.source} detail={dp.sourceDetail} url={dp.url} label={dp.label} ticker={ticker} />
                                                  </li>
                                                ))}
                                              </ul>
                                            </div>
                                          )}
                                        </div>
                                      )}
                                      {isExpanded && isAnalystConsensus && (
                                        <AnalystSnapshotPanel
                                          ticker={ticker}
                                          stockCurrency={tickerCurrency(ticker)}
                                          snapshot={getAnalystSnapshot(ticker)}
                                          breakdown={computeAnalystConsensus(getAnalystSnapshot(ticker), stock.price)}
                                          reports={getAnalystReports(ticker)}
                                          onChange={(next) => {
                                            updateAnalystSnapshot(ticker, next);
                                            // Auto-derive analystConsensus score + explanation
                                            // when snapshot changes (FactSet target edit, etc.)
                                            const c = computeAnalystConsensus(next, stock.price);
                                            updateScore(ticker, "analystConsensus", c.score);
                                            updateExplanations(ticker, { analystConsensus: buildConsensusExplanation(c) });
                                          }}
                                          onUpload={(source, dataUrl, label) => uploadAnalystReport(ticker, source, dataUrl, label)}
                                          onRemoveReport={(source) => removeAnalystReport(ticker, source)}
                                          onConvertTarget={(source, fromCurrency) => convertAnalystTarget(ticker, source, fromCurrency)}
                                        />
                                      )}
                                      {/* AI Rating: editable BoostedAI rating (0-5) + cycling
                                          consensus chip. Score auto-derives via
                                          mapBoostedAiToAiRating — same logic the Inbox tab uses,
                                          so edits on either page produce identical results. */}
                                      {isExpanded && cat.key === "aiRating" && (() => {
                                        // Warning: the most recent BoostedAI screenshot upload did
                                        // NOT read a value for this name. Cleared by either a
                                        // successful screenshot read OR a manual edit (both bump
                                        // boostedLastReadAt).
                                        const lastShot = stock.boostedLastScreenshotAt;
                                        const lastRead = stock.boostedLastReadAt;
                                        const showChip = !!lastShot && (!lastRead || Date.parse(lastShot) > Date.parse(lastRead));
                                        const nowIso = () => new Date().toISOString();
                                        return (
                                          <div className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3">
                                            <div className="flex flex-wrap items-center gap-2">
                                              <div className="text-[11px] text-ink-3">BoostedAI inputs</div>
                                              {showChip && (
                                                <span
                                                  className="inline-flex items-center gap-1.5 text-[11px] text-warn"
                                                  title={`Last BoostedAI screenshot didn't read a value for ${ticker} (uploaded ${lastShot?.slice(0, 10)}). Re-screenshot or edit a value below to clear.`}
                                                >
                                                  <span className="dot bg-warn" /> Last screenshot didn&apos;t capture this name
                                                </span>
                                              )}
                                            </div>
                                            <div className="flex flex-wrap items-center gap-3">
                                              <label className="flex items-center gap-2 text-[12px]">
                                                <span className="text-ink-2">Rating (0-5):</span>
                                                <EditableNumberCell
                                                  value={stock.boostedAi ?? null}
                                                  step="0.1"
                                                  min={0}
                                                  max={5}
                                                  onCommit={(next) => {
                                                    const rating = next == null ? undefined : next;
                                                    updateStockFields(ticker, { boostedAi: rating, boostedLastReadAt: nowIso() });
                                                    const mapped = mapBoostedAiToAiRating(next ?? null, stock.boostedAiConsensus ?? null);
                                                    if (mapped != null) updateScore(ticker, "aiRating", mapped);
                                                  }}
                                                  width="w-16"
                                                  placeholder="—"
                                                  ariaLabel={`BoostedAI rating for ${ticker}`}
                                                  formatDisplay={(n) => n.toFixed(1)}
                                                />
                                              </label>
                                              <label className="flex items-center gap-2 text-[12px]">
                                                <span className="text-ink-2">Consensus:</span>
                                                <ConsensusButton
                                                  value={stock.boostedAiConsensus ?? null}
                                                  ariaLabel={`BoostedAI consensus for ${ticker}`}
                                                  onChange={(next) => {
                                                    updateStockFields(ticker, { boostedAiConsensus: next ?? undefined, boostedLastReadAt: nowIso() });
                                                    const mapped = mapBoostedAiToAiRating(stock.boostedAi ?? null, next);
                                                    if (mapped != null) updateScore(ticker, "aiRating", mapped);
                                                  }}
                                                />
                                              </label>
                                            </div>
                                            <p className="text-[11px] text-ink-3">
                                              Score maps: rating 4.5+ &amp; bullish consensus → 2, 3.5+ &amp; any non-bearish → 1, else 0. Same logic as the Inbox tab.
                                            </p>
                                          </div>
                                        );
                                      })()}
                                      {/* Relative Strength: editable SIA SMAX (0-10). Score
                                          auto-derives via mapSmaxToRelativeStrength. */}
                                      {isExpanded && cat.key === "relativeStrength" && (() => {
                                        const lastShot = stock.siaLastScreenshotAt;
                                        const lastRead = stock.siaLastReadAt;
                                        const showChip = !!lastShot && (!lastRead || Date.parse(lastShot) > Date.parse(lastRead));
                                        const nowIso = () => new Date().toISOString();
                                        return (
                                          <div className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3">
                                            <div className="flex flex-wrap items-center gap-2">
                                              <div className="text-[11px] text-ink-3">SIA SMAX input</div>
                                              {showChip && (
                                                <span
                                                  className="inline-flex items-center gap-1.5 text-[11px] text-warn"
                                                  title={`Last SIA screenshot didn't read a value for ${ticker} (uploaded ${lastShot?.slice(0, 10)}). Re-screenshot or edit a value below to clear.`}
                                                >
                                                  <span className="dot bg-warn" /> Last screenshot didn&apos;t capture this name
                                                </span>
                                              )}
                                            </div>
                                            <div className="flex flex-wrap items-center gap-3">
                                              <label className="flex items-center gap-2 text-[12px]">
                                                <span className="text-ink-2">SMAX (0-10):</span>
                                                <EditableNumberCell
                                                  value={(stock as { sia?: number | null }).sia ?? null}
                                                  step="1"
                                                  min={0}
                                                  max={10}
                                                  onCommit={(next) => {
                                                    updateStockFields(ticker, { sia: next == null ? undefined : next, siaLastReadAt: nowIso() } as Partial<typeof stock>);
                                                    const mapped = mapSmaxToRelativeStrength(next ?? null);
                                                    if (mapped != null) updateScore(ticker, "relativeStrength", mapped);
                                                  }}
                                                  width="w-16"
                                                  placeholder="—"
                                                  ariaLabel={`SIA SMAX for ${ticker}`}
                                                  formatDisplay={(n) => String(Math.round(n))}
                                                />
                                              </label>
                                            </div>
                                            <p className="text-[11px] text-ink-3">
                                              Score maps: 8-10 → 2, 6-7 → 1, 0-5 → 0. Same logic as the Inbox tab.
                                            </p>
                                          </div>
                                        );
                                      })()}
                                      {/* MarketEdge: editable Power Rating (-60..100), Opinion,
                                          Opinion Score (-4..4), Opinion Date. Power Rating drives
                                          the marketEdge score; Opinion + Score drive the
                                          deteriorating-Long / reversal-Avoid warning. */}
                                      {isExpanded && cat.key === "marketEdge" && (() => {
                                        const me = stock.marketEdge ?? {};
                                        const warning = marketEdgeWarning(me.opinion, me.opinionScore);
                                        const opinionTone =
                                          me.opinion === "long" ? "text-pos"
                                          : me.opinion === "avoid" ? "text-neg"
                                          : me.opinion === "neutral" ? "text-ink-2"
                                          : "text-ink-3";
                                        const cycleOpinion = () => {
                                          const cycle: (MarketEdgeOpinion | undefined)[] = [undefined, "long", "neutral", "avoid"];
                                          const idx = me.opinion == null ? 0 : Math.max(0, cycle.indexOf(me.opinion));
                                          const next = cycle[(idx + 1) % cycle.length];
                                          updateStockFields(ticker, { marketEdge: { ...me, opinion: next } });
                                        };
                                        return (
                                          <div className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3">
                                            <div className="flex flex-wrap items-center gap-2">
                                              <div className="text-[11px] text-ink-3">MarketEdge inputs</div>
                                              {warning && (
                                                <span
                                                  className={`inline-flex items-center gap-1.5 text-[11px] ${warning.kind === "deteriorating" ? "text-warn" : "text-accent"}`}
                                                  title={
                                                    warning.kind === "deteriorating"
                                                      ? `Held Long with Opinion Score ${me.opinionScore} — MarketEdge flags significant technical deterioration. Surfaced in the morning brief risk context.`
                                                      : `Avoid name with Opinion Score ${me.opinionScore} — MarketEdge flags significant technical improvement (reversal watch).`
                                                  }
                                                >
                                                  <span className={`dot ${warning.kind === "deteriorating" ? "bg-warn" : "bg-accent"}`} /> {warning.label}
                                                </span>
                                              )}
                                            </div>
                                            <div className="flex flex-wrap items-center gap-3">
                                              <label className="flex items-center gap-2 text-[12px]">
                                                <span className="text-ink-2">Power Rating:</span>
                                                <EditableNumberCell
                                                  value={me.powerRating ?? null}
                                                  step="1"
                                                  min={-60}
                                                  max={100}
                                                  onCommit={(next) => {
                                                    const nextMe = { ...me, powerRating: next == null ? undefined : next };
                                                    updateStockFields(ticker, { marketEdge: nextMe });
                                                    const mapped = mapPowerRatingToMarketEdge(next ?? null);
                                                    if (mapped != null) updateScore(ticker, "marketEdge", mapped);
                                                  }}
                                                  width="w-16"
                                                  placeholder="—"
                                                  ariaLabel={`MarketEdge Power Rating for ${ticker}`}
                                                  formatDisplay={(n) => String(Math.round(n))}
                                                />
                                              </label>
                                              <label className="flex items-center gap-2 text-[12px]">
                                                <span className="text-ink-2">Opinion:</span>
                                                <button
                                                  type="button"
                                                  onClick={cycleOpinion}
                                                  title="Click to cycle: — → Long → Neutral → Avoid. The Opinion + Opinion Score drive the deteriorating-Long / reversal-Avoid warning."
                                                  className={`inline-flex h-7 w-[76px] items-center justify-center rounded-control border border-line bg-surface text-[12px] hover:bg-surface-hover transition-colors ${opinionTone}`}
                                                >
                                                  {me.opinion === "long" ? "Long" : me.opinion === "avoid" ? "Avoid" : me.opinion === "neutral" ? "Neutral" : "—"}
                                                </button>
                                              </label>
                                              <label className="flex items-center gap-2 text-[12px]">
                                                <span className="text-ink-2">Opinion Score:</span>
                                                <EditableNumberCell
                                                  value={me.opinionScore ?? null}
                                                  step="1"
                                                  min={-4}
                                                  max={4}
                                                  onCommit={(next) => {
                                                    const nextMe = { ...me, opinionScore: next == null ? undefined : next };
                                                    updateStockFields(ticker, { marketEdge: nextMe });
                                                  }}
                                                  width="w-14"
                                                  placeholder="—"
                                                  ariaLabel={`MarketEdge Opinion Score for ${ticker}`}
                                                  formatDisplay={(n) => String(Math.round(n))}
                                                />
                                              </label>
                                              <label className="flex items-center gap-2 text-[12px]">
                                                <span className="text-ink-2">Opinion Date:</span>
                                                <input
                                                  type="date"
                                                  value={me.opinionDate ?? ""}
                                                  onChange={(e) => updateStockFields(ticker, { marketEdge: { ...me, opinionDate: e.target.value || undefined } })}
                                                  className={INPUT}
                                                  aria-label={`MarketEdge Opinion Date for ${ticker}`}
                                                />
                                              </label>
                                            </div>
                                            <p className="text-[11px] text-ink-3">
                                              Power Rating maps to MarketEdge Opinions: ≥ +60 → 2 (Long), −27 to +59 → 1 (Neutral), &lt;−27 → 0 (Avoid). Opinion + Opinion Score drive the warning flag (Long &amp; score ≤ −3, or Avoid &amp; score ≥ +3) — NOT the composite. Updated weekly via CSV upload on the Inbox tab.
                                            </p>
                                          </div>
                                        );
                                      })()}
                                      {!hasNotesEditor && !isAnalystConsensus && !hasContent && cat.inputType !== "manual" && cat.inputType !== "computed" && (
                                        <p className="text-[11.5px] text-ink-3">Re-score via Claude to generate an explanation.</p>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}

          {/* ── Fund details: load state, MER override, scrape warnings ── */}
          {!scoreable && (
            <section className="panel">
              <div className="panel-h">
                <span className="t">Fund details</span>
                <span className="m">{merLabel} feeds the Client Report blended fee</span>
              </div>
              <div className="flex flex-col gap-3 p-3.5">
                {loadingFundData && !stock.fundData && (
                  <p className="animate-pulse text-[12.5px] text-ink-3">Loading fund data…</p>
                )}
                {/* Suspect-zero warning — auto-fetch returned 0 and no manual
                    override exists. 0% MER isn't realistic for a fund/ETF, so
                    surface a visible nudge to type the real value below. */}
                {autoIsZero && !merIsManual && (
                  <div className="flex items-start gap-2 rounded-card bg-warn-soft px-3 py-2 text-[11.5px] text-warn">
                    <span className="mt-0.5 shrink-0"><AppIcon name="warn" size={14} /></span>
                    <span>
                      <span className="font-medium">Auto-fetched {merLabel} is 0%.</span>{" "}
                      This is almost certainly a scrape miss — funds and ETFs essentially never have a 0% MER. Enter the real value below so the Client Report blended-fee calc uses it.
                    </span>
                  </div>
                )}
                {!stock.fundData && !loadingFundData && (
                  <div>
                    <button onClick={fetchFundData} className={BTN_PRIMARY}>Load fund data</button>
                  </div>
                )}
                {/* Manual MER override. The auto-fetch in /api/fund-data misses
                    many mutual-fund series and some lightly-covered ETFs
                    (Morningstar page-layout drift, missing yfinance coverage).
                    The Client Report reads
                    `stock.manualExpenseRatio ?? fundData.expenseRatio`, so a
                    value typed here overrides whatever the scraper found. */}
                <div>
                  <label className="block text-[11px] text-ink-3" htmlFor={`manual-mer-${ticker}`}>
                    Manual MER override (%)
                  </label>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <input
                      id={`manual-mer-${ticker}`}
                      type="number"
                      step="0.01"
                      min="0"
                      max="10"
                      placeholder={stock.fundData?.expenseRatio != null ? `auto: ${stock.fundData.expenseRatio.toFixed(2)}` : "e.g. 0.08"}
                      defaultValue={stock.manualExpenseRatio != null ? String(stock.manualExpenseRatio) : ""}
                      onBlur={(e) => {
                        const raw = e.target.value.trim();
                        if (raw === "") {
                          if (stock.manualExpenseRatio != null) {
                            updateStockFields(ticker, { manualExpenseRatio: undefined });
                          }
                          return;
                        }
                        const n = Number(raw);
                        if (Number.isFinite(n) && n >= 0 && n <= 10) {
                          updateStockFields(ticker, { manualExpenseRatio: n });
                        }
                      }}
                      className={`${INPUT} w-28 text-right font-mono`}
                    />
                    <span className="text-[11px] text-ink-3">
                      Used by the Client Report when auto-fetch is missing or wrong.
                    </span>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Fund Data Panels (ETFs / Mutual Funds) */}
          {!scoreable && stock.fundData && (
            <FundDataPanels
              fundData={stock.fundData}
              ticker={stock.ticker}
              onHoldingsUpdate={(holdings, sectors, url) => {
                let sourceLabel = "Custom URL";
                try {
                  sourceLabel = new URL(url).hostname.replace(/^www\./, "");
                } catch {
                  /* fall through to default label */
                }
                updateFundData(stock.ticker, {
                  ...stock.fundData!,
                  topHoldings: holdings,
                  sectorWeightings: sectors,
                  holdingsUrl: url,
                  holdingsLastUpdated: new Date().toISOString(),
                  holdingsSource: sourceLabel,
                });
              }}
            />
          )}
        </div>

        {/* RIGHT */}
        <div className="flex min-w-0 flex-col gap-3.5">
          {scoreable && <StockSynthesisTile ticker={stock.ticker} />}
          {/* Thesis & kill conditions — pre-registered exit criteria, checked
              deterministically from data already on this page. */}
          {scoreable && (() => {
            const snap = getAnalystSnapshot(stock.ticker)?.factset;
            const revUp = typeof snap?.revUp === "number" ? snap.revUp : null;
            const revDown = typeof snap?.revDown === "number" ? snap.revDown : null;
            return (
              <ThesisTile
                ticker={stock.ticker}
                earningsDate={stock.healthData?.earningsDate ?? null}
                signals={{
                  score: typeof stock.adjusted === "number" ? stock.adjusted : null,
                  netRevisions: revUp != null || revDown != null ? (revUp ?? 0) - (revDown ?? 0) : null,
                  revUp,
                  revDown,
                  riskLevel: stock.riskAlert ? stock.riskAlert.level : stock.technicals ? null : undefined,
                  price: typeof stock.price === "number" ? stock.price : stock.healthData?.currentPrice ?? null,
                  ma200: stock.healthData?.twoHundredDayAvg ?? null,
                }}
              />
            );
          })()}
          {/* Street takeaways — the post-earnings street read. */}
          {scoreable && <StreetTakeawaysTile ticker={stock.ticker} />}

          {/* ── Risk & factors: three label/value reads, each with its full
              content one persisted click away (inside the sub-components). ── */}
          {((stock.riskAlert && stock.technicals) || stock.healthData || scoreable) && (
            <section className="panel">
              <div className="panel-h">
                <span className="t">Risk &amp; factors</span>
                <span className="m ml-auto">technicals · health · shadow model</span>
              </div>
              <div className="flex flex-col divide-y divide-line-soft">
                {stock.riskAlert && stock.technicals && (
                  <RiskAlertPanel riskAlert={stock.riskAlert} technicals={stock.technicals} className="px-3.5 py-3" />
                )}
                {stock.healthData && (
                  <StockHealthMonitor healthData={stock.healthData} technicals={stock.technicals} className="px-3.5 py-3" />
                )}
                {scoreable && (
                  <FactorLensTile ticker={stock.ticker} adjusted={stock.adjusted} className="px-3.5 py-3" />
                )}
              </div>
            </section>
          )}

          {/* Portfolio Role — only for equity ETFs/MFs */}
          {!scoreable && stock.instrumentType && stock.instrumentType !== "stock" && (() => {
            // Only show for equity-class ETFs/MFs (not bond/alternative funds)
            const nameLower = (stock.name || "").toLowerCase();
            const sectorLower = (stock.sector || "").toLowerCase();
            const isBondOrAlt = sectorLower.includes("bond") || sectorLower.includes("fixed") || nameLower.includes("bond") || nameLower.includes("fixed income")
              || sectorLower.includes("alternative") || nameLower.includes("alternative") || nameLower.includes("premium yield") || nameLower.includes("premium incom") || nameLower.includes("hedge") || nameLower.includes("option income") || nameLower.includes("option writing") || nameLower.includes("covered call");
            if (isBondOrAlt) return null;
            return (
              <CollapsibleSection
                prefKey="stock.portfolioRole"
                defaultCollapsed
                className="border-line"
                titleClass="text-[13px] font-semibold text-ink"
                title="Portfolio role"
              >
                <p className="mb-3 text-[11.5px] text-ink-3">Core = indexed/passive. Alpha = active picks. Sector exposure is based on Alpha picks only.</p>
                <div className="seg">
                  <button type="button" onClick={() => updateStockFields(ticker, { designation: "core" })} className={stock.designation === "core" ? "on" : ""}>
                    Core
                  </button>
                  <button type="button" onClick={() => updateStockFields(ticker, { designation: "alpha" })} className={(stock.designation || "alpha") === "alpha" ? "on" : ""}>
                    Alpha
                  </button>
                </div>
              </CollapsibleSection>
            );
          })()}

          {/* Model Eligibility & Per-Model Weights — FUNDS only here (weights +
              US-equity % live with the fund). For stocks the eligibility
              matrix lives on Portfolio › Models. */}
          {!scoreable && (
            <CollapsibleSection
              prefKey="stock.modelEligibility"
              defaultCollapsed
              className="border-line"
              titleClass="text-[13px] font-semibold text-ink"
              title="Model eligibility"
            >
              <p className="mb-3 text-[11.5px] text-ink-3">
                Toggle which PIM model groups this position is eligible for. Set the weight (%) for each model&apos;s Balanced profile.
              </p>

              {/* US equity exposure — drives SPY put hedge sizing. Funds/ETFs ONLY:
                  an individual stock's exposure follows its listing (US-listed is
                  US, Canadian-listed is Canadian), so it resolves without asking.
                  Only a fund can be ambiguous — XUH.TO is a Canadian listing that
                  is 100% US equity, and a Global mandate is genuinely partial. */}
              {(() => {
                const res = resolveUsEquityPct(ticker, stock);
                return (
                  <div className="mb-3.5 rounded-card border border-line bg-surface-2 p-3">
                    <label className="mb-1 block text-[11px] text-ink-3" htmlFor={`us-eq-${ticker}`}>
                      US equity exposure (%)
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        id={`us-eq-${ticker}`}
                        type="number"
                        step="1"
                        min="0"
                        max="100"
                        placeholder={res.source === "country" ? `auto: ${res.pct}` : "e.g. 65"}
                        defaultValue={stock.usEquityPct != null ? String(stock.usEquityPct) : ""}
                        onBlur={(e) => {
                          const raw = e.target.value.trim();
                          if (raw === "") {
                            if (stock.usEquityPct != null) {
                              updateStockFields(ticker, { usEquityPct: undefined });
                            }
                            return;
                          }
                          const n = Number(raw);
                          if (Number.isFinite(n) && n >= 0 && n <= 100) {
                            updateStockFields(ticker, { usEquityPct: n });
                          }
                        }}
                        className={`${INPUT} w-28 text-right font-mono`}
                      />
                      {res.source === "unresolved" ? (
                        <span className="inline-flex items-center gap-1.5 text-[11.5px] text-warn">
                          <span className="dot bg-warn" /> Needs a value
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-[11.5px] text-pos">
                          <span className="dot bg-pos" /> {res.pct}% {res.source === "manual" ? "(manual)" : "(auto)"}
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 text-[11px] text-ink-3">
                      {res.reason} Used to size SPY put hedges against the book&apos;s US equity notional. Leave blank to use the derived value.
                    </p>
                  </div>
                );
              })()}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {pimModels.groups.map((group) => {
                  const eligible = stock.modelEligibility?.[group.id] !== false;
                  const modelWeight = stock.modelWeights?.[group.id] ?? stock.weights.portfolio;
                  return (
                    <div key={group.id} className="rounded-card border border-line bg-surface">
                      <button
                        onClick={() => toggleModelEligibility(ticker, group.id, !eligible)}
                        className={`flex h-8 w-full items-center gap-2 px-2.5 text-left text-[12.5px] transition-colors ${eligible ? "text-ink" : "text-ink-3 hover:text-ink-2"}`}
                        aria-pressed={eligible}
                      >
                        <span className={`grid h-4 w-4 shrink-0 place-items-center rounded border transition-colors ${eligible ? "border-ink bg-ink text-white" : "border-line bg-surface"}`}>
                          {eligible && <AppIcon name="check" size={11} strokeWidth={3} />}
                        </span>
                        {group.name}
                      </button>
                      {/* Per-model weight input for funds/ETFs */}
                      {eligible && (
                        <ModelWeightInput
                          groupId={group.id}
                          modelWeight={modelWeight}
                          isOverride={stock.modelWeights?.[group.id] != null && stock.modelWeights[group.id] !== stock.weights.portfolio}
                          onCommit={(val) => updateModelWeight(ticker, group.id, val)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </CollapsibleSection>
          )}

          {/* Score History — append-only change log */}
          {scoreable && (
            <ScoreHistory
              ticker={stock.ticker}
              currentTotal={stock.adjusted}
              currentRaw={stock.raw}
            />
          )}
        </div>
      </div>
    </main>
  );
}
