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
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { scoredStocks, addStock } = useStocks();

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
    fetch("/api/kv/research")
      .then((r) => r.json())
      .then(async (data) => {
        if (data.research) {
          let research = data.research as ResearchState;
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
      fetch("/api/kv/research", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ research: next }),
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

  /* Uptick helpers */
  const addUptick = (entry: UptickEntry) => {
    if (state.newtonUpticks.some((u) => u.ticker === entry.ticker)) return;
    save({ ...state, newtonUpticks: [...state.newtonUpticks, entry] });
  };
  const removeUptick = (ticker: string) => {
    save({ ...state, newtonUpticks: state.newtonUpticks.filter((u) => u.ticker !== ticker) });
  };
  const updateUptick = (idx: number, field: keyof UptickEntry, value: string) => {
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

  /* Attachment helpers */
  const addAttachment = (att: BriefAttachment) => {
    save({ ...state, attachments: [...(state.attachments || []), att] });
  };
  const removeAttachment = (id: string) => {
    save({ ...state, attachments: (state.attachments || []).filter((a) => a.id !== id) });
  };

  if (!loaded) return null;

  return (
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-slate-900 md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Research Notes</h1>
          <p className="text-slate-500 mt-1">Track external research sources, ideas, and notes. All changes are saved and shared across the team.</p>
        </div>

        {/* ── Newton's Upticks ── */}
        <section className="rounded-[24px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-xl font-bold">Newton&apos;s Upticks</h3>
              <p className="text-xs text-slate-400">Fundstrat technical uptick list &mdash; click any cell to edit</p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={refreshUptickNames}
                disabled={namesLoading}
                className="flex items-center gap-1.5 rounded-lg bg-slate-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50 transition-colors"
                title="Refresh company names & sectors from Yahoo Finance"
              >
                <svg className={`w-3.5 h-3.5 ${namesLoading ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" /></svg>
                {namesLoading ? "Updating..." : "Refresh Names"}
              </button>
              <button
                onClick={() => fetchLivePrices()}
                disabled={pricesLoading}
                className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50 transition-colors"
                title="Refresh all prices from Yahoo Finance"
              >
                <svg className={`w-3.5 h-3.5 ${pricesLoading ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" /></svg>
                {pricesLoading ? "Updating..." : "Refresh Prices"}
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
                          <EditableCell value={`$${u.priceWhenAdded.toFixed(2)}`} onChange={(v) => updateUptick(i, "priceWhenAdded", v.replace("$", ""))} />
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
                        <EditableCell value={u.support} onChange={(v) => updateUptick(i, "support", v)} />
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        <EditableCell value={u.resistance} onChange={(v) => updateUptick(i, "resistance", v)} />
                      </td>
                      <td className="py-2 pr-3 text-slate-500">
                        <EditableCell value={u.dateAdded} onChange={(v) => updateUptick(i, "dateAdded", v)} />
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
        </section>

        {/* ── Seeking Alpha - Alpha Picks ── */}
        <section className="rounded-[24px] border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-lg font-semibold mb-3">Seeking Alpha &mdash; Alpha Picks</h3>
          <ImageUpload
            section="seeking-alpha-picks"
            sectionLabel="Alpha Picks"
            attachments={state.attachments || []}
            onAdd={addAttachment}
            onRemove={removeAttachment}
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
              <p className="mt-3 text-xs text-slate-400">Growth: Tech, Comm Svc, Consumer Disc · Cyclical: Fin, Ind, Mat, Energy · Quality dampening ±35%</p>
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
