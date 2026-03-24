"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { ResearchState, UptickEntry, IdeaEntry } from "@/app/lib/defaults";
import { defaultResearch } from "@/app/lib/defaults";

/* ─── Uptick Add Form ─── */
function UptickAddForm({ onAdd }: { onAdd: (e: UptickEntry) => void }) {
  const [ticker, setTicker] = useState("");
  const [name, setName] = useState("");
  const [sector, setSector] = useState("");
  const [price, setPrice] = useState("");
  const [support, setSupport] = useState("");
  const [resistance, setResistance] = useState("");
  const [priceWhenAdded, setPriceWhenAdded] = useState("");

  const sectors = [
    "Communication Services", "Consumer Discretionary", "Consumer Staples", "Crypto ETF",
    "Energy", "Financials", "Health Care", "Industrials", "Information Technology",
    "Materials", "Real Estate", "Utilities",
  ];

  return (
    <form
      className="flex flex-wrap gap-2 mt-3 items-end"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ticker.trim()) return;
        onAdd({
          ticker: ticker.trim().toUpperCase(),
          name: name.trim() || ticker.trim().toUpperCase(),
          sector: sector || "—",
          price: parseFloat(price) || 0,
          support: support.trim() || "—",
          resistance: resistance.trim() || "—",
          dateAdded: new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" }),
          priceWhenAdded: parseFloat(priceWhenAdded) || parseFloat(price) || 0,
        });
        setTicker(""); setName(""); setSector(""); setPrice(""); setSupport(""); setResistance(""); setPriceWhenAdded("");
      }}
    >
      <div>
        <label className="text-xs text-slate-400 block">Ticker*</label>
        <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="AMZN" className="w-20 rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-mono" />
      </div>
      <div>
        <label className="text-xs text-slate-400 block">Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Amazon.com Inc" className="w-40 rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
      </div>
      <div>
        <label className="text-xs text-slate-400 block">Sector</label>
        <select value={sector} onChange={(e) => setSector(e.target.value)} className="w-44 rounded-lg border border-slate-200 px-2 py-1.5 text-sm bg-white">
          <option value="">Select...</option>
          {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div>
        <label className="text-xs text-slate-400 block">Price</label>
        <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="213.21" type="number" step="0.01" className="w-24 rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
      </div>
      <div>
        <label className="text-xs text-slate-400 block">Support</label>
        <input value={support} onChange={(e) => setSupport(e.target.value)} placeholder="196, 161" className="w-24 rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
      </div>
      <div>
        <label className="text-xs text-slate-400 block">Resistance</label>
        <input value={resistance} onChange={(e) => setResistance(e.target.value)} placeholder="220, 249" className="w-24 rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
      </div>
      <div>
        <label className="text-xs text-slate-400 block">Price Added</label>
        <input value={priceWhenAdded} onChange={(e) => setPriceWhenAdded(e.target.value)} placeholder="161.26" type="number" step="0.01" className="w-24 rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
      </div>
      <button type="submit" className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800">
        Add
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
        <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="AAPL" className="w-24 rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-mono" />
      </div>
      <div>
        <label className="text-xs text-slate-400 block">Price Added</label>
        <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="175.00" type="number" step="0.01" className="w-24 rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
      </div>
      <button type="submit" className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800">
        Add
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
        className={`w-full bg-blue-50 border border-blue-300 rounded px-1 py-0.5 text-sm outline-none ${className}`}
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

export default function ResearchPage() {
  const [state, setState] = useState<ResearchState>(defaultResearch);
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch("/api/kv/research")
      .then((r) => r.json())
      .then((data) => {
        if (data.research) setState(data.research);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

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
              <h3 className="text-xl font-bold">Newton&apos;s Upticks&hellip;</h3>
              <p className="text-xs text-slate-400">Fundstrat technical uptick list &mdash; click any cell to edit</p>
            </div>
            <span className="text-sm text-slate-400">{state.newtonUpticks.length} stocks</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-2 border-teal-600 text-left">
                  <th className="py-2 pr-2 text-xs font-semibold text-teal-700 w-8">#</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-teal-700">Ticker</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-teal-700">Name</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-teal-700">Sector</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-teal-700 text-right">Price*</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-teal-700 text-right">Support</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-teal-700 text-right">Resistance</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-teal-700">Date Added</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-teal-700 text-right">Price When Added</th>
                  <th className="py-2 text-xs font-semibold text-teal-700 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {state.newtonUpticks.map((u, i) => {
                  const isNew = u.dateAdded === new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
                  const rowBg = isNew ? "bg-amber-50 font-semibold" : i % 2 === 0 ? "bg-white" : "bg-slate-50/50";
                  return (
                    <tr key={u.ticker} className={`border-b border-slate-100 ${rowBg} hover:bg-blue-50/40 transition-colors`}>
                      <td className="py-2 pr-2 text-slate-400">{i + 1}</td>
                      <td className="py-2 pr-3 font-mono font-bold text-teal-700">${u.ticker}</td>
                      <td className="py-2 pr-3">
                        <EditableCell value={u.name} onChange={(v) => updateUptick(i, "name", v)} />
                      </td>
                      <td className="py-2 pr-3 text-slate-600">
                        <EditableCell value={u.sector} onChange={(v) => updateUptick(i, "sector", v)} />
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        <EditableCell value={u.price || "—"} onChange={(v) => updateUptick(i, "price", v)} type="number" />
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
                      <td className="py-2 pr-3 text-right font-mono">
                        {u.priceWhenAdded ? (
                          <EditableCell value={`$${u.priceWhenAdded.toFixed(2)}`} onChange={(v) => updateUptick(i, "priceWhenAdded", v.replace("$", ""))} />
                        ) : (
                          <span className="text-emerald-600 font-semibold">NEW</span>
                        )}
                      </td>
                      <td className="py-2">
                        <button onClick={() => removeUptick(u.ticker)} className="text-slate-300 hover:text-red-500 font-bold transition-colors" title="Remove">
                          &times;
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {state.newtonUpticks.length === 0 && (
                  <tr>
                    <td colSpan={10} className="py-8 text-center text-slate-400 italic">No upticks added yet</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <UptickAddForm onAdd={addUptick} />
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
                  <th className="py-2 pr-3 text-xs font-semibold text-emerald-700">Ticker</th>
                  <th className="py-2 text-xs font-semibold text-emerald-700 text-right">Price When Added</th>
                  <th className="py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {state.fundstratTop.map((item, i) => (
                  <tr key={item.ticker} className={`border-b border-slate-100 ${i % 2 === 0 ? "bg-white" : "bg-emerald-50/30"} hover:bg-emerald-50/60 transition-colors`}>
                    <td className="py-2 pr-2 text-slate-400">{i + 1}</td>
                    <td className="py-2 pr-3 font-mono font-bold text-emerald-700">${item.ticker}</td>
                    <td className="py-2 text-right font-mono">
                      <EditableCell
                        value={item.priceWhenAdded ? `$${item.priceWhenAdded.toFixed(2)}` : "—"}
                        onChange={(v) => updateIdea("fundstratTop", i, v.replace("$", ""))}
                      />
                    </td>
                    <td className="py-2">
                      <button onClick={() => removeIdea("fundstratTop", item.ticker)} className="text-slate-300 hover:text-red-500 font-bold transition-colors">&times;</button>
                    </td>
                  </tr>
                ))}
                {state.fundstratTop.length === 0 && (
                  <tr><td colSpan={4} className="py-6 text-center text-slate-400 italic">No top ideas added yet</td></tr>
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
                  <th className="py-2 pr-3 text-xs font-semibold text-red-700">Ticker</th>
                  <th className="py-2 text-xs font-semibold text-red-700 text-right">Price When Added</th>
                  <th className="py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {state.fundstratBottom.map((item, i) => (
                  <tr key={item.ticker} className={`border-b border-slate-100 ${i % 2 === 0 ? "bg-white" : "bg-red-50/30"} hover:bg-red-50/60 transition-colors`}>
                    <td className="py-2 pr-2 text-slate-400">{i + 1}</td>
                    <td className="py-2 pr-3 font-mono font-bold text-red-700">${item.ticker}</td>
                    <td className="py-2 text-right font-mono">
                      <EditableCell
                        value={item.priceWhenAdded ? `$${item.priceWhenAdded.toFixed(2)}` : "—"}
                        onChange={(v) => updateIdea("fundstratBottom", i, v.replace("$", ""))}
                      />
                    </td>
                    <td className="py-2">
                      <button onClick={() => removeIdea("fundstratBottom", item.ticker)} className="text-slate-300 hover:text-red-500 font-bold transition-colors">&times;</button>
                    </td>
                  </tr>
                ))}
                {state.fundstratBottom.length === 0 && (
                  <tr><td colSpan={4} className="py-6 text-center text-slate-400 italic">No bottom ideas added yet</td></tr>
                )}
              </tbody>
            </table>

            <IdeaAddForm onAdd={(e) => addIdea("fundstratBottom", e)} />
          </section>
        </div>

        {/* ── General Notes ── */}
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
