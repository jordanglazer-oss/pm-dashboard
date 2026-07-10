"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { ResearchState, UptickEntry, IdeaEntry, RBCEntry, SectorViewEntry, SectorView, LeeFocusArea, AlphaPickEntry, FewEntry } from "@/app/lib/defaults";
import { defaultResearch, GICS_SECTORS } from "@/app/lib/defaults";
import { dedupeRbcEntries } from "@/app/lib/rbc-canonical";
import { applyResearchEntries } from "@/app/lib/research-merge";
import type { RemovalSource } from "@/app/lib/research-removals";
import { displayTicker } from "@/app/lib/ticker";
import { ImageUpload, type BriefAttachment } from "@/app/components/ImageUpload";
import { CollapsibleSection } from "@/app/components/CollapsibleSection";
import { useStocks } from "@/app/lib/StockContext";
import type { Stock, ScoreKey } from "@/app/lib/types";

/** Fire-and-forget: log tickers dropped from a research list to the
 *  append-only pm:research-removals store so the Dashboard Change Monitor
 *  surfaces them. Never blocks or throws into the caller. */
function postResearchRemovals(source: RemovalSource, tickers: string[]) {
  if (!tickers.length) return;
  void fetch("/api/kv/research-removals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ removals: tickers.map((ticker) => ({ ticker, source })) }),
  }).catch(() => {});
}

/** Parse a stored date string ("M/D/YYYY", ISO, etc.) to a timestamp for
 *  CHRONOLOGICAL sorting. Without this, date columns sort lexically by string
 *  ("1/…" < "10/…" < "2/…"), i.e. effectively by month digit rather than by
 *  actual date. Invalid/empty → 0 (sorts as oldest). */
function dateAddedMs(s: string | undefined): number {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Canonicalize an Uptick ticker for matching across the scrape and the
 * stored list: strip a leading $, convert dual-class "/" to "-", drop any
 * trailing exchange suffix after a "." or space, uppercase. Used by the
 * scrape-merge AND the dismissed-tombstone logic so "$BRK/B" from a
 * screenshot, "BRK-B" in the list, and "BRK.B" all collapse to one key.
 */
function normalizeUptickTicker(t: string): string {
  return t.replace(/^\$+/, "").replace(/\//g, "-").split(/[.\s]/)[0].toUpperCase();
}

/* ─── Uptick Add Form ─── */
function UptickAddForm({ onAdd }: { onAdd: (e: UptickEntry) => void }) {
  const [ticker, setTicker] = useState("");
  const [support, setSupport] = useState("");
  const [resistance, setResistance] = useState("");
  const [priceWhenAdded, setPriceWhenAdded] = useState("");
  const [adding, setAdding] = useState(false);

  return (
    <form
      className="flex flex-wrap gap-2 mt-3 items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        const t = ticker.trim().toUpperCase();
        if (!t) return;
        setAdding(true);
        let name = t;
        let sector = "—";
        try {
          const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(t)}`);
          if (res.ok) {
            const data = await res.json();
            if (data.names?.[t]) name = data.names[t];
            if (data.sectors?.[t]) sector = data.sectors[t];
          }
        } catch { /* fallback */ }
        onAdd({
          ticker: t,
          name,
          sector,
          price: 0,
          support: support.trim() || "—",
          resistance: resistance.trim() || "—",
          dateAdded: new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" }),
          priceWhenAdded: parseFloat(priceWhenAdded) || 0,
        });
        setTicker(""); setSupport(""); setResistance(""); setPriceWhenAdded("");
        setAdding(false);
      }}
    >
      <div>
        <label className="text-xs text-ink-3 block">Ticker*</label>
        <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="AMZN" className="w-20 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm font-mono outline-none placeholder:text-ink-3 focus:bg-white focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all" />
      </div>
      <div>
        <label className="text-xs text-ink-3 block">Support</label>
        <input value={support} onChange={(e) => setSupport(e.target.value)} placeholder="196, 161" className="w-24 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm outline-none placeholder:text-ink-3 focus:bg-white focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all" />
      </div>
      <div>
        <label className="text-xs text-ink-3 block">Resistance</label>
        <input value={resistance} onChange={(e) => setResistance(e.target.value)} placeholder="220, 249" className="w-24 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm outline-none placeholder:text-ink-3 focus:bg-white focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all" />
      </div>
      <div>
        <label className="text-xs text-ink-3 block">Price Added</label>
        <input value={priceWhenAdded} onChange={(e) => setPriceWhenAdded(e.target.value)} placeholder="161.26" type="number" step="0.01" className="w-24 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm outline-none placeholder:text-ink-3 focus:bg-white focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all" />
      </div>
      <button type="submit" disabled={adding} className="rounded-xl bg-accent px-5 py-2 text-sm font-semibold text-white hover:bg-accent transition-colors disabled:opacity-50">
        {adding ? "Adding..." : "Add"}
      </button>
    </form>
  );
}

/* ─── Idea Add Form ─── */
function IdeaAddForm({ onAdd }: { onAdd: (e: IdeaEntry) => void }) {
  const [ticker, setTicker] = useState("");
  const [price, setPrice] = useState("");

  return (
    <form
      className="flex gap-2 mt-3 items-end"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ticker.trim()) return;
        onAdd({ ticker: ticker.trim().toUpperCase(), priceWhenAdded: parseFloat(price) || 0 });
        setTicker(""); setPrice("");
      }}
    >
      <div>
        <label className="text-xs text-ink-3 block">Ticker*</label>
        <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="AAPL" className="w-24 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm font-mono outline-none placeholder:text-ink-3 focus:bg-white focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all" />
      </div>
      <div>
        <label className="text-xs text-ink-3 block">Price Added</label>
        <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="175.00" type="number" step="0.01" className="w-24 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm outline-none placeholder:text-ink-3 focus:bg-white focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all" />
      </div>
      <button type="submit" className="rounded-xl bg-accent px-5 py-2 text-sm font-semibold text-white hover:bg-accent transition-colors">
        Add
      </button>
    </form>
  );
}

/**
 * Manual-entry form for Seeking Alpha Alpha Picks. Mirrors
 * UptickAddForm: takes a ticker (required) + entry price, auto-fetches
 * name + sector via /api/company-name so the row lands fully populated.
 * Used as the manual fallback to the screenshot-driven primary flow.
 */
function AlphaPickAddForm({ onAdd }: { onAdd: (e: AlphaPickEntry) => void }) {
  const [ticker, setTicker] = useState("");
  const [priceWhenAdded, setPriceWhenAdded] = useState("");
  const [adding, setAdding] = useState(false);

  return (
    <form
      className="flex flex-wrap gap-2 mt-3 items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        const t = ticker.trim().toUpperCase();
        if (!t) return;
        setAdding(true);
        let name = t;
        let sector = "—";
        try {
          const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(t)}`);
          if (res.ok) {
            const data = await res.json();
            if (data.names?.[t]) name = data.names[t];
            if (data.sectors?.[t]) sector = data.sectors[t];
          }
        } catch { /* fallback */ }
        onAdd({
          ticker: t,
          name,
          sector,
          price: 0,
          priceWhenAdded: parseFloat(priceWhenAdded) || 0,
          dateAdded: new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" }),
        });
        setTicker(""); setPriceWhenAdded("");
        setAdding(false);
      }}
    >
      <div>
        <label className="text-xs text-ink-3 block">Ticker*</label>
        <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="AMZN" className="w-24 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm font-mono outline-none placeholder:text-ink-3 focus:bg-white focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all" />
      </div>
      <div>
        <label className="text-xs text-ink-3 block">Price Picked</label>
        <input value={priceWhenAdded} onChange={(e) => setPriceWhenAdded(e.target.value)} placeholder="215.40" type="number" step="0.01" className="w-28 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm outline-none placeholder:text-ink-3 focus:bg-white focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all" />
      </div>
      <button type="submit" disabled={adding} className="rounded-xl bg-accent px-5 py-2 text-sm font-semibold text-white hover:bg-accent transition-colors disabled:opacity-50">
        {adding ? "Adding..." : "Add"}
      </button>
    </form>
  );
}

/**
 * Inline screenshot-scan block used by the four non-Newton research
 * sources (Fundstrat Top/Bottom, RBC Canadian Focus, Alpha Picks).
 * Mirrors the upticks scanner's UI pattern: ImageUpload + Refresh +
 * Force re-scan + status line. The scrape itself is hash-gated per
 * source on the server, so refreshes with unchanged screenshots cost
 * zero Anthropic tokens.
 */
function ResearchScraperBlock(props: {
  source: "fundstrat-top" | "fundstrat-bottom" | "fundstrat-smid-top" | "fundstrat-smid-bottom" | "rbc-focus" | "rbc-us-focus" | "rbc-equate-cad" | "rbc-equate-usd" | "jpm-us-analyst-focus" | "seeking-alpha-picks" | "rbccm-few";
  sectionLabel: string;
  helperText: string;
  attachments: BriefAttachment[];
  onAddAttachment: (att: BriefAttachment) => Promise<void> | void;
  onRemoveAttachment: (id: string) => Promise<void> | void;
  onScrape: (force?: boolean) => Promise<boolean>;
  loading: boolean;
  status?: string;
}) {
  const hasAttachments = props.attachments.filter((a) => a.section === props.source).length > 0;
  return (
    <div className="mt-4 border-t border-line-soft pt-4">
      <div className="flex items-center gap-3 mb-2">
        <h4 className="text-sm font-bold text-ink-2">Screenshot Scanner</h4>
        <span className="text-[10px] text-ink-3">{props.helperText}</span>
      </div>
      <ImageUpload
        section={props.source}
        sectionLabel={props.sectionLabel}
        attachments={props.attachments}
        onAdd={props.onAddAttachment}
        onRemove={props.onRemoveAttachment}
      />
      <div className="flex items-center gap-3 mt-2">
        {props.status && (
          <p className="text-[10px] text-ink-3">{props.status}</p>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => { void props.onScrape(false); }}
            disabled={props.loading || !hasAttachments}
            className="text-[10px] rounded-md bg-accent-soft px-2.5 py-1 font-semibold text-accent hover:bg-accent-soft disabled:opacity-50 transition-colors"
            title="Re-run vision against the current screenshot. Cached if the image hasn't changed since last scan (no Anthropic cost)."
          >
            {props.loading ? "Scanning..." : "Refresh"}
          </button>
          <button
            onClick={() => { void props.onScrape(true); }}
            disabled={props.loading || !hasAttachments}
            className="text-[10px] rounded-md border border-line bg-white px-2 py-1 font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-50 transition-colors"
            title="Bypass the cache and re-run Anthropic vision. Use when the previous parse was incomplete."
          >
            Force re-scan
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── RBC Add Form ─── */
function RBCAddForm({ onAdd }: { onAdd: (e: RBCEntry) => void }) {
  const [ticker, setTicker] = useState("");
  const [adding, setAdding] = useState(false);

  return (
    <form
      className="flex gap-2 mt-3 items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        const t = ticker.trim().toUpperCase();
        if (!t) return;
        setAdding(true);
        let sector = "—";
        try {
          const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(t)}`);
          if (res.ok) {
            const data = await res.json();
            if (data.sectors?.[t]) sector = data.sectors[t];
          }
        } catch { /* fallback */ }
        onAdd({
          ticker: t,
          sector,
          weight: 0,
          dateAdded: new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" }),
        });
        setTicker("");
        setAdding(false);
      }}
    >
      <div>
        <label className="text-xs text-ink-3 block">Ticker*</label>
        <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="RY" className="w-24 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm font-mono outline-none placeholder:text-ink-3 focus:bg-white focus:border-accent-border focus:ring-1 focus:ring-accent-border transition-all" />
      </div>
      <button type="submit" disabled={adding} className="rounded-xl bg-accent px-5 py-2 text-sm font-semibold text-white hover:bg-accent transition-colors disabled:opacity-50">
        {adding ? "Adding..." : "Add"}
      </button>
    </form>
  );
}

/* ─── RBCCM FEW Add Form ─── */
function FewAddForm({ onAdd }: { onAdd: (e: FewEntry) => void }) {
  const [ticker, setTicker] = useState("");
  const [adding, setAdding] = useState(false);
  return (
    <form
      className="flex gap-2 mt-3 items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        let t = ticker.trim().toUpperCase();
        if (!t) return;
        // Canadian list — ensure a .TO suffix so prices/names resolve.
        if (!/\.(TO|NE)$/.test(t) && !/-T$/.test(t)) t = `${t}.TO`;
        setAdding(true);
        let name: string | undefined;
        let industry: string | undefined;
        try {
          const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(t)}`);
          if (res.ok) {
            const data = await res.json();
            if (data.names?.[t]) name = data.names[t];
            if (data.sectors?.[t]) industry = data.sectors[t];
          }
        } catch { /* fallback */ }
        onAdd({ ticker: t, name, industry });
        setTicker("");
        setAdding(false);
      }}
    >
      <div>
        <label className="text-xs text-ink-3 block">Ticker*</label>
        <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="RY" className="w-24 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm font-mono outline-none placeholder:text-ink-3 focus:bg-white focus:border-violet-soft focus:ring-1 focus:ring-violet-soft transition-all" />
      </div>
      <button type="submit" disabled={adding} className="rounded-xl bg-violet px-5 py-2 text-sm font-semibold text-white hover:bg-violet transition-colors disabled:opacity-50">
        {adding ? "Adding..." : "Add"}
      </button>
    </form>
  );
}

