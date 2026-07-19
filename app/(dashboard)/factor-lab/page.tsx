"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { isScoreable } from "@/app/lib/scoring";
import { MAX_SCORE } from "@/app/lib/types";
import { displayTicker } from "@/app/lib/ticker";

/**
 * /factor-lab — the shadow factor model's read-out surface (Phase B3).
 *
 * STRICTLY ADDITIVE. This page reads the 41-pt scores (from context) and the
 * nightly quant/overlay/blend read-outs (from /api/factor-scores) and shows
 * them side by side. It writes nothing and changes no existing number — it's
 * the comparison view to put in front of the PM before any integration
 * decision (Phase D).
 */

type FactorEntry = {
  ticker: string;
  sector: string;
  quant: number | null;
  confidence: number | null;
  overlay: number | null;
  blend70: number | null;
  blendMod: number | null;
  groups: Record<string, number>;
};

type Row = {
  ticker: string;
  name: string;
  sector: string;
  bucket: string;
  rating: string;         // current Buy/Hold/Sell from the 41-pt system
  adjusted: number;       // 41-pt adjusted
  quant: number | null;   // factor percentile
  overlay: number | null;
  blend70: number | null;
  blendMod: number | null;
  confidence: number | null;
  groups: Record<string, number>;
  rank41: number | null;  // rank within quant-covered book by 41-pt
  rankQuant: number | null;
  deltaRank: number | null; // rank41 - rankQuant (positive → factor lens ranks it HIGHER)
};

type SortKey = "disagreement" | "adjusted" | "quant" | "overlay" | "blend70";
type ConsolSortKey = "ticker" | "adjusted" | "rating" | "quant" | "overlay" | "blend70" | "changed" | "rankMove";

type LensStats = { meanIC: number; icStd: number; nDates: number; avgNames: number; tStat: number | null };
type Validation = {
  ok: boolean;
  firstDate: string | null;
  lastDate: string | null;
  dataDays: number;
  tickers: number;
  horizons: { horizon: string; lenses: Partial<Record<string, LensStats>> }[];
  note: string;
};

type ScreenName = {
  ticker: string;
  sector: string;
  quant: number;
  confidence: number;
  groups: Record<string, number>;
  altmanZ?: number;
  distress?: "distress" | "grey";
};

/** Map a 0–100 blend to the 41-pt system's Buy/Hold/Sell bands: the same
 *  FRACTIONAL thresholds (30/41 ≈ 73%, 18/41 ≈ 44%) so the what-if is an
 *  apples-to-apples rating comparison, not a new opinion scale. */
function impliedRating(p: number | null): "Buy" | "Hold" | "Sell" | null {
  if (p == null) return null;
  if (p >= 73) return "Buy";
  if (p <= 44) return "Sell";
  return "Hold";
}

const LENS_ORDER = ["s41", "quant", "overlay", "blend70", "blendMod"] as const;
const LENS_LABEL: Record<string, string> = {
  s41: "41-pt score",
  quant: "Quant %ile",
  overlay: "Judgment overlay",
  blend70: "Blend 70/30",
  blendMod: "Blend ±15 mod",
};

const GROUP_ORDER = ["quality", "growth", "valuation", "momentum"] as const;
const GROUP_LABEL: Record<string, string> = {
  quality: "Qual", growth: "Grow", valuation: "Val", momentum: "Mom",
};

function pctColor(p: number | null): string {
  if (p == null) return "text-ink-3";
  if (p >= 70) return "text-pos";
  if (p <= 30) return "text-neg";
  return "text-ink";
}

