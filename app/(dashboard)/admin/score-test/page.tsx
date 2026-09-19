"use client";

/**
 * /admin/score-test — the anchor × thinking 2×2 for the scoring prompt.
 *
 * Runs the SAME names several times under four set-ups (prior-score anchor
 * on/off × extended thinking on/off) through /api/admin/score-dispersion and
 * tabulates how much the scores move between identical runs. It answers two
 * open questions from the prompt audit with one experiment:
 *   S-07  does the "adopt the prior when ambiguous" rule earn its keep?
 *   X-01  does extended thinking make scoring steadier?
 *
 * NOTHING IS PERSISTED: the dispersion route never writes scores or history,
 * and results live only in this page until copied out. Each run is one real
 * model call (web search off by default, to isolate sampling noise and cost).
 */

import React, { useMemo, useRef, useState } from "react";
import { useStocks } from "@/app/lib/StockContext";

type Config = { id: string; label: string; anchor: "on" | "off"; thinking: "on" | "off" };
const CONFIGS: Config[] = [
  { id: "A", label: "Anchor on · thinking off (today's production)", anchor: "on", thinking: "off" },
  { id: "B", label: "Anchor off · thinking off", anchor: "off", thinking: "off" },
  { id: "C", label: "Anchor on · thinking on", anchor: "on", thinking: "on" },
  { id: "D", label: "Anchor off · thinking on", anchor: "off", thinking: "on" },
];

type Run = { config: string; ticker: string; run: number; scores: Record<string, number> | null; seconds: number; error?: string };

const AI_KEYS = ["secular", "growth", "returnsMargins", "relativeValuation", "historicalValuation", "leverageCoverage", "cashFlowQuality", "competitiveMoat", "catalysts", "trackRecord", "ownershipTrends"];

function total(scores: Record<string, number>): number {
  return AI_KEYS.reduce((s, k) => s + (typeof scores[k] === "number" ? scores[k] : 0), 0);
}

/** Per-config steadiness: for each ticker, how far apart identical runs landed. */
function summarize(runs: Run[], config: string) {
  const ok = runs.filter((r) => r.config === config && r.scores);
  const byTicker = new Map<string, Run[]>();
  for (const r of ok) byTicker.set(r.ticker, [...(byTicker.get(r.ticker) ?? []), r]);
  let totalRangeSum = 0, tickers = 0, catCells = 0, catMoved = 0, catRangeSum = 0;
  for (const rs of byTicker.values()) {
    if (rs.length < 2) continue;
    tickers++;
    const totals = rs.map((r) => total(r.scores!));
    totalRangeSum += Math.max(...totals) - Math.min(...totals);
    for (const k of AI_KEYS) {
      const vals = rs.map((r) => r.scores![k]).filter((v): v is number => typeof v === "number");
      if (vals.length < 2) continue;
      const range = Math.max(...vals) - Math.min(...vals);
      catCells++;
      catRangeSum += range;
      if (range > 0) catMoved++;
    }
  }
  const secs = ok.map((r) => r.seconds);
  return {
    runs: ok.length,
    failed: runs.filter((r) => r.config === config && !r.scores).length,
    tickers,
    avgTotalRange: tickers ? totalRangeSum / tickers : null,
    pctCategoriesMoved: catCells ? (catMoved / catCells) * 100 : null,
    avgCategoryRange: catCells ? catRangeSum / catCells : null,
    avgSeconds: secs.length ? secs.reduce((a, b) => a + b, 0) / secs.length : null,
  };
}

