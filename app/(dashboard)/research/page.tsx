"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { ResearchState, UptickEntry, IdeaEntry, RBCEntry, SectorViewEntry, SectorView, LeeFocusArea, AlphaPickEntry } from "@/app/lib/defaults";
import { defaultResearch, GICS_SECTORS } from "@/app/lib/defaults";
import { dedupeRbcEntries } from "@/app/lib/rbc-canonical";
import { ImageUpload, type BriefAttachment } from "@/app/components/ImageUpload";
import { useStocks } from "@/app/lib/StockContext";
import type { Stock, ScoreKey } from "@/app/lib/types";

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
        <label className="text-xs text-slate-400 block">Ticker*</label>
        <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="AMZN" className="w-20 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-mono outline-none placeholder:text-slate-400 focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all" />
      </div>
      <div>
        <label className="text-xs text-slate-400 block">Support</label>
        <input value={support} onChange={(e) => setSupport(e.target.value)} placeholder="196, 161" className="w-24 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none placeholder:text-slate-400 focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all" />
      </div>
      <div>
        <label className="text-xs text-slate-400 block">Resistance</label>
        <input value={resistance} onChange={(e) => setResistance(e.target.value)} placeholder="220, 249" className="w-24 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none placeholder:text-slate-400 focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all" />
      </div>
      <div>
        <label className="text-xs text-slate-400 block">Price Added</label>
        <input value={priceWhenAdded} onChange={(e) => setPriceWhenAdded(e.target.value)} placeholder="161.26" type="number" step="0.01" className="w-24 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none placeholder:text-slate-400 focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all" />
      </div>
      <button type="submit" disabled={adding} className="rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors disabled:opacity-50">
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
        <label className="text-xs text-slate-400 block">Ticker*</label>
        <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="AAPL" className="w-24 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-mono outline-none placeholder:text-slate-400 focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all" />
      </div>
      <div>
        <label className="text-xs text-slate-400 block">Price Added</label>
        <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="175.00" type="number" step="0.01" className="w-24 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none placeholder:text-slate-400 focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all" />
      </div>
      <button type="submit" className="rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors">
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
        <label className="text-xs text-slate-400 block">Ticker*</label>
        <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="AMZN" className="w-24 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-mono outline-none placeholder:text-slate-400 focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all" />
      </div>
      <div>
        <label className="text-xs text-slate-400 block">Price Picked</label>
        <input value={priceWhenAdded} onChange={(e) => setPriceWhenAdded(e.target.value)} placeholder="215.40" type="number" step="0.01" className="w-28 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none placeholder:text-slate-400 focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all" />
      </div>
      <button type="submit" disabled={adding} className="rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors disabled:opacity-50">
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
  source: "fundstrat-top" | "fundstrat-bottom" | "fundstrat-smid-top" | "fundstrat-smid-bottom" | "rbc-focus" | "rbc-us-focus" | "seeking-alpha-picks";
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
    <div className="mt-4 border-t border-slate-100 pt-4">
      <div className="flex items-center gap-3 mb-2">
        <h4 className="text-sm font-bold text-slate-700">Screenshot Scanner</h4>
        <span className="text-[10px] text-slate-400">{props.helperText}</span>
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
          <p className="text-[10px] text-slate-500">{props.status}</p>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => { void props.onScrape(false); }}
            disabled={props.loading || !hasAttachments}
            className="text-[10px] rounded-md bg-blue-50 px-2.5 py-1 font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50 transition-colors"
            title="Re-run vision against the current screenshot. Cached if the image hasn't changed since last scan (no Anthropic cost)."
          >
            {props.loading ? "Scanning..." : "Refresh"}
          </button>
          <button
            onClick={() => { void props.onScrape(true); }}
            disabled={props.loading || !hasAttachments}
            className="text-[10px] rounded-md border border-slate-300 bg-white px-2 py-1 font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50 transition-colors"
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
        <label className="text-xs text-slate-400 block">Ticker*</label>
        <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="RY" className="w-24 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-mono outline-none placeholder:text-slate-400 focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all" />
      </div>
      <button type="submit" disabled={adding} className="rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors disabled:opacity-50">
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
        className={`w-full bg-white border border-blue-300 rounded-lg px-1 py-0.5 text-sm outline-none focus:ring-1 focus:ring-blue-200 transition-all ${className}`}
      />
    );
  }

  return (
    <span
      onClick={() => { setTemp(String(value)); setEditing(true); }}
      className={`cursor-pointer hover:bg-blue-50 rounded px-1 py-0.5 transition-colors ${className}`}
      title="Click to edit"
    >
      {value || "—"}
    </span>
  );
}

type UptickSortKey = "ticker" | "name" | "sector" | "price" | "support" | "resistance" | "dateAdded" | "priceWhenAdded";
type IdeaSortKey = "ticker" | "priceWhenAdded" | "currentPrice";
type RBCSortKey = "ticker" | "name" | "sector" | "weight" | "dateAdded";
type SortDir = "asc" | "desc";

type LivePrices = Record<string, number | null>;