/** Small ±3 z-score bar. Green right (good), red left (bad). */
function ZBar({ z }: { z: number | undefined }) {
  if (z == null) return <span className="inline-block w-[54px] text-center text-ink-3">·</span>;
  const clamped = Math.max(-3, Math.min(3, z));
  const pct = (Math.abs(clamped) / 3) * 50; // half-width
  const pos = clamped >= 0;
  return (
    <span className="relative inline-block h-[10px] w-[54px] rounded-sm bg-surface-2 align-middle" title={`z ${z.toFixed(2)}`}>
      <span className="absolute left-1/2 top-0 h-full w-px bg-line" />
      <span
        className={`absolute top-0 h-full rounded-sm ${pos ? "bg-pos/70" : "bg-neg/70"}`}
        style={pos ? { left: "50%", width: `${pct}%` } : { right: "50%", width: `${pct}%` }}
      />
    </span>
  );
}

export default function FactorLabPage() {
  const { scoredStocks } = useStocks();
  const [entries, setEntries] = useState<Record<string, FactorEntry>>({});
  const [builtAt, setBuiltAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("disagreement");
  const [showMethod, setShowMethod] = useState(false);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [screen, setScreen] = useState<ScreenName[] | null>(null);
  const [screenBuiltAt, setScreenBuiltAt] = useState<string | null>(null);
  const [screenSector, setScreenSector] = useState<string>("All");
  const [screenShowAll, setScreenShowAll] = useState(false);
  const [consolSort, setConsolSort] = useState<ConsolSortKey>("rankMove");
  const [consolDir, setConsolDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/factor-scores");
        const j = await r.json();
        if (!alive) return;
        setEntries(j.entries || {});
        setBuiltAt(j.builtAt || null);
      } catch {
        /* leave empty */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    (async () => {
      try {
        const r = await fetch("/api/factor-validation");
        const j = await r.json();
        if (alive && j?.ok) setValidation(j as Validation);
      } catch {
        /* panel simply doesn't render */
      }
    })();
    (async () => {
      try {
        const r = await fetch("/api/factor-screen");
        const j = await r.json();
        if (alive && j?.ok) {
          setScreen((j.names as ScreenName[]) ?? []);
          setScreenBuiltAt(j.builtAt ?? null);
        }
      } catch {
        if (alive) setScreen([]);
      }
    })();
    return () => { alive = false; };
  }, []);

  const rows = useMemo<Row[]>(() => {
    const book = scoredStocks.filter(
      (s) => (s.bucket === "Portfolio" || s.bucket === "Watchlist") && isScoreable(s),
    );
    const base: Row[] = book.map((s) => {
      const e = entries[s.ticker.toUpperCase()];
      return {
        ticker: s.ticker,
        name: s.name,
        sector: s.sector,
        bucket: s.bucket,
        rating: s.rating,
        adjusted: s.adjusted,
        quant: e?.quant ?? null,
        overlay: e?.overlay ?? null,
        blend70: e?.blend70 ?? null,
        blendMod: e?.blendMod ?? null,
        confidence: e?.confidence ?? null,
        groups: e?.groups ?? {},
        rank41: null,
        rankQuant: null,
        deltaRank: null,
      };
    });

    // Rank only within the names that HAVE a quant reading, so the two ranks
    // are over the same population (apples to apples for the delta).
    const covered = base.filter((r) => r.quant != null);
    const by41 = [...covered].sort((a, b) => b.adjusted - a.adjusted);
    by41.forEach((r, i) => (r.rank41 = i + 1));
    const byQuant = [...covered].sort((a, b) => (b.quant ?? 0) - (a.quant ?? 0));
    byQuant.forEach((r, i) => (r.rankQuant = i + 1));
    for (const r of covered) {
      if (r.rank41 != null && r.rankQuant != null) r.deltaRank = r.rank41 - r.rankQuant;
    }
    return base;
  }, [scoredStocks, entries]);

  const sorted = useMemo(() => {
    const withQuant = rows.filter((r) => r.quant != null);
    const withoutQuant = rows.filter((r) => r.quant == null);
    const s = [...withQuant].sort((a, b) => {
      switch (sortKey) {
        case "adjusted": return b.adjusted - a.adjusted;
        case "quant": return (b.quant ?? 0) - (a.quant ?? 0);
        case "overlay": return (b.overlay ?? -1) - (a.overlay ?? -1);
        case "blend70": return (b.blend70 ?? 0) - (a.blend70 ?? 0);
        case "disagreement":
        default: return Math.abs(b.deltaRank ?? 0) - Math.abs(a.deltaRank ?? 0);
      }
    });
    return [...s, ...withoutQuant];
  }, [rows, sortKey]);

  const coveredCount = rows.filter((r) => r.quant != null).length;

  // The sharpest disagreements, for the callout strip.
  const topDisagree = useMemo(() => {
    return rows
      .filter((r) => r.deltaRank != null)
      .sort((a, b) => Math.abs(b.deltaRank ?? 0) - Math.abs(a.deltaRank ?? 0))
      .slice(0, 3);
  }, [rows]);

  const built = builtAt ? new Date(builtAt).toLocaleString() : null;

  // ── Universe Screen: top quant names NOT already in the book ──
  const ownedTickers = useMemo(
    () => new Set(scoredStocks.map((s) => s.ticker.toUpperCase())),
    [scoredStocks],
  );
  const screenSectors = useMemo(() => {
    if (!screen) return [];
    return [...new Set(screen.map((n) => n.sector))].sort();
  }, [screen]);
  const screenRows = useMemo(() => {
    if (!screen) return [];
    return screen
      .filter((n) => !ownedTickers.has(n.ticker.toUpperCase()))
      .filter((n) => screenSector === "All" || n.sector === screenSector);
    // already sorted by quant desc at write time
  }, [screen, ownedTickers, screenSector]);
  const screenVisible = screenShowAll ? screenRows.slice(0, 100) : screenRows.slice(0, 25);

  // ── Consolidation Preview: what the blends would do to the book TODAY ──
  const consolidation = useMemo(() => {
    const covered = rows.filter((r) => r.quant != null && r.rank41 != null);
    if (covered.length < 5) return null;
    const byBlend = [...covered].sort((a, b) => (b.blend70 ?? 0) - (a.blend70 ?? 0));
    const blendRank = new Map(byBlend.map((r, i) => [r.ticker, i + 1]));
    const items = covered.map((r) => {
      const now = r.rating;
      const b70 = impliedRating(r.blend70);
      const bMod = impliedRating(r.blendMod);
      return {
        ...r,
        blendRank: blendRank.get(r.ticker) ?? null,
        rankMove: (r.rank41 ?? 0) - (blendRank.get(r.ticker) ?? 0), // + = blend ranks it higher
        b70,
        bMod,
        changed70: b70 != null && b70 !== now,
        changedMod: bMod != null && bMod !== now,
      };
    });
    const up70 = items.filter((i) => i.changed70 && i.b70 === "Buy").length
      + items.filter((i) => i.changed70 && i.rating === "Sell" && i.b70 === "Hold").length;
    const down70 = items.filter((i) => i.changed70 && i.b70 === "Sell").length
      + items.filter((i) => i.changed70 && i.rating === "Buy" && i.b70 === "Hold").length;
    return {
      items: items.sort((a, b) => Math.abs(b.rankMove) - Math.abs(a.rankMove)),
      changes70: items.filter((i) => i.changed70).length,
      changesMod: items.filter((i) => i.changedMod).length,
      up70,
      down70,
      n: items.length,
    };
  }, [rows]);

  // Sortable view over the full consolidation table.
  const consolItems = useMemo(() => {
    if (!consolidation) return [];
    const ratingOrd = (r: string | null | undefined) => (r === "Buy" ? 2 : r === "Hold" ? 1 : r === "Sell" ? 0 : -1);
    const items = [...consolidation.items].sort((a, b) => {
      let cmp = 0;
      switch (consolSort) {
        case "ticker": cmp = a.ticker.localeCompare(b.ticker); break;
        case "adjusted": cmp = a.adjusted - b.adjusted; break;
        case "rating": cmp = ratingOrd(a.rating) - ratingOrd(b.rating); break;
        case "quant": cmp = (a.quant ?? 0) - (b.quant ?? 0); break;
        case "overlay": cmp = (a.overlay ?? -1) - (b.overlay ?? -1); break;
        case "blend70": cmp = (a.blend70 ?? 0) - (b.blend70 ?? 0); break;
        case "changed": cmp = Number(a.changed70) - Number(b.changed70) || ratingOrd(a.b70) - ratingOrd(b.b70); break;
        case "rankMove": default: cmp = Math.abs(a.rankMove) - Math.abs(b.rankMove); break;
      }
      return consolDir === "asc" ? cmp : -cmp;
    });
    return items;
  }, [consolidation, consolSort, consolDir]);

  const toggleConsolSort = (key: ConsolSortKey) => {
    if (consolSort === key) setConsolDir(consolDir === "asc" ? "desc" : "asc");
    else { setConsolSort(key); setConsolDir(key === "ticker" ? "asc" : "desc"); }
  };
  const consolArrow = (key: ConsolSortKey) =>
    consolSort === key ? (consolDir === "asc" ? " ▲" : " ▼") : "";

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-6">
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink">Factor Lab <span className="ml-2 rounded bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-3 align-middle">shadow · read-only</span></h1>
      </div>
      <p className="mb-4 max-w-3xl text-sm text-ink-2">
        A from-scratch quantitative factor model computed <em>beside</em> the 41-point score — it changes nothing.
        Each name is z-scored against its GICS-sector peers in a ~540-name S&amp;P 500 + TSX 60 universe,
        rolled into a 0–100 <strong>quant percentile</strong>. The <strong>judgment overlay</strong> is the 41-pt
        system&rsquo;s qualitative categories (brand, moat, catalysts, charting, track record) — the part no factor
        replicates. The <strong>blends</strong> are the integration candidates a later validation phase will race.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-3">
        <span>{coveredCount} of {rows.length} book names factor-scored</span>
        {built && <span>· universe/scores built {built}</span>}
        <button onClick={() => setShowMethod((v) => !v)} className="text-accent hover:underline">
          {showMethod ? "hide" : "how to read this"}
        </button>
      </div>

      {showMethod && (
        <div className="mb-5 rounded-lg border border-line bg-surface p-4 text-xs leading-relaxed text-ink-2">
          <div className="mb-2 font-semibold text-ink">Reading the columns</div>
          <ul className="ml-4 list-disc space-y-1">
            <li><strong>41-pt</strong> — the current committee score (adjusted, out of {MAX_SCORE}). Unchanged.</li>
            <li><strong>Quant %ile</strong> — pure factor percentile vs sector peers. 70+ green, 30− red. This is the machine&rsquo;s cross-sectional read; it knows nothing about the 41-pt score.</li>
            <li><strong>ΔRank</strong> — 41-pt rank minus quant rank, over the {coveredCount} scored names. <span className="text-pos">Positive</span> = the factor model likes it <em>more</em> than the committee; <span className="text-neg">negative</span> = less. Big magnitudes are where the two views genuinely disagree — the rows worth a human look.</li>
            <li><strong>Overlay</strong> — judgment lens (qualitative categories only), 0–100. Blank = not yet assessed.</li>
            <li><strong>70/30</strong> and <strong>Mod</strong> — the two integration candidates: 0.7·quant + 0.3·overlay, and quant nudged ±15 by the overlay.</li>
            <li><strong>Factor z-bars</strong> — mean sector z per group (Quality / Growth / Valuation / Momentum). Right/green good, left/red bad, ±3 scale.</li>
          </ul>
        </div>
      )}

      {topDisagree.length > 0 && (
        <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {topDisagree.map((r) => {
            const factorHigher = (r.deltaRank ?? 0) > 0;
            return (
              <div key={r.ticker} className="rounded-lg border border-line bg-surface p-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm font-semibold text-ink">{displayTicker(r.ticker)}</span>
                  <span className={`text-xs font-semibold ${factorHigher ? "text-pos" : "text-neg"}`}>
                    factor {factorHigher ? "▲" : "▼"} {Math.abs(r.deltaRank ?? 0)} ranks
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-ink-3">
                  41-pt {Number(r.adjusted.toFixed(1))}/{MAX_SCORE} · quant {r.quant}%ile
                </div>
                <div className="mt-1 text-[11px] text-ink-2">
                  {factorHigher
                    ? "Factors rate it higher than the committee — a name the qualitative read may be discounting."
                    : "Committee rates it higher than the factors — conviction the numbers don't yet support."}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-ink-3">Sort:</span>
        {([
          ["disagreement", "Disagreement"],
          ["quant", "Quant %ile"],
          ["adjusted", "41-pt"],
          ["overlay", "Overlay"],
          ["blend70", "Blend 70/30"],
        ] as [SortKey, string][]).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setSortKey(k)}
            className={`rounded-full px-3 py-1 ${sortKey === k ? "bg-accent text-white" : "bg-surface-2 text-ink-2 hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-ink-3">Loading factor read-outs…</div>
      ) : coveredCount === 0 ? (
        <div className="rounded-lg border border-line bg-surface p-6 text-sm text-ink-2">
          No factor scores yet. They&rsquo;re written nightly by the shadow job; you can force a run any time via{" "}
          <code className="rounded bg-surface-2 px-1">/api/admin/factor-debug?book=1&amp;run=1</code>.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-surface text-left text-xs text-ink-3">
                <th className="px-3 py-2">Ticker</th>
                <th className="px-3 py-2">Sector</th>
                <th className="px-3 py-2 text-right">41-pt</th>
                <th className="px-3 py-2 text-right">Quant %ile</th>
                <th className="px-3 py-2 text-right">ΔRank</th>
                <th className="px-3 py-2 text-right">Overlay</th>
                <th className="px-3 py-2 text-right">70/30</th>
                <th className="px-3 py-2 text-right">Mod</th>
                {GROUP_ORDER.map((g) => (
                  <th key={g} className="px-2 py-2 text-center">{GROUP_LABEL[g]}</th>
                ))}
                <th className="px-2 py-2 text-right">Conf</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const hasQuant = r.quant != null;
                return (
                  <tr key={r.ticker} className={`border-b border-line/60 ${hasQuant ? "" : "opacity-50"}`}>
                    <td className="px-3 py-2">
                      <Link href={`/stock/${encodeURIComponent(r.ticker)}`} className="font-mono font-semibold text-ink hover:text-accent">
                        {displayTicker(r.ticker)}
                      </Link>
                      <span className="ml-1 text-[10px] text-ink-3">{r.bucket === "Portfolio" ? "P" : "W"}</span>
                    </td>
                    <td className="px-3 py-2 text-xs text-ink-3">{r.sector || "—"}</td>
                    <td className="px-3 py-2 text-right font-mono text-ink-2">{Number(r.adjusted.toFixed(1))}</td>
                    <td className={`px-3 py-2 text-right font-mono font-semibold ${pctColor(r.quant)}`}>
                      {hasQuant ? r.quant : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {r.deltaRank == null ? "—" : (
                        <span className={r.deltaRank > 0 ? "text-pos" : r.deltaRank < 0 ? "text-neg" : "text-ink-3"}>
                          {r.deltaRank > 0 ? "+" : ""}{r.deltaRank}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-ink-2">{r.overlay ?? "—"}</td>
                    <td className="px-3 py-2 text-right font-mono text-ink-2">{r.blend70 ?? "—"}</td>
                    <td className="px-3 py-2 text-right font-mono text-ink-2">{r.blendMod ?? "—"}</td>
                    {GROUP_ORDER.map((g) => (
                      <td key={g} className="px-2 py-2 text-center"><ZBar z={r.groups[g]} /></td>
                    ))}
                    <td className="px-2 py-2 text-right text-xs text-ink-3">{r.confidence ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Universe Screen: idea generation from the full ~540-name universe ── */}
      <div className="mt-8 rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">Universe Screen — top quant names you don&rsquo;t own</h2>
          {screenBuiltAt && (
            <span className="text-[11px] text-ink-3">built {new Date(screenBuiltAt).toLocaleDateString()}</span>
          )}
        </div>
        <p className="mt-1 max-w-3xl text-xs text-ink-2">
          Every S&amp;P 500 + TSX 60 constituent scored by the same factor model, Portfolio and Watchlist names
          excluded — what the machine says you&rsquo;re missing. A <span className="font-semibold text-neg">distress</span> or{" "}
          <span className="font-semibold text-warn">grey</span> badge is an Altman-style balance-sheet veto: the name
          screens well but the balance sheet disagrees — treat the percentile with suspicion.
        </p>

        {!screen ? (
          <div className="mt-3 text-xs text-ink-3">Loading screen…</div>
        ) : screen.length === 0 ? (
          <div className="mt-3 text-xs text-ink-2">
            Not built yet — the per-name universe read-outs are written by the weekly universe rebuild (Sunday).
            After the next rebuild this section populates automatically.
          </div>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-ink-3">Sector:</span>
              <select
                value={screenSector}
                onChange={(e) => setScreenSector(e.target.value)}
                className="rounded border border-line bg-white px-2 py-1 text-xs text-ink-2 outline-none focus:border-accent-border"
              >
                <option value="All">All ({screenRows.length})</option>
                {screenSectors.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-3">
                    <th className="py-2 pr-3">#</th>
                    <th className="py-2 pr-3">Ticker</th>
                    <th className="py-2 pr-3">Sector</th>
                    <th className="py-2 pr-3 text-right">Quant %ile</th>
                    {GROUP_ORDER.map((g) => (
                      <th key={g} className="px-2 py-2 text-center">{GROUP_LABEL[g]}</th>
                    ))}
                    <th className="py-2 pr-3 text-right">Conf</th>
                    <th className="py-2">Veto</th>
                  </tr>
                </thead>
                <tbody>
                  {screenVisible.map((n, i) => (
                    <tr key={n.ticker} className="border-b border-line/60">
                      <td className="py-2 pr-3 text-xs text-ink-3">{i + 1}</td>
                      <td className="py-2 pr-3 font-mono font-semibold text-ink">{displayTicker(n.ticker)}</td>
                      <td className="py-2 pr-3 text-xs text-ink-3">{n.sector}</td>
                      <td className={`py-2 pr-3 text-right font-mono font-semibold ${pctColor(n.quant)}`}>{n.quant}</td>
                      {GROUP_ORDER.map((g) => (
                        <td key={g} className="px-2 py-2 text-center"><ZBar z={n.groups?.[g]} /></td>
                      ))}
                      <td className="py-2 pr-3 text-right text-xs text-ink-3">{n.confidence}</td>
                      <td className="py-2">
                        {n.distress === "distress" ? (
                          <span className="rounded bg-neg-soft px-1.5 py-0.5 text-[10px] font-semibold text-neg border border-neg-border" title={`Altman-style Z ${n.altmanZ}`}>distress</span>
                        ) : n.distress === "grey" ? (
                          <span className="rounded bg-warn-soft px-1.5 py-0.5 text-[10px] font-semibold text-warn border border-warn-border" title={`Altman-style Z ${n.altmanZ}`}>grey</span>
                        ) : (
                          <span className="text-[10px] text-ink-3">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {screenRows.length > 25 && (
              <button onClick={() => setScreenShowAll((v) => !v)} className="mt-2 text-xs text-accent hover:underline">
                {screenShowAll ? "show top 25" : `show top 100 (of ${screenRows.length})`}
              </button>
            )}
          </>
        )}
      </div>

      {/* ── Consolidation Preview: WHAT-IF only — nothing here is live ── */}
      <div className="mt-8 rounded-lg border border-dashed border-accent-border bg-accent-soft/40 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">
            Consolidation Preview
            <span className="ml-2 rounded bg-white px-2 py-0.5 text-[10px] font-medium text-ink-3 border border-line align-middle">what-if · not live · Phase D decision pending</span>
          </h2>
        </div>
        <p className="mt-1 max-w-3xl text-xs text-ink-2">
          If the book were rated on <strong>Blend 70/30</strong> (0.7·quant + 0.3·judgment) today, using the same
          fractional Buy/Sell thresholds as the 41-pt system (Buy ≥ 73%, Sell ≤ 44%) — here&rsquo;s exactly what would
          change. This is a preview of the integration decision, not the decision: blend weights are earned in the
          Validation table below, and nothing switches over until the evidence and an explicit sign-off say so.
        </p>

        {!consolidation ? (
          <div className="mt-3 text-xs text-ink-3">Needs at least 5 factor-scored book names.</div>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap gap-4 text-xs">
              <span className="text-ink"><strong>{consolidation.changes70}</strong> of {consolidation.n} ratings would change</span>
              <span className="text-pos">▲ {consolidation.up70} upgrades</span>
              <span className="text-neg">▼ {consolidation.down70} downgrades</span>
              <span className="text-ink-3">(±15-mod variant: {consolidation.changesMod} changes)</span>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-3">
                    <th className="cursor-pointer select-none py-2 pr-3 hover:text-ink" onClick={() => toggleConsolSort("ticker")}>Ticker{consolArrow("ticker")}</th>
                    <th className="cursor-pointer select-none py-2 pr-3 text-right hover:text-ink" onClick={() => toggleConsolSort("adjusted")}>41-pt{consolArrow("adjusted")}</th>
                    <th className="cursor-pointer select-none py-2 pr-3 hover:text-ink" onClick={() => toggleConsolSort("rating")}>Rating now{consolArrow("rating")}</th>
                    <th className="cursor-pointer select-none py-2 pr-3 text-right hover:text-ink" onClick={() => toggleConsolSort("quant")}>Quant{consolArrow("quant")}</th>
                    <th className="cursor-pointer select-none py-2 pr-3 text-right hover:text-ink" onClick={() => toggleConsolSort("overlay")}>Overlay{consolArrow("overlay")}</th>
                    <th className="cursor-pointer select-none py-2 pr-3 text-right hover:text-ink" onClick={() => toggleConsolSort("blend70")}>Blend 70/30{consolArrow("blend70")}</th>
                    <th className="cursor-pointer select-none py-2 pr-3 hover:text-ink" onClick={() => toggleConsolSort("changed")}>Implied rating{consolArrow("changed")}</th>
                    <th className="cursor-pointer select-none py-2 pr-3 text-right hover:text-ink" onClick={() => toggleConsolSort("rankMove")}>Rank move{consolArrow("rankMove")}</th>
                  </tr>
                </thead>
                <tbody>
                  {consolItems.map((r) => (
                    <tr key={r.ticker} className={`border-b border-line/60 ${r.changed70 ? "bg-white/70" : ""}`}>
                      <td className="py-2 pr-3">
                        <Link href={`/stock/${encodeURIComponent(r.ticker)}`} className="font-mono font-semibold text-ink hover:text-accent">
                          {displayTicker(r.ticker)}
                        </Link>
                        <span className="ml-1 text-[10px] text-ink-3">{r.bucket === "Portfolio" ? "P" : "W"}</span>
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-ink-2">{Number(r.adjusted.toFixed(1))}</td>
                      <td className="py-2 pr-3 text-xs">{r.rating}</td>
                      <td className={`py-2 pr-3 text-right font-mono ${pctColor(r.quant)}`}>{r.quant}</td>
                      <td className="py-2 pr-3 text-right font-mono text-ink-2">{r.overlay ?? "—"}</td>
                      <td className="py-2 pr-3 text-right font-mono font-semibold text-ink">{r.blend70}</td>
                      <td className="py-2 pr-3 text-xs">
                        {r.changed70 ? (
                          <span className={`font-semibold ${r.b70 === "Buy" ? "text-pos" : r.b70 === "Sell" ? "text-neg" : "text-ink"}`}>
                            {r.rating} → {r.b70}
                          </span>
                        ) : (
                          <span className="text-ink-3">{r.b70 ?? "—"} (no change)</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-xs">
                        <span className={r.rankMove > 0 ? "text-pos" : r.rankMove < 0 ? "text-neg" : "text-ink-3"} title={`41-pt rank ${r.rank41} → blend rank ${r.blendRank}`}>
                          {r.rankMove > 0 ? "+" : ""}{r.rankMove}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-2 text-[11px] text-ink-3">
              All {consolidation.n} factor-scored book names (P = Portfolio, W = Watchlist). Click any header to sort.
              Highlighted rows = rating would change under Blend 70/30. Rank move = 41-pt rank minus blend rank
              (positive = the blend ranks it higher); hover for the exact ranks. Names without an overlay are
              blended as quant-only (unassessed ≠ weak).
            </div>
          </>
        )}
      </div>

      {/* ── Phase C: four-way IC validation ── */}
      <div className="mt-8 rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">Validation — which lens predicts forward returns?</h2>
          {validation && validation.dataDays > 0 && (
            <span className="text-[11px] text-ink-3">
              {validation.dataDays} day{validation.dataDays === 1 ? "" : "s"} of history · {validation.tickers} names · since {validation.firstDate}
            </span>
          )}
        </div>
        <p className="mt-1 max-w-3xl text-xs text-ink-2">
          Mean Spearman rank IC of each lens vs realized forward returns, from the nightly point-in-time log.
          Positive = higher-ranked names outperformed. This table is what earns the blend weights — no
          integration happens until it says so.
        </p>

        {!validation ? (
          <div className="mt-3 text-xs text-ink-3">Loading validation…</div>
        ) : (
          <>
            <div className="mt-2 text-xs text-ink-2">{validation.note}</div>
            {validation.horizons.some((h) => Object.keys(h.lenses).length > 0) && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full max-w-2xl border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-ink-3">
                      <th className="py-2 pr-3">Lens</th>
                      {validation.horizons.map((h) => (
                        <th key={h.horizon} className="py-2 pr-3 text-right">{h.horizon} IC</th>
                      ))}
                      <th className="py-2 text-right">obs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {LENS_ORDER.map((lens) => {
                      const cells = validation.horizons.map((h) => h.lenses[lens]);
                      if (cells.every((c) => !c)) return null;
                      const maxObs = Math.max(...cells.map((c) => c?.nDates ?? 0));
                      return (
                        <tr key={lens} className="border-b border-line/60">
                          <td className="py-2 pr-3 text-ink">{LENS_LABEL[lens]}</td>
                          {cells.map((c, i) => (
                            <td key={i} className="py-2 pr-3 text-right font-mono">
                              {c ? (
                                <span className={c.meanIC > 0.02 ? "text-pos" : c.meanIC < -0.02 ? "text-neg" : "text-ink-2"} title={`std ${c.icStd} · t ${c.tStat ?? "—"} · avg ${c.avgNames} names`}>
                                  {c.meanIC > 0 ? "+" : ""}{c.meanIC.toFixed(3)}
                                </span>
                              ) : (
                                <span className="text-ink-3">—</span>
                              )}
                            </td>
                          ))}
                          <td className="py-2 text-right text-xs text-ink-3">{maxObs || "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
