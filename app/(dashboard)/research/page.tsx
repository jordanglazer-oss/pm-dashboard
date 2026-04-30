"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { ResearchState, UptickEntry, IdeaEntry, RBCEntry, SectorViewEntry, SectorView, LeeFocusArea } from "@/app/lib/defaults";
import { defaultResearch, GICS_SECTORS } from "@/app/lib/defaults";
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
 * Inline screenshot-scan block used by the four non-Newton research
 * sources (Fundstrat Top/Bottom, RBC Canadian Focus, Alpha Picks).
 * Mirrors the upticks scanner's UI pattern: ImageUpload + Refresh +
 * Force re-scan + status line. The scrape itself is hash-gated per
 * source on the server, so refreshes with unchanged screenshots cost
 * zero Anthropic tokens.
 */
function ResearchScraperBlock(props: {
  source: "fundstrat-top" | "fundstrat-bottom" | "rbc-focus" | "seeking-alpha-picks";
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
type RBCSortKey = "ticker" | "sector" | "dateAdded";
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
  const [rbcSort, setRbcSort] = useState<{ key: RBCSortKey; dir: SortDir }>({ key: "ticker", dir: "asc" });

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
  type SourceKey = "fundstrat-top" | "fundstrat-bottom" | "rbc-focus" | "seeking-alpha-picks";
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
  function toggleTopSort(key: IdeaSortKey) {
    setTopSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }
  function toggleBottomSort(key: IdeaSortKey) {
    setBottomSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }
  function toggleRbcSort(key: RBCSortKey) {
    setRbcSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
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

  function sortedRbc() {
    return [...(state.rbcCanadianFocus || [])].sort((a, b) => {
      const { key, dir } = rbcSort;
      const cmp = String(a[key] || "").localeCompare(String(b[key] || ""));
      return dir === "asc" ? cmp : -cmp;
    });
  }

  const uArrow = (key: UptickSortKey) => uptickSort.key === key ? (uptickSort.dir === "asc" ? " ▲" : " ▼") : "";
  const tArrow = (key: IdeaSortKey) => topSort.key === key ? (topSort.dir === "asc" ? " ▲" : " ▼") : "";
  const bArrow = (key: IdeaSortKey) => bottomSort.key === key ? (bottomSort.dir === "asc" ? " ▲" : " ▼") : "";
  const rArrow = (key: RBCSortKey) => rbcSort.key === key ? (rbcSort.dir === "asc" ? " ▲" : " ▼") : "";

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

      if (source === "rbc-focus") {
        const existing = state.rbcCanadianFocus || [];
        const byNorm = new Map(existing.map((r) => [normalize(r.ticker), r]));
        let matched = 0;
        let added = 0;
        for (const e of entries) {
          const norm = normalize(e.ticker);
          const ex = byNorm.get(norm);
          if (ex) {
            matched += 1;
            byNorm.set(norm, {
              ticker: ex.ticker,
              sector: e.sector ?? ex.sector,
              weight: e.weight ?? ex.weight,
              dateAdded: e.dateAdded ?? ex.dateAdded,
            });
          } else {
            added += 1;
            byNorm.set(norm, {
              ticker: norm,
              sector: e.sector ?? "—",
              weight: e.weight ?? 0,
              dateAdded: e.dateAdded ?? new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" }),
            });
          }
        }
        nextState = { ...state, rbcCanadianFocus: Array.from(byNorm.values()) };
        const cachedLabel = data.cached ? " (cached)" : "";
        setScrapeStatusMap((m) => ({ ...m, [source]: `${entries.length} rows${cachedLabel} · ${matched} matched · ${added} added` }));
      } else {
        // IdeaEntry-shaped sources
        const stateKey = source === "fundstrat-top" ? "fundstratTop"
                       : source === "fundstrat-bottom" ? "fundstratBottom"
                       : "alphaPicks";
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
  }, [state, save]);

  /**
   * Cross-source synthesis: POSTs the current research state + brief
   * to /api/research-synthesis. Server hash-gates on the inputs:
   * unchanged research + brief → returns the cached result with zero
   * Anthropic spend. Force=true bypasses to re-generate against the
   * same inputs (use when the previous output was thin or the prompt
   * needs another shot).
   *
   * The result lives only on the server cache (pm:research-synthesis-cache).
   * The page fires this once on mount with force=false to hydrate the
   * tile from cache. The user's "Refresh" button calls it again with
   * force=false (which is still essentially free if nothing changed),
   * and "Force re-generate" passes force=true.
   */
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
      const cachedLabel = data.cached ? "cached" : "fresh";
      const totalPicks = data.result.topPicks.length + data.result.honorableMentions.length;
      setSynthesisStatus(`${totalPicks} picks · ${cachedLabel}`);
      return true;
    } catch (e) {
      console.error("research-synthesis failed:", e);
      setSynthesisStatus("Synthesis failed");
      return false;
    } finally {
      setSynthesisLoading(false);
    }
  }, [state, brief]);

  // Auto-hydrate the synthesis on first load. POSTs with force=false so
  // the server returns the cached result if the inputs are unchanged
  // since the last generation — zero token spend. We wait until research
  // state is loaded before firing.
  const synthesisHydratedRef = useRef(false);
  useEffect(() => {
    if (!loaded || synthesisHydratedRef.current) return;
    synthesisHydratedRef.current = true;
    void generateSynthesis(false);
  }, [loaded, generateSynthesis]);

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
  const addIdea = (key: "fundstratTop" | "fundstratBottom", entry: IdeaEntry) => {
    if (state[key].some((i) => i.ticker === entry.ticker)) return;
    save({ ...state, [key]: [...state[key], entry] });
  };
  const removeIdea = (key: "fundstratTop" | "fundstratBottom", ticker: string) => {
    save({ ...state, [key]: state[key].filter((i) => i.ticker !== ticker) });
  };
  const updateIdea = (key: "fundstratTop" | "fundstratBottom", idx: number, price: string) => {
    const updated = [...state[key]];
    updated[idx] = { ...updated[idx], priceWhenAdded: parseFloat(price) || 0 };
    save({ ...state, [key]: updated });
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
              <button
                onClick={() => { void generateSynthesis(false); }}
                disabled={synthesisLoading}
                className="text-[11px] rounded-md bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                title={synthesis ? "Re-fetch the cached synthesis (free if inputs haven't changed)" : "Generate the cross-source synthesis from current research + brief"}
              >
                {synthesisLoading ? "Generating..." : synthesis ? "Refresh" : "Generate"}
              </button>
              <button
                onClick={() => { void generateSynthesis(true); }}
                disabled={synthesisLoading}
                className="text-[11px] rounded-md border border-slate-300 bg-white px-2.5 py-1.5 font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50 transition-colors"
                title="Bypass cache and re-run the synthesis prompt against current inputs"
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
                <h3 className="text-xl font-bold text-emerald-800">Fundstrat Top Ideas</h3>
                <p className="text-xs text-slate-400">Best long ideas from research</p>
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
              sectionLabel="Fundstrat Top Ideas"
              helperText="Upload a Fundstrat Top Ideas screenshot. On Refresh, ticker + entry price are extracted and merged into the list. Re-scans only if the image changes."
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
                <h3 className="text-xl font-bold text-red-800">Fundstrat Bottom Ideas</h3>
                <p className="text-xs text-slate-400">Names to avoid or short</p>
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
              sectionLabel="Fundstrat Bottom Ideas"
              helperText="Upload a Fundstrat Bottom Ideas screenshot. On Refresh, ticker + entry price are extracted and merged into the list."
              attachments={state.attachments || []}
              onAddAttachment={addAttachment}
              onRemoveAttachment={removeAttachment}
              onScrape={(force) => scrapeResearchSource("fundstrat-bottom", force)}
              loading={!!scrapeLoadingMap["fundstrat-bottom"]}
              status={scrapeStatusMap["fundstrat-bottom"]}
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
                <th className="py-2 pr-3 text-xs font-semibold text-blue-700 cursor-pointer hover:text-blue-900 select-none" onClick={() => toggleRbcSort("sector")}>Sector{rArrow("sector")}</th>
                <th className="py-2 pr-3 text-xs font-semibold text-blue-700">Weight (%)</th>
                <th className="py-2 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {sortedRbc().map((item, i) => (
                <tr key={item.ticker} className={`border-b border-slate-100 ${i % 2 === 0 ? "bg-white" : "bg-blue-50/30"} hover:bg-blue-50/60 transition-colors`}>
                  <td className="py-2 pr-2 text-slate-400">{i + 1}</td>
                  <td className="py-2 pr-3 font-mono font-bold text-blue-700">${item.ticker}</td>
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
                  <td className="py-2">
                    <button onClick={() => removeRbc(item.ticker)} className="text-slate-300 hover:text-red-500 font-bold transition-colors">&times;</button>
                  </td>
                </tr>
              ))}
              {(state.rbcCanadianFocus || []).length === 0 && (
                <tr><td colSpan={5} className="py-6 text-center text-slate-400 italic">No names added yet</td></tr>
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

        {/* ── Seeking Alpha - Alpha Picks ── */}
        <section className="rounded-[24px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-lg font-semibold">Seeking Alpha &mdash; Alpha Picks</h3>
              <p className="text-xs text-slate-400">Institutional buy recommendations from Seeking Alpha</p>
            </div>
            <span className="text-sm text-slate-400">{(state.alphaPicks ?? []).length} picks</span>
          </div>

          {(state.alphaPicks ?? []).length > 0 ? (
            <table className="w-full text-sm mb-3">
              <thead>
                <tr className="border-b border-slate-200 text-left">
                  <th className="py-2 pr-2 text-xs font-semibold text-slate-600 w-8">#</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-slate-600">Ticker</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-slate-600 text-right">Current Price</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-slate-600 text-right">Price Picked</th>
                  <th className="py-2 pr-2 text-xs font-semibold text-slate-600 text-right">Chg</th>
                  <th className="py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {(state.alphaPicks ?? []).map((pick, i) => {
                  const livePrice = livePrices[pick.ticker];
                  const pctChange = livePrice && pick.priceWhenAdded
                    ? ((livePrice - pick.priceWhenAdded) / pick.priceWhenAdded * 100)
                    : null;
                  return (
                    <tr key={pick.ticker} className={`border-b border-slate-100 ${i % 2 === 0 ? "bg-white" : "bg-slate-50/40"}`}>
                      <td className="py-2 pr-2 text-slate-400">{i + 1}</td>
                      <td className="py-2 pr-3 font-mono font-bold">${pick.ticker}</td>
                      <td className="py-2 pr-3 text-right font-mono">
                        {pricesLoading ? <span className="text-slate-300 animate-pulse">...</span>
                          : livePrice != null ? <span className="font-semibold">${livePrice.toFixed(2)}</span>
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        {pick.priceWhenAdded ? `$${pick.priceWhenAdded.toFixed(2)}` : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="py-2 pr-2 text-right font-mono text-xs">
                        {pctChange != null ? (
                          <span className={pctChange >= 0 ? "text-emerald-600" : "text-red-500"}>
                            {pctChange >= 0 ? "+" : ""}{pctChange.toFixed(1)}%
                          </span>
                        ) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <button
                          onClick={() => save({ ...state, alphaPicks: (state.alphaPicks ?? []).filter((p) => p.ticker !== pick.ticker) })}
                          className="text-slate-300 hover:text-red-500 font-bold transition-colors"
                          title="Remove"
                        >
                          &times;
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-slate-400 italic mb-3">No picks yet — upload a screenshot below to populate.</p>
          )}

          <ResearchScraperBlock
            source="seeking-alpha-picks"
            sectionLabel="Alpha Picks"
            helperText="Upload a Seeking Alpha — Alpha Picks dashboard screenshot. On Refresh, ticker + entry price are extracted into the list above."
            attachments={state.attachments || []}
            onAddAttachment={addAttachment}
            onRemoveAttachment={removeAttachment}
            onScrape={(force) => scrapeResearchSource("seeking-alpha-picks", force)}
            loading={!!scrapeLoadingMap["seeking-alpha-picks"]}
            status={scrapeStatusMap["seeking-alpha-picks"]}
          />
        </section>

        {/* ── General Notes ── */}
        <section className="rounded-[24px] border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-lg font-semibold mb-3">General Notes</h3>
          <textarea
            value={state.generalNotes}
            onChange={(e) => save({ ...state, generalNotes: e.target.value })}
            placeholder="Market observations, strategy notes, meeting takeaways..."
            rows={8}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed outline-none resize-y placeholder:text-slate-400 focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all"
          />
        </section>

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