export default function ScoreTestPage() {
  const { stocks } = useStocks();
  const defaults = useMemo(
    () => stocks.filter((s) => s.bucket === "Portfolio" && (s.instrumentType ?? "stock") === "stock").slice(0, 10).map((s) => s.ticker).join(", "),
    [stocks],
  );
  const [tickersText, setTickersText] = useState<string | null>(null);
  const [runsPer, setRunsPer] = useState(2);
  const [verify, setVerify] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);
  const [status, setStatus] = useState<string>("");
  const [running, setRunning] = useState(false);
  const stop = useRef(false);

  const tickers = (tickersText ?? defaults).split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
  const planned = tickers.length * runsPer * CONFIGS.length;

  async function start() {
    stop.current = false;
    setRunning(true);
    setRuns([]);
    const jobs: { c: Config; t: string; n: number }[] = [];
    // Interleave configs so a partial run still compares like with like.
    for (let n = 1; n <= runsPer; n++) for (const t of tickers) for (const c of CONFIGS) jobs.push({ c, t, n });
    let done = 0;
    for (const j of jobs) {
      if (stop.current) break;
      setStatus(`Run ${done + 1} of ${jobs.length}: ${j.t} · set-up ${j.c.id} · pass ${j.n}`);
      const t0 = Date.now();
      let row: Run;
      try {
        const res = await fetch(`/api/admin/score-dispersion?ticker=${encodeURIComponent(j.t)}&anchor=${j.c.anchor}&thinking=${j.c.thinking}&verify=${verify ? "on" : "off"}`);
        const data = await res.json();
        row = { config: j.c.id, ticker: j.t, run: j.n, scores: res.ok ? data.scores ?? null : null, seconds: (Date.now() - t0) / 1000, error: res.ok ? undefined : String(data?.detail ?? data?.error ?? res.status) };
      } catch (e) {
        row = { config: j.c.id, ticker: j.t, run: j.n, scores: null, seconds: (Date.now() - t0) / 1000, error: e instanceof Error ? e.message : String(e) };
      }
      setRuns((prev) => [...prev, row]);
      done++;
    }
    setStatus(stop.current ? `Stopped after ${done} runs.` : `Finished ${done} runs.`);
    setRunning(false);
  }

  const fmt = (v: number | null, d = 2) => (v == null ? "—" : v.toFixed(d));

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 text-ink">
      <h1 className="text-2xl font-semibold">Scoring steadiness test</h1>
      <p className="mt-2 text-sm text-ink-2">
        Scores the same names several times under four set-ups and measures how far identical runs drift apart. Lower is steadier.
        Nothing is saved: no score, no history entry. Each run is one real model call, so {planned} runs will cost roughly
        ${(planned * (verify ? 0.18 : 0.08)).toFixed(0)} and take a while. Keep this tab open until it finishes.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-[1fr_auto_auto]">
        <label className="text-sm">
          <span className="mb-1 block font-medium">Tickers ({tickers.length})</span>
          <textarea id="score-test-tickers" className="h-20 w-full rounded border border-line bg-surface p-2 text-sm" value={tickersText ?? defaults} onChange={(e) => setTickersText(e.target.value)} disabled={running} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">Passes per set-up</span>
          <input id="score-test-runs" type="number" min={2} max={5} className="w-24 rounded border border-line bg-surface p-2" value={runsPer} onChange={(e) => setRunsPer(Math.max(2, Math.min(5, Number(e.target.value) || 2)))} disabled={running} />
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input id="score-test-verify" type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} disabled={running} />
          <span>Web search on</span>
        </label>
      </div>

      <div className="mt-4 flex items-center gap-3">
        {!running ? (
          <button type="button" onClick={start} disabled={tickers.length === 0} className="rounded bg-ink px-4 py-2 text-sm font-medium text-white disabled:opacity-40">Start {planned} runs</button>
        ) : (
          <button type="button" onClick={() => { stop.current = true; }} className="rounded border border-line px-4 py-2 text-sm font-medium">Stop after this run</button>
        )}
        <span className="text-sm text-ink-2">{status}</span>
      </div>

      <h2 className="mt-8 text-lg font-semibold">Result by set-up</h2>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-3">
              <th className="py-2 pr-3">Set-up</th><th className="px-3">Runs</th><th className="px-3">Names compared</th>
              <th className="px-3">Avg swing in total (pts)</th><th className="px-3">Categories that moved</th><th className="px-3">Avg category swing</th><th className="px-3">Sec / run</th>
            </tr>
          </thead>
          <tbody>
            {CONFIGS.map((c) => {
              const s = summarize(runs, c.id);
              return (
                <tr key={c.id} className="border-b border-line">
                  <td className="py-2 pr-3"><span className="font-semibold">{c.id}</span> · {c.label}</td>
                  <td className="px-3 tabular-nums">{s.runs}{s.failed ? ` (+${s.failed} failed)` : ""}</td>
                  <td className="px-3 tabular-nums">{s.tickers}</td>
                  <td className="px-3 tabular-nums">{fmt(s.avgTotalRange)}</td>
                  <td className="px-3 tabular-nums">{s.pctCategoriesMoved == null ? "—" : `${s.pctCategoriesMoved.toFixed(0)}%`}</td>
                  <td className="px-3 tabular-nums">{fmt(s.avgCategoryRange)}</td>
                  <td className="px-3 tabular-nums">{fmt(s.avgSeconds, 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm text-ink-2">
        How to read it: “Avg swing in total” is the gap between the highest and lowest total the same name received across identical runs, averaged over names.
        “Categories that moved” is the share of name-and-category pairs that did not get the same score every time. If B is about as steady as A, the prior-score anchor is not doing much and can go.
        If C and D are steadier than A and B, extended thinking earns its place.
      </p>

      {runs.length > 0 && (
        <div className="mt-6">
          <button type="button" onClick={() => navigator.clipboard.writeText(JSON.stringify({ tickers, runsPer, verify, configs: CONFIGS, summary: Object.fromEntries(CONFIGS.map((c) => [c.id, summarize(runs, c.id)])), runs }, null, 2))} className="rounded border border-line px-3 py-1.5 text-sm">Copy full results</button>
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium">Every run ({runs.length})</summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-line text-left text-ink-3"><th className="py-1 pr-2">Set-up</th><th className="px-2">Ticker</th><th className="px-2">Pass</th><th className="px-2">Total</th>{AI_KEYS.map((k) => <th key={k} className="px-1">{k.slice(0, 6)}</th>)}<th className="px-2">Note</th></tr></thead>
                <tbody>
                  {runs.map((r, i) => (
                    <tr key={i} className="border-b border-line">
                      <td className="py-1 pr-2">{r.config}</td><td className="px-2">{r.ticker}</td><td className="px-2">{r.run}</td>
                      <td className="px-2 tabular-nums">{r.scores ? total(r.scores) : "—"}</td>
                      {AI_KEYS.map((k) => <td key={k} className="px-1 tabular-nums">{r.scores?.[k] ?? "—"}</td>)}
                      <td className="px-2 text-neg">{r.error ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