/* ─── Editable Cell ─── */
function EditableCell({
  value,
  onChange,
  className = "",
  type = "text",
}: {
  value: string | number;
  onChange: (v: string) => void;
  className?: string;
  type?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [temp, setTemp] = useState(String(value));

  if (editing) {
    return (
      <input
        autoFocus
        type={type}
        step={type === "number" ? "0.01" : undefined}
        value={temp}
        onChange={(e) => setTemp(e.target.value)}
        onBlur={() => { onChange(temp); setEditing(false); }}
        onKeyDown={(e) => { if (e.key === "Enter") { onChange(temp); setEditing(false); } if (e.key === "Escape") setEditing(false); }}
        className={`w-full bg-white border border-accent-border rounded-lg px-1 py-0.5 text-sm outline-none focus:ring-1 focus:ring-accent-border transition-all ${className}`}
      />
    );
  }

  return (
    <span
      onClick={() => { setTemp(String(value)); setEditing(true); }}
      className={`cursor-pointer hover:bg-accent-soft rounded px-1 py-0.5 transition-colors ${className}`}
      title="Click to edit"
    >
      {value || "—"}
    </span>
  );
}

type UptickSortKey = "ticker" | "name" | "sector" | "price" | "support" | "resistance" | "dateAdded" | "priceWhenAdded";
type IdeaSortKey = "ticker" | "priceWhenAdded" | "currentPrice";
type RBCSortKey = "ticker" | "name" | "sector" | "weight" | "dateAdded";
type JpmSortKey = "name" | "ticker" | "industry" | "strategy" | "currentPrice" | "priceTarget";
type EquateSortKey = "name" | "ticker" | "industry" | "currentPrice";
type FewSortKey = "ticker" | "name" | "industry" | "price";
type AlphaSortKey = "name" | "ticker" | "sector" | "rating" | "holdingWeight" | "currentPrice" | "priceWhenAdded" | "returnSinceAdded" | "dateAdded" | "days";
type SortDir = "asc" | "desc";

type LivePrices = Record<string, number | null>;

const ZERO_SCORES: Record<ScoreKey, number> = {
  brand: 0, secular: 0, researchCoverage: 0, marketEdge: 0,
  analystConsensus: 0, researchMentions: 0,
  charting: 0, relativeStrength: 0, aiRating: 0, growth: 0,
  relativeValuation: 0, historicalValuation: 0, leverageCoverage: 0,
  cashFlowQuality: 0, competitiveMoat: 0, turnaround: 0, catalysts: 0,
  trackRecord: 0, ownershipTrends: 0,
};

export default function ResearchPage() {
  const [state, setState] = useState<ResearchState>(defaultResearch);
  const [loaded, setLoaded] = useState(false);
  const [attachmentsSaveError, setAttachmentsSaveError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { scoredStocks, addStock, brief, uiPrefs, setUiPref, refreshResearchMentions, priceRefreshNonce } = useStocks();

  // Add a research idea to the watchlist (auto-fetches name + sector)
  const addToWatchlist = useCallback(async (ticker: string) => {
    if (scoredStocks.some((s) => s.ticker === ticker)) return false;
    let name = ticker;
    let sector = "Technology";
    try {
      const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(ticker)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.names?.[ticker]) name = data.names[ticker];
        if (data.sectors?.[ticker]) sector = data.sectors[ticker];
      }
    } catch { /* fallback */ }
    const stock: Stock = {
      ticker,
      name,
      bucket: "Watchlist",
      sector,
      beta: 1.0,
      weights: { portfolio: 0 },
      scores: { ...ZERO_SCORES },
      notes: "",
    };
    addStock(stock);
    return true;
  }, [scoredStocks, addStock]);
  // Per-table column sorts — all persisted via uiPrefs so the user's
  // choices survive refreshes AND sync across devices through pm:ui-prefs.
  // Same pattern as the Alpha Picks sort above; each table gets its own
  // uiPrefs keys so the seven sorts don't collide.
  const UPTICK_SORT_KEYS: ReadonlyArray<UptickSortKey> = ["ticker", "name", "sector", "price", "support", "resistance", "dateAdded", "priceWhenAdded"];
  const IDEA_SORT_KEYS: ReadonlyArray<IdeaSortKey> = ["ticker", "priceWhenAdded", "currentPrice"];
  const readSort = <K extends string>(keyPrefName: string, dirPrefName: string, allowed: ReadonlyArray<K>, defaultKey: K, defaultDir: SortDir): { key: K; dir: SortDir } => {
    const rawKey = uiPrefs[keyPrefName];
    const rawDir = uiPrefs[dirPrefName];
    return {
      key: (allowed.includes(rawKey as K) ? (rawKey as K) : defaultKey) as K,
      dir: (rawDir === "asc" || rawDir === "desc") ? (rawDir as SortDir) : defaultDir,
    };
  };
  const writeSort = (keyPrefName: string, dirPrefName: string, next: { key: string; dir: SortDir }) => {
    setUiPref(keyPrefName, next.key);
    setUiPref(dirPrefName, next.dir);
  };

  const uptickSort = readSort<UptickSortKey>("research.uptickSortKey", "research.uptickSortDir", UPTICK_SORT_KEYS, "ticker", "asc");
  const setUptickSort = (next: { key: UptickSortKey; dir: SortDir }) => writeSort("research.uptickSortKey", "research.uptickSortDir", next);
  const topSort = readSort<IdeaSortKey>("research.topSortKey", "research.topSortDir", IDEA_SORT_KEYS, "ticker", "asc");
  const setTopSort = (next: { key: IdeaSortKey; dir: SortDir }) => writeSort("research.topSortKey", "research.topSortDir", next);
  const bottomSort = readSort<IdeaSortKey>("research.bottomSortKey", "research.bottomSortDir", IDEA_SORT_KEYS, "ticker", "asc");
  const setBottomSort = (next: { key: IdeaSortKey; dir: SortDir }) => writeSort("research.bottomSortKey", "research.bottomSortDir", next);
  const smidTopSort = readSort<IdeaSortKey>("research.smidTopSortKey", "research.smidTopSortDir", IDEA_SORT_KEYS, "ticker", "asc");
  const setSmidTopSort = (next: { key: IdeaSortKey; dir: SortDir }) => writeSort("research.smidTopSortKey", "research.smidTopSortDir", next);
  const smidBottomSort = readSort<IdeaSortKey>("research.smidBottomSortKey", "research.smidBottomSortDir", IDEA_SORT_KEYS, "ticker", "asc");
  const setSmidBottomSort = (next: { key: IdeaSortKey; dir: SortDir }) => writeSort("research.smidBottomSortKey", "research.smidBottomSortDir", next);
  // Alpha Picks rating filter — null = show all, otherwise show only
  // picks whose rating matches (case-insensitive). Strong Buy / Buy /
  // Hold / Sell / Strong Sell, plus an "(unrated)" bucket for legacy
  // picks scraped before the rating field existed.
  const [alphaRatingFilter, setAlphaRatingFilter] = useState<string | null>(null);
  // Column sort for the Alpha Picks table — persisted via uiPrefs so the
  // user's choice survives refreshes AND syncs across devices via
  // pm:ui-prefs. Default: highest holding-weight first (SA's published
  // portfolio order). User can override and the choice sticks.
  const ALPHA_SORT_KEYS: ReadonlyArray<AlphaSortKey> = ["name", "ticker", "sector", "rating", "holdingWeight", "currentPrice", "priceWhenAdded", "returnSinceAdded", "dateAdded", "days"];
  const rawAlphaSortKey = uiPrefs["research.alphaSortKey"];
  const rawAlphaSortDir = uiPrefs["research.alphaSortDir"];
  const alphaSort = {
    key: (ALPHA_SORT_KEYS.includes(rawAlphaSortKey as AlphaSortKey)
      ? (rawAlphaSortKey as AlphaSortKey)
      : "holdingWeight") as AlphaSortKey,
    dir: (rawAlphaSortDir === "asc" ? "asc" : "desc") as SortDir,
  };
  const setAlphaSort = (next: { key: AlphaSortKey; dir: SortDir }) => {
    setUiPref("research.alphaSortKey", next.key);
    setUiPref("research.alphaSortDir", next.dir);
  };
  const RBC_SORT_KEYS: ReadonlyArray<RBCSortKey> = ["ticker", "name", "sector", "weight", "dateAdded"];
  const rbcSort = readSort<RBCSortKey>("research.rbcSortKey", "research.rbcSortDir", RBC_SORT_KEYS, "ticker", "asc");
  const setRbcSort = (next: { key: RBCSortKey; dir: SortDir }) => writeSort("research.rbcSortKey", "research.rbcSortDir", next);
  const rbcUsSort = readSort<RBCSortKey>("research.rbcUsSortKey", "research.rbcUsSortDir", RBC_SORT_KEYS, "ticker", "asc");
  const setRbcUsSort = (next: { key: RBCSortKey; dir: SortDir }) => writeSort("research.rbcUsSortKey", "research.rbcUsSortDir", next);
  const EQUATE_SORT_KEYS: ReadonlyArray<EquateSortKey> = ["name", "ticker", "industry", "currentPrice"];
  const equateCadSort = readSort<EquateSortKey>("research.equateCadSortKey", "research.equateCadSortDir", EQUATE_SORT_KEYS, "ticker", "asc");
  const setEquateCadSort = (next: { key: EquateSortKey; dir: SortDir }) => writeSort("research.equateCadSortKey", "research.equateCadSortDir", next);
  const equateUsdSort = readSort<EquateSortKey>("research.equateUsdSortKey", "research.equateUsdSortDir", EQUATE_SORT_KEYS, "ticker", "asc");
  const setEquateUsdSort = (next: { key: EquateSortKey; dir: SortDir }) => writeSort("research.equateUsdSortKey", "research.equateUsdSortDir", next);
  const JPM_SORT_KEYS: ReadonlyArray<JpmSortKey> = ["name", "ticker", "industry", "strategy", "currentPrice", "priceTarget"];
  const jpmFocusSort = readSort<JpmSortKey>("research.jpmFocusSortKey", "research.jpmFocusSortDir", JPM_SORT_KEYS, "ticker", "asc");
  const setJpmFocusSort = (next: { key: JpmSortKey; dir: SortDir }) => writeSort("research.jpmFocusSortKey", "research.jpmFocusSortDir", next);
  const FEW_SORT_KEYS: ReadonlyArray<FewSortKey> = ["ticker", "name", "industry", "price"];
  const fewSort = readSort<FewSortKey>("research.fewSortKey", "research.fewSortDir", FEW_SORT_KEYS, "ticker", "asc");
  const setFewSort = (next: { key: FewSortKey; dir: SortDir }) => writeSort("research.fewSortKey", "research.fewSortDir", next);

  // Live prices from Yahoo Finance
  const [livePrices, setLivePrices] = useState<LivePrices>({});
  const [pricesLoading, setPricesLoading] = useState(false);
  const [pricesFetchedAt, setPricesFetchedAt] = useState<string | null>(null);

  // Live FactSet prices for the JPM Focus List (ticker → price). The JPM card's
  // "Current price" column shows FactSet's live value rather than the Yahoo
  // livePrices map, per the requirement that it be FactSet-sourced.
  const [factsetPrices, setFactsetPrices] = useState<Record<string, number | null>>({});
  // GICS industry from FactSet, keyed by ticker — authoritative source for the
  // Industry column (the CORE 40 model-portfolio PDFs don't carry industry).
  // Broad GICS sector from FactSet (FG_GICS_SECTOR), keyed by ticker — the ~11
  // top-level sectors (Financials, Energy, …). Shown in the list "Sector" column
  // rather than the far more granular FG_GICS_INDUSTRY.
  const [factsetSectors, setFactsetSectors] = useState<Record<string, string | null>>({});
  const [factsetPricesLoading, setFactsetPricesLoading] = useState(false);

  const fetchFactsetPrices = useCallback(async (researchState?: ResearchState) => {
    const s = researchState || state;
    // JPM + both RBC Equate lists show a LIVE FactSet price column.
    const tickers = [...new Set([
      ...(s.jpmUsAnalystFocus ?? []).map((r) => r.ticker),
      ...(s.equateCad ?? []).map((r) => r.ticker),
      ...(s.equateUsd ?? []).map((r) => r.ticker),
    ])];
    if (tickers.length === 0) return;
    setFactsetPricesLoading(true);
    try {
      const res = await fetch("/api/factset-prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers }),
      });
      if (!res.ok) return;
      const data = await res.json();
      setFactsetPrices((prev) => ({ ...prev, ...(data.prices || {}) }));
      setFactsetSectors((prev) => ({ ...prev, ...(data.sectors || {}) }));
    } catch {
      // silently fail — column shows "—"
    } finally {
      setFactsetPricesLoading(false);
    }
  }, [state]);

  const fetchLivePrices = useCallback(async (researchState?: ResearchState) => {
    const s = researchState || state;
    const allTickers = [
      ...s.newtonUpticks.map((u) => u.ticker),
      ...s.fundstratTop.map((i) => i.ticker),
      ...s.fundstratBottom.map((i) => i.ticker),
      ...(s.fundstratSmidTop ?? []).map((i) => i.ticker),
      ...(s.fundstratSmidBottom ?? []).map((i) => i.ticker),
      ...(s.alphaPicks ?? []).map((i) => i.ticker),
      ...(s.rbccmFew ?? []).map((i) => i.ticker),
    ];
    const unique = [...new Set(allTickers)];
    if (unique.length === 0) return;

    setPricesLoading(true);
    try {
      const res = await fetch("/api/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers: unique }),
      });
      if (!res.ok) return;
      const data = await res.json();
      setLivePrices(data.prices || {});
      setPricesFetchedAt(data.fetchedAt || new Date().toISOString());
    } catch {
      // silently fail
    } finally {
      setPricesLoading(false);
    }
  }, [state]);

  const [namesLoading, setNamesLoading] = useState(false);
  const [scrapeLoading, setScrapeLoading] = useState(false);
  const [scrapeStatus, setScrapeStatus] = useState<string | null>(null);

  // Per-source loading + status state for the four research-scrape sources
  // (Fundstrat Top, Fundstrat Bottom, RBC Canadian Focus, Alpha Picks).
  // The Newton's Upticks scrape uses the older `scrapeLoading` /
  // `scrapeStatus` because its Refresh button does more than just scrape
  // (it also refreshes prices and names). The new sources are
  // scrape-only so a per-source map keeps each section's UI independent.
  type SourceKey = "fundstrat-top" | "fundstrat-bottom" | "fundstrat-smid-top" | "fundstrat-smid-bottom" | "rbc-focus" | "rbc-us-focus" | "rbc-equate-cad" | "rbc-equate-usd" | "jpm-us-analyst-focus" | "seeking-alpha-picks" | "rbccm-few";
  const [scrapeLoadingMap, setScrapeLoadingMap] = useState<Partial<Record<SourceKey, boolean>>>({});
  const [scrapeStatusMap, setScrapeStatusMap] = useState<Partial<Record<SourceKey, string>>>({});

  // Cross-source synthesis state. The synthesis tile at the top of the
  // page asks Claude to find the best buy targets across all five
  // research sources, weighted by cross-source overlap and the brief's
  // regime/horizon read. Hash-gated server-side so unchanged inputs
  // don't spend Anthropic tokens.
  type RegimeFitRating = "high" | "medium" | "low" | "contrary";
  type SynthesisPick = {
    ticker: string;
    sources: string[];
    sourceCount: number;
    thesis: string;
    regimeFit?: RegimeFitRating;
    regimeFitRationale?: string;
    /** 0-100 model conviction. Optional — saved synthesis blobs from
     *  before this field was added decode without errors. */
    conviction?: number;
  };
  type SynthesisResult = {
    summary: string;
    regimeTilts?: string[];
    topPicks: SynthesisPick[];
    /** Optional for backward compatibility — old persisted blobs in
     *  pm:research-synthesis predate this field. */
    regimeAlignedHighlights?: SynthesisPick[];
    honorableMentions: SynthesisPick[];
    cautions?: string[];
    regimeContext?: string;
  };
  const [synthesis, setSynthesis] = useState<SynthesisResult | null>(null);
  const [synthesisGeneratedAt, setSynthesisGeneratedAt] = useState<string | null>(null);
  const [synthesisLoading, setSynthesisLoading] = useState(false);
  const [synthesisStatus, setSynthesisStatus] = useState<string | null>(null);
  const [synthesisCached, setSynthesisCached] = useState(false);
  // Collapse state for the Cross-Source Synthesis section, persisted via
  // uiPrefs (Redis-backed) so it sticks across refreshes and devices —
  // same pattern as the ranking-table collapse keys.
  const synthesisCollapsed = uiPrefs["research.synthesisCollapsed"] === "1";
  // Per-source view: "rows" (compact mockup list, default) or "table" (the full
  // sortable + inline-editable table). Persisted in uiPrefs like the collapse keys.
  const newtonView = uiPrefs["research.newton.view"] || "rows";

  // Toggle handlers — read the current sort object directly (no functional
  // setState since these sorts are now derived from uiPrefs rather than
  // local React state). Behavior is identical: same column → flip dir;
  // different column → reset to ascending for that column.
  function toggleUptickSort(key: UptickSortKey) {
    setUptickSort(uptickSort.key === key ? { key, dir: uptickSort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }
  function toggleSmidTopSort(key: IdeaSortKey) {
    setSmidTopSort(smidTopSort.key === key ? { key, dir: smidTopSort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }
  function toggleSmidBottomSort(key: IdeaSortKey) {
    setSmidBottomSort(smidBottomSort.key === key ? { key, dir: smidBottomSort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }
  function toggleTopSort(key: IdeaSortKey) {
    setTopSort(topSort.key === key ? { key, dir: topSort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }
  function toggleBottomSort(key: IdeaSortKey) {
    setBottomSort(bottomSort.key === key ? { key, dir: bottomSort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }
  function toggleRbcSort(key: RBCSortKey) {
    setRbcSort(rbcSort.key === key ? { key, dir: rbcSort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }
  function toggleRbcUsSort(key: RBCSortKey) {
    setRbcUsSort(rbcUsSort.key === key ? { key, dir: rbcUsSort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }
  function toggleEquateCadSort(key: EquateSortKey) {
    setEquateCadSort(equateCadSort.key === key ? { key, dir: equateCadSort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }
  function toggleEquateUsdSort(key: EquateSortKey) {
    setEquateUsdSort(equateUsdSort.key === key ? { key, dir: equateUsdSort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }
  function toggleJpmFocusSort(key: JpmSortKey) {
    setJpmFocusSort(jpmFocusSort.key === key ? { key, dir: jpmFocusSort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }
  function toggleFewSort(key: FewSortKey) {
    setFewSort(fewSort.key === key ? { key, dir: fewSort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }

  function sortedUpticks() {
    return [...state.newtonUpticks].sort((a, b) => {
      const { key, dir } = uptickSort;
      let cmp = 0;
      if (key === "price") {
        cmp = (livePrices[a.ticker] || 0) - (livePrices[b.ticker] || 0);
      } else if (key === "priceWhenAdded") {
        cmp = (a.priceWhenAdded || 0) - (b.priceWhenAdded || 0);
      } else if (key === "dateAdded") {
        cmp = dateAddedMs(a.dateAdded) - dateAddedMs(b.dateAdded);
      } else {
        cmp = String(a[key] || "").localeCompare(String(b[key] || ""));
      }
      return dir === "asc" ? cmp : -cmp;
    });
  }

  function sortedIdeas(items: IdeaEntry[], sort: { key: IdeaSortKey; dir: SortDir }) {
    return [...items].sort((a, b) => {
      let cmp = 0;
      if (sort.key === "currentPrice") {
        cmp = (livePrices[a.ticker] || 0) - (livePrices[b.ticker] || 0);
      } else if (sort.key === "priceWhenAdded") {
        cmp = (a.priceWhenAdded || 0) - (b.priceWhenAdded || 0);
      } else {
        cmp = a.ticker.localeCompare(b.ticker);
      }
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }

  function compareRbc(a: RBCEntry, b: RBCEntry, key: RBCSortKey): number {
    if (key === "weight") return (a.weight ?? 0) - (b.weight ?? 0);
    if (key === "dateAdded") return dateAddedMs(a.dateAdded) - dateAddedMs(b.dateAdded);
    return String(a[key] || "").localeCompare(String(b[key] || ""));
  }
  function sortedRbc() {
    return [...(state.rbcCanadianFocus || [])].sort((a, b) => {
      const { key, dir } = rbcSort;
      const cmp = compareRbc(a, b, key);
      return dir === "asc" ? cmp : -cmp;
    });
  }
  function sortedRbcUs() {
    return [...(state.rbcUsFocus || [])].sort((a, b) => {
      const { key, dir } = rbcUsSort;
      const cmp = compareRbc(a, b, key);
      return dir === "asc" ? cmp : -cmp;
    });
  }
  function compareEquate(a: RBCEntry, b: RBCEntry, key: EquateSortKey): number {
    if (key === "currentPrice") return (factsetPrices[a.ticker] ?? 0) - (factsetPrices[b.ticker] ?? 0);
    if (key === "industry") return String(factsetSectors[a.ticker] || a.industry || "").localeCompare(String(factsetSectors[b.ticker] || b.industry || ""));
    return String(a[key] || "").localeCompare(String(b[key] || ""));
  }
  function sortedEquateCad() {
    return [...(state.equateCad || [])].sort((a, b) => {
      const { key, dir } = equateCadSort;
      const cmp = compareEquate(a, b, key);
      return dir === "asc" ? cmp : -cmp;
    });
  }
  function sortedEquateUsd() {
    return [...(state.equateUsd || [])].sort((a, b) => {
      const { key, dir } = equateUsdSort;
      const cmp = compareEquate(a, b, key);
      return dir === "asc" ? cmp : -cmp;
    });
  }
  function sortedJpmFocus() {
    return [...(state.jpmUsAnalystFocus || [])].sort((a, b) => {
      const { key, dir } = jpmFocusSort;
      let cmp = 0;
      if (key === "currentPrice") {
        cmp = (factsetPrices[a.ticker] ?? 0) - (factsetPrices[b.ticker] ?? 0);
      } else if (key === "priceTarget") {
        cmp = (a.priceTarget ?? 0) - (b.priceTarget ?? 0);
      } else if (key === "industry") {
        cmp = String(factsetSectors[a.ticker] || a.industry || "").localeCompare(String(factsetSectors[b.ticker] || b.industry || ""));
      } else {
        cmp = String(a[key] || "").localeCompare(String(b[key] || ""));
      }
      return dir === "asc" ? cmp : -cmp;
    });
  }

  // FEW price sort/display prefers the live Yahoo price, falling back to
  // the price captured from the screenshot.
  function fewPrice(e: FewEntry): number {
    const live = livePrices[e.ticker];
    if (typeof live === "number" && live > 0) return live;
    return e.price ?? 0;
  }
  function compareFew(a: FewEntry, b: FewEntry, key: FewSortKey): number {
    if (key === "price") return fewPrice(a) - fewPrice(b);
    if (key === "industry") return String(a.industry || "").localeCompare(String(b.industry || ""));
    if (key === "name") return String(a.name || "").localeCompare(String(b.name || ""));
    return String(a.ticker || "").localeCompare(String(b.ticker || ""));
  }
  function sortedFew() {
    return [...(state.rbccmFew || [])].sort((a, b) => {
      const { key, dir } = fewSort;
      const cmp = compareFew(a, b, key);
      return dir === "asc" ? cmp : -cmp;
    });
  }

  const uArrow = (key: UptickSortKey) => uptickSort.key === key ? (uptickSort.dir === "asc" ? " ▲" : " ▼") : "";
  const tArrow = (key: IdeaSortKey) => topSort.key === key ? (topSort.dir === "asc" ? " ▲" : " ▼") : "";
  const bArrow = (key: IdeaSortKey) => bottomSort.key === key ? (bottomSort.dir === "asc" ? " ▲" : " ▼") : "";
  const stArrow = (key: IdeaSortKey) => smidTopSort.key === key ? (smidTopSort.dir === "asc" ? " ▲" : " ▼") : "";
  const sbArrow = (key: IdeaSortKey) => smidBottomSort.key === key ? (smidBottomSort.dir === "asc" ? " ▲" : " ▼") : "";
  const rArrow = (key: RBCSortKey) => rbcSort.key === key ? (rbcSort.dir === "asc" ? " ▲" : " ▼") : "";
  const rUsArrow = (key: RBCSortKey) => rbcUsSort.key === key ? (rbcUsSort.dir === "asc" ? " ▲" : " ▼") : "";
  const ecArrow = (key: EquateSortKey) => equateCadSort.key === key ? (equateCadSort.dir === "asc" ? " ▲" : " ▼") : "";
  const euArrow = (key: EquateSortKey) => equateUsdSort.key === key ? (equateUsdSort.dir === "asc" ? " ▲" : " ▼") : "";
  const jArrow = (key: JpmSortKey) => jpmFocusSort.key === key ? (jpmFocusSort.dir === "asc" ? " ▲" : " ▼") : "";
  const fArrow = (key: FewSortKey) => fewSort.key === key ? (fewSort.dir === "asc" ? " ▲" : " ▼") : "";

  useEffect(() => {
    fetch("/api/kv/research", { cache: "no-store" })
      .then((r) => r.json())
      .then(async (data) => {
        if (data.research) {
          let research = data.research as ResearchState;

          // Hydrate attachment dataUrls from per-image Redis keys. Legacy
          // entries that still carry an inline dataUrl are migrated into
          // the /[id] store on first load so the research blob stays lean.
          if (research.attachments && research.attachments.length > 0) {
            const hydrated = await Promise.all(
              research.attachments.map(async (a) => {
                if (a.dataUrl) {
                  // Legacy: migrate inline dataUrl into its own key.
                  try {
                    await fetch(`/api/kv/attachments/${a.id}`, {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ dataUrl: a.dataUrl }),
                    });
                  } catch { /* best-effort */ }
                  return a;
                }
                try {
                  const res = await fetch(`/api/kv/attachments/${a.id}`);
                  if (!res.ok) return null;
                  const imgData = await res.json();
                  return imgData.dataUrl ? { ...a, dataUrl: imgData.dataUrl } : null;
                } catch {
                  return null;
                }
              })
            );
            research = {
              ...research,
              attachments: hydrated.filter((x): x is BriefAttachment => x !== null),
            };
          }

          // Migrate older pm:research blobs where alphaPicks was
          // persisted as IdeaEntry[] (just ticker + priceWhenAdded).
          // The Newton's Upticks-aligned shape adds name + sector +
          // dateAdded + price; fill defaults so the table renders
          // without throwing on missing fields.
          //
          // CRITICAL: spread `partial` first so ALL existing fields
          // (rating, holdingWeight, returnSinceAdded, manualSell, etc)
          // pass through. The previous shape of this migration listed
          // each field explicitly and dropped anything not enumerated —
          // which meant every page load silently wiped Rating, Holding %,
          // and SA Return on every Alpha Pick, requiring a fresh scrape
          // to restore them. The spread + per-field defaults keep both
          // properties: legacy blobs get safe defaults, new blobs retain
          // every field.
          if (research.alphaPicks && research.alphaPicks.length > 0) {
            research = {
              ...research,
              alphaPicks: research.alphaPicks.map((p): AlphaPickEntry => {
                const partial = p as Partial<AlphaPickEntry> & IdeaEntry;
                return {
                  ...partial,
                  ticker: partial.ticker,
                  name: partial.name ?? partial.ticker,
                  sector: partial.sector ?? "—",
                  price: typeof partial.price === "number" ? partial.price : 0,
                  priceWhenAdded: partial.priceWhenAdded ?? 0,
                  dateAdded: partial.dateAdded ?? "",
                };
              }),
            };
          }

          setState(research);
          fetchLivePrices(research);
          void fetchFactsetPrices(research);

          // Backfill missing names/sectors for existing uptick entries
          const needsBackfill = research.newtonUpticks.filter(
            (u) => !u.name || u.name === u.ticker || !u.sector || u.sector === "—"
          );
          if (needsBackfill.length > 0) {
            try {
              const tickers = needsBackfill.map((u) => u.ticker).join(",");
              const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(tickers)}`);
              if (res.ok) {
                const info = await res.json();
                let changed = false;
                const updated = research.newtonUpticks.map((u) => {
                  const newName = info.names?.[u.ticker];
                  const newSector = info.sectors?.[u.ticker];
                  const shouldUpdateName = newName && (!u.name || u.name === u.ticker);
                  const shouldUpdateSector = newSector && (!u.sector || u.sector === "—");
                  if (shouldUpdateName || shouldUpdateSector) {
                    changed = true;
                    return {
                      ...u,
                      ...(shouldUpdateName ? { name: newName } : {}),
                      ...(shouldUpdateSector ? { sector: newSector } : {}),
                    };
                  }
                  return u;
                });
                if (changed) {
                  research = { ...research, newtonUpticks: updated };
                  setState(research);
                  // Persist the backfilled data
                  fetch("/api/kv/research", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ research }),
                  }).catch(() => {});
                }
              }
            } catch { /* best-effort */ }
          }

          // Same backfill for Alpha Picks: any rows persisted before
          // the upticks-shape upgrade, or scraped under the older flow,
          // arrive with name = ticker and sector = "—". Pull names +
          // sectors via Yahoo and persist if anything changed.
          const alphaPicksNeedFill = (research.alphaPicks ?? []).filter(
            (p) => !p.name || p.name === p.ticker || !p.sector || p.sector === "—"
          );
          if (alphaPicksNeedFill.length > 0) {
            try {
              const tickers = alphaPicksNeedFill.map((p) => p.ticker).join(",");
              const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(tickers)}`);
              if (res.ok) {
                const info = await res.json();
                let changed = false;
                const updated = (research.alphaPicks ?? []).map((p) => {
                  const newName = info.names?.[p.ticker];
                  const newSector = info.sectors?.[p.ticker];
                  const shouldUpdateName = newName && (!p.name || p.name === p.ticker);
                  const shouldUpdateSector = newSector && (!p.sector || p.sector === "—");
                  if (shouldUpdateName || shouldUpdateSector) {
                    changed = true;
                    return {
                      ...p,
                      ...(shouldUpdateName ? { name: newName } : {}),
                      ...(shouldUpdateSector ? { sector: newSector } : {}),
                    };
                  }
                  return p;
                });
                if (changed) {
                  research = { ...research, alphaPicks: updated };
                  setState(research);
                  fetch("/api/kv/research", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ research }),
                  }).catch(() => {});
                }
              }
            } catch { /* best-effort */ }
          }

          // RBC Canadian Focus: canonicalize every ticker to Yahoo
          // ".TO" form AND dedupe duplicates that arose from RBC's
          // multiple ticker conventions for the same security
          // (e.g. BBD-B.TO vs BBD.B-T → both = Bombardier Class B,
          // BIP-UN.TO vs BIP.UN-T → both = Brookfield Infra). Names
          // looked up under malformed tickers (which Yahoo fuzzy-
          // matched to wrong companies — BBD.B-T → "Banco Bradesco
          // SA") are cleared so the next refreshRbcNames pass
          // re-fetches under the canonical ticker.
          {
            const canadian = research.rbcCanadianFocus || [];
            if (canadian.length > 0) {
              const { entries: deduped, changed } = dedupeRbcEntries(canadian);
              if (changed) {
                research = { ...research, rbcCanadianFocus: deduped };
                setState(research);
                fetch("/api/kv/research", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ research }),
                }).catch(() => {});
              }
            }
          }

          // Backfill missing names for both RBC lists + the JPM list.
          for (const listKey of ["rbcCanadianFocus", "rbcUsFocus", "jpmUsAnalystFocus", "equateCad", "equateUsd"] as const) {
            const list = (research[listKey] || []) as RBCEntry[];
            const needsFill = list.filter((r) => !r.name || r.name === r.ticker || !r.sector || r.sector === "—");
            if (needsFill.length === 0) continue;
            try {
              const tickers = needsFill.map((r) => r.ticker).join(",");
              const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(tickers)}`);
              if (!res.ok) continue;
              const info = await res.json();
              let changed = false;
              const updated = list.map((r) => {
                const newName = info.names?.[r.ticker];
                const newSector = info.sectors?.[r.ticker];
                const shouldUpdateName = newName && (!r.name || r.name === r.ticker);
                const shouldUpdateSector = newSector && (!r.sector || r.sector === "—");
                if (shouldUpdateName || shouldUpdateSector) {
                  changed = true;
                  return {
                    ...r,
                    ...(shouldUpdateName ? { name: newName } : {}),
                    ...(shouldUpdateSector ? { sector: newSector } : {}),
                  };
                }
                return r;
              });
              if (changed) {
                research = { ...research, [listKey]: updated } as ResearchState;
                setState(research);
                fetch("/api/kv/research", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ research }),
                }).catch(() => {});
              }
            } catch { /* best-effort */ }
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Holds the most recent state we want to persist. `save()` updates this
  // on every call, and the unload handler (below) reads it synchronously
  // to flush any in-flight debounced save before the tab closes / refreshes.
  // Without this, a quick refresh after a user action could drop the save
  // since the debounce hadn't fired yet.
  const pendingSaveRef = useRef<ResearchState | null>(null);

  // Build the wire-shape state (strips inline dataUrls from attachments) and
  // POST it. Used by both the debounced save and the unload-flush path.
  const sendResearchSave = useCallback((next: ResearchState, useBeacon = false): Promise<void> => {
    const serializable: ResearchState = {
      ...next,
      attachments: (next.attachments || []).map((a) => ({
        id: a.id,
        label: a.label,
        section: a.section,
        addedAt: a.addedAt,
        dataUrl: "", // placeholder; not read client-side
      })),
    };
    const body = JSON.stringify({ research: serializable });
    if (useBeacon && typeof navigator !== "undefined" && "sendBeacon" in navigator) {
      // beforeunload fires synchronously; fetch() can't reliably complete
      // before the tab is torn down. navigator.sendBeacon is designed for
      // exactly this case — fire-and-forget POST that survives the unload.
      try {
        const blob = new Blob([body], { type: "application/json" });
        navigator.sendBeacon("/api/kv/research", blob);
        return Promise.resolve();
      } catch {
        // Fall through to fetch on beacon failure (unlikely).
      }
    }
    // Return the promise so callers can await the PUT before triggering a
    // researchMentions recompute — the tally reads pm:research, so it must
    // run AFTER this write lands or it reads the pre-edit state.
    return fetch("/api/kv/research", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    })
      .then(() => {})
      .catch((e) => console.error("Failed to save research:", e));
  }, []);

  const save = useCallback((next: ResearchState) => {
    setState(next);
    pendingSaveRef.current = next;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // 300ms debounce (was 800ms) — short enough that the user almost never
    // hits "refresh before save" in practice, long enough to coalesce
    // rapid-fire updates (e.g. scrape → name backfill → price backfill all
    // queuing saves within ~200ms of each other). The unload handler below
    // catches the rare case where the user refreshes inside the window.
    saveTimer.current = setTimeout(async () => {
      pendingSaveRef.current = null;
      // Await the PUT so pm:research is persisted BEFORE the recompute reads
      // it — otherwise the tally races the write and reads the pre-edit
      // state. Recompute researchMentions on EVERY research change (manual
      // add/remove of a list entry, not just scrapes). The recompute is a
      // cheap deterministic Redis read; the only-when-changed guard in
      // refreshResearchMentions means it persists/re-renders only when a
      // score actually moved. This makes researchMentions update on edit
      // the way SIA/BoostedAI do, from the PM's point of view.
      await sendResearchSave(next);
      void refreshResearchMentions();
    }, 300);
  }, [sendResearchSave, refreshResearchMentions]);

  // Flush any pending debounced save on page unload (refresh, close, nav
  // away). Uses sendBeacon so the POST survives the tab teardown — fetch()
  // would be cancelled mid-flight. This is the safety net that makes the
  // debounce shorter without risking lost data on quick refreshes.
  useEffect(() => {
    const onBeforeUnload = () => {
      const pending = pendingSaveRef.current;
      if (!pending) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      pendingSaveRef.current = null;
      sendResearchSave(pending, /*useBeacon=*/true);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [sendResearchSave]);

  const refreshUptickNames = useCallback(async () => {
    if (state.newtonUpticks.length === 0) return;
    setNamesLoading(true);
    try {
      const tickers = state.newtonUpticks.map((u) => u.ticker).join(",");
      const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(tickers)}`);
      if (res.ok) {
        const info = await res.json();
        let changed = false;
        const updated = state.newtonUpticks.map((u) => {
          const newName = info.names?.[u.ticker];
          const newSector = info.sectors?.[u.ticker];
          if ((newName && newName !== u.name) || (newSector && newSector !== u.sector)) {
            changed = true;
            return { ...u, name: newName || u.name, sector: newSector || u.sector };
          }
          return u;
        });
        if (changed) {
          save({ ...state, newtonUpticks: updated });
        }
      }
    } catch { /* silent */ }
    finally { setNamesLoading(false); }
  }, [state, save]);

  /**
   * Mirror of refreshUptickNames for the Alpha Picks list. Pulls
   * company names + sectors via /api/company-name in one batch and
   * updates any rows whose name/sector are blank, "—", or just the
   * ticker placeholder. Called automatically after a successful
   * Alpha Picks scrape so newly added tickers land fully populated.
   */
  const refreshAlphaPickNames = useCallback(async (overrideState?: ResearchState) => {
    const s = overrideState || state;
    const list = s.alphaPicks ?? [];
    if (list.length === 0) return;
    const needsFill = list.filter((p) => !p.name || p.name === p.ticker || !p.sector || p.sector === "—");
    if (needsFill.length === 0) return;
    try {
      const tickers = needsFill.map((p) => p.ticker).join(",");
      const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(tickers)}`);
      if (!res.ok) return;
      const info = await res.json();
      let changed = false;
      const updated = list.map((p) => {
        const newName = info.names?.[p.ticker];
        const newSector = info.sectors?.[p.ticker];
        if ((newName && newName !== p.name) || (newSector && newSector !== p.sector)) {
          changed = true;
          return { ...p, name: newName || p.name, sector: newSector || p.sector };
        }
        return p;
      });
      if (changed) {
        save({ ...s, alphaPicks: updated });
      }
    } catch { /* silent */ }
  }, [state, save]);

  /**
   * One-time bootstrap of priceWhenAdded for Alpha Picks entries.
   *
   * The picked price is HISTORICAL — once known, it doesn't change.
   * Seeking Alpha doesn't expose the original entry price directly,
   * but we can derive it from the current price + their reported
   * return %:
   *   priceWhenAdded = currentPrice / (1 + returnSinceAdded / 100)
   *
   * This effect runs whenever livePrices update. For each Alpha Pick
   * with returnSinceAdded set but priceWhenAdded still 0, it computes
   * the historical price ONCE and persists it. After that the entry
   * has a real priceWhenAdded that stays fixed across renders and
   * even across re-scrapes (the merge intentionally preserves it).
   *
   * Without this, a render-time derivation against a moving live
   * price would cause the displayed Price Picked to drift slightly
   * every refresh — which is wrong for what's supposed to be a
   * historical entry price.
   */
  useEffect(() => {
    if (!loaded) return;
    const picks = state.alphaPicks ?? [];
    if (picks.length === 0) return;
    let changed = false;
    const updated = picks.map((p) => {
      if (p.priceWhenAdded > 0) return p; // already bootstrapped
      if (p.returnSinceAdded == null) return p; // can't derive
      const live = livePrices[p.ticker];
      if (live == null) return p; // no current price yet
      const factor = 1 + p.returnSinceAdded / 100;
      if (factor === 0) return p; // -100% return = total loss; can't divide
      changed = true;
      return { ...p, priceWhenAdded: live / factor };
    });
    if (changed) save({ ...state, alphaPicks: updated });
  }, [loaded, state, livePrices, save]);

  /**
   * Refresh company names + sectors for both RBC focus lists in a
   * single batched call. Targets entries whose name is missing or
   * placeholder, OR whose sector isn't a recognized GICS sector
   * (RBC reports use labels like "Financials & Real Estate" /
   * "Consumer Cyclical" that don't match the GICS form used
   * elsewhere in the app — Yahoo returns the canonical GICS sector
   * which we want to standardize on).
   */
  const refreshRbcNames = useCallback(async (list: "rbcCanadianFocus" | "rbcUsFocus" | "jpmUsAnalystFocus" | "equateCad" | "equateUsd", overrideState?: ResearchState) => {
    const s = overrideState || state;
    const entries = (s[list] || []) as RBCEntry[];
    if (entries.length === 0) return;
    const gicsSet = new Set<string>(GICS_SECTORS);
    const needsFill = entries.filter(
      (r) => !r.name || r.name === r.ticker || !r.sector || r.sector === "—" || !gicsSet.has(r.sector)
    );
    if (needsFill.length === 0) return;
    try {
      const tickers = needsFill.map((r) => r.ticker).join(",");
      const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(tickers)}`);
      if (!res.ok) return;
      const info = await res.json();
      let changed = false;
      const updated = entries.map((r) => {
        const newName = info.names?.[r.ticker];
        const newSector = info.sectors?.[r.ticker];
        // Always overwrite when Yahoo returns a value — this normalizes
        // RBC sector labels to the GICS form used elsewhere in the app.
        if (newName || newSector) {
          if ((newName && newName !== r.name) || (newSector && newSector !== r.sector)) {
            changed = true;
            return { ...r, name: newName || r.name, sector: newSector || r.sector };
          }
        }
        return r;
      });
      if (changed) {
        save({ ...s, [list]: updated } as ResearchState);
      }
    } catch { /* silent */ }
  }, [state, save]);

  // Consolidated refresh: when the nav "Refresh prices" button runs
  // (refreshAllPrices bumps priceRefreshNonce), re-pull the Research tab's own
  // live prices + FactSet prices + name backfills — so ONE refresh button in the
  // menu covers research-tab stocks too, instead of a separate research refresh.
  const priceNonceSeen = useRef(0);
  useEffect(() => {
    if (priceRefreshNonce === priceNonceSeen.current) return;
    priceNonceSeen.current = priceRefreshNonce;
    if (priceRefreshNonce === 0) return; // initial mount, nothing to refresh
    void fetchLivePrices();
    void fetchFactsetPrices();
    void refreshUptickNames();
    (["rbcCanadianFocus", "rbcUsFocus", "jpmUsAnalystFocus", "equateCad", "equateUsd"] as const).forEach((l) => void refreshRbcNames(l));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceRefreshNonce]);

  /** Backfill missing company names for the RBCCM FEW list. The screenshot
   *  usually supplies the company + industry; this only fills the name for
   *  rows that arrived without one (e.g. manual ticker-only adds). Industry
   *  is left as-scraped (Yahoo exposes GICS sector, not the finer industry
   *  label the FEW report uses). */
  const refreshFewNames = useCallback(async (overrideState?: ResearchState) => {
    const s = overrideState || state;
    const entries = s.rbccmFew || [];
    if (entries.length === 0) return;
    const needsFill = entries.filter((r) => !r.name || r.name === r.ticker);
    if (needsFill.length === 0) return;
    try {
      const tickers = needsFill.map((r) => r.ticker).join(",");
      const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(tickers)}`);
      if (!res.ok) return;
      const info = await res.json();
      let changed = false;
      const updated = entries.map((r) => {
        const newName = info.names?.[r.ticker];
        if (newName && newName !== r.name) {
          changed = true;
          return { ...r, name: newName };
        }
        return r;
      });
      if (changed) save({ ...s, rbccmFew: updated });
    } catch { /* silent */ }
  }, [state, save]);

  /**
   * Scrape uptick screenshot(s) via Anthropic vision, merge parsed rows into
   * state.newtonUpticks. Mirrors the JPM-flows caching pattern: the server
   * side fingerprints the image(s) and only spends tokens when the fingerprint
   * changes. A "Refresh" with unchanged images is free.
   *
   * Merge rules:
   *   - Existing ticker → overwrite only support/resistance/priceWhenAdded/
   *     dateAdded. Preserve name/sector/price (those come from Yahoo).
   *   - New ticker      → append with empty name/sector; the next
   *     refreshUptickNames backfill will populate them.
   */
  const [lastScrape, setLastScrape] = useState<Array<{ ticker: string; support?: string; resistance?: string; priceWhenAdded?: number; dateAdded?: string }>>([]);

  const scrapeUpticks = useCallback(async (force = false): Promise<{ merged: ResearchState; changed: boolean } | null> => {
    const upticksAttachments = (state.attachments || []).filter((a) => a.section === "upticks");
    if (upticksAttachments.length === 0) return null;
    setScrapeLoading(true);
    try {
      const res = await fetch("/api/upticks-scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          force,
          attachments: upticksAttachments.map((a) => ({ id: a.id, label: a.label, dataUrl: a.dataUrl })),
        }),
      });
      if (!res.ok) { setScrapeStatus("Screenshot scan failed"); return null; }
      const data = await res.json() as { entries?: Array<{ ticker: string; support?: string; resistance?: string; priceWhenAdded?: number; dateAdded?: string }>; cached?: boolean };
      const entries = data.entries || [];
      setLastScrape(entries);
      if (entries.length === 0) {
        setScrapeStatus(data.cached ? "No rows in cached scan — click Force re-scan to retry" : "Vision found no rows — try Force re-scan or a clearer screenshot");
        return null;
      }

      // Normalize tickers for matching — strip $ prefix, map / → - (Newton
      // writes dual-class shares as "BRK/B" but Yahoo uses "BRK-B"), and
      // drop any trailing exchange suffix. Ensures "$BRK/B" from a
      // screenshot matches "BRK-B" in the stored list.
      const existingByNorm = new Map(state.newtonUpticks.map((u) => [normalizeUptickTicker(u.ticker), u]));
      // Tombstones — tickers the PM removed with the X. The scrape must
      // never re-add these (they're usually OCR/vision hallucinations the
      // PM deliberately deleted). Manually re-adding clears the tombstone.
      const dismissed = new Set((state.dismissedUpticks ?? []).map(normalizeUptickTicker));

      // REPLACE mode: a screenshot is a full snapshot of the current Upticks
      // list, so tickers no longer in it are removed. Safety guard (mirrors
      // research-merge.ts SAFETY_THRESHOLD): if the new screenshot has fewer
      // than 30% of the existing rows — a partial or failed scan — fall back
      // to ADDITIVE so we never wipe the list. Matched rows keep their
      // backfilled metadata; tombstoned tickers are never re-added.
      const replaceMode =
        state.newtonUpticks.length === 0 ||
        entries.length / state.newtonUpticks.length >= 0.3;
      const today = new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });

      const merged = new Map<string, UptickEntry>();
      if (!replaceMode) {
        for (const u of state.newtonUpticks) merged.set(normalizeUptickTicker(u.ticker), u);
      }
      let matched = 0;
      let updatedFields = 0;
      let added = 0;
      let skippedDismissed = 0;
      for (const e of entries) {
        const norm = normalizeUptickTicker(e.ticker);
        const existing = existingByNorm.get(norm);
        if (existing) {
          matched += 1;
          const next: UptickEntry = {
            ...existing,
            support: e.support ?? existing.support,
            resistance: e.resistance ?? existing.resistance,
            priceWhenAdded: e.priceWhenAdded ?? existing.priceWhenAdded,
            dateAdded: e.dateAdded ?? existing.dateAdded,
          };
          merged.set(norm, next);
          if (JSON.stringify(next) !== JSON.stringify(existing)) updatedFields += 1;
        } else if (dismissed.has(norm)) {
          skippedDismissed += 1;
        } else {
          added += 1;
          merged.set(norm, {
            ticker: norm,
            name: norm,
            sector: "—",
            price: 0,
            support: e.support ?? "",
            resistance: e.resistance ?? "",
            dateAdded: e.dateAdded ?? today,
            priceWhenAdded: e.priceWhenAdded ?? 0,
          });
        }
      }
      // Tickers present in the old list but absent from the screenshot — only
      // removed in replace mode. Captured for the Change Monitor (item C).
      const newNorms = new Set(entries.map((e) => normalizeUptickTicker(e.ticker)));
      const removedEntries = replaceMode
        ? state.newtonUpticks.filter((u) => !newNorms.has(normalizeUptickTicker(u.ticker)))
        : [];
      const removed = removedEntries.length;
      const changed = added > 0 || updatedFields > 0 || removed > 0;

      const cachedLabel = data.cached ? " (cached)" : "";
      const modeLabel = replaceMode ? "" : " · additive (partial screenshot — nothing removed)";
      const removedLabel = removed > 0 ? ` · ${removed} removed` : "";
      const dismissedLabel = skippedDismissed > 0 ? ` · ${skippedDismissed} skipped (tombstoned)` : "";
      setScrapeStatus(
        `${entries.length} rows in screenshot${cachedLabel} · ${matched} matched · ${added} added${removedLabel}${dismissedLabel}${modeLabel}`,
      );
      if (!changed) return { merged: state, changed: false };
      const nextState: ResearchState = { ...state, newtonUpticks: Array.from(merged.values()) };
      save(nextState);
      postResearchRemovals("newton-upticks", removedEntries.map((u) => u.ticker));
      return { merged: nextState, changed: true };
    } catch (e) {
      console.error("Uptick scrape failed:", e);
      setScrapeStatus("Screenshot scan failed");
      return null;
    } finally {
      setScrapeLoading(false);
      // researchMentions recompute is now handled by save() — it fires the
      // recompute AFTER the pm:research PUT lands, so it reads the freshly
      // merged list rather than racing the write. (Previously this finally
      // block called refreshResearchMentions directly, which could read
      // pm:research before save's debounced PUT completed.)
    }
  }, [state, save]);

  /**
   * Scrape one of the four research sources beyond Newton's Upticks.
   * POSTs the source-specific attachments to /api/research-scrape; the
   * route hash-gates on image fingerprint per-source, so refreshes with
   * unchanged screenshots cost zero Anthropic tokens.
   *
   * Merge rules:
   *   - fundstrat-top / fundstrat-bottom / seeking-alpha-picks → upsert
   *     IdeaEntry by ticker. Existing entries keep their dateAdded if any.
   *   - rbc-focus → upsert RBCEntry by ticker. Sector / weight / dateAdded
   *     overwrite when the screenshot provides them; entries with no
   *     screenshot match are preserved as-is.
   *
   * Force=true bypasses the cache to re-run vision (use when the previous
   * parse missed fields or returned [] on a complex screenshot).
   */
  const scrapeResearchSource = useCallback(async (source: SourceKey, force = false): Promise<boolean> => {
    const sourceAttachments = (state.attachments || []).filter((a) => a.section === source);
    if (sourceAttachments.length === 0) {
      setScrapeStatusMap((m) => ({ ...m, [source]: "No screenshot uploaded for this source yet" }));
      return false;
    }
    setScrapeLoadingMap((m) => ({ ...m, [source]: true }));
    setScrapeStatusMap((m) => ({ ...m, [source]: undefined }));
    try {
      const res = await fetch("/api/research-scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source,
          force,
          attachments: sourceAttachments.map((a) => ({ id: a.id, label: a.label, dataUrl: a.dataUrl })),
        }),
      });
      if (!res.ok) {
        setScrapeStatusMap((m) => ({ ...m, [source]: "Screenshot scan failed" }));
        return false;
      }
      const data = await res.json() as {
        source: SourceKey;
        entries?: Array<{ ticker: string; priceWhenAdded?: number; sector?: string; weight?: number; dateAdded?: string; name?: string; industry?: string; price?: number }>;
        cached?: boolean;
      };
      const entries = data.entries || [];

      if (entries.length === 0) {
        setScrapeStatusMap((m) => ({ ...m, [source]: data.cached
          ? "No rows in cached scan — click Force re-scan to retry"
          : "Vision found no rows — try Force re-scan or a clearer screenshot" }));
        return false;
      }

      // Use the shared merge lib (also used by the email-inbox dispatcher) so
      // both paths apply identical REPLACE-mode semantics: a screenshot
      // becomes the new full list, names no longer present get removed,
      // manualSell-tagged alphaPicks survive. Safety check falls back to
      // additive merge when the new screenshot has < 30% of the existing
      // list's rows (partial / vision miss). See app/lib/research-merge.ts.
      const { nextState, summary } = applyResearchEntries(
        state,
        source,
        entries as unknown[],
      );
      const cachedLabel = data.cached ? " (cached)" : "";
      const modeLabel = summary.mode === "additive"
        ? (summary.sameDayAccumulate ? " · same-day (added to today's earlier screenshot)" : " · ADDITIVE FALLBACK")
        : "";
      const removedLabel = summary.mode === "replace" && summary.removed > 0 ? ` · ${summary.removed} removed` : "";
      const reasonLabel = summary.fallbackReason ? ` ⚠ ${summary.fallbackReason}` : "";
      setScrapeStatusMap((m) => ({
        ...m,
        [source]: `${entries.length} rows${cachedLabel}${modeLabel} · ${summary.matched} matched · ${summary.added} added${removedLabel}${reasonLabel}`,
      }));
      save(nextState);
      postResearchRemovals(source, summary.removedTickers);

      // Source-specific follow-ups: Yahoo name backfill + live prices. Run
      // off the freshly-merged state so they see the post-merge list.
      if (source === "rbc-focus") {
        void refreshRbcNames("rbcCanadianFocus", nextState);
      } else if (source === "rbc-us-focus") {
        void refreshRbcNames("rbcUsFocus", nextState);
      } else if (source === "rbc-equate-cad") {
        void refreshRbcNames("equateCad", nextState);
        void fetchFactsetPrices(nextState);
      } else if (source === "rbc-equate-usd") {
        void refreshRbcNames("equateUsd", nextState);
        void fetchFactsetPrices(nextState);
      } else if (source === "jpm-us-analyst-focus") {
        void refreshRbcNames("jpmUsAnalystFocus", nextState);
        void fetchFactsetPrices(nextState);
      } else if (source === "seeking-alpha-picks") {
        void refreshAlphaPickNames(nextState);
        void fetchLivePrices(nextState);
      } else if (source === "rbccm-few") {
        void refreshFewNames(nextState);
        void fetchLivePrices(nextState);
      }
      return true;
    } catch (e) {
      console.error(`research-scrape:${source} failed:`, e);
      setScrapeStatusMap((m) => ({ ...m, [source]: "Screenshot scan failed" }));
      return false;
    } finally {
      setScrapeLoadingMap((m) => ({ ...m, [source]: false }));
      // researchMentions recompute is handled by save() (post-PUT), so it
      // reads the freshly merged list instead of racing the write.
    }
  }, [state, save, refreshAlphaPickNames, refreshRbcNames, fetchLivePrices, fetchFactsetPrices]);

  /**
   * Cross-source synthesis with strict stickiness.
   *
   *   - On page mount, hydrate from the server's persisted blob via
   *     a GET. No Anthropic call regardless of how many times the
   *     research page is opened or reloaded across devices.
   *   - If no synthesis is persisted yet (first-ever generation),
   *     auto-fire a POST with force=false. The server generates,
   *     persists, and returns. Subsequent loads then hit the
   *     persisted blob via the GET path.
   *   - "Force re-generate" passes force=true. The server overwrites
   *     the persisted blob with a fresh synthesis using the current
   *     research + current brief — this is the only path that mutates
   *     the persisted state.
   *
   * Net effect: synthesis stays anchored to the brief at the moment
   * it was first generated, doesn't migrate when the brief is
   * regenerated, and doesn't waste tokens on every page load.
   */
  const loadPersistedSynthesis = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/research-synthesis", { method: "GET" });
      if (!res.ok) return false;
      const data = await res.json() as {
        result: SynthesisResult | null;
        generatedAt?: string | null;
        generatedDate?: string | null;
        briefRegime?: string;
        briefDate?: string;
      };
      if (!data.result) {
        setSynthesis(null);
        setSynthesisGeneratedAt(null);
        return false;
      }
      setSynthesis(data.result);
      setSynthesisGeneratedAt(data.generatedAt ?? null);
      setSynthesisCached(true);
      const totalPicks = data.result.topPicks.length + (data.result.regimeAlignedHighlights?.length ?? 0) + data.result.honorableMentions.length;
      const briefLabel = data.briefRegime ? ` · ${data.briefRegime} regime` : "";
      const dateLabel = data.generatedDate ? ` · ${data.generatedDate}` : "";
      setSynthesisStatus(`${totalPicks} picks${briefLabel}${dateLabel}`);
      return true;
    } catch (e) {
      console.error("research-synthesis load failed:", e);
      return false;
    }
  }, []);

  const generateSynthesis = useCallback(async (force = false): Promise<boolean> => {
    setSynthesisLoading(true);
    setSynthesisStatus(null);
    try {
      const res = await fetch("/api/research-synthesis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ research: state, brief, force }),
      });
      if (!res.ok) {
        // Surface the server's actual error message (the route now returns
        // it) so failures are diagnosable instead of an opaque label.
        const errBody = await res.json().catch(() => null);
        const detail = errBody?.error ? `: ${errBody.error}` : ` (HTTP ${res.status})`;
        setSynthesisStatus(`Synthesis failed${detail}`);
        return false;
      }
      const data = await res.json() as {
        result: SynthesisResult | null;
        cached?: boolean;
        generatedAt?: string;
        generatedDate?: string;
        briefRegime?: string;
        briefDate?: string;
        reason?: string;
        message?: string;
      };
      if (!data.result) {
        setSynthesis(null);
        setSynthesisStatus(data.message || "No synthesis available yet");
        return false;
      }
      setSynthesis(data.result);
      setSynthesisCached(!!data.cached);
      setSynthesisGeneratedAt(data.generatedAt ?? null);
      const totalPicks = data.result.topPicks.length + (data.result.regimeAlignedHighlights?.length ?? 0) + data.result.honorableMentions.length;
      const briefLabel = data.briefRegime ? ` · ${data.briefRegime} regime` : "";
      const stickyLabel = data.cached ? " · sticky" : " · fresh";
      setSynthesisStatus(`${totalPicks} picks${briefLabel}${stickyLabel}`);
      return true;
    } catch (e) {
      console.error("research-synthesis failed:", e);
      setSynthesisStatus("Synthesis failed");
      return false;
    } finally {
      setSynthesisLoading(false);
    }
  }, [state, brief]);

  // Hydrate from the persisted synthesis on mount. If nothing's
  // persisted yet, auto-generate (one-time, after the brief has had a
  // chance to load — see briefReadyRef below). Subsequent reloads
  // never re-fire Anthropic; only Force re-generate does.
  const synthesisHydratedRef = useRef(false);
  const briefReadyRef = useRef(false);
  useEffect(() => {
    if (!loaded || synthesisHydratedRef.current) return;
    synthesisHydratedRef.current = true;
    (async () => {
      const hadStored = await loadPersistedSynthesis();
      if (hadStored) return;
      // No persisted synthesis — wait briefly for the brief to load
      // from useStocks() so the first-ever generation has full context.
      // If brief is still null after the wait, generate without it
      // (the route handles null brief gracefully).
      if (!brief && !briefReadyRef.current) {
        // Defer by one tick so the next render with a populated brief
        // can hit; if still null we proceed anyway.
        await new Promise((r) => setTimeout(r, 800));
      }
      void generateSynthesis(false);
    })();
  }, [loaded, brief, loadPersistedSynthesis, generateSynthesis]);

  // Track whether the brief has been seen yet so the auto-generate
  // path can wait for it once.
  useEffect(() => {
    if (brief) briefReadyRef.current = true;
  }, [brief]);

  /* Uptick helpers */
  const addUptick = (entry: UptickEntry) => {
    if (state.newtonUpticks.some((u) => u.ticker === entry.ticker)) return;
    // Manually adding a ticker clears any tombstone for it, so an explicit
    // re-add un-dismisses a previously-removed name.
    const norm = normalizeUptickTicker(entry.ticker);
    const dismissedUpticks = (state.dismissedUpticks ?? []).filter(
      (t) => normalizeUptickTicker(t) !== norm,
    );
    save({ ...state, newtonUpticks: [...state.newtonUpticks, entry], dismissedUpticks });
  };
  const removeUptick = (ticker: string) => {
    // Record a tombstone so the scrape never re-adds this entry on Refresh.
    // De-duped, normalized. This is what stops a removed hallucination from
    // reappearing.
    const norm = normalizeUptickTicker(ticker);
    const dismissedUpticks = Array.from(
      new Set([...(state.dismissedUpticks ?? []).map(normalizeUptickTicker), norm]),
    );
    save({
      ...state,
      newtonUpticks: state.newtonUpticks.filter((u) => u.ticker !== ticker),
      dismissedUpticks,
    });
  };
  const updateUptick = (ticker: string, field: keyof UptickEntry, value: string) => {
    // Look up by ticker, not index. The table renders rows in sorted order,
    // so the row's visual index does NOT match its index in state.newtonUpticks.
    // Using an index here silently wrote edits to the wrong row.
    const idx = state.newtonUpticks.findIndex((u) => u.ticker === ticker);
    if (idx < 0) return;
    const updated = [...state.newtonUpticks];
    const entry = { ...updated[idx] };
    if (field === "price" || field === "priceWhenAdded") {
      (entry as Record<string, unknown>)[field] = parseFloat(value) || 0;
    } else {
      (entry as Record<string, unknown>)[field] = value;
    }
    updated[idx] = entry;
    save({ ...state, newtonUpticks: updated });
  };

  /* Idea helpers */
  type IdeaListKey = "fundstratTop" | "fundstratBottom" | "fundstratSmidTop" | "fundstratSmidBottom";
  const ideaList = (key: IdeaListKey): IdeaEntry[] => (state[key] as IdeaEntry[] | undefined) || [];
  const addIdea = (key: IdeaListKey, entry: IdeaEntry) => {
    const list = ideaList(key);
    if (list.some((i) => i.ticker === entry.ticker)) return;
    save({ ...state, [key]: [...list, entry] } as ResearchState);
  };
  const removeIdea = (key: IdeaListKey, ticker: string) => {
    save({ ...state, [key]: ideaList(key).filter((i) => i.ticker !== ticker) } as ResearchState);
  };
  const updateIdea = (key: IdeaListKey, idx: number, price: string) => {
    const updated = [...ideaList(key)];
    if (idx < 0 || idx >= updated.length) return;
    updated[idx] = { ...updated[idx], priceWhenAdded: parseFloat(price) || 0 };
    save({ ...state, [key]: updated } as ResearchState);
  };

  /* RBC helpers */
  const addRbc = (entry: RBCEntry) => {
    const list = state.rbcCanadianFocus || [];
    if (list.some((r) => r.ticker === entry.ticker)) return;
    save({ ...state, rbcCanadianFocus: [...list, entry] });
  };
  const removeRbc = (ticker: string) => {
    save({ ...state, rbcCanadianFocus: (state.rbcCanadianFocus || []).filter((r) => r.ticker !== ticker) });
  };
  const addRbcUs = (entry: RBCEntry) => {
    const list = state.rbcUsFocus || [];
    if (list.some((r) => r.ticker === entry.ticker)) return;
    save({ ...state, rbcUsFocus: [...list, entry] });
  };
  const removeRbcUs = (ticker: string) => {
    save({ ...state, rbcUsFocus: (state.rbcUsFocus || []).filter((r) => r.ticker !== ticker) });
  };
  const addEquateCad = (entry: RBCEntry) => {
    const list = state.equateCad || [];
    if (list.some((r) => r.ticker === entry.ticker)) return;
    save({ ...state, equateCad: [...list, entry] });
  };
  const removeEquateCad = (ticker: string) => {
    save({ ...state, equateCad: (state.equateCad || []).filter((r) => r.ticker !== ticker) });
  };
  const addEquateUsd = (entry: RBCEntry) => {
    const list = state.equateUsd || [];
    if (list.some((r) => r.ticker === entry.ticker)) return;
    save({ ...state, equateUsd: [...list, entry] });
  };
  const removeEquateUsd = (ticker: string) => {
    save({ ...state, equateUsd: (state.equateUsd || []).filter((r) => r.ticker !== ticker) });
  };
  const addJpmFocus = (entry: RBCEntry) => {
    const list = state.jpmUsAnalystFocus || [];
    if (list.some((r) => r.ticker === entry.ticker)) return;
    save({ ...state, jpmUsAnalystFocus: [...list, entry] });
  };
  const removeJpmFocus = (ticker: string) => {
    save({ ...state, jpmUsAnalystFocus: (state.jpmUsAnalystFocus || []).filter((r) => r.ticker !== ticker) });
  };
  const addFew = (entry: FewEntry) => {
    const list = state.rbccmFew || [];
    if (list.some((r) => r.ticker === entry.ticker)) return;
    save({ ...state, rbccmFew: [...list, entry] });
  };
  const removeFew = (ticker: string) => {
    save({ ...state, rbccmFew: (state.rbccmFew || []).filter((r) => r.ticker !== ticker) });
  };

  /* Attachment helpers — image payloads are stored in separate Redis keys
     via /api/kv/attachments/[id] so they never blow up the research blob.
     Only the lightweight manifest (id/label/section/addedAt) rides on
     `state.attachments`. addAttachment writes the image synchronously
     before updating state, so a drop-then-refresh is safe. */
  const addAttachment = async (att: BriefAttachment) => {
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
        return;
      }
      setAttachmentsSaveError(null);
      // Keep the dataUrl in local state for previews, but strip it on save
      // (see research GET/PUT helpers below — the manifest lives inside
      // the research blob without dataUrls).
      save({ ...state, attachments: [...(state.attachments || []), att] });
    } catch (e) {
      setAttachmentsSaveError(`Screenshot save network error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const removeAttachment = async (id: string) => {
    save({ ...state, attachments: (state.attachments || []).filter((a) => a.id !== id) });
    try {
      await fetch(`/api/kv/attachments/${id}`, { method: "DELETE" });
    } catch {
      // Orphan key cleanup — non-fatal if it fails.
    }
  };

  if (!loaded) return null;

  return (
    <main className="min-h-screen bg-ground px-4 py-6 text-ink md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="max-w-3xl">
            <h1 className="text-3xl font-semibold tracking-tight">Research Notes</h1>
            <p className="text-ink-3 mt-1">Every sell-side &amp; quant source list — each with a screenshot scanner and paste-to-add. Drag any ticker onto the Watchlist. The cross-source synthesis ranks names appearing across multiple lists.</p>
          </div>
          <button
            onClick={() => {
              if (synthesis) {
                if (!confirm("Re-synthesize will overwrite the existing synthesis using the CURRENT brief. The previous synthesis (and its brief context) will be replaced. Continue?")) return;
                void generateSynthesis(true);
              } else {
                void generateSynthesis(false);
              }
            }}
            disabled={synthesisLoading}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-control border border-line bg-surface px-3 py-1.5 text-sm font-semibold text-ink-2 hover:bg-surface-2 disabled:opacity-50 transition-colors"
            title="Regenerate the cross-source synthesis from the current research + brief."
          >
            <svg className={`w-3.5 h-3.5 ${synthesisLoading ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            {synthesisLoading ? "Synthesizing…" : synthesis ? "Re-synthesize" : "Generate"}
          </button>
        </div>

        {attachmentsSaveError && (
          <div className="rounded-xl border border-warn-border bg-warn-soft px-4 py-3 text-sm text-warn">
            <strong>Screenshots not saved:</strong> {attachmentsSaveError}
          </div>
        )}

        {/* ── Cross-Source Synthesis ──
            AI-generated buy-target list synthesizing all five research
            sources + the brief's regime/horizon read. Cross-source
            overlap (a ticker mentioned by 2+ sources) is weighted
            higher. Cached server-side: refreshes with unchanged
            research + brief return instantly with no Anthropic cost. */}
        <section className="rounded-2xl border border-line bg-white p-6 shadow-sm">
          <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-full bg-violet" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-violet">Cross-Source Synthesis</h3>
              <span className="text-xs text-ink-3">Claude · regime-aware</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {synthesisStatus && (
                <span className="text-[11px] text-ink-3 mr-1">{synthesisStatus}</span>
              )}
              {synthesisGeneratedAt && (
                <span className="text-[10px] text-ink-3 mr-1" title={`Generated ${new Date(synthesisGeneratedAt).toLocaleString()}`}>
                  {new Date(synthesisGeneratedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </span>
              )}
              <button
                onClick={() => setUiPref("research.synthesisCollapsed", synthesisCollapsed ? "0" : "1")}
                className="text-[11px] rounded-md border border-line bg-white px-2 py-1.5 font-medium text-ink-2 hover:bg-surface-2 transition-colors inline-flex items-center gap-1"
                title={synthesisCollapsed ? "Expand the synthesis" : "Collapse the synthesis"}
                aria-expanded={!synthesisCollapsed}
              >
                <svg className={`w-3.5 h-3.5 transition-transform ${synthesisCollapsed ? "" : "rotate-180"}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
                {synthesisCollapsed ? "Expand" : "Collapse"}
              </button>
            </div>
          </div>

          {!synthesisCollapsed && !synthesis && !synthesisLoading && (
            <div className="rounded-lg border border-dashed border-line bg-white/70 p-4 text-sm text-ink-3">
              {synthesisStatus
                ? <>{synthesisStatus}</>
                : <>No synthesis generated yet. Add some research picks across the sources below, then click <strong>Generate</strong>.</>}
            </div>
          )}

          {!synthesisCollapsed && synthesis && (() => {
            // Render helper for the regime-fit pill on a pick. The
            // colors visually separate the model's OPINION on regime
            // alignment from the source-derived thesis text below.
            const fitColor: Record<RegimeFitRating, string> = {
              high: "bg-pos-soft text-pos ring-1 ring-pos-border",
              medium: "bg-surface-2 text-ink-2 ring-1 ring-line",
              low: "bg-warn-soft text-warn ring-1 ring-warn-border",
              contrary: "bg-neg-soft text-neg ring-1 ring-neg-border",
            };
            const fitLabel: Record<RegimeFitRating, string> = {
              high: "Regime: HIGH fit",
              medium: "Regime: medium fit",
              low: "Regime: LOW fit",
              contrary: "Regime: CONTRARY",
            };
            // Conviction badge: 0-100 model conviction. Color-banded so the
            // PM can spot high-conviction picks at a glance without reading
            // the number — green ≥75, amber 60-74, slate <60. Hidden when
            // the field is missing (old persisted synthesis blobs).
            const ConvictionBadge = ({ p }: { p: SynthesisPick }) => {
              if (typeof p.conviction !== "number") return null;
              const c = p.conviction;
              const tone =
                c >= 75 ? "bg-pos-soft text-pos border-pos-border"
                : c >= 60 ? "bg-warn-soft text-warn border-warn-border"
                : "bg-surface-2 text-ink-2 border-line";
              return (
                <span
                  className={`text-[10px] font-bold rounded-full px-2 py-0.5 border ${tone}`}
                  title={`Model conviction: ${c}/100 (combines source count, regime fit, and absence of dissent)`}
                >
                  Conviction {c}
                </span>
              );
            };
            const RegimeFitBlock = ({ p }: { p: SynthesisPick }) => {
              if (!p.regimeFit) return null;
              return (
                <div className="mt-2 flex items-start gap-2 rounded-md bg-surface-2 px-2 py-1.5">
                  <span className={`text-[10px] font-bold uppercase tracking-wider rounded-full px-2 py-0.5 whitespace-nowrap ${fitColor[p.regimeFit]}`}>
                    {fitLabel[p.regimeFit]}
                  </span>
                  {p.regimeFitRationale && (
                    <span className="text-[11px] leading-5 text-ink-2 italic">
                      {p.regimeFitRationale}
                    </span>
                  )}
                </div>
              );
            };
            return (
              <div className="space-y-4">
                {/* Summary line + regime tag */}
                <div className="flex items-start gap-2 flex-wrap">
                  {synthesis.regimeContext && (
                    <span className={`text-[10px] font-bold uppercase tracking-wider rounded-full px-2 py-0.5 mt-0.5 ${
                      synthesis.regimeContext === "Risk-On"  ? "bg-pos-soft text-pos"
                      : synthesis.regimeContext === "Risk-Off" ? "bg-neg-soft text-neg"
                      : "bg-warn-soft text-warn"
                    }`}>
                      {synthesis.regimeContext}
                    </span>
                  )}
                  <p className="text-sm leading-6 text-ink-2 flex-1 min-w-[260px]">{synthesis.summary}</p>
                </div>

                {/* Regime tilts — the model's distilled view of what the
                    current environment favors. These drove the regimeFit
                    ratings on each pick below. */}
                {synthesis.regimeTilts && synthesis.regimeTilts.length > 0 && (
                  <div className="rounded-lg border border-accent-border bg-accent-soft/60 p-3">
                    <h4 className="text-[10px] font-bold uppercase tracking-wider text-accent mb-1.5">
                      Regime Tilts <span className="text-accent font-normal normal-case">· model&apos;s read of what this market favors</span>
                    </h4>
                    <ul className="text-xs leading-5 text-accent space-y-0.5 list-disc list-inside">
                      {synthesis.regimeTilts.map((t, i) => <li key={i}>{t}</li>)}
                    </ul>
                  </div>
                )}

                {/* Pick columns — mockup's 3-across layout. */}
                <div className="grid gap-5 md:grid-cols-3 items-start">
                {/* Top picks — multi-source. Always primary, regardless
                    of regime fit. The fit pill on each card lets the PM
                    spot multi-source picks the regime doesn't favor. */}
                {synthesis.topPicks.length > 0 && (
                  <div>
                    <h4 className="text-xs font-bold uppercase tracking-wider text-violet mb-2">
                      Top Picks <span className="text-ink-3 font-normal">· cross-source overlap (research-driven)</span>
                    </h4>
                    <ul className="space-y-3">
                      {synthesis.topPicks.map((p) => (
                        <li key={p.ticker} className="rounded-xl border border-violet-soft bg-white p-3 shadow-sm">
                          <div className="flex items-center gap-2 flex-wrap mb-1.5">
                            <span className="font-mono font-bold text-base text-violet">${displayTicker(p.ticker)}</span>
                            <span className="text-[10px] font-bold rounded-full bg-violet text-white px-2 py-0.5">
                              {p.sourceCount} sources
                            </span>
                            <ConvictionBadge p={p} />
                            {p.sources.map((s) => (
                              <span key={s} className="text-[10px] rounded-full bg-surface-2 text-ink-2 px-2 py-0.5">
                                {s}
                              </span>
                            ))}
                          </div>
                          <p className="text-sm leading-6 text-ink-2">{p.thesis}</p>
                          <RegimeFitBlock p={p} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Regime-aligned highlights — single-source picks where
                    the model thinks the regime strongly favors the name.
                    This is opinion-driven; the orange/teal styling
                    makes that visually distinct from the indigo top
                    picks above. */}
                {synthesis.regimeAlignedHighlights && synthesis.regimeAlignedHighlights.length > 0 && (
                  <div>
                    <h4 className="text-xs font-bold uppercase tracking-wider text-accent mb-2">
                      Regime-Aligned Highlights <span className="text-ink-3 font-normal">· single-source, opinion-driven by current environment</span>
                    </h4>
                    <ul className="space-y-2.5">
                      {synthesis.regimeAlignedHighlights.map((p) => (
                        <li key={p.ticker} className="rounded-xl border border-accent-border bg-white p-3 shadow-sm">
                          <div className="flex items-center gap-2 flex-wrap mb-1.5">
                            <span className="font-mono font-bold text-base text-accent">${displayTicker(p.ticker)}</span>
                            <ConvictionBadge p={p} />
                            {p.sources.map((s) => (
                              <span key={s} className="text-[10px] rounded-full bg-surface-2 text-ink-2 px-2 py-0.5">
                                {s}
                              </span>
                            ))}
                          </div>
                          <p className="text-sm leading-6 text-ink-2">{p.thesis}</p>
                          <RegimeFitBlock p={p} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Honorable mentions — single source, weaker regime fit. */}
                {synthesis.honorableMentions.length > 0 && (
                  <div>
                    <h4 className="text-xs font-bold uppercase tracking-wider text-ink-2 mb-2">
                      Honorable Mentions <span className="text-ink-3 font-normal">· single-source, regime-neutral</span>
                    </h4>
                    <ul className="space-y-2">
                      {synthesis.honorableMentions.map((p) => (
                        <li key={p.ticker} className="rounded-lg border border-line-soft bg-white/70 p-2.5">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span className="font-mono font-bold text-sm">${displayTicker(p.ticker)}</span>
                            <ConvictionBadge p={p} />
                            {p.sources.map((s) => (
                              <span key={s} className="text-[10px] rounded-full bg-surface-2 text-ink-2 px-2 py-0.5">
                                {s}
                              </span>
                            ))}
                          </div>
                          <p className="text-xs leading-5 text-ink-2">{p.thesis}</p>
                          <RegimeFitBlock p={p} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                </div>{/* /pick columns */}

                {/* Cautions */}
                {synthesis.cautions && synthesis.cautions.length > 0 && (
                  <div className="rounded-lg border border-warn-border bg-warn-soft p-3">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-warn mb-1">Cautions</h4>
                    <ul className="text-xs leading-5 text-warn list-disc list-inside space-y-0.5">
                      {synthesis.cautions.map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            );
          })()}
        </section>

        {/* ── Newton's Upticks ── */}
        <CollapsibleSection
          prefKey="research.newton"
          className="border-line"
          titleClass="text-xl font-bold"
          title={<>Newton&apos;s Upticks</>}
          subtitle={<>Fundstrat technical uptick list &mdash; click any cell to edit</>}
          right={<span className="text-sm text-ink-3">{state.newtonUpticks.length} stocks</span>}
        >

          {pricesFetchedAt && (
            <p className="text-[10px] text-ink-3 mb-2">
              Prices updated {new Date(pricesFetchedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}
            </p>
          )}

          {/* View toggle: compact mockup rows (default) vs the full sortable + inline-editable table. */}
          <div className="flex items-center justify-end mb-2">
            <button
              onClick={() => setUiPref("research.newton.view", newtonView === "rows" ? "table" : "rows")}
              className="text-[11px] rounded-md border border-line bg-white px-2 py-1 font-medium text-ink-2 hover:bg-surface-2 transition-colors"
              title={newtonView === "rows" ? "Switch to the full sortable, inline-editable table" : "Switch to the compact rows view"}
            >
              {newtonView === "rows" ? "Table view" : "Rows view"}
            </button>
          </div>

          {newtonView === "rows" ? (
            <div className="rounded-xl border border-line-soft overflow-hidden">
              {sortedUpticks().map((u) => {
                const livePrice = livePrices[u.ticker];
                const pctChange = livePrice && u.priceWhenAdded ? ((livePrice - u.priceWhenAdded) / u.priceWhenAdded * 100) : null;
                const inList = scoredStocks.some((s) => s.ticker === u.ticker);
                return (
                  <div key={u.ticker} className="group flex items-center gap-3 border-b border-line-soft px-3 py-2.5 last:border-b-0 hover:bg-surface-2/50">
                    <span className="shrink-0 text-ink-faint select-none" title="Use + Watch to add to the Watchlist">⋮⋮</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono font-bold text-ink">{displayTicker(u.ticker)}</span>
                        {u.name && u.name !== u.ticker && <span className="truncate text-sm text-ink-2">{u.name}</span>}
                      </div>
                      <div className="text-[11px] text-ink-3 truncate">
                        {u.sector && u.sector !== "—" ? u.sector : "—"}
                        {(u.support || u.resistance) && <span className="ml-2 text-ink-faint">S {u.support || "—"} · R {u.resistance || "—"}</span>}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-mono text-sm text-ink">{livePrice != null ? `$${livePrice.toFixed(2)}` : "—"}</div>
                      <div className={`font-mono text-xs ${pctChange == null ? "text-ink-faint" : pctChange >= 0 ? "text-pos" : "text-neg"}`}>
                        {pctChange == null ? "" : `${pctChange >= 0 ? "+" : ""}${pctChange.toFixed(1)}%`}
                      </div>
                    </div>
                    <div className="shrink-0 w-[68px] text-right opacity-0 group-hover:opacity-100 transition-opacity">
                      {inList ? (
                        <span className="text-[10px] text-pos font-medium">In list</span>
                      ) : (
                        <button onClick={(e) => { e.stopPropagation(); addToWatchlist(u.ticker); }} className="text-[10px] text-accent font-semibold" title="Add to Watchlist">+ Watch</button>
                      )}
                      <button onClick={() => removeUptick(u.ticker)} className="ml-1.5 text-ink-faint hover:text-neg font-bold" title="Remove">×</button>
                    </div>
                  </div>
                );
              })}
              {state.newtonUpticks.length === 0 && <div className="px-3 py-8 text-center text-ink-3 italic">No upticks added yet</div>}
            </div>
          ) : (
          <div className="overflow-x-auto">
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead>
                <tr className="border-b-2 border-accent-border text-left">
                  <th className="py-2 pr-2 text-xs font-semibold text-accent w-8">#</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-accent cursor-pointer hover:text-accent select-none" onClick={() => toggleUptickSort("ticker")}>Ticker{uArrow("ticker")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-accent cursor-pointer hover:text-accent select-none" onClick={() => toggleUptickSort("name")}>Name{uArrow("name")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-accent cursor-pointer hover:text-accent select-none" onClick={() => toggleUptickSort("sector")}>Sector{uArrow("sector")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-accent text-right cursor-pointer hover:text-accent select-none" onClick={() => toggleUptickSort("price")}>Price{uArrow("price")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-accent text-right cursor-pointer hover:text-accent select-none" onClick={() => toggleUptickSort("priceWhenAdded")}>Price Added{uArrow("priceWhenAdded")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-accent text-right">Chg</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-accent text-right">Support</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-accent text-right">Resistance</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-accent cursor-pointer hover:text-accent select-none" onClick={() => toggleUptickSort("dateAdded")}>Date Added{uArrow("dateAdded")}</th>
                  <th className="py-2 text-xs font-semibold text-accent w-8"></th>
                </tr>
              </thead>
              <tbody>
                {sortedUpticks().map((u, i) => {
                  const isNew = u.dateAdded === new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
                  const rowBg = isNew ? "bg-warn-soft font-semibold" : i % 2 === 0 ? "bg-white" : "bg-surface-2/50";
                  const livePrice = livePrices[u.ticker];
                  const pctChange = livePrice && u.priceWhenAdded ? ((livePrice - u.priceWhenAdded) / u.priceWhenAdded * 100) : null;
                  return (
                    <tr key={u.ticker} className={`border-b border-line-soft ${rowBg} hover:bg-accent-soft/40 transition-colors`}>
                      <td className="py-2 pr-2 text-ink-3">{i + 1}</td>
                      <td className="py-2 pr-3 font-mono font-bold text-accent">${displayTicker(u.ticker)}</td>
                      <td className="py-2 pr-3 text-ink-2 truncate max-w-[160px]">
                        {u.name && u.name !== u.ticker ? u.name : <span className="text-ink-faint italic text-xs">loading...</span>}
                      </td>
                      <td className="py-2 pr-3 text-ink-2 truncate max-w-[140px]">
                        {u.sector && u.sector !== "—" ? u.sector : <span className="text-ink-faint italic text-xs">loading...</span>}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        {pricesLoading ? (
                          <span className="text-ink-faint animate-pulse">...</span>
                        ) : livePrice != null ? (
                          <span className="font-semibold">${livePrice.toFixed(2)}</span>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        {u.priceWhenAdded ? (
                          <EditableCell value={`$${u.priceWhenAdded.toFixed(2)}`} onChange={(v) => updateUptick(u.ticker, "priceWhenAdded", v.replace("$", ""))} />
                        ) : (
                          <span className="text-pos font-semibold">NEW</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-xs">
                        {pctChange != null ? (
                          <span className={pctChange >= 0 ? "text-pos" : "text-neg"}>
                            {pctChange >= 0 ? "+" : ""}{pctChange.toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        <EditableCell value={u.support} onChange={(v) => updateUptick(u.ticker, "support", v)} />
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        <EditableCell value={u.resistance} onChange={(v) => updateUptick(u.ticker, "resistance", v)} />
                      </td>
                      <td className="py-2 pr-3 text-ink-3">
                        <EditableCell value={u.dateAdded} onChange={(v) => updateUptick(u.ticker, "dateAdded", v)} />
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {scoredStocks.some((s) => s.ticker === u.ticker) ? (
                          <span className="text-[10px] text-pos font-medium">In list</span>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); addToWatchlist(u.ticker); }}
                            className="text-[10px] text-accent hover:text-accent font-semibold transition-colors"
                            title="Add to Watchlist"
                          >
                            + Watch
                          </button>
                        )}
                        <button onClick={() => removeUptick(u.ticker)} className="ml-2 text-ink-faint hover:text-neg font-bold transition-colors" title="Remove">
                          &times;
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {state.newtonUpticks.length === 0 && (
                  <tr>
                    <td colSpan={11} className="py-8 text-center text-ink-3 italic">No upticks added yet</td>
                  </tr>
                )}
              </tbody>
            </table></div>
          </div>
          )}

          <UptickAddForm onAdd={addUptick} />

          {/*
            Screenshot scraper. Uploads are persisted in state.attachments with
            section === "upticks" (same storage the rest of Research uses).
            On Refresh, scrapeUpticks() POSTs these images to
            /api/upticks-scrape, which re-runs the Anthropic vision call ONLY
            if the image fingerprint changed (same caching pattern as JPM
            flows). Unchanged images = zero tokens spent.
          */}
          <div className="mt-5 border-t border-line-soft pt-4">
            <div className="flex items-center gap-3 mb-2">
              <h4 className="text-sm font-bold text-accent">Screenshot Scanner</h4>
              <span className="text-[10px] text-ink-3">
                Upload a Newton&apos;s Upticks screenshot. On Refresh, support/resistance/price/date fields are auto-populated from the image. Re-scans only if the image changes.
              </span>
            </div>
            <ImageUpload
              section="upticks"
              sectionLabel="Newton's Upticks"
              attachments={state.attachments || []}
              onAdd={addAttachment}
              onRemove={removeAttachment}
            />
            <div className="flex items-center gap-3 mt-2">
              {scrapeStatus && (
                <p className="text-[10px] text-ink-3">{scrapeStatus}</p>
              )}
              <button
                onClick={() => { void scrapeUpticks(true); }}
                disabled={scrapeLoading || (state.attachments || []).filter((a) => a.section === "upticks").length === 0}
                className="ml-auto text-[10px] rounded-md border border-line bg-white px-2 py-1 font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-50 transition-colors"
                title="Ignore the cached parse and re-run Anthropic vision against the current screenshot. Use this if the last scan missed support/resistance or other fields."
              >
                Force re-scan
              </button>
            </div>
            {/* Debug: show exactly what the vision call extracted so you can
                see whether the model actually read support/resistance off
                the screenshot. If rows show here with empty support/resistance,
                the prompt needs improvement — not the merge logic. */}
            {lastScrape.length > 0 && (
              <details className="mt-2 text-[10px] text-ink-3">
                <summary className="cursor-pointer hover:text-ink-2">
                  View parsed rows from screenshot ({lastScrape.length})
                </summary>
                <div className="mt-1 overflow-x-auto">
                  <div className="overflow-x-auto"><table className="w-full text-[10px]">
                    <thead>
                      <tr className="text-ink-3 border-b border-line">
                        <th className="py-1 pr-2 text-left">Ticker</th>
                        <th className="py-1 pr-2 text-left">Support</th>
                        <th className="py-1 pr-2 text-left">Resistance</th>
                        <th className="py-1 pr-2 text-right">Price Added</th>
                        <th className="py-1 text-left">Date Added</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lastScrape.map((r, i) => (
                        <tr key={`${r.ticker}-${i}`} className="border-b border-line-soft">
                          <td className="py-0.5 pr-2 font-mono font-semibold">{displayTicker(r.ticker)}</td>
                          <td className="py-0.5 pr-2">{r.support ?? <span className="text-ink-faint">—</span>}</td>
                          <td className="py-0.5 pr-2">{r.resistance ?? <span className="text-ink-faint">—</span>}</td>
                          <td className="py-0.5 pr-2 text-right">{r.priceWhenAdded != null ? `$${r.priceWhenAdded}` : <span className="text-ink-faint">—</span>}</td>
                          <td className="py-0.5">{r.dateAdded ?? <span className="text-ink-faint">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table></div>
                </div>
              </details>
            )}
          </div>

          {/* Newton sector views — compact inline toggles */}
          <div className="mt-5 border-t border-line-soft pt-4">
            <div className="flex items-center gap-3 mb-3">
              <h4 className="text-sm font-bold text-accent">Newton&apos;s Sector Views</h4>
              <span className="text-[10px] text-ink-3">Click to toggle OW / N / UW</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {(state.newtonSectors ?? GICS_SECTORS.map((s) => ({ sector: s, view: "neutral" as SectorView }))).map((sv) => {
                const cycle = () => {
                  const next: SectorView =
                    sv.view === "neutral" ? "overweight" : sv.view === "overweight" ? "underweight" : "neutral";
                  const updated = (state.newtonSectors ?? GICS_SECTORS.map((s) => ({ sector: s, view: "neutral" as SectorView }))).map((e) =>
                    e.sector === sv.sector ? { ...e, view: next } : e
                  );
                  save({ ...state, newtonSectors: updated });
                };
                const bg =
                  sv.view === "overweight"
                    ? "bg-pos-soft text-pos border-pos-border"
                    : sv.view === "underweight"
                    ? "bg-neg-soft text-neg border-neg-border"
                    : "bg-surface-2 text-ink-3 border-line";
                const badge =
                  sv.view === "overweight" ? "OW" : sv.view === "underweight" ? "UW" : "N";
                return (
                  <button
                    key={sv.sector}
                    onClick={cycle}
                    className={`rounded-full border px-3 py-1 text-xs font-semibold transition-all hover:shadow-sm select-none ${bg}`}
                    title={`${sv.sector}: ${sv.view} — click to cycle`}
                  >
                    {sv.sector} <span className="font-bold ml-0.5">{badge}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Lee sector views — same toggle pattern as Newton */}
          <div className="mt-4 border-t border-line-soft pt-4">
            <div className="flex items-center gap-3 mb-3">
              <h4 className="text-sm font-bold text-warn">Lee&apos;s Sector Views</h4>
              <span className="text-[10px] text-ink-3">Click to toggle OW / N / UW</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {(state.leeSectors ?? GICS_SECTORS.map((s) => ({ sector: s, view: "neutral" as SectorView }))).map((sv) => {
                const cycle = () => {
                  const next: SectorView =
                    sv.view === "neutral" ? "overweight" : sv.view === "overweight" ? "underweight" : "neutral";
                  const updated = (state.leeSectors ?? GICS_SECTORS.map((s) => ({ sector: s, view: "neutral" as SectorView }))).map((e) =>
                    e.sector === sv.sector ? { ...e, view: next } : e
                  );
                  save({ ...state, leeSectors: updated });
                };
                const bg =
                  sv.view === "overweight"
                    ? "bg-pos-soft text-pos border-pos-border"
                    : sv.view === "underweight"
                    ? "bg-neg-soft text-neg border-neg-border"
                    : "bg-surface-2 text-ink-3 border-line";
                const badge =
                  sv.view === "overweight" ? "OW" : sv.view === "underweight" ? "UW" : "N";
                return (
                  <button
                    key={sv.sector}
                    onClick={cycle}
                    className={`rounded-full border px-3 py-1 text-xs font-semibold transition-all hover:shadow-sm select-none ${bg}`}
                    title={`${sv.sector}: ${sv.view} — click to cycle`}
                  >
                    {sv.sector} <span className="font-bold ml-0.5">{badge}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </CollapsibleSection>

        {/* ── Fundstrat Ideas ── */}
        <div className="grid gap-5 lg:grid-cols-2">
          {/* Top Ideas */}
          <CollapsibleSection
            prefKey="research.fsTop"
            linkedKeys={["research.fsBottom"]}
            className="border-pos-border min-w-0"
            titleClass="text-xl font-bold text-pos"
            title={<>Fundstrat Large-Cap Top Ideas</>}
            subtitle={<>Best long ideas — large-cap names</>}
            right={<><span className="text-sm text-ink-3">{state.fundstratTop.length} names</span></>}
          >

            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead>
                <tr className="border-b-2 border-pos-border text-left">
                  <th className="py-2 pr-2 text-xs font-semibold text-pos w-8">#</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-pos cursor-pointer hover:text-pos select-none" onClick={() => toggleTopSort("ticker")}>Ticker{tArrow("ticker")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-pos text-right cursor-pointer hover:text-pos select-none" onClick={() => toggleTopSort("currentPrice")}>Current Price{tArrow("currentPrice")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-pos text-right cursor-pointer hover:text-pos select-none" onClick={() => toggleTopSort("priceWhenAdded")}>Price Added{tArrow("priceWhenAdded")}</th>
                  <th className="py-2 pr-2 text-xs font-semibold text-pos text-right">Chg</th>
                  <th className="py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {sortedIdeas(state.fundstratTop, topSort).map((item, i) => {
                  const livePrice = livePrices[item.ticker];
                  const pctChange = livePrice && item.priceWhenAdded ? ((livePrice - item.priceWhenAdded) / item.priceWhenAdded * 100) : null;
                  return (
                    <tr key={item.ticker} className={`border-b border-line-soft ${i % 2 === 0 ? "bg-white" : "bg-pos-soft/30"} hover:bg-pos-soft/60 transition-colors`}>
                      <td className="py-2 pr-2 text-ink-3">{i + 1}</td>
                      <td className="py-2 pr-3 font-mono font-bold text-pos">${displayTicker(item.ticker)}</td>
                      <td className="py-2 pr-3 text-right font-mono">
                        {pricesLoading ? (
                          <span className="text-ink-faint animate-pulse">...</span>
                        ) : livePrice != null ? (
                          <span className="font-semibold">${livePrice.toFixed(2)}</span>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        <EditableCell
                          value={item.priceWhenAdded ? `$${item.priceWhenAdded.toFixed(2)}` : "—"}
                          onChange={(v) => updateIdea("fundstratTop", i, v.replace("$", ""))}
                        />
                      </td>
                      <td className="py-2 pr-2 text-right font-mono text-xs">
                        {pctChange != null ? (
                          <span className={pctChange >= 0 ? "text-pos" : "text-neg"}>
                            {pctChange >= 0 ? "+" : ""}{pctChange.toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {scoredStocks.some((s) => s.ticker === item.ticker) ? (
                          <span className="text-[10px] text-pos font-medium">In list</span>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); addToWatchlist(item.ticker); }}
                            className="text-[10px] text-accent hover:text-accent font-semibold transition-colors"
                            title="Add to Watchlist"
                          >
                            + Watch
                          </button>
                        )}
                        <button onClick={() => removeIdea("fundstratTop", item.ticker)} className="ml-2 text-ink-faint hover:text-neg font-bold transition-colors">&times;</button>
                      </td>
                    </tr>
                  );
                })}
                {state.fundstratTop.length === 0 && (
                  <tr><td colSpan={6} className="py-6 text-center text-ink-3 italic">No top ideas added yet</td></tr>
                )}
              </tbody>
            </table></div>

            <IdeaAddForm onAdd={(e) => addIdea("fundstratTop", e)} />

            <ResearchScraperBlock
              source="fundstrat-top"
              sectionLabel="Fundstrat Large-Cap Top Ideas"
              helperText="Upload a Fundstrat Large-Cap Top Ideas screenshot. On Refresh, ticker + entry price are extracted and merged into the list. Re-scans only if the image changes."
              attachments={state.attachments || []}
              onAddAttachment={addAttachment}
              onRemoveAttachment={removeAttachment}
              onScrape={(force) => scrapeResearchSource("fundstrat-top", force)}
              loading={!!scrapeLoadingMap["fundstrat-top"]}
              status={scrapeStatusMap["fundstrat-top"]}
            />
          </CollapsibleSection>

          {/* Bottom Ideas */}
          <CollapsibleSection
            prefKey="research.fsBottom"
            linkedKeys={["research.fsTop"]}
            className="border-neg-border min-w-0"
            titleClass="text-xl font-bold text-neg"
            title={<>Fundstrat Large-Cap Bottom Ideas</>}
            subtitle={<>Names to avoid or short — large-cap</>}
            right={<><span className="text-sm text-ink-3">{state.fundstratBottom.length} names</span></>}
          >

            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead>
                <tr className="border-b-2 border-neg-border text-left">
                  <th className="py-2 pr-2 text-xs font-semibold text-neg w-8">#</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-neg cursor-pointer hover:text-neg select-none" onClick={() => toggleBottomSort("ticker")}>Ticker{bArrow("ticker")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-neg text-right cursor-pointer hover:text-neg select-none" onClick={() => toggleBottomSort("currentPrice")}>Current Price{bArrow("currentPrice")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-neg text-right cursor-pointer hover:text-neg select-none" onClick={() => toggleBottomSort("priceWhenAdded")}>Price Added{bArrow("priceWhenAdded")}</th>
                  <th className="py-2 pr-2 text-xs font-semibold text-neg text-right">Chg</th>
                  <th className="py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {sortedIdeas(state.fundstratBottom, bottomSort).map((item, i) => {
                  const livePrice = livePrices[item.ticker];
                  const pctChange = livePrice && item.priceWhenAdded ? ((livePrice - item.priceWhenAdded) / item.priceWhenAdded * 100) : null;
                  return (
                    <tr key={item.ticker} className={`border-b border-line-soft ${i % 2 === 0 ? "bg-white" : "bg-neg-soft/30"} hover:bg-neg-soft/60 transition-colors`}>
                      <td className="py-2 pr-2 text-ink-3">{i + 1}</td>
                      <td className="py-2 pr-3 font-mono font-bold text-neg">${displayTicker(item.ticker)}</td>
                      <td className="py-2 pr-3 text-right font-mono">
                        {pricesLoading ? (
                          <span className="text-ink-faint animate-pulse">...</span>
                        ) : livePrice != null ? (
                          <span className="font-semibold">${livePrice.toFixed(2)}</span>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        <EditableCell
                          value={item.priceWhenAdded ? `$${item.priceWhenAdded.toFixed(2)}` : "—"}
                          onChange={(v) => updateIdea("fundstratBottom", i, v.replace("$", ""))}
                        />
                      </td>
                      <td className="py-2 pr-2 text-right font-mono text-xs">
                        {pctChange != null ? (
                          <span className={pctChange >= 0 ? "text-pos" : "text-neg"}>
                            {pctChange >= 0 ? "+" : ""}{pctChange.toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {scoredStocks.some((s) => s.ticker === item.ticker) ? (
                          <span className="text-[10px] text-pos font-medium">In list</span>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); addToWatchlist(item.ticker); }}
                            className="text-[10px] text-accent hover:text-accent font-semibold transition-colors"
                            title="Add to Watchlist"
                          >
                            + Watch
                          </button>
                        )}
                        <button onClick={() => removeIdea("fundstratBottom", item.ticker)} className="ml-2 text-ink-faint hover:text-neg font-bold transition-colors">&times;</button>
                      </td>
                    </tr>
                  );
                })}
                {state.fundstratBottom.length === 0 && (
                  <tr><td colSpan={6} className="py-6 text-center text-ink-3 italic">No bottom ideas added yet</td></tr>
                )}
              </tbody>
            </table></div>

            <IdeaAddForm onAdd={(e) => addIdea("fundstratBottom", e)} />

            <ResearchScraperBlock
              source="fundstrat-bottom"
              sectionLabel="Fundstrat Large-Cap Bottom Ideas"
              helperText="Upload a Fundstrat Large-Cap Bottom Ideas screenshot. On Refresh, ticker + entry price are extracted and merged into the list."
              attachments={state.attachments || []}
              onAddAttachment={addAttachment}
              onRemoveAttachment={removeAttachment}
              onScrape={(force) => scrapeResearchSource("fundstrat-bottom", force)}
              loading={!!scrapeLoadingMap["fundstrat-bottom"]}
              status={scrapeStatusMap["fundstrat-bottom"]}
            />
          </CollapsibleSection>
        </div>

        {/* ── Fundstrat SMID-Cap Core Top + Bottom (mirrors the
             Large-Cap pair). Top is positive (buy), Bottom is negative
             (avoid/short, treated identically to Large-Cap Bottom by
             the cross-source synthesis). */}
        <div className="grid gap-5 lg:grid-cols-2">
          {/* SMID Top Ideas */}
          <CollapsibleSection
            prefKey="research.fsSmidTop"
            linkedKeys={["research.fsSmidBottom"]}
            className="border-pos-border min-w-0"
            titleClass="text-xl font-bold text-pos"
            title={<>Fundstrat Top SMID-Cap Core Ideas</>}
            subtitle={<>Best long ideas — small/mid-cap names</>}
            right={<><span className="text-sm text-ink-3">{(state.fundstratSmidTop ?? []).length} names</span></>}
          >

            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead>
                <tr className="border-b-2 border-pos-border text-left">
                  <th className="py-2 pr-2 text-xs font-semibold text-pos w-8">#</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-pos cursor-pointer hover:text-pos select-none" onClick={() => toggleSmidTopSort("ticker")}>Ticker{stArrow("ticker")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-pos text-right cursor-pointer hover:text-pos select-none" onClick={() => toggleSmidTopSort("currentPrice")}>Current Price{stArrow("currentPrice")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-pos text-right cursor-pointer hover:text-pos select-none" onClick={() => toggleSmidTopSort("priceWhenAdded")}>Price Added{stArrow("priceWhenAdded")}</th>
                  <th className="py-2 pr-2 text-xs font-semibold text-pos text-right">Chg</th>
                  <th className="py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {sortedIdeas(state.fundstratSmidTop ?? [], smidTopSort).map((item, i) => {
                  const livePrice = livePrices[item.ticker];
                  const pctChange = livePrice && item.priceWhenAdded ? ((livePrice - item.priceWhenAdded) / item.priceWhenAdded * 100) : null;
                  return (
                    <tr key={item.ticker} className={`border-b border-line-soft ${i % 2 === 0 ? "bg-white" : "bg-pos-soft/30"} hover:bg-pos-soft/60 transition-colors`}>
                      <td className="py-2 pr-2 text-ink-3">{i + 1}</td>
                      <td className="py-2 pr-3 font-mono font-bold text-pos">${displayTicker(item.ticker)}</td>
                      <td className="py-2 pr-3 text-right font-mono">
                        {pricesLoading ? <span className="text-ink-faint animate-pulse">...</span>
                          : livePrice != null ? <span className="font-semibold">${livePrice.toFixed(2)}</span>
                          : <span className="text-ink-faint">—</span>}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        <EditableCell
                          value={item.priceWhenAdded ? `$${item.priceWhenAdded.toFixed(2)}` : "—"}
                          onChange={(v) => updateIdea("fundstratSmidTop", i, v.replace("$", ""))}
                        />
                      </td>
                      <td className="py-2 pr-2 text-right font-mono text-xs">
                        {pctChange != null ? (
                          <span className={pctChange >= 0 ? "text-pos" : "text-neg"}>
                            {pctChange >= 0 ? "+" : ""}{pctChange.toFixed(1)}%
                          </span>
                        ) : <span className="text-ink-faint">—</span>}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {scoredStocks.some((s) => s.ticker === item.ticker) ? (
                          <span className="text-[10px] text-pos font-medium">In list</span>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); addToWatchlist(item.ticker); }}
                            className="text-[10px] text-accent hover:text-accent font-semibold transition-colors"
                            title="Add to Watchlist"
                          >
                            + Watch
                          </button>
                        )}
                        <button onClick={() => removeIdea("fundstratSmidTop", item.ticker)} className="ml-2 text-ink-faint hover:text-neg font-bold transition-colors">&times;</button>
                      </td>
                    </tr>
                  );
                })}
                {(state.fundstratSmidTop ?? []).length === 0 && (
                  <tr><td colSpan={6} className="py-6 text-center text-ink-3 italic">No top SMID ideas added yet</td></tr>
                )}
              </tbody>
            </table></div>

            <IdeaAddForm onAdd={(e) => addIdea("fundstratSmidTop", e)} />

            <ResearchScraperBlock
              source="fundstrat-smid-top"
              sectionLabel="Fundstrat Top SMID-Cap Core Ideas"
              helperText="Upload a Fundstrat Top SMID-Cap Core Ideas screenshot. On Refresh, ticker + entry price are extracted and merged into the list."
              attachments={state.attachments || []}
              onAddAttachment={addAttachment}
              onRemoveAttachment={removeAttachment}
              onScrape={(force) => scrapeResearchSource("fundstrat-smid-top", force)}
              loading={!!scrapeLoadingMap["fundstrat-smid-top"]}
              status={scrapeStatusMap["fundstrat-smid-top"]}
            />
          </CollapsibleSection>

          {/* SMID Bottom Ideas */}
          <CollapsibleSection
            prefKey="research.fsSmidBottom"
            linkedKeys={["research.fsSmidTop"]}
            className="border-neg-border min-w-0"
            titleClass="text-xl font-bold text-neg"
            title={<>Fundstrat Bottom SMID-Cap Core Ideas</>}
            subtitle={<>Names to avoid or short — small/mid-cap</>}
            right={<><span className="text-sm text-ink-3">{(state.fundstratSmidBottom ?? []).length} names</span></>}
          >

            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead>
                <tr className="border-b-2 border-neg-border text-left">
                  <th className="py-2 pr-2 text-xs font-semibold text-neg w-8">#</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-neg cursor-pointer hover:text-neg select-none" onClick={() => toggleSmidBottomSort("ticker")}>Ticker{sbArrow("ticker")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-neg text-right cursor-pointer hover:text-neg select-none" onClick={() => toggleSmidBottomSort("currentPrice")}>Current Price{sbArrow("currentPrice")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-neg text-right cursor-pointer hover:text-neg select-none" onClick={() => toggleSmidBottomSort("priceWhenAdded")}>Price Added{sbArrow("priceWhenAdded")}</th>
                  <th className="py-2 pr-2 text-xs font-semibold text-neg text-right">Chg</th>
                  <th className="py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {sortedIdeas(state.fundstratSmidBottom ?? [], smidBottomSort).map((item, i) => {
                  const livePrice = livePrices[item.ticker];
                  const pctChange = livePrice && item.priceWhenAdded ? ((livePrice - item.priceWhenAdded) / item.priceWhenAdded * 100) : null;
                  return (
                    <tr key={item.ticker} className={`border-b border-line-soft ${i % 2 === 0 ? "bg-white" : "bg-neg-soft/30"} hover:bg-neg-soft/60 transition-colors`}>
                      <td className="py-2 pr-2 text-ink-3">{i + 1}</td>
                      <td className="py-2 pr-3 font-mono font-bold text-neg">${displayTicker(item.ticker)}</td>
                      <td className="py-2 pr-3 text-right font-mono">
                        {pricesLoading ? <span className="text-ink-faint animate-pulse">...</span>
                          : livePrice != null ? <span className="font-semibold">${livePrice.toFixed(2)}</span>
                          : <span className="text-ink-faint">—</span>}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        <EditableCell
                          value={item.priceWhenAdded ? `$${item.priceWhenAdded.toFixed(2)}` : "—"}
                          onChange={(v) => updateIdea("fundstratSmidBottom", i, v.replace("$", ""))}
                        />
                      </td>
                      <td className="py-2 pr-2 text-right font-mono text-xs">
                        {pctChange != null ? (
                          <span className={pctChange >= 0 ? "text-pos" : "text-neg"}>
                            {pctChange >= 0 ? "+" : ""}{pctChange.toFixed(1)}%
                          </span>
                        ) : <span className="text-ink-faint">—</span>}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {scoredStocks.some((s) => s.ticker === item.ticker) ? (
                          <span className="text-[10px] text-pos font-medium">In list</span>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); addToWatchlist(item.ticker); }}
                            className="text-[10px] text-accent hover:text-accent font-semibold transition-colors"
                            title="Add to Watchlist"
                          >
                            + Watch
                          </button>
                        )}
                        <button onClick={() => removeIdea("fundstratSmidBottom", item.ticker)} className="ml-2 text-ink-faint hover:text-neg font-bold transition-colors">&times;</button>
                      </td>
                    </tr>
                  );
                })}
                {(state.fundstratSmidBottom ?? []).length === 0 && (
                  <tr><td colSpan={6} className="py-6 text-center text-ink-3 italic">No bottom SMID ideas added yet</td></tr>
                )}
              </tbody>
            </table></div>

            <IdeaAddForm onAdd={(e) => addIdea("fundstratSmidBottom", e)} />

            <ResearchScraperBlock
              source="fundstrat-smid-bottom"
              sectionLabel="Fundstrat Bottom SMID-Cap Core Ideas"
              helperText="Upload a Fundstrat Bottom SMID-Cap Core Ideas screenshot. On Refresh, ticker + entry price are extracted and merged into the list."
              attachments={state.attachments || []}
              onAddAttachment={addAttachment}
              onRemoveAttachment={removeAttachment}
              onScrape={(force) => scrapeResearchSource("fundstrat-smid-bottom", force)}
              loading={!!scrapeLoadingMap["fundstrat-smid-bottom"]}
              status={scrapeStatusMap["fundstrat-smid-bottom"]}
            />
          </CollapsibleSection>
        </div>

        {/* ── Tom Lee Focus Areas ── */}
        <CollapsibleSection
          prefKey="research.leeFocus"
          className="border-warn-border"
          titleClass="text-lg font-bold text-warn"
          title={<>Tom Lee&apos;s Focus Areas</>}
          subtitle={<>Key themes and areas Lee is emphasizing — type freely, these feed into the morning brief</>}
          right={<><span className="text-sm text-ink-3">{(state.leeFocusAreas ?? []).length} themes</span></>}
        >
          <div className="flex flex-wrap gap-2 mb-3">
            {(state.leeFocusAreas ?? []).map((area, idx) => (
              <span
                key={idx}
                className="inline-flex items-center gap-1 rounded-full border border-warn-border bg-warn-soft px-3 py-1 text-sm font-medium text-warn"
              >
                {area.label}
                <button
                  onClick={() => {
                    const updated = (state.leeFocusAreas ?? []).filter((_, i) => i !== idx);
                    save({ ...state, leeFocusAreas: updated });
                  }}
                  className="ml-0.5 text-warn hover:text-neg font-bold transition-colors text-xs"
                  title="Remove"
                >
                  &times;
                </button>
              </span>
            ))}
            {(state.leeFocusAreas ?? []).length === 0 && (
              <span className="text-sm text-ink-3 italic">No focus areas added yet</span>
            )}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const input = (e.currentTarget.elements.namedItem("leeArea") as HTMLInputElement);
              const val = input.value.trim();
              if (!val) return;
              save({
                ...state,
                leeFocusAreas: [...(state.leeFocusAreas ?? []), { label: val }],
              });
              input.value = "";
            }}
          >
            <input
              name="leeArea"
              placeholder="e.g. AI infrastructure, GARP names, epicenter stocks…"
              className="flex-1 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm outline-none placeholder:text-ink-3 focus:bg-white focus:border-warn-border focus:ring-1 focus:ring-warn-border transition-all"
            />
            <button
              type="submit"
              className="rounded-xl bg-warn px-4 py-2 text-sm font-semibold text-white hover:bg-warn transition-colors"
            >
              Add
            </button>
          </form>
        </CollapsibleSection>

        {/* ── RBC Canadian Focus List ── */}
        <CollapsibleSection
          prefKey="research.rbcCa"
          className="border-accent-border"
          titleClass="text-xl font-bold text-accent"
          title={<>RBC Canadian Focus List</>}
          subtitle={<>RBC Capital Markets Canadian equity picks</>}
          right={<><span className="text-sm text-ink-3">{(state.rbcCanadianFocus || []).length} names</span></>}
        >

          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-accent-border text-left">
                <th className="py-2 pr-2 text-xs font-semibold text-accent w-8">#</th>
                <th className="py-2 pr-3 text-xs font-semibold text-accent cursor-pointer hover:text-accent select-none" onClick={() => toggleRbcSort("ticker")}>Ticker{rArrow("ticker")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-accent cursor-pointer hover:text-accent select-none" onClick={() => toggleRbcSort("name")}>Name{rArrow("name")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-accent cursor-pointer hover:text-accent select-none" onClick={() => toggleRbcSort("sector")}>Sector{rArrow("sector")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-accent cursor-pointer hover:text-accent select-none" onClick={() => toggleRbcSort("weight")}>Weight (%){rArrow("weight")}</th>
                <th className="py-2 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {sortedRbc().map((item, i) => (
                <tr key={item.ticker} className={`border-b border-line-soft ${i % 2 === 0 ? "bg-white" : "bg-accent-soft/30"} hover:bg-accent-soft/60 transition-colors`}>
                  <td className="py-2 pr-2 text-ink-3">{i + 1}</td>
                  <td className="py-2 pr-3 font-mono font-bold text-accent">${displayTicker(item.ticker)}</td>
                  <td className="py-2 pr-3 text-ink-2 truncate max-w-[260px]" title={item.name || item.ticker}>{item.name || <span className="text-ink-faint italic">—</span>}</td>
                  <td className="py-2 pr-3 text-ink-2">{item.sector}</td>
                  <td className="py-2 pr-3 text-ink-3">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={item.weight ?? 0}
                      onChange={(e) => {
                        const val = e.target.value;
                        const list = [...(state.rbcCanadianFocus || [])];
                        const idx = list.findIndex((r) => r.ticker === item.ticker);
                        if (idx >= 0) {
                          list[idx] = { ...list[idx], weight: val === "" || val === "-" ? 0 : parseFloat(val) || 0 };
                          save({ ...state, rbcCanadianFocus: list });
                        }
                      }}
                      className="w-16 rounded border border-transparent px-1 py-0.5 text-sm text-center hover:border-line focus:border-accent-border focus:outline-none bg-transparent"
                    />
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {scoredStocks.some((s) => s.ticker === item.ticker) ? (
                      <span className="text-[10px] text-pos font-medium">In list</span>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); addToWatchlist(item.ticker); }}
                        className="text-[10px] text-accent hover:text-accent font-semibold transition-colors"
                        title="Add to Watchlist"
                      >
                        + Watch
                      </button>
                    )}
                    <button onClick={() => removeRbc(item.ticker)} className="ml-2 text-ink-faint hover:text-neg font-bold transition-colors">&times;</button>
                  </td>
                </tr>
              ))}
              {(state.rbcCanadianFocus || []).length === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-ink-3 italic">No names added yet</td></tr>
              )}
            </tbody>
          </table></div>

          <RBCAddForm onAdd={addRbc} />

          <ResearchScraperBlock
            source="rbc-focus"
            sectionLabel="RBC Canadian Focus List"
            helperText="Upload an RBC Canadian Focus List screenshot. On Refresh, ticker + sector + weight + date are extracted and merged."
            attachments={state.attachments || []}
            onAddAttachment={addAttachment}
            onRemoveAttachment={removeAttachment}
            onScrape={(force) => scrapeResearchSource("rbc-focus", force)}
            loading={!!scrapeLoadingMap["rbc-focus"]}
            status={scrapeStatusMap["rbc-focus"]}
          />
        </CollapsibleSection>

        {/* ── RBC US Focus List ──
            Parallel to the Canadian list. Same RBCEntry shape, same
            manual-add + screenshot-scan flow; targets state.rbcUsFocus
            so the two stay independent. Section is teal-accented to
            visually distinguish it from the blue Canadian section. */}
        <CollapsibleSection
          prefKey="research.rbcUs"
          className="border-accent-border"
          titleClass="text-xl font-bold text-accent"
          title={<>RBC US Focus List</>}
          subtitle={<>RBC Capital Markets US equity picks</>}
          right={<><span className="text-sm text-ink-3">{(state.rbcUsFocus || []).length} names</span></>}
        >

          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-accent-border text-left">
                <th className="py-2 pr-2 text-xs font-semibold text-accent w-8">#</th>
                <th className="py-2 pr-3 text-xs font-semibold text-accent cursor-pointer hover:text-accent select-none" onClick={() => toggleRbcUsSort("ticker")}>Ticker{rUsArrow("ticker")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-accent cursor-pointer hover:text-accent select-none" onClick={() => toggleRbcUsSort("name")}>Name{rUsArrow("name")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-accent cursor-pointer hover:text-accent select-none" onClick={() => toggleRbcUsSort("sector")}>Sector{rUsArrow("sector")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-accent cursor-pointer hover:text-accent select-none" onClick={() => toggleRbcUsSort("weight")}>Weight (%){rUsArrow("weight")}</th>
                <th className="py-2 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {sortedRbcUs().map((item, i) => (
                <tr key={item.ticker} className={`border-b border-line-soft ${i % 2 === 0 ? "bg-white" : "bg-accent-soft/30"} hover:bg-accent-soft/60 transition-colors`}>
                  <td className="py-2 pr-2 text-ink-3">{i + 1}</td>
                  <td className="py-2 pr-3 font-mono font-bold text-accent">${displayTicker(item.ticker)}</td>
                  <td className="py-2 pr-3 text-ink-2 truncate max-w-[260px]" title={item.name || item.ticker}>{item.name || <span className="text-ink-faint italic">—</span>}</td>
                  <td className="py-2 pr-3 text-ink-2">{item.sector}</td>
                  <td className="py-2 pr-3 text-ink-3">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={item.weight ?? 0}
                      onChange={(e) => {
                        const val = e.target.value;
                        const list = [...(state.rbcUsFocus || [])];
                        const idx = list.findIndex((r) => r.ticker === item.ticker);
                        if (idx >= 0) {
                          list[idx] = { ...list[idx], weight: val === "" || val === "-" ? 0 : parseFloat(val) || 0 };
                          save({ ...state, rbcUsFocus: list });
                        }
                      }}
                      className="w-16 rounded border border-transparent px-1 py-0.5 text-sm text-center hover:border-line focus:border-accent-border focus:outline-none bg-transparent"
                    />
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {scoredStocks.some((s) => s.ticker === item.ticker) ? (
                      <span className="text-[10px] text-pos font-medium">In list</span>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); addToWatchlist(item.ticker); }}
                        className="text-[10px] text-accent hover:text-accent font-semibold transition-colors"
                        title="Add to Watchlist"
                      >
                        + Watch
                      </button>
                    )}
                    <button onClick={() => removeRbcUs(item.ticker)} className="ml-2 text-ink-faint hover:text-neg font-bold transition-colors">&times;</button>
                  </td>
                </tr>
              ))}
              {(state.rbcUsFocus || []).length === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-ink-3 italic">No names added yet</td></tr>
              )}
            </tbody>
          </table></div>

          <RBCAddForm onAdd={addRbcUs} />

          <ResearchScraperBlock
            source="rbc-us-focus"
            sectionLabel="RBC US Focus List"
            helperText="Upload an RBC US Focus List screenshot. On Refresh, ticker + sector + weight + date are extracted and merged."
            attachments={state.attachments || []}
            onAddAttachment={addAttachment}
            onRemoveAttachment={removeAttachment}
            onScrape={(force) => scrapeResearchSource("rbc-us-focus", force)}
            loading={!!scrapeLoadingMap["rbc-us-focus"]}
            status={scrapeStatusMap["rbc-us-focus"]}
          />
        </CollapsibleSection>

        {/* ── JPM US Equity Analyst Focus List ──
            J.P. Morgan's US equity analyst focus picks. Columns: company name,
            ticker, industry, strategy, current price (LIVE from FactSet via
            /api/factset-prices), price target. Stored on state.jpmUsAnalystFocus
            (RBCEntry + optional industry/strategy/priceTarget); auto-tallies into
            researchMentions via SOURCES. Amber-accented. */}
        <CollapsibleSection
          prefKey="research.jpm"
          className="border-warn-border"
          titleClass="text-xl font-bold text-warn"
          title={<>JPM US Equity Analyst Focus List</>}
          subtitle={<>J.P. Morgan US equity analyst focus picks · prices live from FactSet</>}
          right={<span className="text-sm text-ink-3">{(state.jpmUsAnalystFocus || []).length} names</span>}
        >

          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-warn-border text-left">
                <th className="py-2 pr-3 text-xs font-semibold text-warn cursor-pointer hover:text-warn select-none" onClick={() => toggleJpmFocusSort("name")}>Company name{jArrow("name")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-warn cursor-pointer hover:text-warn select-none" onClick={() => toggleJpmFocusSort("ticker")}>Ticker{jArrow("ticker")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-warn cursor-pointer hover:text-warn select-none" onClick={() => toggleJpmFocusSort("industry")}>Sector{jArrow("industry")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-warn cursor-pointer hover:text-warn select-none" onClick={() => toggleJpmFocusSort("strategy")}>Strategy{jArrow("strategy")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-warn text-right cursor-pointer hover:text-warn select-none" onClick={() => toggleJpmFocusSort("currentPrice")}>Current price{jArrow("currentPrice")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-warn text-right cursor-pointer hover:text-warn select-none" onClick={() => toggleJpmFocusSort("priceTarget")}>Price target{jArrow("priceTarget")}</th>
                <th className="py-2 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {sortedJpmFocus().map((item, i) => {
                const fsPrice = factsetPrices[item.ticker];
                return (
                <tr key={item.ticker} className={`border-b border-line-soft ${i % 2 === 0 ? "bg-white" : "bg-warn-soft/30"} hover:bg-warn-soft/60 transition-colors`}>
                  <td className="py-2 pr-3 text-ink-2 truncate max-w-[240px]" title={item.name || item.ticker}>{item.name || <span className="text-ink-faint italic">—</span>}</td>
                  <td className="py-2 pr-3 font-mono font-bold text-warn">${displayTicker(item.ticker)}</td>
                  <td className="py-2 pr-3 text-ink-2 truncate max-w-[180px]" title={factsetSectors[item.ticker] || item.industry || ""}>{factsetSectors[item.ticker] || item.industry || <span className="text-ink-faint">—</span>}</td>
                  <td className="py-2 pr-3 text-ink-2">{item.strategy || <span className="text-ink-faint">—</span>}</td>
                  <td className="py-2 pr-3 text-right font-mono text-ink-2 whitespace-nowrap">
                    {typeof fsPrice === "number" ? `$${fsPrice.toFixed(2)}` : <span className="text-ink-faint">—</span>}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-ink-2 whitespace-nowrap">
                    {typeof item.priceTarget === "number" ? `$${item.priceTarget.toFixed(2)}` : <span className="text-ink-faint">—</span>}
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {scoredStocks.some((s) => s.ticker === item.ticker) ? (
                      <span className="text-[10px] text-pos font-medium">In list</span>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); addToWatchlist(item.ticker); }}
                        className="text-[10px] text-accent hover:text-accent font-semibold transition-colors"
                        title="Add to Watchlist"
                      >
                        + Watch
                      </button>
                    )}
                    <button onClick={() => removeJpmFocus(item.ticker)} className="ml-2 text-ink-faint hover:text-neg font-bold transition-colors">&times;</button>
                  </td>
                </tr>
                );
              })}
              {(state.jpmUsAnalystFocus || []).length === 0 && (
                <tr><td colSpan={7} className="py-6 text-center text-ink-3 italic">No names added yet</td></tr>
              )}
            </tbody>
          </table></div>

          <RBCAddForm onAdd={addJpmFocus} />

          <ResearchScraperBlock
            source="jpm-us-analyst-focus"
            sectionLabel="JPM US Equity Analyst Focus List"
            helperText="Upload a JPM US Equity Analyst Focus List screenshot. On Refresh, company name + ticker + industry + strategy + price target are extracted; current price comes live from FactSet."
            attachments={state.attachments || []}
            onAddAttachment={addAttachment}
            onRemoveAttachment={removeAttachment}
            onScrape={(force) => scrapeResearchSource("jpm-us-analyst-focus", force)}
            loading={!!scrapeLoadingMap["jpm-us-analyst-focus"]}
            status={scrapeStatusMap["jpm-us-analyst-focus"]}
          />
        </CollapsibleSection>

        {/* ── RBC Equate — Canada Large Cap CORE 40 ──
            Models the RBC US Focus card exactly. Same RBCEntry shape,
            same manual-add + screenshot-scan flow; targets state.equateCad
            (Canadian/.TO tickers). Sky-accented as its own section. */}
        <CollapsibleSection
          prefKey="research.equateCad"
          className="border-accent-border"
          titleClass="text-xl font-bold text-accent"
          title={<>RBC Equate — Canada Large Cap CORE 40</>}
          subtitle={<>RBC Equate Canada Large Cap CORE 40 Model Portfolio</>}
          right={<><span className="text-sm text-ink-3">{(state.equateCad || []).length} names</span></>}
        >

          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-accent-border text-left">
                <th className="py-2 pr-3 text-xs font-semibold text-accent cursor-pointer hover:text-accent select-none" onClick={() => toggleEquateCadSort("name")}>Company name{ecArrow("name")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-accent cursor-pointer hover:text-accent select-none" onClick={() => toggleEquateCadSort("ticker")}>Ticker{ecArrow("ticker")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-accent cursor-pointer hover:text-accent select-none" onClick={() => toggleEquateCadSort("industry")}>Sector{ecArrow("industry")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-accent text-right cursor-pointer hover:text-accent select-none" onClick={() => toggleEquateCadSort("currentPrice")}>Current price{ecArrow("currentPrice")}</th>
                <th className="py-2 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {sortedEquateCad().map((item, i) => {
                const fsPrice = factsetPrices[item.ticker];
                return (
                <tr key={item.ticker} className={`border-b border-line-soft ${i % 2 === 0 ? "bg-white" : "bg-accent-soft/30"} hover:bg-accent-soft/60 transition-colors`}>
                  <td className="py-2 pr-3 text-ink-2 truncate max-w-[240px]" title={item.name || item.ticker}>{item.name || <span className="text-ink-faint italic">—</span>}</td>
                  <td className="py-2 pr-3 font-mono font-bold text-accent">${displayTicker(item.ticker)}</td>
                  <td className="py-2 pr-3 text-ink-2 truncate max-w-[180px]" title={factsetSectors[item.ticker] || item.industry || ""}>{factsetSectors[item.ticker] || item.industry || <span className="text-ink-faint">—</span>}</td>
                  <td className="py-2 pr-3 text-right font-mono text-ink-2 whitespace-nowrap">{typeof fsPrice === "number" ? `$${fsPrice.toFixed(2)}` : <span className="text-ink-faint">—</span>}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {scoredStocks.some((s) => s.ticker === item.ticker) ? (
                      <span className="text-[10px] text-pos font-medium">In list</span>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); addToWatchlist(item.ticker); }}
                        className="text-[10px] text-accent hover:text-accent font-semibold transition-colors"
                        title="Add to Watchlist"
                      >
                        + Watch
                      </button>
                    )}
                    <button onClick={() => removeEquateCad(item.ticker)} className="ml-2 text-ink-faint hover:text-neg font-bold transition-colors">&times;</button>
                  </td>
                </tr>
                );
              })}
              {(state.equateCad || []).length === 0 && (
                <tr><td colSpan={5} className="py-6 text-center text-ink-3 italic">No names added yet</td></tr>
              )}
            </tbody>
          </table></div>

          <RBCAddForm onAdd={addEquateCad} />

          <ResearchScraperBlock
            source="rbc-equate-cad"
            sectionLabel="RBC Equate — Canada Large Cap CORE 40"
            helperText="Upload the RBC Equate PDF. On Refresh, ONLY the Canada Large Cap CORE 40 Model Portfolio is read (other lists ignored) — company name + ticker + industry are extracted; current price is live from FactSet."
            attachments={state.attachments || []}
            onAddAttachment={addAttachment}
            onRemoveAttachment={removeAttachment}
            onScrape={(force) => scrapeResearchSource("rbc-equate-cad", force)}
            loading={!!scrapeLoadingMap["rbc-equate-cad"]}
            status={scrapeStatusMap["rbc-equate-cad"]}
          />
        </CollapsibleSection>

        {/* ── RBC Equate — U.S. All Cap CORE 40 ──
            Models the RBC US Focus card exactly. Same RBCEntry shape,
            same manual-add + screenshot-scan flow; targets state.equateUsd
            (US bare tickers). Sky-accented as its own section. */}
        <CollapsibleSection
          prefKey="research.equateUsd"
          className="border-accent-border"
          titleClass="text-xl font-bold text-accent"
          title={<>RBC Equate — U.S. All Cap CORE 40</>}
          subtitle={<>RBC Equate U.S. All Cap CORE 40 Model Portfolio</>}
          right={<><span className="text-sm text-ink-3">{(state.equateUsd || []).length} names</span></>}
        >

          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-accent-border text-left">
                <th className="py-2 pr-3 text-xs font-semibold text-accent cursor-pointer hover:text-accent select-none" onClick={() => toggleEquateUsdSort("name")}>Company name{euArrow("name")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-accent cursor-pointer hover:text-accent select-none" onClick={() => toggleEquateUsdSort("ticker")}>Ticker{euArrow("ticker")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-accent cursor-pointer hover:text-accent select-none" onClick={() => toggleEquateUsdSort("industry")}>Sector{euArrow("industry")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-accent text-right cursor-pointer hover:text-accent select-none" onClick={() => toggleEquateUsdSort("currentPrice")}>Current price{euArrow("currentPrice")}</th>
                <th className="py-2 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {sortedEquateUsd().map((item, i) => {
                const fsPrice = factsetPrices[item.ticker];
                return (
                <tr key={item.ticker} className={`border-b border-line-soft ${i % 2 === 0 ? "bg-white" : "bg-accent-soft/30"} hover:bg-accent-soft/60 transition-colors`}>
                  <td className="py-2 pr-3 text-ink-2 truncate max-w-[240px]" title={item.name || item.ticker}>{item.name || <span className="text-ink-faint italic">—</span>}</td>
                  <td className="py-2 pr-3 font-mono font-bold text-accent">${displayTicker(item.ticker)}</td>
                  <td className="py-2 pr-3 text-ink-2 truncate max-w-[180px]" title={factsetSectors[item.ticker] || item.industry || ""}>{factsetSectors[item.ticker] || item.industry || <span className="text-ink-faint">—</span>}</td>
                  <td className="py-2 pr-3 text-right font-mono text-ink-2 whitespace-nowrap">{typeof fsPrice === "number" ? `$${fsPrice.toFixed(2)}` : <span className="text-ink-faint">—</span>}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {scoredStocks.some((s) => s.ticker === item.ticker) ? (
                      <span className="text-[10px] text-pos font-medium">In list</span>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); addToWatchlist(item.ticker); }}
                        className="text-[10px] text-accent hover:text-accent font-semibold transition-colors"
                        title="Add to Watchlist"
                      >
                        + Watch
                      </button>
                    )}
                    <button onClick={() => removeEquateUsd(item.ticker)} className="ml-2 text-ink-faint hover:text-neg font-bold transition-colors">&times;</button>
                  </td>
                </tr>
                );
              })}
              {(state.equateUsd || []).length === 0 && (
                <tr><td colSpan={5} className="py-6 text-center text-ink-3 italic">No names added yet</td></tr>
              )}
            </tbody>
          </table></div>

          <RBCAddForm onAdd={addEquateUsd} />

          <ResearchScraperBlock
            source="rbc-equate-usd"
            sectionLabel="RBC Equate — U.S. All Cap CORE 40"
            helperText="Upload the RBC Equate PDF. On Refresh, ONLY the U.S. All Cap CORE 40 Model Portfolio is read (other lists ignored) — company name + ticker + industry are extracted; current price is live from FactSet."
            attachments={state.attachments || []}
            onAddAttachment={addAttachment}
            onRemoveAttachment={removeAttachment}
            onScrape={(force) => scrapeResearchSource("rbc-equate-usd", force)}
            loading={!!scrapeLoadingMap["rbc-equate-usd"]}
            status={scrapeStatusMap["rbc-equate-usd"]}
          />
        </CollapsibleSection>

        {/* ── RBCCM Canadian Fundamental Equity Weighting (FEW) Portfolio ──
            Canadian equity list. Tickers in the screenshot omit the
            suffix, so the scrape canonicalizes to ".TO". Only the four
            columns the PM tracks are captured: ticker, company, industry,
            price. Indigo-accented to distinguish from the RBC focus lists. */}
        <CollapsibleSection
          prefKey="research.few"
          className="border-violet-soft"
          titleClass="text-xl font-bold text-violet"
          title={<>RBCCM Canadian FEW Portfolio</>}
          subtitle={<>RBC Capital Markets Canadian Fundamental Equity Weighting portfolio</>}
          right={<><span className="text-sm text-ink-3">{(state.rbccmFew || []).length} names</span></>}
        >

          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-violet-soft text-left">
                <th className="py-2 pr-2 text-xs font-semibold text-violet w-8">#</th>
                <th className="py-2 pr-3 text-xs font-semibold text-violet cursor-pointer hover:text-violet select-none" onClick={() => toggleFewSort("ticker")}>Ticker{fArrow("ticker")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-violet cursor-pointer hover:text-violet select-none" onClick={() => toggleFewSort("name")}>Company{fArrow("name")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-violet cursor-pointer hover:text-violet select-none" onClick={() => toggleFewSort("industry")}>Industry{fArrow("industry")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-violet cursor-pointer hover:text-violet select-none text-right" onClick={() => toggleFewSort("price")}>Price{fArrow("price")}</th>
                <th className="py-2 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {sortedFew().map((item, i) => {
                const px = fewPrice(item);
                return (
                <tr key={item.ticker} className={`border-b border-line-soft ${i % 2 === 0 ? "bg-white" : "bg-violet-soft/30"} hover:bg-violet-soft/60 transition-colors`}>
                  <td className="py-2 pr-2 text-ink-3">{i + 1}</td>
                  <td className="py-2 pr-3 font-mono font-bold text-violet">${displayTicker(item.ticker)}</td>
                  <td className="py-2 pr-3 text-ink-2 truncate max-w-[260px]" title={item.name || item.ticker}>{item.name || <span className="text-ink-faint italic">—</span>}</td>
                  <td className="py-2 pr-3 text-ink-2">{item.industry || <span className="text-ink-faint italic">—</span>}</td>
                  <td className="py-2 pr-3 text-ink-2 text-right font-mono">{px > 0 ? `$${px.toFixed(2)}` : <span className="text-ink-faint">—</span>}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {scoredStocks.some((s) => s.ticker === item.ticker) ? (
                      <span className="text-[10px] text-pos font-medium">In list</span>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); addToWatchlist(item.ticker); }}
                        className="text-[10px] text-violet hover:text-violet font-semibold transition-colors"
                        title="Add to Watchlist"
                      >
                        + Watch
                      </button>
                    )}
                    <button onClick={() => removeFew(item.ticker)} className="ml-2 text-ink-faint hover:text-neg font-bold transition-colors">&times;</button>
                  </td>
                </tr>
                );
              })}
              {(state.rbccmFew || []).length === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-ink-3 italic">No names added yet</td></tr>
              )}
            </tbody>
          </table></div>

          <FewAddForm onAdd={addFew} />

          <ResearchScraperBlock
            source="rbccm-few"
            sectionLabel="RBCCM Canadian FEW Portfolio"
            helperText="Upload an RBCCM Canadian FEW Portfolio screenshot. On Refresh, ticker (auto-suffixed .TO) + company + industry + price are extracted and merged."
            attachments={state.attachments || []}
            onAddAttachment={addAttachment}
            onRemoveAttachment={removeAttachment}
            onScrape={(force) => scrapeResearchSource("rbccm-few", force)}
            loading={!!scrapeLoadingMap["rbccm-few"]}
            status={scrapeStatusMap["rbccm-few"]}
          />
        </CollapsibleSection>

        {/* ── Seeking Alpha - Alpha Picks ──
            Mirrors the Newton's Upticks layout: name + sector + price
            + entry + dateAdded + change columns, screenshot-first flow
            with a manual add fallback. The screenshot is the primary
            input; the manual form covers the case where you want to
            log a pick without screenshotting. */}
        <CollapsibleSection
          prefKey="research.alpha"
          className="border-line"
          titleClass="text-xl font-bold"
          title={<>Seeking Alpha &mdash; Alpha Picks</>}
          subtitle={<>Institutional buy recommendations &mdash; primarily populated by uploading the Alpha Picks dashboard screenshot. Manual adds also work.</>}
          right={<><span className="text-sm text-ink-3">{(state.alphaPicks ?? []).length} picks</span></>}
        >
          {(() => {
            // ── Derived data for the Alpha Picks section ────────────
            const allPicks = state.alphaPicks ?? [];
            // Normalize ratings to a small set of canonical labels for
            // filter buttons + color coding. SA badge text varies
            // slightly ("Strong Buy" vs "STRONG BUY") so we lower-case
            // and Title-case for the button label and use a tone map
            // for the color.
            const norm = (r: string | undefined) => (r || "").trim().toLowerCase();
            const canonicalRating = (r: string | undefined): string | null => {
              const n = norm(r);
              if (n === "strong buy") return "Strong Buy";
              if (n === "buy") return "Buy";
              if (n === "hold") return "Hold";
              if (n === "sell") return "Sell";
              if (n === "strong sell") return "Strong Sell";
              return null;
            };
            // Bucket assignment for the filter chips. Manual-sell
            // overrides SA's rating so the PM can find their flagged
            // positions in a single filter regardless of what SA
            // still says.
            const bucket = (p: AlphaPickEntry): string => {
              if (p.manualSell) return "Manual Sell";
              return canonicalRating(p.rating) ?? "(unrated)";
            };
            const ratingTone = (r: string | undefined): string => {
              const c = canonicalRating(r);
              if (c === "Strong Buy") return "bg-pos text-white";
              if (c === "Buy") return "bg-pos-soft text-pos ring-1 ring-pos-border";
              if (c === "Hold") return "bg-warn-soft text-warn ring-1 ring-warn-border";
              if (c === "Sell") return "bg-neg-soft text-neg ring-1 ring-neg-border";
              if (c === "Strong Sell") return "bg-neg text-white";
              return "bg-surface-2 text-ink-3";
            };
            const manualSellTone = "bg-neg text-white";

            // Sell candidates per SA's rules + the PM's manual flag:
            //   - Rating is Sell or Strong Sell → SA sells.
            //   - Hold for 180+ days → SA sells.
            //   - Manually marked for sale by the PM → treated identically.
            // All three flow through the "Drop sell candidates" button
            // and trigger weight redistribution per SA's rule.
            const daysSince = (d: string | undefined): number | null => {
              if (!d) return null;
              const t = Date.parse(d);
              if (isNaN(t)) return null;
              return Math.floor((Date.now() - t) / 86400000);
            };
            const isSellCandidate = (pick: AlphaPickEntry): boolean => {
              if (pick.manualSell) return true;
              const c = canonicalRating(pick.rating);
              if (c === "Sell" || c === "Strong Sell") return true;
              if (c === "Hold") {
                const days = daysSince(pick.dateAdded);
                if (days != null && days >= 180) return true;
              }
              return false;
            };

            // Counts per filter button.
            const counts: Record<string, number> = { All: allPicks.length };
            for (const p of allPicks) {
              const b = bucket(p);
              counts[b] = (counts[b] || 0) + 1;
            }
            const filterButtons: Array<{ key: string | null; label: string }> = [
              { key: null, label: "All" },
              { key: "Strong Buy", label: "Strong Buy" },
              { key: "Buy", label: "Buy" },
              { key: "Hold", label: "Hold" },
              { key: "Sell", label: "Sell" },
              { key: "Strong Sell", label: "Strong Sell" },
              { key: "Manual Sell", label: "Manual Sell" },
              { key: "(unrated)", label: "Unrated" },
            ];

            // Apply the rating filter.
            const filteredPicks = alphaRatingFilter == null
              ? allPicks
              : allPicks.filter((p) => bucket(p) === alphaRatingFilter);

            // Apply column sort. Numeric fields use signed comparison;
            // strings use locale-aware compare. Missing values sort to the
            // end regardless of direction (so an unfilled Holding %
            // doesn't accidentally float to the top of an ascending sort).
            // The ratingOrder array gives Strong Sell → Strong Buy a
            // natural ordinal for the Rating column.
            const ratingOrder: Record<string, number> = {
              "strong sell": 0,
              "sell": 1,
              "(unrated)": 2,
              "hold": 3,
              "buy": 4,
              "strong buy": 5,
            };
            const cmpNum = (a: number | null | undefined, b: number | null | undefined): number => {
              if (a == null && b == null) return 0;
              if (a == null) return 1; // nulls always last
              if (b == null) return -1;
              return a - b;
            };
            const cmpStr = (a: string | null | undefined, b: string | null | undefined): number => {
              const av = (a ?? "").trim();
              const bv = (b ?? "").trim();
              if (!av && !bv) return 0;
              if (!av) return 1;
              if (!bv) return -1;
              return av.localeCompare(bv);
            };
            const visiblePicks = [...filteredPicks].sort((a, b) => {
              let cmp = 0;
              switch (alphaSort.key) {
                case "name": cmp = cmpStr(a.name, b.name); break;
                case "ticker": cmp = cmpStr(a.ticker, b.ticker); break;
                case "sector": cmp = cmpStr(a.sector, b.sector); break;
                case "rating": {
                  const ar = ratingOrder[(a.rating || "(unrated)").toLowerCase()] ?? -1;
                  const br = ratingOrder[(b.rating || "(unrated)").toLowerCase()] ?? -1;
                  cmp = ar - br;
                  break;
                }
                case "holdingWeight": cmp = cmpNum(a.holdingWeight, b.holdingWeight); break;
                case "currentPrice": cmp = cmpNum(livePrices[a.ticker], livePrices[b.ticker]); break;
                case "priceWhenAdded": cmp = cmpNum(a.priceWhenAdded > 0 ? a.priceWhenAdded : null, b.priceWhenAdded > 0 ? b.priceWhenAdded : null); break;
                case "returnSinceAdded": cmp = cmpNum(a.returnSinceAdded, b.returnSinceAdded); break;
                case "dateAdded": {
                  const at = a.dateAdded ? Date.parse(a.dateAdded) : NaN;
                  const bt = b.dateAdded ? Date.parse(b.dateAdded) : NaN;
                  cmp = cmpNum(isFinite(at) ? at : null, isFinite(bt) ? bt : null);
                  break;
                }
                case "days": cmp = cmpNum(daysSince(a.dateAdded), daysSince(b.dateAdded)); break;
              }
              return alphaSort.dir === "asc" ? cmp : -cmp;
            });

            const toggleAlphaSort = (key: AlphaSortKey) => {
              // alphaSort is now derived from uiPrefs (not React state), so
              // we read the current value directly rather than using the
              // functional update form.
              if (alphaSort.key === key) {
                setAlphaSort({ key, dir: alphaSort.dir === "asc" ? "desc" : "asc" });
              } else {
                const defaultDir: SortDir = key === "name" || key === "ticker" || key === "sector" || key === "dateAdded" ? "asc" : "desc";
                setAlphaSort({ key, dir: defaultDir });
              }
            };
            const alphaArrow = (key: AlphaSortKey) => alphaSort.key === key ? (alphaSort.dir === "asc" ? " ▲" : " ▼") : "";

            // Toggle the PM's manual-sell flag on a single pick.
            // Updates state directly without touching the rest of the
            // Sell a single pick — removes it from the list AND
            // redistributes its weight equally across the remaining
            // picks (mirrors SA's documented rule: "cash generated
            // from sold positions will be equally invested across the
            // remaining stocks in the Alpha Picks portfolio").
            //
            // Match by ticker + dateAdded so a sell action on one pick
            // doesn't accidentally remove a same-ticker duplicate from
            // a different date. Picks without holdingWeight (legacy
            // entries) are skipped from both sides of the redistribution
            // — they stay at undefined holdingWeight until the next
            // fresh scrape pulls SA's actual numbers.
            const sellPick = (ticker: string, dateAdded: string | undefined) => {
              const dropped = allPicks.find((p) =>
                p.ticker === ticker && (p.dateAdded || "") === (dateAdded || "")
              );
              if (!dropped) return;
              if (!confirm(`Sell ${dropped.name || ticker} from Alpha Picks?\n\nWeight (${dropped.holdingWeight != null ? dropped.holdingWeight.toFixed(2) + "%" : "—"}) will be redistributed equally across the remaining picks.`)) return;
              const remaining = allPicks.filter((p) =>
                !(p.ticker === ticker && (p.dateAdded || "") === (dateAdded || ""))
              );
              const droppedWeight = dropped.holdingWeight ?? 0;
              const remainingWithWeight = remaining.filter((p) => p.holdingWeight != null);
              const perPickAdd = remainingWithWeight.length > 0 && droppedWeight > 0
                ? droppedWeight / remainingWithWeight.length
                : 0;
              const updated = remaining.map((p) =>
                p.holdingWeight != null && perPickAdd > 0
                  ? { ...p, holdingWeight: parseFloat((p.holdingWeight + perPickAdd).toFixed(2)) }
                  : p
              );
              save({ ...state, alphaPicks: updated });
            };

            return (
              <>
                {/* Rating filter chips. The 'Drop sell candidates' bulk
                    action was removed in favor of the per-row 'Sell' button
                    which handles removal + weight redistribution directly. */}
                <div className="flex items-center gap-3 mb-3 flex-wrap">
                  <div className="flex flex-wrap gap-1.5">
                    {filterButtons.map((b) => {
                      const active = alphaRatingFilter === b.key;
                      const c = counts[b.key ?? "All"] ?? 0;
                      if (b.key !== null && c === 0) return null; // hide empty buckets
                      return (
                        <button
                          key={b.label}
                          onClick={() => setAlphaRatingFilter(b.key)}
                          className={`text-[11px] font-semibold rounded-full px-2.5 py-1 transition-colors ${
                            active
                              ? "bg-ink text-white"
                              : "bg-surface-2 text-ink-2 hover:bg-line"
                          }`}
                        >
                          {b.label} <span className="opacity-70">({c})</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <div className="overflow-x-auto"><table className="w-full text-sm">
                    <thead>
                      <tr className="border-b-2 border-line text-left">
                        <th className="py-2 pr-2 text-xs font-semibold text-ink-2 w-8">#</th>
                        <th className="py-2 pr-3 text-xs font-semibold text-ink-2 cursor-pointer select-none hover:text-ink" onClick={() => toggleAlphaSort("name")}>Name{alphaArrow("name")}</th>
                        <th className="py-2 pr-3 text-xs font-semibold text-ink-2 cursor-pointer select-none hover:text-ink" onClick={() => toggleAlphaSort("ticker")}>Ticker{alphaArrow("ticker")}</th>
                        <th className="py-2 pr-3 text-xs font-semibold text-ink-2 cursor-pointer select-none hover:text-ink" onClick={() => toggleAlphaSort("sector")}>Sector{alphaArrow("sector")}</th>
                        <th className="py-2 pr-2 text-xs font-semibold text-ink-2 cursor-pointer select-none hover:text-ink" onClick={() => toggleAlphaSort("rating")}>Rating{alphaArrow("rating")}</th>
                        <th className="py-2 pr-2 text-xs font-semibold text-ink-2 text-right cursor-pointer select-none hover:text-ink" onClick={() => toggleAlphaSort("holdingWeight")}>Holding %{alphaArrow("holdingWeight")}</th>
                        <th className="py-2 pr-3 text-xs font-semibold text-ink-2 text-right cursor-pointer select-none hover:text-ink" onClick={() => toggleAlphaSort("currentPrice")}>Current Price{alphaArrow("currentPrice")}</th>
                        <th className="py-2 pr-3 text-xs font-semibold text-ink-2 text-right cursor-pointer select-none hover:text-ink" onClick={() => toggleAlphaSort("priceWhenAdded")}>Price Picked{alphaArrow("priceWhenAdded")}</th>
                        <th className="py-2 pr-2 text-xs font-semibold text-ink-2 text-right cursor-pointer select-none hover:text-ink" onClick={() => toggleAlphaSort("returnSinceAdded")}>SA Return{alphaArrow("returnSinceAdded")}</th>
                        <th className="py-2 pr-3 text-xs font-semibold text-ink-2 cursor-pointer select-none hover:text-ink" onClick={() => toggleAlphaSort("dateAdded")}>Date Added{alphaArrow("dateAdded")}</th>
                        <th className="py-2 pr-2 text-xs font-semibold text-ink-2 text-right cursor-pointer select-none hover:text-ink" onClick={() => toggleAlphaSort("days")}>Days{alphaArrow("days")}</th>
                        <th className="py-2 w-16"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visiblePicks.map((pick, i) => {
                        const livePrice = livePrices[pick.ticker];
                        // priceWhenAdded is bootstrapped once via the
                        // Alpha-Picks bootstrap useEffect when livePrices
                        // first arrives. Use it directly here — it's
                        // historical and stays fixed across renders.
                        const days = daysSince(pick.dateAdded);
                        const flagged = isSellCandidate(pick);
                        return (
                          <tr key={`${pick.ticker}|${pick.dateAdded || ""}|${i}`} className={`border-b border-line-soft ${flagged ? "bg-neg-soft/40" : i % 2 === 0 ? "bg-white" : "bg-surface-2/40"} hover:bg-surface-2 transition-colors`}>
                            <td className="py-2 pr-2 text-ink-3">{i + 1}</td>
                            <td className="py-2 pr-3 text-ink-2 truncate max-w-[200px]" title={pick.name}>{pick.name}</td>
                            <td className="py-2 pr-3 font-mono font-bold">${displayTicker(pick.ticker)}</td>
                            <td className="py-2 pr-3 text-xs text-ink-3">{pick.sector || "—"}</td>
                            <td className="py-2 pr-2">
                              <div className="flex items-center gap-1 flex-wrap">
                                {pick.rating ? (
                                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${ratingTone(pick.rating)}`}>
                                    {canonicalRating(pick.rating) ?? pick.rating}
                                  </span>
                                ) : <span className="text-ink-faint text-[10px]">—</span>}
                                {pick.manualSell && (
                                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${manualSellTone}`} title="Manually flagged as sold by the PM (overrides SA rating for sell-candidate logic)">
                                    Manual Sell
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="py-2 pr-2 text-right font-mono text-xs">
                              {pick.holdingWeight != null
                                ? <span className="text-ink-2">{pick.holdingWeight.toFixed(2)}%</span>
                                : <span className="text-ink-faint">—</span>}
                            </td>
                            <td className="py-2 pr-3 text-right font-mono">
                              {pricesLoading ? <span className="text-ink-faint animate-pulse">...</span>
                                : livePrice != null ? <span className="font-semibold">${livePrice.toFixed(2)}</span>
                                : <span className="text-ink-faint">—</span>}
                            </td>
                            <td className="py-2 pr-3 text-right font-mono">
                              {pick.priceWhenAdded > 0
                                ? `$${pick.priceWhenAdded.toFixed(2)}`
                                : <span className="text-ink-faint">—</span>}
                            </td>
                            <td className="py-2 pr-2 text-right font-mono text-xs">
                              {pick.returnSinceAdded != null ? (
                                <span className={pick.returnSinceAdded >= 0 ? "text-pos" : "text-neg"}>
                                  {pick.returnSinceAdded >= 0 ? "+" : ""}{pick.returnSinceAdded.toFixed(1)}%
                                </span>
                              ) : <span className="text-ink-faint">—</span>}
                            </td>
                            <td className="py-2 pr-3 text-xs text-ink-3">{pick.dateAdded || "—"}</td>
                            <td className="py-2 pr-2 text-right text-xs">
                              {days != null ? (
                                <span className={canonicalRating(pick.rating) === "Hold" && days >= 150 ? "text-neg font-semibold" : "text-ink-3"} title={canonicalRating(pick.rating) === "Hold" && days >= 180 ? "Hold ≥ 180 days — SA would sell" : canonicalRating(pick.rating) === "Hold" && days >= 150 ? "Approaching SA's 180-day Hold sell rule" : ""}>
                                  {days}d
                                </span>
                              ) : <span className="text-ink-faint">—</span>}
                            </td>
                            <td className="py-2 text-right whitespace-nowrap">
                              {scoredStocks.some((s) => s.ticker === pick.ticker) ? (
                                <span className="text-[10px] text-pos font-medium">In list</span>
                              ) : (
                                <button
                                  onClick={(e) => { e.stopPropagation(); addToWatchlist(pick.ticker); }}
                                  className="text-[10px] text-accent hover:text-accent font-semibold transition-colors"
                                  title="Add to Watchlist"
                                >
                                  + Watch
                                </button>
                              )}
                              <button
                                onClick={() => sellPick(pick.ticker, pick.dateAdded)}
                                className="ml-2 text-[10px] font-semibold text-neg hover:text-neg transition-colors"
                                title="Sell this pick — removes it from the list AND redistributes its weight equally across the remaining picks (per SA's documented rule)."
                              >
                                Sell
                              </button>
                              <button
                                onClick={() => {
                                  if (!confirm(`Remove ${pick.name || pick.ticker} from the list WITHOUT redistributing weight?\n\n(Use the "Sell" button if you want weight redistribution.)`)) return;
                                  save({ ...state, alphaPicks: allPicks.filter((p) => !(p.ticker === pick.ticker && (p.dateAdded || "") === (pick.dateAdded || ""))) });
                                }}
                                className="ml-2 text-ink-faint hover:text-neg font-bold transition-colors"
                                title="Remove this specific pick with NO weight redistribution. Use this for duplicates or wrong tickers. Other picks with the same ticker on different dates stay."
                              >
                                &times;
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                      {visiblePicks.length === 0 && (
                        <tr><td colSpan={12} className="py-8 text-center text-ink-3 italic">
                          {allPicks.length === 0 ? "No picks yet — upload a screenshot below or add manually" : "No picks match this rating filter"}
                        </td></tr>
                      )}
                    </tbody>
                  </table></div>
                </div>
              </>
            );
          })()}

          <AlphaPickAddForm onAdd={(entry) => {
            const list = state.alphaPicks ?? [];
            if (list.some((p) => p.ticker === entry.ticker)) return;
            save({ ...state, alphaPicks: [...list, entry] });
          }} />

          <ResearchScraperBlock
            source="seeking-alpha-picks"
            sectionLabel="Alpha Picks"
            helperText="Upload a Seeking Alpha — Alpha Picks dashboard screenshot. On Refresh, ticker + entry price are extracted into the list above. Re-scans only if the image changes."
            attachments={state.attachments || []}
            onAddAttachment={addAttachment}
            onRemoveAttachment={removeAttachment}
            onScrape={(force) => scrapeResearchSource("seeking-alpha-picks", force)}
            loading={!!scrapeLoadingMap["seeking-alpha-picks"]}
            status={scrapeStatusMap["seeking-alpha-picks"]}
          />
        </CollapsibleSection>

        {/* General Notes section removed per user request — was unused
            in the daily workflow. The generalNotes field stays on the
            ResearchState schema for backward-compat with persisted
            data; nothing renders it. */}

        {/* ── Quick Reference ── */}
        <CollapsibleSection
          prefKey="research.quickRef"
          className="border-line"
          titleClass="text-lg font-semibold"
          title={<>Quick Reference</>}
        >
          <div className="grid gap-5 md:grid-cols-3">
            <div className="rounded-xl bg-surface-2 p-4">
              <div className="text-xs font-bold uppercase tracking-wider text-ink-3 mb-3">PIM Score Thresholds</div>
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between"><span className="text-pos font-medium">Strong Buy</span><span>&ge; 30/40</span></div>
                <div className="flex justify-between"><span className="text-pos font-medium">Moderate Buy</span><span>&ge; 26/40</span></div>
                <div className="flex justify-between"><span className="text-warn font-medium">Hold</span><span>&ge; 22/40</span></div>
                <div className="flex justify-between"><span className="text-neg font-medium">Underweight</span><span>&ge; 18/40</span></div>
                <div className="flex justify-between"><span className="text-neg font-medium">Sell</span><span>&lt; 18/40</span></div>
              </div>
            </div>
            <div className="rounded-xl bg-surface-2 p-4">
              <div className="text-xs font-bold uppercase tracking-wider text-ink-3 mb-3">Regime Multipliers</div>
              <div className="space-y-1.5 text-sm">
                <div className="text-xs font-bold text-neg mt-1">Risk-Off</div>
                <div className="flex justify-between"><span>Growth</span><span className="text-neg font-medium">0.85x</span></div>
                <div className="flex justify-between"><span>Cyclical</span><span className="text-warn font-medium">0.90x</span></div>
                <div className="flex justify-between"><span>Defensive</span><span className="text-pos font-medium">1.10x</span></div>
                <div className="text-xs font-bold text-warn mt-2">Neutral</div>
                <div className="flex justify-between"><span>All sectors</span><span className="text-ink-3 font-medium">1.0x</span></div>
                <div className="text-xs font-bold text-pos mt-2">Risk-On</div>
                <div className="flex justify-between"><span>Growth</span><span className="text-pos font-medium">1.10x</span></div>
                <div className="flex justify-between"><span>Cyclical</span><span className="text-pos font-medium">1.05x</span></div>
                <div className="flex justify-between"><span>Defensive</span><span className="text-warn font-medium">0.92x</span></div>
              </div>
              <p className="mt-3 text-xs text-ink-3">Growth: Tech, Comm Svc, Consumer Disc · Cyclical: Fin, Ind, Mat · Neutral: Energy, Real Estate · Quality dampening ±35%</p>
            </div>
            <div className="rounded-xl bg-surface-2 p-4">
              <div className="text-xs font-bold uppercase tracking-wider text-ink-3 mb-3">Contrarian Thresholds</div>
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between"><span>F&G &le; 15</span><span className="text-pos font-medium">Contrarian Buy</span></div>
                <div className="flex justify-between"><span>F&G &ge; 75</span><span className="text-neg font-medium">Contrarian Sell</span></div>
                <div className="flex justify-between"><span>AAII &le; -20</span><span className="text-pos font-medium">Contrarian Buy</span></div>
                <div className="flex justify-between"><span>AAII &ge; +30</span><span className="text-neg font-medium">Contrarian Sell</span></div>
              </div>
            </div>
          </div>
        </CollapsibleSection>
      </div>
    </main>
  );
}
