"use client";

import React, { useState, useEffect, useCallback } from "react";

type TickerList = { name: string; tickers: string[] };
type IdeaList = { name: string; items: { ticker: string; tag: "Top" | "Bottom" }[] };

const STORAGE_KEY = "pm-research-notes";

type ResearchState = {
  newtonUpticks: string[];
  fundstratTop: string[];
  fundstratBottom: string[];
  customLists: TickerList[];
  generalNotes: string;
};

const defaultState: ResearchState = {
  newtonUpticks: [],
  fundstratTop: [],
  fundstratBottom: [],
  customLists: [],
  generalNotes: "",
};

function loadState(): ResearchState {
  if (typeof window === "undefined") return defaultState;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...defaultState, ...JSON.parse(raw) } : defaultState;
  } catch {
    return defaultState;
  }
}

function TickerPills({
  tickers,
  onRemove,
}: {
  tickers: string[];
  onRemove: (t: string) => void;
}) {
  if (tickers.length === 0) return <span className="text-sm text-slate-400 italic">No tickers added</span>;
  return (
    <div className="flex flex-wrap gap-2">
      {tickers.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 px-3 py-1 text-sm font-medium text-blue-800"
        >
          {t}
          <button
            onClick={() => onRemove(t)}
            className="ml-0.5 text-blue-500 hover:text-red-500 font-bold"
          >
            &times;
          </button>
        </span>
      ))}
    </div>
  );
}

function AddTickerInput({ onAdd }: { onAdd: (t: string) => void }) {
  const [val, setVal] = useState("");
  return (
    <form
      className="flex gap-2 mt-3"
      onSubmit={(e) => {
        e.preventDefault();
        const t = val.trim().toUpperCase();
        if (t) {
          onAdd(t);
          setVal("");
        }
      }}
    >
      <input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="Add ticker"
        className="w-32 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none placeholder:text-slate-400"
      />
      <button
        type="submit"
        className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
      >
        Add
      </button>
    </form>
  );
}

export default function ResearchPage() {
  const [state, setState] = useState<ResearchState>(defaultState);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setState(loadState());
    setLoaded(true);
  }, []);

  const save = useCallback(
    (next: ResearchState) => {
      setState(next);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    },
    []
  );

  const addTo = (key: "newtonUpticks" | "fundstratTop" | "fundstratBottom", t: string) => {
    if (state[key].includes(t)) return;
    save({ ...state, [key]: [...state[key], t] });
  };

  const removeFrom = (key: "newtonUpticks" | "fundstratTop" | "fundstratBottom", t: string) => {
    save({ ...state, [key]: state[key].filter((x) => x !== t) });
  };

  if (!loaded) return null;

  return (
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-slate-900 md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-5xl space-y-6">
        <h1 className="text-3xl font-semibold tracking-tight">Research Notes</h1>
        <p className="text-slate-500">Track external research sources, ideas, and notes. All data saved locally in your browser.</p>

        {/* External Source Lists */}
        <div className="grid gap-5 lg:grid-cols-3">
          {/* Newton Upticks */}
          <section className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
            <h3 className="text-lg font-semibold mb-1">Mark Newton Upticks</h3>
            <p className="text-xs text-slate-400 mb-3">Fundstrat technical uptick list</p>
            <TickerPills tickers={state.newtonUpticks} onRemove={(t) => removeFrom("newtonUpticks", t)} />
            <AddTickerInput onAdd={(t) => addTo("newtonUpticks", t)} />
          </section>

          {/* Fundstrat Top Ideas */}
          <section className="rounded-[24px] border border-emerald-200 bg-emerald-50/30 p-5 shadow-sm">
            <h3 className="text-lg font-semibold text-emerald-800 mb-1">Fundstrat Top Ideas</h3>
            <p className="text-xs text-slate-400 mb-3">Best long ideas from research</p>
            <TickerPills tickers={state.fundstratTop} onRemove={(t) => removeFrom("fundstratTop", t)} />
            <AddTickerInput onAdd={(t) => addTo("fundstratTop", t)} />
          </section>

          {/* Fundstrat Bottom Ideas */}
          <section className="rounded-[24px] border border-red-200 bg-red-50/30 p-5 shadow-sm">
            <h3 className="text-lg font-semibold text-red-800 mb-1">Fundstrat Bottom Ideas</h3>
            <p className="text-xs text-slate-400 mb-3">Names to avoid or short</p>
            <TickerPills tickers={state.fundstratBottom} onRemove={(t) => removeFrom("fundstratBottom", t)} />
            <AddTickerInput onAdd={(t) => addTo("fundstratBottom", t)} />
          </section>
        </div>

        {/* General Notes */}
        <section className="rounded-[24px] border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-lg font-semibold mb-3">General Notes</h3>
          <textarea
            value={state.generalNotes}
            onChange={(e) => save({ ...state, generalNotes: e.target.value })}
            placeholder="Market observations, strategy notes, meeting takeaways..."
            rows={8}
            className="w-full rounded-xl border border-slate-200 p-4 text-sm leading-relaxed outline-none resize-y placeholder:text-slate-400"
          />
        </section>

        {/* Quick Reference */}
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
                <div className="flex justify-between"><span>Offensive (Risk-Off)</span><span className="text-red-600 font-medium">0.82x</span></div>
                <div className="flex justify-between"><span>Defensive (Risk-Off)</span><span className="text-emerald-600 font-medium">1.10x</span></div>
                <div className="flex justify-between"><span>Risk-On</span><span className="text-slate-600 font-medium">1.00x</span></div>
              </div>
              <p className="mt-3 text-xs text-slate-400">Offensive: Tech, Comm Services, Consumer Disc</p>
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