const ZERO_SCORES: Record<ScoreKey, number> = {
  brand: 0, secular: 0, researchCoverage: 0, externalSources: 0,
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
  const { scoredStocks, addStock, brief } = useStocks();

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
  const [uptickSort, setUptickSort] = useState<{ key: UptickSortKey; dir: SortDir }>({ key: "ticker", dir: "asc" });
  const [topSort, setTopSort] = useState<{ key: IdeaSortKey; dir: SortDir }>({ key: "ticker", dir: "asc" });
  const [bottomSort, setBottomSort] = useState<{ key: IdeaSortKey; dir: SortDir }>({ key: "ticker", dir: "asc" });
  const [smidTopSort, setSmidTopSort] = useState<{ key: IdeaSortKey; dir: SortDir }>({ key: "ticker", dir: "asc" });
  const [smidBottomSort, setSmidBottomSort] = useState<{ key: IdeaSortKey; dir: SortDir }>({ key: "ticker", dir: "asc" });
  // Alpha Picks rating filter — null = show all, otherwise show only
  // picks whose rating matches (case-insensitive). Strong Buy / Buy /
  // Hold / Sell / Strong Sell, plus an "(unrated)" bucket for legacy
  // picks scraped before the rating field existed.
  const [alphaRatingFilter, setAlphaRatingFilter] = useState<string | null>(null);
  const [rbcSort, setRbcSort] = useState<{ key: RBCSortKey; dir: SortDir }>({ key: "ticker", dir: "asc" });
  const [rbcUsSort, setRbcUsSort] = useState<{ key: RBCSortKey; dir: SortDir }>({ key: "ticker", dir: "asc" });

  // Live prices from Yahoo Finance
  const [livePrices, setLivePrices] = useState<LivePrices>({});
  const [pricesLoading, setPricesLoading] = useState(false);
  const [pricesFetchedAt, setPricesFetchedAt] = useState<string | null>(null);

  const fetchLivePrices = useCallback(async (researchState?: ResearchState) => {
    const s = researchState || state;
    const allTickers = [
      ...s.newtonUpticks.map((u) => u.ticker),
      ...s.fundstratTop.map((i) => i.ticker),
      ...s.fundstratBottom.map((i) => i.ticker),
      ...(s.fundstratSmidTop ?? []).map((i) => i.ticker),
      ...(s.fundstratSmidBottom ?? []).map((i) => i.ticker),
      ...(s.alphaPicks ?? []).map((i) => i.ticker),
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
  type SourceKey = "fundstrat-top" | "fundstrat-bottom" | "fundstrat-smid-top" | "fundstrat-smid-bottom" | "rbc-focus" | "rbc-us-focus" | "seeking-alpha-picks";
  const [scrapeLoadingMap, setScrapeLoadingMap] = useState<Partial<Record<SourceKey, boolean>>>({});
  const [scrapeStatusMap, setScrapeStatusMap] = useState<Partial<Record<SourceKey, string>>>({});

  // Cross-source synthesis state. The synthesis tile at the top of the
  // page asks Claude to find the best buy targets across all five
  // research sources, weighted by cross-source overlap and the brief's
  // regime/horizon read. Hash-gated server-side so unchanged inputs
  // don't spend Anthropic tokens.
  type SynthesisPick = { ticker: string; sources: string[]; sourceCount: number; thesis: string };
  type SynthesisResult = {
    summary: string;
    topPicks: SynthesisPick[];
    honorableMentions: SynthesisPick[];
    cautions?: string[];
    regimeContext?: string;
  };
  const [synthesis, setSynthesis] = useState<SynthesisResult | null>(null);
  const [synthesisGeneratedAt, setSynthesisGeneratedAt] = useState<string | null>(null);
  const [synthesisLoading, setSynthesisLoading] = useState(false);
  const [synthesisStatus, setSynthesisStatus] = useState<string | null>(null);
  const [synthesisCached, setSynthesisCached] = useState(false);

  function toggleUptickSort(key: UptickSortKey) {
    setUptickSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }
  function toggleSmidTopSort(key: IdeaSortKey) {
    setSmidTopSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }
  function toggleSmidBottomSort(key: IdeaSortKey) {
    setSmidBottomSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }
  function toggleTopSort(key: IdeaSortKey) {
    setTopSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }
  function toggleBottomSort(key: IdeaSortKey) {
    setBottomSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }
  function toggleRbcSort(key: RBCSortKey) {
    setRbcSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }
  function toggleRbcUsSort(key: RBCSortKey) {
    setRbcUsSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }

  function sortedUpticks() {
    return [...state.newtonUpticks].sort((a, b) => {
      const { key, dir } = uptickSort;
      let cmp = 0;
      if (key === "price") {
        cmp = (livePrices[a.ticker] || 0) - (livePrices[b.ticker] || 0);
      } else if (key === "priceWhenAdded") {
        cmp = (a.priceWhenAdded || 0) - (b.priceWhenAdded || 0);
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

  const uArrow = (key: UptickSortKey) => uptickSort.key === key ? (uptickSort.dir === "asc" ? " ▲" : " ▼") : "";
  const tArrow = (key: IdeaSortKey) => topSort.key === key ? (topSort.dir === "asc" ? " ▲" : " ▼") : "";
  const bArrow = (key: IdeaSortKey) => bottomSort.key === key ? (bottomSort.dir === "asc" ? " ▲" : " ▼") : "";
  const stArrow = (key: IdeaSortKey) => smidTopSort.key === key ? (smidTopSort.dir === "asc" ? " ▲" : " ▼") : "";
  const sbArrow = (key: IdeaSortKey) => smidBottomSort.key === key ? (smidBottomSort.dir === "asc" ? " ▲" : " ▼") : "";
  const rArrow = (key: RBCSortKey) => rbcSort.key === key ? (rbcSort.dir === "asc" ? " ▲" : " ▼") : "";
  const rUsArrow = (key: RBCSortKey) => rbcUsSort.key === key ? (rbcUsSort.dir === "asc" ? " ▲" : " ▼") : "";

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
          // without throwing on missing fields. The next refreshAlpha
          // PickNames pass will populate name + sector via Yahoo.
          if (research.alphaPicks && research.alphaPicks.length > 0) {
            research = {
              ...research,
              alphaPicks: research.alphaPicks.map((p): AlphaPickEntry => {
                const partial = p as Partial<AlphaPickEntry> & IdeaEntry;
                return {
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

          // Backfill missing names for both RBC lists.
          for (const listKey of ["rbcCanadianFocus", "rbcUsFocus"] as const) {
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

  const save = useCallback((next: ResearchState) => {
    setState(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      // Strip attachment dataUrls before persisting the research blob — the
      // image payloads live in their own Redis keys (see /api/kv/attachments/[id]).
      // Keeping dataUrls inline used to balloon the blob past write limits
      // and silently drop the save, which is why screenshots vanished on
      // refresh when many were attached.
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
      fetch("/api/kv/research", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ research: serializable }),
      }).catch((e) => console.error("Failed to save research:", e));
    }, 800);
  }, []);

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
  const refreshRbcNames = useCallback(async (list: "rbcCanadianFocus" | "rbcUsFocus", overrideState?: ResearchState) => {
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
      const normalize = (t: string) =>
        t.replace(/^\$+/, "").replace(/\//g, "-").split(/[.\s]/)[0].toUpperCase();
      const existingByNorm = new Map(state.newtonUpticks.map((u) => [normalize(u.ticker), u]));

      const merged = new Map(state.newtonUpticks.map((u) => [u.ticker, u]));
      let matched = 0;
      let updatedFields = 0;
      let changed = false;
      for (const e of entries) {
        const norm = normalize(e.ticker);
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
          if (JSON.stringify(next) !== JSON.stringify(existing)) {
            merged.set(existing.ticker, next);
            updatedFields += 1;
            changed = true;
          }
        } else {
          merged.set(norm, {
            ticker: norm,
            name: norm,
            sector: "—",
            price: 0,
            support: e.support ?? "",
            resistance: e.resistance ?? "",
            dateAdded: e.dateAdded ?? new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" }),
            priceWhenAdded: e.priceWhenAdded ?? 0,
          });
          changed = true;
        }
      }

      const cachedLabel = data.cached ? " (cached)" : "";
      setScrapeStatus(
        `${entries.length} rows in screenshot${cachedLabel} · ${matched} matched your list · ${updatedFields} updated`,
      );
      if (!changed) return { merged: state, changed: false };
      const nextState: ResearchState = { ...state, newtonUpticks: Array.from(merged.values()) };
      save(nextState);
      return { merged: nextState, changed: true };
    } catch (e) {
      console.error("Uptick scrape failed:", e);
      setScrapeStatus("Screenshot scan failed");
      return null;
    } finally {
      setScrapeLoading(false);
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
        entries?: Array<{ ticker: string; priceWhenAdded?: number; sector?: string; weight?: number; dateAdded?: string }>;
        cached?: boolean;
      };
      const entries = data.entries || [];

      if (entries.length === 0) {
        setScrapeStatusMap((m) => ({ ...m, [source]: data.cached
          ? "No rows in cached scan — click Force re-scan to retry"
          : "Vision found no rows — try Force re-scan or a clearer screenshot" }));
        return false;
      }

      // Normalize tickers same way upticks does so "$BRK/B" matches "BRK-B".
      const normalize = (t: string) =>
        t.replace(/^\$+/, "").replace(/\//g, "-").split(/[.\s]/)[0].toUpperCase();

      let nextState: ResearchState = state;

      if (source === "rbc-focus" || source === "rbc-us-focus") {
        // Both RBC lists share the same RBCEntry shape and merge logic.
        // The only difference is which state field they target.
        const stateKey = source === "rbc-focus" ? "rbcCanadianFocus" : "rbcUsFocus";
        const existing = (state[stateKey] as RBCEntry[] | undefined) || [];
        const byNorm = new Map(existing.map((r) => [normalize(r.ticker), r]));
        let matched = 0;
        let added = 0;
        for (const e of entries) {
          const norm = normalize(e.ticker);
          const ex = byNorm.get(norm);
          if (ex) {
            matched += 1;
            byNorm.set(norm, {
              ticker: e.ticker || ex.ticker, // adopt scrape's canonical ticker (e.g. .TO form for Canadian)
              name: ex.name, // preserve any name that's already been backfilled
              sector: e.sector ?? ex.sector,
              weight: e.weight ?? ex.weight,
              dateAdded: e.dateAdded ?? ex.dateAdded,
            });
          } else {
            added += 1;
            byNorm.set(norm, {
              ticker: e.ticker, // already canonicalized by parseRbcRows (.TO for Canadian)
              sector: e.sector ?? "—",
              weight: e.weight ?? 0,
              dateAdded: e.dateAdded ?? new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" }),
            });
          }
        }
        // Dedupe Canadian list after merge — the scrape can emit
        // conflicting ticker variants for the same security
        // (BBD-B.TO vs BBD.B-T) which the byNorm map won't catch
        // (their normalize() output differs because normalize strips
        // .TO but keeps -T). dedupeRbcEntries collapses by canonical
        // form. US list doesn't need this — bare tickers don't have
        // the multi-variant problem.
        const merged = Array.from(byNorm.values());
        const finalList = source === "rbc-focus"
          ? dedupeRbcEntries(merged).entries
          : merged;
        nextState = { ...state, [stateKey]: finalList } as ResearchState;
        const cachedLabel = data.cached ? " (cached)" : "";
        setScrapeStatusMap((m) => ({ ...m, [source]: `${entries.length} rows${cachedLabel} · ${matched} matched · ${added} added` }));
        // Save first, then backfill names + sectors for any new rows.
        save(nextState);
        void refreshRbcNames(stateKey, nextState);
        return true;
      } else if (source === "seeking-alpha-picks") {
        // Alpha Picks: rich entries (name + sector + dateAdded + price)
        // mirroring Newton's Upticks. Server returns ticker + priceWhenAdded;
        // we preserve existing name/sector for matched rows and stub
        // defaults for new rows. The post-scrape refreshAlphaPickNames
        // call backfills name/sector via /api/company-name in batch.
        const existing: AlphaPickEntry[] = state.alphaPicks || [];
        // Dedup existing entries: if both US and Canadian (-T) forms
        // exist for the same base ticker, keep only the -T variant
        // (the canonical form the scraper returns).
        const rawMap = new Map(existing.map((i) => [normalize(i.ticker), i]));
        for (const key of Array.from(rawMap.keys())) {
          if (!key.endsWith("-T") && rawMap.has(`${key}-T`)) rawMap.delete(key);
        }
        const byNorm = rawMap;
        let matched = 0;
        let added = 0;
        // Alpha Picks scrape returns rich entries (ticker + name +
        // sector + dateAdded + returnSinceAdded + rating). Use those
        // directly when present rather than falling back to the
        // ticker-as-name placeholder. The Yahoo refreshAlphaPickNames
        // pass after still normalizes sectors to GICS form.
        type ScrapedAlpha = { ticker: string; name?: string; sector?: string; dateAdded?: string; returnSinceAdded?: number; rating?: string; holdingWeight?: number };
        const today = new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
        // Canadian-variant lookup: "-T" suffix may differ between
        // existing entries (US ticker) and freshly-scraped entries
        // (Canadian ticker) or vice-versa. When exact match fails,
        // try the counterpart form so the entry overwrites rather
        // than duplicating.
        const findExisting = (norm: string): { key: string; entry: AlphaPickEntry } | undefined => {
          const direct = byNorm.get(norm);
          if (direct) return { key: norm, entry: direct };
          const alt = norm.endsWith("-T") ? norm.slice(0, -2) : `${norm}-T`;
          const fallback = byNorm.get(alt);
          if (fallback) return { key: alt, entry: fallback };
          return undefined;
        };
        for (const eRaw of entries) {
          const e = eRaw as ScrapedAlpha;
          const norm = normalize(e.ticker);
          const found = findExisting(norm);
          if (found) {
            const ex = found.entry;
            // Remove old key if the ticker form changed (US→Canadian)
            if (found.key !== norm) byNorm.delete(found.key);
            matched += 1;
            byNorm.set(norm, {
              ...ex,
              // Adopt the scraped ticker form (e.g. US→Canadian -T)
              ticker: norm,
              // Prefer scraped values when populated; fall back to
              // existing for unchanged fields. priceWhenAdded is
              // intentionally retained — it's a HISTORICAL value and
              // shouldn't drift each scrape. The bootstrap useEffect
              // populates it once when livePrices arrives, then it
              // stays fixed.
              name: e.name?.trim() || ex.name,
              sector: e.sector?.trim() || ex.sector,
              dateAdded: e.dateAdded?.trim() || ex.dateAdded,
              returnSinceAdded: e.returnSinceAdded ?? ex.returnSinceAdded,
              rating: e.rating?.trim() || ex.rating,
              // holdingWeight DOES update on each scrape — SA's
              // dashboard reflects the latest portfolio weight after
              // their own redistributions, and a fresh scrape should
              // overwrite any local redistribution we did between
              // screenshot uploads.
              holdingWeight: e.holdingWeight ?? ex.holdingWeight,
            });
          } else {
            added += 1;
            byNorm.set(norm, {
              ticker: norm,
              name: e.name?.trim() || norm,
              sector: e.sector?.trim() || "—",
              price: 0,
              priceWhenAdded: 0,
              dateAdded: e.dateAdded?.trim() || today,
              returnSinceAdded: e.returnSinceAdded,
              rating: e.rating?.trim(),
              holdingWeight: e.holdingWeight,
            });
          }
        }
        nextState = { ...state, alphaPicks: Array.from(byNorm.values()) };
        const cachedLabel = data.cached ? " (cached)" : "";
        setScrapeStatusMap((m) => ({ ...m, [source]: `${entries.length} rows${cachedLabel} · ${matched} matched · ${added} added` }));
        save(nextState);
        // Backfill names/sectors via Yahoo (normalizes RBC-style
        // sector labels to GICS form). Then refresh live prices so
        // the table populates Current Price + derived Price Picked
        // immediately rather than waiting for the next manual refresh.
        void refreshAlphaPickNames(nextState);
        void fetchLivePrices(nextState);
        return true;
      } else {
        // IdeaEntry-shaped sources (Fundstrat Top/Bottom, SMID Top/Bottom)
        const stateKey =
          source === "fundstrat-top"         ? "fundstratTop"
        : source === "fundstrat-bottom"      ? "fundstratBottom"
        : source === "fundstrat-smid-top"    ? "fundstratSmidTop"
        : /* fundstrat-smid-bottom */         "fundstratSmidBottom";
        const existing: IdeaEntry[] = (state[stateKey as keyof ResearchState] as IdeaEntry[]) || [];
        const byNorm = new Map(existing.map((i) => [normalize(i.ticker), i]));
        let matched = 0;
        let added = 0;
        for (const e of entries) {
          const norm = normalize(e.ticker);
          const ex = byNorm.get(norm);
          if (ex) {
            matched += 1;
            byNorm.set(norm, {
              ticker: ex.ticker,
              priceWhenAdded: e.priceWhenAdded ?? ex.priceWhenAdded,
            });
          } else {
            added += 1;
            byNorm.set(norm, {
              ticker: norm,
              priceWhenAdded: e.priceWhenAdded ?? 0,
            });
          }
        }
        nextState = { ...state, [stateKey]: Array.from(byNorm.values()) } as ResearchState;
        const cachedLabel = data.cached ? " (cached)" : "";
        setScrapeStatusMap((m) => ({ ...m, [source]: `${entries.length} rows${cachedLabel} · ${matched} matched · ${added} added` }));
      }

      save(nextState);
      return true;
    } catch (e) {
      console.error(`research-scrape:${source} failed:`, e);
      setScrapeStatusMap((m) => ({ ...m, [source]: "Screenshot scan failed" }));
      return false;
    } finally {
      setScrapeLoadingMap((m) => ({ ...m, [source]: false }));
    }
  }, [state, save, refreshAlphaPickNames, refreshRbcNames, fetchLivePrices]);

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
      const totalPicks = data.result.topPicks.length + data.result.honorableMentions.length;
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
        setSynthesisStatus("Synthesis failed");
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
      const totalPicks = data.result.topPicks.length + data.result.honorableMentions.length;
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
    save({ ...state, newtonUpticks: [...state.newtonUpticks, entry] });
  };
  const removeUptick = (ticker: string) => {
    save({ ...state, newtonUpticks: state.newtonUpticks.filter((u) => u.ticker !== ticker) });
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
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-slate-900 md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Research Notes</h1>
          <p className="text-slate-500 mt-1">Track external research sources, ideas, and notes. All changes are saved and shared across the team.</p>
        </div>

        {attachmentsSaveError && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <strong>Screenshots not saved:</strong> {attachmentsSaveError}
          </div>
        )}

        {/* ── Cross-Source Synthesis ──
            AI-generated buy-target list synthesizing all five research
            sources + the brief's regime/horizon read. Cross-source
            overlap (a ticker mentioned by 2+ sources) is weighted
            higher. Cached server-side: refreshes with unchanged
            research + brief return instantly with no Anthropic cost. */}
        <section className="rounded-[24px] border border-indigo-200 bg-gradient-to-br from-indigo-50/60 to-white p-6 shadow-sm">
          <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
            <div>
              <h3 className="text-xl font-bold text-indigo-900 flex items-center gap-2">
                <span>✦</span> Cross-Source Synthesis
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                Best buy targets across all research sources, weighted by cross-source overlap and the morning brief. Names mentioned by 2+ sources rank as Top Picks.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {synthesisStatus && (
                <span className="text-[11px] text-slate-500 mr-1">{synthesisStatus}</span>
              )}
              {synthesisGeneratedAt && (
                <span className="text-[10px] text-slate-400 mr-1" title={`Generated ${new Date(synthesisGeneratedAt).toLocaleString()}`}>
                  {new Date(synthesisGeneratedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </span>
              )}
              {!synthesis && (
                <button
                  onClick={() => { void generateSynthesis(false); }}
                  disabled={synthesisLoading}
                  className="text-[11px] rounded-md bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                  title="Generate the cross-source synthesis from current research + brief. Persists across refreshes."
                >
                  {synthesisLoading ? "Generating..." : "Generate"}
                </button>
              )}
              <button
                onClick={() => {
                  if (!confirm("Force re-generate will overwrite the existing synthesis using the CURRENT brief. The previous synthesis (and its brief context) will be replaced. Continue?")) return;
                  void generateSynthesis(true);
                }}
                disabled={synthesisLoading}
                className="text-[11px] rounded-md border border-slate-300 bg-white px-2.5 py-1.5 font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50 transition-colors"
                title="Overwrite the persisted synthesis with a fresh one using the current brief. The new synthesis becomes the new sticky version."
              >
                Force re-generate
              </button>
            </div>
          </div>

          {!synthesis && !synthesisLoading && (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white/70 p-4 text-sm text-slate-500">
              {synthesisStatus
                ? <>{synthesisStatus}</>
                : <>No synthesis generated yet. Add some research picks across the sources below, then click <strong>Generate</strong>.</>}
            </div>
          )}

          {synthesis && (
            <div className="space-y-4">
              {/* Summary line + regime tag */}
              <div className="flex items-start gap-2 flex-wrap">
                {synthesis.regimeContext && (
                  <span className={`text-[10px] font-bold uppercase tracking-wider rounded-full px-2 py-0.5 mt-0.5 ${
                    synthesis.regimeContext === "Risk-On"  ? "bg-emerald-100 text-emerald-700"
                    : synthesis.regimeContext === "Risk-Off" ? "bg-red-100 text-red-700"
                    : "bg-amber-100 text-amber-700"
                  }`}>
                    {synthesis.regimeContext}
                  </span>
                )}
                <p className="text-sm leading-6 text-slate-700 flex-1 min-w-[260px]">{synthesis.summary}</p>
              </div>

              {/* Top picks — multi-source */}
              {synthesis.topPicks.length > 0 && (
                <div>
                  <h4 className="text-xs font-bold uppercase tracking-wider text-indigo-700 mb-2">
                    Top Picks <span className="text-slate-400 font-normal">· cross-source overlap</span>
                  </h4>
                  <ul className="space-y-3">
                    {synthesis.topPicks.map((p) => (
                      <li key={p.ticker} className="rounded-xl border border-indigo-100 bg-white p-3 shadow-sm">
                        <div className="flex items-center gap-2 flex-wrap mb-1.5">
                          <span className="font-mono font-bold text-base text-indigo-900">${p.ticker}</span>
                          <span className="text-[10px] font-bold rounded-full bg-indigo-600 text-white px-2 py-0.5">
                            {p.sourceCount} sources
                          </span>
                          {p.sources.map((s) => (
                            <span key={s} className="text-[10px] rounded-full bg-slate-100 text-slate-600 px-2 py-0.5">
                              {s}
                            </span>
                          ))}
                        </div>
                        <p className="text-sm leading-6 text-slate-700">{p.thesis}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Honorable mentions — single source */}
              {synthesis.honorableMentions.length > 0 && (
                <div>
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-600 mb-2">
                    Honorable Mentions <span className="text-slate-400 font-normal">· single-source standouts</span>
                  </h4>
                  <ul className="space-y-2">
                    {synthesis.honorableMentions.map((p) => (
                      <li key={p.ticker} className="rounded-lg border border-slate-100 bg-white/70 p-2.5">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="font-mono font-bold text-sm">${p.ticker}</span>
                          {p.sources.map((s) => (
                            <span key={s} className="text-[10px] rounded-full bg-slate-100 text-slate-600 px-2 py-0.5">
                              {s}
                            </span>
                          ))}
                        </div>
                        <p className="text-xs leading-5 text-slate-600">{p.thesis}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Cautions */}
              {synthesis.cautions && synthesis.cautions.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-amber-800 mb-1">Cautions</h4>
                  <ul className="text-xs leading-5 text-amber-900 list-disc list-inside space-y-0.5">
                    {synthesis.cautions.map((c, i) => <li key={i}>{c}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── Newton's Upticks ── */}
        <section className="rounded-[24px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-xl font-bold">Newton&apos;s Upticks</h3>
              <p className="text-xs text-slate-400">Fundstrat technical uptick list &mdash; click any cell to edit</p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={async () => {
                  // Scrape first so any new tickers are in state before the
                  // names backfill runs against them. Scrape is a no-op (and
                  // free) when no upticks screenshot is attached, and is free
                  // server-side when the attached image hasn't changed since
                  // last scan — same caching pattern as JPM flows.
                  await scrapeUpticks();
                  void refreshUptickNames();
                  void fetchLivePrices();
                }}
                disabled={namesLoading || pricesLoading || scrapeLoading}
                className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50 transition-colors"
                title="Refresh prices + company names/sectors. If a screenshot is attached, re-scan it only if the image changed since last scan."
              >
                <svg className={`w-3.5 h-3.5 ${(namesLoading || pricesLoading || scrapeLoading) ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" /></svg>
                {(namesLoading || pricesLoading || scrapeLoading) ? "Updating..." : "Refresh"}
              </button>
              <span className="text-sm text-slate-400">{state.newtonUpticks.length} stocks</span>
            </div>
          </div>

          {pricesFetchedAt && (
            <p className="text-[10px] text-slate-400 mb-2">
              Prices updated {new Date(pricesFetchedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}
            </p>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-2 border-teal-600 text-left">
                  <th className="py-2 pr-2 text-xs font-semibold text-teal-700 w-8">#</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-teal-700 cursor-pointer hover:text-teal-900 select-none" onClick={() => toggleUptickSort("ticker")}>Ticker{uArrow("ticker")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-teal-700 cursor-pointer hover:text-teal-900 select-none" onClick={() => toggleUptickSort("name")}>Name{uArrow("name")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-teal-700 cursor-pointer hover:text-teal-900 select-none" onClick={() => toggleUptickSort("sector")}>Sector{uArrow("sector")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-teal-700 text-right cursor-pointer hover:text-teal-900 select-none" onClick={() => toggleUptickSort("price")}>Price{uArrow("price")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-teal-700 text-right cursor-pointer hover:text-teal-900 select-none" onClick={() => toggleUptickSort("priceWhenAdded")}>Price Added{uArrow("priceWhenAdded")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-teal-700 text-right">Chg</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-teal-700 text-right">Support</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-teal-700 text-right">Resistance</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-teal-700 cursor-pointer hover:text-teal-900 select-none" onClick={() => toggleUptickSort("dateAdded")}>Date Added{uArrow("dateAdded")}</th>
                  <th className="py-2 text-xs font-semibold text-teal-700 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {sortedUpticks().map((u, i) => {
                  const isNew = u.dateAdded === new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
                  const rowBg = isNew ? "bg-amber-50 font-semibold" : i % 2 === 0 ? "bg-white" : "bg-slate-50/50";
                  const livePrice = livePrices[u.ticker];
                  const pctChange = livePrice && u.priceWhenAdded ? ((livePrice - u.priceWhenAdded) / u.priceWhenAdded * 100) : null;
                  return (
                    <tr key={u.ticker} className={`border-b border-slate-100 ${rowBg} hover:bg-blue-50/40 transition-colors`}>
                      <td className="py-2 pr-2 text-slate-400">{i + 1}</td>
                      <td className="py-2 pr-3 font-mono font-bold text-teal-700">${u.ticker}</td>
                      <td className="py-2 pr-3 text-slate-700 truncate max-w-[160px]">
                        {u.name && u.name !== u.ticker ? u.name : <span className="text-slate-300 italic text-xs">loading...</span>}
                      </td>
                      <td className="py-2 pr-3 text-slate-600 truncate max-w-[140px]">
                        {u.sector && u.sector !== "—" ? u.sector : <span className="text-slate-300 italic text-xs">loading...</span>}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        {pricesLoading ? (
                          <span className="text-slate-300 animate-pulse">...</span>
                        ) : livePrice != null ? (
                          <span className="font-semibold">${livePrice.toFixed(2)}</span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        {u.priceWhenAdded ? (
                          <EditableCell value={`$${u.priceWhenAdded.toFixed(2)}`} onChange={(v) => updateUptick(u.ticker, "priceWhenAdded", v.replace("$", ""))} />
                        ) : (
                          <span className="text-emerald-600 font-semibold">NEW</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-xs">
                        {pctChange != null ? (
                          <span className={pctChange >= 0 ? "text-emerald-600" : "text-red-500"}>
                            {pctChange >= 0 ? "+" : ""}{pctChange.toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        <EditableCell value={u.support} onChange={(v) => updateUptick(u.ticker, "support", v)} />
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        <EditableCell value={u.resistance} onChange={(v) => updateUptick(u.ticker, "resistance", v)} />
                      </td>
                      <td className="py-2 pr-3 text-slate-500">
                        <EditableCell value={u.dateAdded} onChange={(v) => updateUptick(u.ticker, "dateAdded", v)} />
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {scoredStocks.some((s) => s.ticker === u.ticker) ? (
                          <span className="text-[10px] text-emerald-500 font-medium">In list</span>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); addToWatchlist(u.ticker); }}
                            className="text-[10px] text-blue-500 hover:text-blue-700 font-semibold transition-colors"
                            title="Add to Watchlist"
                          >
                            + Watch
                          </button>
                        )}
                        <button onClick={() => removeUptick(u.ticker)} className="ml-2 text-slate-300 hover:text-red-500 font-bold transition-colors" title="Remove">
                          &times;
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {state.newtonUpticks.length === 0 && (
                  <tr>
                    <td colSpan={11} className="py-8 text-center text-slate-400 italic">No upticks added yet</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <UptickAddForm onAdd={addUptick} />

          {/*
            Screenshot scraper. Uploads are persisted in state.attachments with
            section === "upticks" (same storage the rest of Research uses).
            On Refresh, scrapeUpticks() POSTs these images to
            /api/upticks-scrape, which re-runs the Anthropic vision call ONLY
            if the image fingerprint changed (same caching pattern as JPM
            flows). Unchanged images = zero tokens spent.
          */}
          <div className="mt-5 border-t border-slate-100 pt-4">
            <div className="flex items-center gap-3 mb-2">
              <h4 className="text-sm font-bold text-teal-700">Screenshot Scanner</h4>
              <span className="text-[10px] text-slate-400">
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
                <p className="text-[10px] text-slate-500">{scrapeStatus}</p>
              )}
              <button
                onClick={() => { void scrapeUpticks(true); }}
                disabled={scrapeLoading || (state.attachments || []).filter((a) => a.section === "upticks").length === 0}
                className="ml-auto text-[10px] rounded-md border border-slate-300 bg-white px-2 py-1 font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50 transition-colors"
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
              <details className="mt-2 text-[10px] text-slate-500">
                <summary className="cursor-pointer hover:text-slate-700">
                  View parsed rows from screenshot ({lastScrape.length})
                </summary>
                <div className="mt-1 overflow-x-auto">
                  <table className="w-full text-[10px]">
                    <thead>
                      <tr className="text-slate-400 border-b border-slate-200">
                        <th className="py-1 pr-2 text-left">Ticker</th>
                        <th className="py-1 pr-2 text-left">Support</th>
                        <th className="py-1 pr-2 text-left">Resistance</th>
                        <th className="py-1 pr-2 text-right">Price Added</th>
                        <th className="py-1 text-left">Date Added</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lastScrape.map((r, i) => (
                        <tr key={`${r.ticker}-${i}`} className="border-b border-slate-100">
                          <td className="py-0.5 pr-2 font-mono font-semibold">{r.ticker}</td>
                          <td className="py-0.5 pr-2">{r.support ?? <span className="text-slate-300">—</span>}</td>
                          <td className="py-0.5 pr-2">{r.resistance ?? <span className="text-slate-300">—</span>}</td>
                          <td className="py-0.5 pr-2 text-right">{r.priceWhenAdded != null ? `$${r.priceWhenAdded}` : <span className="text-slate-300">—</span>}</td>
                          <td className="py-0.5">{r.dateAdded ?? <span className="text-slate-300">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </div>

          {/* Newton sector views — compact inline toggles */}
          <div className="mt-5 border-t border-slate-100 pt-4">
            <div className="flex items-center gap-3 mb-3">
              <h4 className="text-sm font-bold text-teal-700">Newton&apos;s Sector Views</h4>
              <span className="text-[10px] text-slate-400">Click to toggle OW / N / UW</span>
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
                    ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                    : sv.view === "underweight"
                    ? "bg-red-100 text-red-800 border-red-300"
                    : "bg-slate-100 text-slate-500 border-slate-200";
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
          <div className="mt-4 border-t border-slate-100 pt-4">
            <div className="flex items-center gap-3 mb-3">
              <h4 className="text-sm font-bold text-amber-700">Lee&apos;s Sector Views</h4>
              <span className="text-[10px] text-slate-400">Click to toggle OW / N / UW</span>
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
                    ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                    : sv.view === "underweight"
                    ? "bg-red-100 text-red-800 border-red-300"
                    : "bg-slate-100 text-slate-500 border-slate-200";
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
        </section>

        {/* ── Fundstrat Ideas ── */}
        <div className="grid gap-5 lg:grid-cols-2">
          {/* Top Ideas */}
          <section className="rounded-[24px] border border-emerald-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold text-emerald-800">Fundstrat Large-Cap Top Ideas</h3>
                <p className="text-xs text-slate-400">Best long ideas — large-cap names</p>
              </div>
              <span className="text-sm text-slate-400">{state.fundstratTop.length} names</span>
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-2 border-emerald-500 text-left">
                  <th className="py-2 pr-2 text-xs font-semibold text-emerald-700 w-8">#</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-emerald-700 cursor-pointer hover:text-emerald-900 select-none" onClick={() => toggleTopSort("ticker")}>Ticker{tArrow("ticker")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-emerald-700 text-right cursor-pointer hover:text-emerald-900 select-none" onClick={() => toggleTopSort("currentPrice")}>Current Price{tArrow("currentPrice")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-emerald-700 text-right cursor-pointer hover:text-emerald-900 select-none" onClick={() => toggleTopSort("priceWhenAdded")}>Price Added{tArrow("priceWhenAdded")}</th>
                  <th className="py-2 pr-2 text-xs font-semibold text-emerald-700 text-right">Chg</th>
                  <th className="py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {sortedIdeas(state.fundstratTop, topSort).map((item, i) => {
                  const livePrice = livePrices[item.ticker];
                  const pctChange = livePrice && item.priceWhenAdded ? ((livePrice - item.priceWhenAdded) / item.priceWhenAdded * 100) : null;
                  return (
                    <tr key={item.ticker} className={`border-b border-slate-100 ${i % 2 === 0 ? "bg-white" : "bg-emerald-50/30"} hover:bg-emerald-50/60 transition-colors`}>
                      <td className="py-2 pr-2 text-slate-400">{i + 1}</td>
                      <td className="py-2 pr-3 font-mono font-bold text-emerald-700">${item.ticker}</td>
                      <td className="py-2 pr-3 text-right font-mono">
                        {pricesLoading ? (
                          <span className="text-slate-300 animate-pulse">...</span>
                        ) : livePrice != null ? (
                          <span className="font-semibold">${livePrice.toFixed(2)}</span>
                        ) : (
                          <span className="text-slate-300">—</span>
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
                          <span className={pctChange >= 0 ? "text-emerald-600" : "text-red-500"}>
                            {pctChange >= 0 ? "+" : ""}{pctChange.toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {scoredStocks.some((s) => s.ticker === item.ticker) ? (
                          <span className="text-[10px] text-emerald-500 font-medium">In list</span>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); addToWatchlist(item.ticker); }}
                            className="text-[10px] text-blue-500 hover:text-blue-700 font-semibold transition-colors"
                            title="Add to Watchlist"
                          >
                            + Watch
                          </button>
                        )}
                        <button onClick={() => removeIdea("fundstratTop", item.ticker)} className="ml-2 text-slate-300 hover:text-red-500 font-bold transition-colors">&times;</button>
                      </td>
                    </tr>
                  );
                })}
                {state.fundstratTop.length === 0 && (
                  <tr><td colSpan={6} className="py-6 text-center text-slate-400 italic">No top ideas added yet</td></tr>
                )}
              </tbody>
            </table>

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
          </section>

          {/* Bottom Ideas */}
          <section className="rounded-[24px] border border-red-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold text-red-800">Fundstrat Large-Cap Bottom Ideas</h3>
                <p className="text-xs text-slate-400">Names to avoid or short — large-cap</p>
              </div>
              <span className="text-sm text-slate-400">{state.fundstratBottom.length} names</span>
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-2 border-red-400 text-left">
                  <th className="py-2 pr-2 text-xs font-semibold text-red-700 w-8">#</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-red-700 cursor-pointer hover:text-red-900 select-none" onClick={() => toggleBottomSort("ticker")}>Ticker{bArrow("ticker")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-red-700 text-right cursor-pointer hover:text-red-900 select-none" onClick={() => toggleBottomSort("currentPrice")}>Current Price{bArrow("currentPrice")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-red-700 text-right cursor-pointer hover:text-red-900 select-none" onClick={() => toggleBottomSort("priceWhenAdded")}>Price Added{bArrow("priceWhenAdded")}</th>
                  <th className="py-2 pr-2 text-xs font-semibold text-red-700 text-right">Chg</th>
                  <th className="py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {sortedIdeas(state.fundstratBottom, bottomSort).map((item, i) => {
                  const livePrice = livePrices[item.ticker];
                  const pctChange = livePrice && item.priceWhenAdded ? ((livePrice - item.priceWhenAdded) / item.priceWhenAdded * 100) : null;
                  return (
                    <tr key={item.ticker} className={`border-b border-slate-100 ${i % 2 === 0 ? "bg-white" : "bg-red-50/30"} hover:bg-red-50/60 transition-colors`}>
                      <td className="py-2 pr-2 text-slate-400">{i + 1}</td>
                      <td className="py-2 pr-3 font-mono font-bold text-red-700">${item.ticker}</td>
                      <td className="py-2 pr-3 text-right font-mono">
                        {pricesLoading ? (
                          <span className="text-slate-300 animate-pulse">...</span>
                        ) : livePrice != null ? (
                          <span className="font-semibold">${livePrice.toFixed(2)}</span>
                        ) : (
                          <span className="text-slate-300">—</span>
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
                          <span className={pctChange >= 0 ? "text-emerald-600" : "text-red-500"}>
                            {pctChange >= 0 ? "+" : ""}{pctChange.toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {scoredStocks.some((s) => s.ticker === item.ticker) ? (
                          <span className="text-[10px] text-emerald-500 font-medium">In list</span>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); addToWatchlist(item.ticker); }}
                            className="text-[10px] text-blue-500 hover:text-blue-700 font-semibold transition-colors"
                            title="Add to Watchlist"
                          >
                            + Watch
                          </button>
                        )}
                        <button onClick={() => removeIdea("fundstratBottom", item.ticker)} className="ml-2 text-slate-300 hover:text-red-500 font-bold transition-colors">&times;</button>
                      </td>
                    </tr>
                  );
                })}
                {state.fundstratBottom.length === 0 && (
                  <tr><td colSpan={6} className="py-6 text-center text-slate-400 italic">No bottom ideas added yet</td></tr>
                )}
              </tbody>
            </table>

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
          </section>
        </div>

        {/* ── Fundstrat SMID-Cap Core Top + Bottom (mirrors the
             Large-Cap pair). Top is positive (buy), Bottom is negative
             (avoid/short, treated identically to Large-Cap Bottom by
             the cross-source synthesis). */}
        <div className="grid gap-5 lg:grid-cols-2">
          {/* SMID Top Ideas */}
          <section className="rounded-[24px] border border-emerald-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold text-emerald-800">Fundstrat Top SMID-Cap Core Ideas</h3>
                <p className="text-xs text-slate-400">Best long ideas — small/mid-cap names</p>
              </div>
              <span className="text-sm text-slate-400">{(state.fundstratSmidTop ?? []).length} names</span>
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-2 border-emerald-500 text-left">
                  <th className="py-2 pr-2 text-xs font-semibold text-emerald-700 w-8">#</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-emerald-700 cursor-pointer hover:text-emerald-900 select-none" onClick={() => toggleSmidTopSort("ticker")}>Ticker{stArrow("ticker")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-emerald-700 text-right cursor-pointer hover:text-emerald-900 select-none" onClick={() => toggleSmidTopSort("currentPrice")}>Current Price{stArrow("currentPrice")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-emerald-700 text-right cursor-pointer hover:text-emerald-900 select-none" onClick={() => toggleSmidTopSort("priceWhenAdded")}>Price Added{stArrow("priceWhenAdded")}</th>
                  <th className="py-2 pr-2 text-xs font-semibold text-emerald-700 text-right">Chg</th>
                  <th className="py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {sortedIdeas(state.fundstratSmidTop ?? [], smidTopSort).map((item, i) => {
                  const livePrice = livePrices[item.ticker];
                  const pctChange = livePrice && item.priceWhenAdded ? ((livePrice - item.priceWhenAdded) / item.priceWhenAdded * 100) : null;
                  return (
                    <tr key={item.ticker} className={`border-b border-slate-100 ${i % 2 === 0 ? "bg-white" : "bg-emerald-50/30"} hover:bg-emerald-50/60 transition-colors`}>
                      <td className="py-2 pr-2 text-slate-400">{i + 1}</td>
                      <td className="py-2 pr-3 font-mono font-bold text-emerald-700">${item.ticker}</td>
                      <td className="py-2 pr-3 text-right font-mono">
                        {pricesLoading ? <span className="text-slate-300 animate-pulse">...</span>
                          : livePrice != null ? <span className="font-semibold">${livePrice.toFixed(2)}</span>
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        <EditableCell
                          value={item.priceWhenAdded ? `$${item.priceWhenAdded.toFixed(2)}` : "—"}
                          onChange={(v) => updateIdea("fundstratSmidTop", i, v.replace("$", ""))}
                        />
                      </td>
                      <td className="py-2 pr-2 text-right font-mono text-xs">
                        {pctChange != null ? (
                          <span className={pctChange >= 0 ? "text-emerald-600" : "text-red-500"}>
                            {pctChange >= 0 ? "+" : ""}{pctChange.toFixed(1)}%
                          </span>
                        ) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {scoredStocks.some((s) => s.ticker === item.ticker) ? (
                          <span className="text-[10px] text-emerald-500 font-medium">In list</span>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); addToWatchlist(item.ticker); }}
                            className="text-[10px] text-blue-500 hover:text-blue-700 font-semibold transition-colors"
                            title="Add to Watchlist"
                          >
                            + Watch
                          </button>
                        )}
                        <button onClick={() => removeIdea("fundstratSmidTop", item.ticker)} className="ml-2 text-slate-300 hover:text-red-500 font-bold transition-colors">&times;</button>
                      </td>
                    </tr>
                  );
                })}
                {(state.fundstratSmidTop ?? []).length === 0 && (
                  <tr><td colSpan={6} className="py-6 text-center text-slate-400 italic">No top SMID ideas added yet</td></tr>
                )}
              </tbody>
            </table>

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
          </section>

          {/* SMID Bottom Ideas */}
          <section className="rounded-[24px] border border-red-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold text-red-800">Fundstrat Bottom SMID-Cap Core Ideas</h3>
                <p className="text-xs text-slate-400">Names to avoid or short — small/mid-cap</p>
              </div>
              <span className="text-sm text-slate-400">{(state.fundstratSmidBottom ?? []).length} names</span>
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-2 border-red-400 text-left">
                  <th className="py-2 pr-2 text-xs font-semibold text-red-700 w-8">#</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-red-700 cursor-pointer hover:text-red-900 select-none" onClick={() => toggleSmidBottomSort("ticker")}>Ticker{sbArrow("ticker")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-red-700 text-right cursor-pointer hover:text-red-900 select-none" onClick={() => toggleSmidBottomSort("currentPrice")}>Current Price{sbArrow("currentPrice")}</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-red-700 text-right cursor-pointer hover:text-red-900 select-none" onClick={() => toggleSmidBottomSort("priceWhenAdded")}>Price Added{sbArrow("priceWhenAdded")}</th>
                  <th className="py-2 pr-2 text-xs font-semibold text-red-700 text-right">Chg</th>
                  <th className="py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {sortedIdeas(state.fundstratSmidBottom ?? [], smidBottomSort).map((item, i) => {
                  const livePrice = livePrices[item.ticker];
                  const pctChange = livePrice && item.priceWhenAdded ? ((livePrice - item.priceWhenAdded) / item.priceWhenAdded * 100) : null;
                  return (
                    <tr key={item.ticker} className={`border-b border-slate-100 ${i % 2 === 0 ? "bg-white" : "bg-red-50/30"} hover:bg-red-50/60 transition-colors`}>
                      <td className="py-2 pr-2 text-slate-400">{i + 1}</td>
                      <td className="py-2 pr-3 font-mono font-bold text-red-700">${item.ticker}</td>
                      <td className="py-2 pr-3 text-right font-mono">
                        {pricesLoading ? <span className="text-slate-300 animate-pulse">...</span>
                          : livePrice != null ? <span className="font-semibold">${livePrice.toFixed(2)}</span>
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        <EditableCell
                          value={item.priceWhenAdded ? `$${item.priceWhenAdded.toFixed(2)}` : "—"}
                          onChange={(v) => updateIdea("fundstratSmidBottom", i, v.replace("$", ""))}
                        />
                      </td>
                      <td className="py-2 pr-2 text-right font-mono text-xs">
                        {pctChange != null ? (
                          <span className={pctChange >= 0 ? "text-emerald-600" : "text-red-500"}>
                            {pctChange >= 0 ? "+" : ""}{pctChange.toFixed(1)}%
                          </span>
                        ) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {scoredStocks.some((s) => s.ticker === item.ticker) ? (
                          <span className="text-[10px] text-emerald-500 font-medium">In list</span>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); addToWatchlist(item.ticker); }}
                            className="text-[10px] text-blue-500 hover:text-blue-700 font-semibold transition-colors"
                            title="Add to Watchlist"
                          >
                            + Watch
                          </button>
                        )}
                        <button onClick={() => removeIdea("fundstratSmidBottom", item.ticker)} className="ml-2 text-slate-300 hover:text-red-500 font-bold transition-colors">&times;</button>
                      </td>
                    </tr>
                  );
                })}
                {(state.fundstratSmidBottom ?? []).length === 0 && (
                  <tr><td colSpan={6} className="py-6 text-center text-slate-400 italic">No bottom SMID ideas added yet</td></tr>
                )}
              </tbody>
            </table>

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
          </section>
        </div>

        {/* ── Tom Lee Focus Areas ── */}
        <section className="rounded-[24px] border border-amber-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-lg font-bold text-amber-800">Tom Lee&apos;s Focus Areas</h3>
              <p className="text-xs text-slate-400">Key themes and areas Lee is emphasizing — type freely, these feed into the morning brief</p>
            </div>
            <span className="text-sm text-slate-400">{(state.leeFocusAreas ?? []).length} themes</span>
          </div>
          <div className="flex flex-wrap gap-2 mb-3">
            {(state.leeFocusAreas ?? []).map((area, idx) => (
              <span
                key={idx}
                className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-sm font-medium text-amber-800"
              >
                {area.label}
                <button
                  onClick={() => {
                    const updated = (state.leeFocusAreas ?? []).filter((_, i) => i !== idx);
                    save({ ...state, leeFocusAreas: updated });
                  }}
                  className="ml-0.5 text-amber-400 hover:text-red-500 font-bold transition-colors text-xs"
                  title="Remove"
                >
                  &times;
                </button>
              </span>
            ))}
            {(state.leeFocusAreas ?? []).length === 0 && (
              <span className="text-sm text-slate-400 italic">No focus areas added yet</span>
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
              className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none placeholder:text-slate-400 focus:bg-white focus:border-amber-300 focus:ring-1 focus:ring-amber-200 transition-all"
            />
            <button
              type="submit"
              className="rounded-xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 transition-colors"
            >
              Add
            </button>
          </form>
        </section>

        {/* ── RBC Canadian Focus List ── */}
        <section className="rounded-[24px] border border-blue-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-xl font-bold text-blue-800">RBC Canadian Focus List</h3>
              <p className="text-xs text-slate-400">RBC Capital Markets Canadian equity picks</p>
            </div>
            <span className="text-sm text-slate-400">{(state.rbcCanadianFocus || []).length} names</span>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-blue-500 text-left">
                <th className="py-2 pr-2 text-xs font-semibold text-blue-700 w-8">#</th>
                <th className="py-2 pr-3 text-xs font-semibold text-blue-700 cursor-pointer hover:text-blue-900 select-none" onClick={() => toggleRbcSort("ticker")}>Ticker{rArrow("ticker")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-blue-700 cursor-pointer hover:text-blue-900 select-none" onClick={() => toggleRbcSort("name")}>Name{rArrow("name")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-blue-700 cursor-pointer hover:text-blue-900 select-none" onClick={() => toggleRbcSort("sector")}>Sector{rArrow("sector")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-blue-700 cursor-pointer hover:text-blue-900 select-none" onClick={() => toggleRbcSort("weight")}>Weight (%){rArrow("weight")}</th>
                <th className="py-2 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {sortedRbc().map((item, i) => (
                <tr key={item.ticker} className={`border-b border-slate-100 ${i % 2 === 0 ? "bg-white" : "bg-blue-50/30"} hover:bg-blue-50/60 transition-colors`}>
                  <td className="py-2 pr-2 text-slate-400">{i + 1}</td>
                  <td className="py-2 pr-3 font-mono font-bold text-blue-700">${item.ticker}</td>
                  <td className="py-2 pr-3 text-slate-700 truncate max-w-[260px]" title={item.name || item.ticker}>{item.name || <span className="text-slate-300 italic">—</span>}</td>
                  <td className="py-2 pr-3 text-slate-600">{item.sector}</td>
                  <td className="py-2 pr-3 text-slate-500">
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
                      className="w-16 rounded border border-transparent px-1 py-0.5 text-sm text-center hover:border-slate-200 focus:border-blue-300 focus:outline-none bg-transparent"
                    />
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {scoredStocks.some((s) => s.ticker === item.ticker) ? (
                      <span className="text-[10px] text-emerald-500 font-medium">In list</span>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); addToWatchlist(item.ticker); }}
                        className="text-[10px] text-blue-500 hover:text-blue-700 font-semibold transition-colors"
                        title="Add to Watchlist"
                      >
                        + Watch
                      </button>
                    )}
                    <button onClick={() => removeRbc(item.ticker)} className="ml-2 text-slate-300 hover:text-red-500 font-bold transition-colors">&times;</button>
                  </td>
                </tr>
              ))}
              {(state.rbcCanadianFocus || []).length === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-slate-400 italic">No names added yet</td></tr>
              )}
            </tbody>
          </table>

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
        </section>

        {/* ── RBC US Focus List ──
            Parallel to the Canadian list. Same RBCEntry shape, same
            manual-add + screenshot-scan flow; targets state.rbcUsFocus
            so the two stay independent. Section is teal-accented to
            visually distinguish it from the blue Canadian section. */}
        <section className="rounded-[24px] border border-teal-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-xl font-bold text-teal-800">RBC US Focus List</h3>
              <p className="text-xs text-slate-400">RBC Capital Markets US equity picks</p>
            </div>
            <span className="text-sm text-slate-400">{(state.rbcUsFocus || []).length} names</span>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-teal-500 text-left">
                <th className="py-2 pr-2 text-xs font-semibold text-teal-700 w-8">#</th>
                <th className="py-2 pr-3 text-xs font-semibold text-teal-700 cursor-pointer hover:text-teal-900 select-none" onClick={() => toggleRbcUsSort("ticker")}>Ticker{rUsArrow("ticker")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-teal-700 cursor-pointer hover:text-teal-900 select-none" onClick={() => toggleRbcUsSort("name")}>Name{rUsArrow("name")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-teal-700 cursor-pointer hover:text-teal-900 select-none" onClick={() => toggleRbcUsSort("sector")}>Sector{rUsArrow("sector")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-teal-700 cursor-pointer hover:text-teal-900 select-none" onClick={() => toggleRbcUsSort("weight")}>Weight (%){rUsArrow("weight")}</th>
                <th className="py-2 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {sortedRbcUs().map((item, i) => (
                <tr key={item.ticker} className={`border-b border-slate-100 ${i % 2 === 0 ? "bg-white" : "bg-teal-50/30"} hover:bg-teal-50/60 transition-colors`}>
                  <td className="py-2 pr-2 text-slate-400">{i + 1}</td>
                  <td className="py-2 pr-3 font-mono font-bold text-teal-700">${item.ticker}</td>
                  <td className="py-2 pr-3 text-slate-700 truncate max-w-[260px]" title={item.name || item.ticker}>{item.name || <span className="text-slate-300 italic">—</span>}</td>
                  <td className="py-2 pr-3 text-slate-600">{item.sector}</td>
                  <td className="py-2 pr-3 text-slate-500">
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
                      className="w-16 rounded border border-transparent px-1 py-0.5 text-sm text-center hover:border-slate-200 focus:border-teal-300 focus:outline-none bg-transparent"
                    />
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {scoredStocks.some((s) => s.ticker === item.ticker) ? (
                      <span className="text-[10px] text-emerald-500 font-medium">In list</span>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); addToWatchlist(item.ticker); }}
                        className="text-[10px] text-blue-500 hover:text-blue-700 font-semibold transition-colors"
                        title="Add to Watchlist"
                      >
                        + Watch
                      </button>
                    )}
                    <button onClick={() => removeRbcUs(item.ticker)} className="ml-2 text-slate-300 hover:text-red-500 font-bold transition-colors">&times;</button>
                  </td>
                </tr>
              ))}
              {(state.rbcUsFocus || []).length === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-slate-400 italic">No names added yet</td></tr>
              )}
            </tbody>
          </table>

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
        </section>

        {/* ── Seeking Alpha - Alpha Picks ──
            Mirrors the Newton's Upticks layout: name + sector + price
            + entry + dateAdded + change columns, screenshot-first flow
            with a manual add fallback. The screenshot is the primary
            input; the manual form covers the case where you want to
            log a pick without screenshotting. */}
        <section className="rounded-[24px] border border-slate-200 bg-white p-6 shadow-sm">
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
              if (c === "Strong Buy") return "bg-emerald-600 text-white";
              if (c === "Buy") return "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200";
              if (c === "Hold") return "bg-amber-100 text-amber-800 ring-1 ring-amber-200";
              if (c === "Sell") return "bg-red-100 text-red-700 ring-1 ring-red-200";
              if (c === "Strong Sell") return "bg-red-600 text-white";
              return "bg-slate-100 text-slate-500";
            };
            const manualSellTone = "bg-red-700 text-white";

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
            const visiblePicks = alphaRatingFilter == null
              ? allPicks
              : allPicks.filter((p) => bucket(p) === alphaRatingFilter);

            // Toggle the PM's manual-sell flag on a single pick.
            // Updates state directly without touching the rest of the
            // entry. Doesn't auto-drop — the pick stays visible (in
            // the "Manual Sell" bucket and with red row highlight)
            // until the user hits "Drop sell candidates."
            const toggleManualSell = (ticker: string) => {
              const updated = allPicks.map((p) =>
                p.ticker === ticker ? { ...p, manualSell: !p.manualSell } : p
              );
              save({ ...state, alphaPicks: updated });
            };

            const sellCandidateCount = allPicks.filter(isSellCandidate).length;

            const handleDropSellCandidates = () => {
              if (sellCandidateCount === 0) return;
              if (!confirm(`Drop ${sellCandidateCount} pick(s) flagged for sale (Sell/Strong Sell rating, or Hold ≥ 180 days)?\n\nWeight from dropped picks will be redistributed equally across the remaining picks (per SA's documented rule).`)) return;

              // Per SA's rule: "the cash generated from sold positions
              // will be equally invested across the remaining stocks
              // in the Alpha Picks portfolio." So sum the dropped
              // weight and split it equally across what's left. Picks
              // without holdingWeight (legacy entries scraped before
              // the field existed) don't contribute to or receive
              // redistribution — they stay at undefined holdingWeight
              // until the next fresh scrape pulls SA's actual numbers.
              const dropped = allPicks.filter(isSellCandidate);
              const remaining = allPicks.filter((p) => !isSellCandidate(p));
              const droppedWeightTotal = dropped.reduce(
                (sum, p) => sum + (p.holdingWeight ?? 0), 0
              );
              const remainingWithWeight = remaining.filter((p) => p.holdingWeight != null);
              const perPickAdd = remainingWithWeight.length > 0
                ? droppedWeightTotal / remainingWithWeight.length
                : 0;
              const updated = remaining.map((p) =>
                p.holdingWeight != null
                  ? { ...p, holdingWeight: parseFloat((p.holdingWeight + perPickAdd).toFixed(2)) }
                  : p
              );
              save({ ...state, alphaPicks: updated });
            };

            return (
              <>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h3 className="text-xl font-bold">Seeking Alpha &mdash; Alpha Picks</h3>
                    <p className="text-xs text-slate-400">
                      Institutional buy recommendations &mdash; primarily populated by uploading the Alpha Picks dashboard screenshot. Manual adds also work.
                    </p>
                  </div>
                  <span className="text-sm text-slate-400">{allPicks.length} picks</span>
                </div>

                {/* Rating filter chips + sell-candidate alert. */}
                <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
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
                              ? "bg-slate-800 text-white"
                              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                          }`}
                        >
                          {b.label} <span className="opacity-70">({c})</span>
                        </button>
                      );
                    })}
                  </div>
                  {sellCandidateCount > 0 && (
                    <button
                      onClick={handleDropSellCandidates}
                      className="text-[11px] font-semibold rounded-full px-3 py-1 bg-red-50 text-red-700 ring-1 ring-red-200 hover:bg-red-100 transition-colors"
                      title="SA sells stocks that drop to Sell/Strong Sell, OR that stay at Hold for 180+ days. This drops those picks from your list."
                    >
                      Drop {sellCandidateCount} sell candidate{sellCandidateCount === 1 ? "" : "s"}
                    </button>
                  )}
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b-2 border-slate-300 text-left">
                        <th className="py-2 pr-2 text-xs font-semibold text-slate-600 w-8">#</th>
                        <th className="py-2 pr-3 text-xs font-semibold text-slate-600">Name</th>
                        <th className="py-2 pr-3 text-xs font-semibold text-slate-600">Ticker</th>
                        <th className="py-2 pr-3 text-xs font-semibold text-slate-600">Sector</th>
                        <th className="py-2 pr-2 text-xs font-semibold text-slate-600">Rating</th>
                        <th className="py-2 pr-2 text-xs font-semibold text-slate-600 text-right">Holding %</th>
                        <th className="py-2 pr-3 text-xs font-semibold text-slate-600 text-right">Current Price</th>
                        <th className="py-2 pr-3 text-xs font-semibold text-slate-600 text-right">Price Picked</th>
                        <th className="py-2 pr-2 text-xs font-semibold text-slate-600 text-right">SA Return</th>
                        <th className="py-2 pr-3 text-xs font-semibold text-slate-600">Date Added</th>
                        <th className="py-2 pr-2 text-xs font-semibold text-slate-600 text-right">Days</th>
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
                          <tr key={pick.ticker} className={`border-b border-slate-100 ${flagged ? "bg-red-50/40" : i % 2 === 0 ? "bg-white" : "bg-slate-50/40"} hover:bg-slate-50 transition-colors`}>
                            <td className="py-2 pr-2 text-slate-400">{i + 1}</td>
                            <td className="py-2 pr-3 text-slate-700 truncate max-w-[200px]" title={pick.name}>{pick.name}</td>
                            <td className="py-2 pr-3 font-mono font-bold">${pick.ticker}</td>
                            <td className="py-2 pr-3 text-xs text-slate-500">{pick.sector || "—"}</td>
                            <td className="py-2 pr-2">
                              <div className="flex items-center gap-1 flex-wrap">
                                {pick.rating ? (
                                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${ratingTone(pick.rating)}`}>
                                    {canonicalRating(pick.rating) ?? pick.rating}
                                  </span>
                                ) : <span className="text-slate-300 text-[10px]">—</span>}
                                {pick.manualSell && (
                                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${manualSellTone}`} title="Manually flagged as sold by the PM (overrides SA rating for sell-candidate logic)">
                                    Manual Sell
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="py-2 pr-2 text-right font-mono text-xs">
                              {pick.holdingWeight != null
                                ? <span className="text-slate-700">{pick.holdingWeight.toFixed(2)}%</span>
                                : <span className="text-slate-300">—</span>}
                            </td>
                            <td className="py-2 pr-3 text-right font-mono">
                              {pricesLoading ? <span className="text-slate-300 animate-pulse">...</span>
                                : livePrice != null ? <span className="font-semibold">${livePrice.toFixed(2)}</span>
                                : <span className="text-slate-300">—</span>}
                            </td>
                            <td className="py-2 pr-3 text-right font-mono">
                              {pick.priceWhenAdded > 0
                                ? `$${pick.priceWhenAdded.toFixed(2)}`
                                : <span className="text-slate-300">—</span>}
                            </td>
                            <td className="py-2 pr-2 text-right font-mono text-xs">
                              {pick.returnSinceAdded != null ? (
                                <span className={pick.returnSinceAdded >= 0 ? "text-emerald-600" : "text-red-500"}>
                                  {pick.returnSinceAdded >= 0 ? "+" : ""}{pick.returnSinceAdded.toFixed(1)}%
                                </span>
                              ) : <span className="text-slate-300">—</span>}
                            </td>
                            <td className="py-2 pr-3 text-xs text-slate-500">{pick.dateAdded || "—"}</td>
                            <td className="py-2 pr-2 text-right text-xs">
                              {days != null ? (
                                <span className={canonicalRating(pick.rating) === "Hold" && days >= 150 ? "text-red-600 font-semibold" : "text-slate-500"} title={canonicalRating(pick.rating) === "Hold" && days >= 180 ? "Hold ≥ 180 days — SA would sell" : canonicalRating(pick.rating) === "Hold" && days >= 150 ? "Approaching SA's 180-day Hold sell rule" : ""}>
                                  {days}d
                                </span>
                              ) : <span className="text-slate-300">—</span>}
                            </td>
                            <td className="py-2 text-right whitespace-nowrap">
                              {scoredStocks.some((s) => s.ticker === pick.ticker) ? (
                                <span className="text-[10px] text-emerald-500 font-medium">In list</span>
                              ) : (
                                <button
                                  onClick={(e) => { e.stopPropagation(); addToWatchlist(pick.ticker); }}
                                  className="text-[10px] text-blue-500 hover:text-blue-700 font-semibold transition-colors"
                                  title="Add to Watchlist"
                                >
                                  + Watch
                                </button>
                              )}
                              <button
                                onClick={() => toggleManualSell(pick.ticker)}
                                className={`ml-2 text-[10px] font-semibold transition-colors ${pick.manualSell ? "text-slate-500 hover:text-slate-700" : "text-red-600 hover:text-red-800"}`}
                                title={pick.manualSell ? "Unmark as sold (return to normal rating bucket)" : "Mark as sold — flags this pick as a sell candidate, regardless of SA's current rating. Use 'Drop sell candidates' to remove and redistribute weight."}
                              >
                                {pick.manualSell ? "Unmark" : "Mark sold"}
                              </button>
                              <button
                                onClick={() => save({ ...state, alphaPicks: allPicks.filter((p) => p.ticker !== pick.ticker) })}
                                className="ml-2 text-slate-300 hover:text-red-500 font-bold transition-colors"
                                title="Remove from list (no weight redistribution)"
                              >
                                &times;
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                      {visiblePicks.length === 0 && (
                        <tr><td colSpan={12} className="py-8 text-center text-slate-400 italic">
                          {allPicks.length === 0 ? "No picks yet — upload a screenshot below or add manually" : "No picks match this rating filter"}
                        </td></tr>
                      )}
                    </tbody>
                  </table>
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
        </section>

        {/* General Notes section removed per user request — was unused
            in the daily workflow. The generalNotes field stays on the
            ResearchState schema for backward-compat with persisted
            data; nothing renders it. */}

        {/* ── Quick Reference ── */}
        <section className="rounded-[24px] border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-lg font-semibold mb-4">Quick Reference</h3>
          <div className="grid gap-5 md:grid-cols-3">
            <div className="rounded-xl bg-slate-50 p-4">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">PIM Score Thresholds</div>
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between"><span className="text-emerald-700 font-medium">Strong Buy</span><span>&ge; 30/40</span></div>
                <div className="flex justify-between"><span className="text-emerald-600 font-medium">Moderate Buy</span><span>&ge; 26/40</span></div>
                <div className="flex justify-between"><span className="text-amber-600 font-medium">Hold</span><span>&ge; 22/40</span></div>
                <div className="flex justify-between"><span className="text-red-500 font-medium">Underweight</span><span>&ge; 18/40</span></div>
                <div className="flex justify-between"><span className="text-red-700 font-medium">Sell</span><span>&lt; 18/40</span></div>
              </div>
            </div>
            <div className="rounded-xl bg-slate-50 p-4">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">Regime Multipliers</div>
              <div className="space-y-1.5 text-sm">
                <div className="text-xs font-bold text-red-700 mt-1">Risk-Off</div>
                <div className="flex justify-between"><span>Growth</span><span className="text-red-600 font-medium">0.85x</span></div>
                <div className="flex justify-between"><span>Cyclical</span><span className="text-amber-600 font-medium">0.90x</span></div>
                <div className="flex justify-between"><span>Defensive</span><span className="text-emerald-600 font-medium">1.10x</span></div>
                <div className="text-xs font-bold text-amber-700 mt-2">Neutral</div>
                <div className="flex justify-between"><span>Growth</span><span className="text-amber-600 font-medium">0.98x</span></div>
                <div className="flex justify-between"><span>Cyclical</span><span className="text-amber-600 font-medium">0.99x</span></div>
                <div className="flex justify-between"><span>Defensive</span><span className="text-emerald-600 font-medium">1.01x</span></div>
                <div className="text-xs font-bold text-emerald-700 mt-2">Risk-On</div>
                <div className="flex justify-between"><span>Growth</span><span className="text-emerald-600 font-medium">1.10x</span></div>
                <div className="flex justify-between"><span>Cyclical</span><span className="text-emerald-600 font-medium">1.05x</span></div>
                <div className="flex justify-between"><span>Defensive</span><span className="text-amber-600 font-medium">0.92x</span></div>
              </div>
              <p className="mt-3 text-xs text-slate-400">Growth: Tech, Comm Svc, Consumer Disc · Cyclical: Fin, Ind, Mat · Neutral: Energy, Real Estate · Quality dampening ±35%</p>
            </div>
            <div className="rounded-xl bg-slate-50 p-4">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">Contrarian Thresholds</div>
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between"><span>F&G &le; 15</span><span className="text-emerald-600 font-medium">Contrarian Buy</span></div>
                <div className="flex justify-between"><span>F&G &ge; 75</span><span className="text-red-600 font-medium">Contrarian Sell</span></div>
                <div className="flex justify-between"><span>AAII &le; -20</span><span className="text-emerald-600 font-medium">Contrarian Buy</span></div>
                <div className="flex justify-between"><span>AAII &ge; +30</span><span className="text-red-600 font-medium">Contrarian Sell</span></div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
