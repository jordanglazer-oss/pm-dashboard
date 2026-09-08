"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { isScoreable } from "@/app/lib/scoring";
import { MAX_SCORE } from "@/app/lib/types";
import { displayTicker } from "@/app/lib/ticker";
import { SkeletonTable } from "@/app/components/Skeleton";
import { EmptyState } from "@/app/components/EmptyState";
import { AppIcon } from "@/app/components/AppIcon";
import { usePersistedOpen } from "@/app/lib/useCollapsed";

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
  perMetric?: Record<string, number>;
  metrics?: Record<string, number>;
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

/** Metric → (group, label, format) for the per-stock math trail. Mirrors
 *  FACTOR_GROUPS in app/lib/factors.ts — keep in sync when adding metrics. */
const METRIC_META: Record<string, { group: (typeof GROUP_ORDER)[number]; label: string; pct?: boolean; x?: boolean }> = {
  fcfMargin: { group: "quality", label: "FCF margin", pct: true },
  operMgn: { group: "quality", label: "Operating margin", pct: true },
  operMgnTrend: { group: "quality", label: "Op-margin trend", pct: true },
  roe: { group: "quality", label: "Return on equity", pct: true },
  accruals: { group: "quality", label: "Accruals ratio", pct: true },
  intCoverage: { group: "quality", label: "Interest coverage", x: true },
  debtEbitda: { group: "quality", label: "Net debt / EBITDA", x: true },
  revGrowth: { group: "growth", label: "Revenue growth (1y)", pct: true },
  epsGrowth: { group: "growth", label: "EPS growth (1y)", pct: true },
  pe: { group: "valuation", label: "P/E", x: true },
  pbk: { group: "valuation", label: "P/Book", x: true },
  psales: { group: "valuation", label: "P/Sales", x: true },
  evEbitda: { group: "valuation", label: "EV/EBITDA", x: true },
  fcfYield: { group: "valuation", label: "FCF yield", pct: true },
  mom12_1: { group: "momentum", label: "12-1M momentum", pct: true },
  mom6_1: { group: "momentum", label: "6-1M momentum", pct: true },
};
const GROUP_WEIGHTS: Record<string, number> = { quality: 0.3, growth: 0.2, valuation: 0.2, momentum: 0.3 };

function fmtMetric(key: string, v: number): string {
  const m = METRIC_META[key];
  if (m?.pct) return `${(v * 100).toFixed(1)}%`;
  if (m?.x) return `${v.toFixed(1)}×`;
  return v.toFixed(2);
}
const GROUP_LABEL: Record<string, string> = {
  quality: "Qual", growth: "Grow", valuation: "Val", momentum: "Mom",
};

const BTN = "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover";
const SELECT = "h-7 rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink-2 outline-none";

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
  // Methodology disclosure — persisted so a PM who opened it once keeps it.
  const [showMethod, toggleMethod] = usePersistedOpen("factorLab.method.open", false);
  // Which book row's math trail is open (click the ticker row to toggle).
  const [openMath, setOpenMath] = useState<string | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [screen, setScreen] = useState<ScreenName[] | null>(null);
  const [screenBuiltAt, setScreenBuiltAt] = useState<string | null>(null);
  const [screenSector, setScreenSector] = useState<string>("All");
  const [screenShowAll, toggleScreenShowAll] = usePersistedOpen("factorLab.screen.showAll", false);
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
  const ConsolTh = ({ id, label, className = "", title }: { id: ConsolSortKey; label: string; className?: string; title?: string }) => (
    <th className={className} title={title}>
      <button type="button" onClick={() => toggleConsolSort(id)} className={`inline-flex items-center gap-0.5 hover:text-ink ${consolSort === id ? "text-ink-2" : ""}`}>
        {label}
        {consolSort === id && <AppIcon name={consolDir === "asc" ? "chevU" : "chevD"} size={11} strokeWidth={2} />}
      </button>
    </th>
  );

  return (
    <div className="flex flex-col gap-3.5">
      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="seg" role="group" aria-label="Sort">
          {([
            ["disagreement", "Disagreement"],
            ["quant", "Quant %ile"],
            ["adjusted", "41-pt"],
            ["overlay", "Overlay"],
            ["blend70", "Blend 70/30"],
          ] as [SortKey, string][]).map(([k, label]) => (
            <button key={k} onClick={() => setSortKey(k)} className={sortKey === k ? "on" : ""}>{label}</button>
          ))}
        </div>
        <span className="text-[11.5px] text-ink-3">
          shadow · read-only · {coveredCount} of {rows.length} book names factor-scored{built && ` · built ${built}`}
        </span>
        <button onClick={toggleMethod} aria-expanded={showMethod} className={`${BTN} ml-auto`}>
          <AppIcon name="help" size={13} strokeWidth={2} />
          How to read this
          <AppIcon name={showMethod ? "chevU" : "chevD"} size={12} strokeWidth={2} className="text-ink-3" />
        </button>
      </div>

      {showMethod && (
        <section className="panel">
          <div className="panel-h"><span className="t">Reading the columns</span><span className="m">a from-scratch factor model computed beside the 41-point score — it changes nothing</span></div>
          <div className="flex flex-col gap-2 px-3.5 py-3 text-[12.5px] leading-[1.5] text-ink-2">
            <p>
              Each name is z-scored against its GICS-sector peers in a ~540-name S&amp;P 500 + TSX 60 universe,
              rolled into a 0–100 <span className="font-medium text-ink">quant percentile</span>. The <span className="font-medium text-ink">judgment overlay</span> is the 41-pt
              system&rsquo;s qualitative categories (brand, moat, catalysts, charting, track record) — the part no factor
              replicates. The <span className="font-medium text-ink">blends</span> are the integration candidates a later validation phase will race.
            </p>
            <ul className="ml-4 list-disc space-y-1">
              <li><span className="font-medium text-ink">41-pt</span> — the current committee score (adjusted, out of {MAX_SCORE}). Unchanged.</li>
              <li><span className="font-medium text-ink">Quant %ile</span> — pure factor percentile vs sector peers. 70+ green, 30− red. This is the machine&rsquo;s cross-sectional read; it knows nothing about the 41-pt score.</li>
              <li><span className="font-medium text-ink">ΔRank</span> — 41-pt rank minus quant rank, over the {coveredCount} scored names. <span className="text-pos">Positive</span> = the factor model likes it <em>more</em> than the committee; <span className="text-neg">negative</span> = less. Big magnitudes are where the two views genuinely disagree — the rows worth a human look.</li>
              <li><span className="font-medium text-ink">Overlay</span> — judgment lens (qualitative categories only), 0–100. Blank = not yet assessed.</li>
              <li><span className="font-medium text-ink">70/30</span> and <span className="font-medium text-ink">Mod</span> — the two integration candidates: 0.7·quant + 0.3·overlay, and quant nudged ±15 by the overlay.</li>
              <li><span className="font-medium text-ink">Factor z-bars</span> — mean sector z per group (Quality / Growth / Valuation / Momentum). Right/green good, left/red bad, ±3 scale.</li>
            </ul>
          </div>
        </section>
      )}

      {topDisagree.length > 0 && (
        <div className="panel grid grid-cols-1 divide-y divide-line-soft sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {topDisagree.map((r) => {
            const factorHigher = (r.deltaRank ?? 0) > 0;
            return (
              <div key={r.ticker} className="px-4 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[13px] font-medium text-ink">{displayTicker(r.ticker)}</span>
                  <span className={`inline-flex items-center gap-0.5 font-mono text-[12px] ${factorHigher ? "text-pos" : "text-neg"}`}>
                    <AppIcon name={factorHigher ? "chevU" : "chevD"} size={11} strokeWidth={2.25} />
                    factor {Math.abs(r.deltaRank ?? 0)} ranks
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-ink-3">
                  41-pt {Number(r.adjusted.toFixed(1))}/{MAX_SCORE} · quant {r.quant}%ile
                </div>
                <div className="mt-1 text-[11.5px] leading-[1.5] text-ink-2">
                  {factorHigher
                    ? "Factors rate it higher than the committee — a name the qualitative read may be discounting."
                    : "Committee rates it higher than the factors — conviction the numbers don't yet support."}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Book: 41-pt beside the factor lens ── */}
      <section className="panel">
        <div className="panel-h">
          <span className="t">Book</span>
          <span className="m">Portfolio + Watchlist · 41-pt beside the factor lens · click a row for the math</span>
        </div>
        {loading ? (
          <div className="p-3.5"><SkeletonTable rows={10} cols={9} /></div>
        ) : coveredCount === 0 ? (
          <EmptyState
            className="!py-8"
            glyph={<AppIcon name="clock" size={18} />}
            title="No factor scores yet"
            body={
              <>
                They&rsquo;re written nightly by the shadow job. To force a run now, open{" "}
                <code className="rounded bg-surface-2 px-1 font-mono text-[11.5px]">/api/admin/factor-debug?book=1&amp;run=1</code>.
              </>
            }
          />
        ) : (
          <div className="tbl-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="pl-3.5">Ticker</th>
                  <th>Sector</th>
                  <th className="n">41-pt</th>
                  <th className="n">Quant %ile</th>
                  <th className="n">ΔRank</th>
                  <th className="n">Overlay</th>
                  <th className="n">70/30</th>
                  <th className="n">Mod</th>
                  {GROUP_ORDER.map((g) => (
                    <th key={g} className="text-center">{GROUP_LABEL[g]}</th>
                  ))}
                  <th className="n pr-3.5">Conf</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => {
                  const hasQuant = r.quant != null;
                  const entry = entries[r.ticker.toUpperCase()];
                  const mathOpen = openMath === r.ticker;
                  const hasTrail = Boolean(entry?.perMetric && Object.keys(entry.perMetric).length);
                  return (
                    <React.Fragment key={r.ticker}>
                    <tr
                      className={`${hasQuant ? "" : "opacity-50"} ${hasTrail ? "cursor-pointer" : ""} ${mathOpen ? "sel" : ""}`}
                      onClick={() => hasTrail && setOpenMath(mathOpen ? null : r.ticker)}
                      title={hasTrail ? "Click to see the math behind this percentile" : undefined}
                    >
                      <td className="pl-3.5">
                        <span className="inline-flex items-center gap-1.5">
                          {hasTrail ? <AppIcon name={mathOpen ? "chevD" : "chevR"} size={12} strokeWidth={2} className="text-ink-faint" /> : <span className="inline-block w-3" />}
                          <Link href={`/stock/${encodeURIComponent(r.ticker)}`} onClick={(e) => e.stopPropagation()} className="font-mono font-medium text-ink hover:text-accent hover:underline">
                            {displayTicker(r.ticker)}
                          </Link>
                          <span className="text-[11px] text-ink-3" title={r.bucket}>{r.bucket === "Portfolio" ? "P" : "W"}</span>
                        </span>
                      </td>
                      <td className="text-[12px] text-ink-2">{r.sector || "—"}</td>
                      <td className="n text-ink-2">{Number(r.adjusted.toFixed(1))}</td>
                      <td className={`n font-medium ${pctColor(r.quant)}`}>{hasQuant ? r.quant : "—"}</td>
                      <td className="n">
                        {r.deltaRank == null ? <span className="text-ink-faint">—</span> : (
                          <span className={r.deltaRank > 0 ? "text-pos" : r.deltaRank < 0 ? "text-neg" : "text-ink-3"}>
                            {r.deltaRank > 0 ? "+" : ""}{r.deltaRank}
                          </span>
                        )}
                      </td>
                      <td className="n text-ink-2">{r.overlay ?? "—"}</td>
                      <td className="n text-ink-2">{r.blend70 ?? "—"}</td>
                      <td className="n text-ink-2">{r.blendMod ?? "—"}</td>
                      {GROUP_ORDER.map((g) => (
                        <td key={g} className="text-center"><ZBar z={r.groups[g]} /></td>
                      ))}
                      <td className="n pr-3.5 text-ink-3">{r.confidence ?? "—"}</td>
                    </tr>
                    {/* ── Math trail: raw value → sector-neutral z → group → composite ── */}
                    {mathOpen && entry?.perMetric && (
                      <tr>
                        <td colSpan={9 + GROUP_ORDER.length} className="whitespace-normal bg-surface-2/40 px-4 py-3">
                          <div className="mb-2 text-[11.5px] leading-[1.5] text-ink-3">
                            Each metric is compared against every <span className="text-ink-2">{r.sector || "sector"}</span> name in the
                            ~560-name universe (winsorized, z clamped to ±3, sign-normalized so higher = better;
                            missing metrics are dropped from both sides, never counted as bearish). Group z = mean
                            of its metrics; composite = Σ group z × weight → percentile via the normal CDF.
                          </div>
                          <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
                            {GROUP_ORDER.map((g) => {
                              const rows = Object.entries(entry.perMetric!).filter(([k]) => METRIC_META[k]?.group === g);
                              if (!rows.length) return (
                                <div key={g}>
                                  <div className="mb-1 text-[11px] text-ink-3">{g} · ×{GROUP_WEIGHTS[g]}</div>
                                  <div className="text-[11px] text-ink-faint">no metrics available</div>
                                </div>
                              );
                              return (
                                <div key={g}>
                                  <div className="mb-1 text-[11px] text-ink-3">
                                    {g} · ×{GROUP_WEIGHTS[g]}
                                    {typeof r.groups[g] === "number" && (
                                      <span className={`ml-1.5 font-mono ${r.groups[g] >= 0 ? "text-pos" : "text-neg"}`}>
                                        z {r.groups[g] >= 0 ? "+" : ""}{r.groups[g].toFixed(2)}
                                      </span>
                                    )}
                                  </div>
                                  {rows.map(([k, z]) => (
                                    <div key={k} className="flex items-baseline gap-2 text-[11.5px] leading-5">
                                      <span className="text-ink-2">{METRIC_META[k]?.label ?? k}</span>
                                      <span className="ml-auto font-mono text-ink-3">
                                        {entry.metrics?.[k] != null ? fmtMetric(k, entry.metrics[k]) : "—"}
                                      </span>
                                      <span className={`w-12 text-right font-mono ${z >= 0 ? "text-pos" : "text-neg"}`}>
                                        {z >= 0 ? "+" : ""}{z.toFixed(2)}
                                      </span>
                                    </div>
                                  ))}
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
          </div>
        )}
        {!loading && coveredCount > 0 && (
          <div className="flex h-8 items-center border-t border-line-soft px-3.5 text-[11.5px] text-ink-3">
            {coveredCount} of {rows.length} factor-scored · P = Portfolio, W = Watchlist · unscored names sink to the bottom
          </div>
        )}
      </section>

      {/* ── Universe Screen: idea generation from the full ~540-name universe ── */}
      <section className="panel">
        <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
          <span className="t">Universe screen</span>
          <span className="m">top quant names you don&rsquo;t own{screenBuiltAt && ` · built ${new Date(screenBuiltAt).toLocaleDateString()}`}</span>
          {screen && screen.length > 0 && (
            <label className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-ink-3">
              Sector
              <select value={screenSector} onChange={(e) => setScreenSector(e.target.value)} className={SELECT}>
                <option value="All">All ({screenRows.length})</option>
                {screenSectors.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        <p className="border-b border-line-soft px-3.5 py-2 text-[11.5px] leading-5 text-ink-3">
          Every S&amp;P 500 + TSX 60 constituent scored by the same factor model, Portfolio and Watchlist names
          excluded — what the machine says you&rsquo;re missing. A <span className="text-neg">distress</span> or{" "}
          <span className="text-warn">grey</span> veto is an Altman-style balance-sheet read: the name
          screens well but the balance sheet disagrees — treat the percentile with suspicion.
        </p>

        {!screen ? (
          <div className="p-3.5"><SkeletonTable rows={6} cols={9} /></div>
        ) : screen.length === 0 ? (
          <EmptyState
            className="!py-8"
            glyph={<AppIcon name="search" size={18} />}
            title="Universe screen not built yet"
            body="The per-name read-outs are written by the weekly universe rebuild (Sunday). This section populates automatically after the next rebuild."
          />
        ) : (
          <>
            <div className="tbl-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="n pl-3.5 w-10">#</th>
                    <th>Ticker</th>
                    <th>Sector</th>
                    <th className="n">Quant %ile</th>
                    {GROUP_ORDER.map((g) => (
                      <th key={g} className="text-center">{GROUP_LABEL[g]}</th>
                    ))}
                    <th className="n">Conf</th>
                    <th className="pr-3.5">Veto</th>
                  </tr>
                </thead>
                <tbody>
                  {screenVisible.map((n, i) => (
                    <tr key={n.ticker}>
                      <td className="n pl-3.5 text-ink-3">{i + 1}</td>
                      <td className="font-mono font-medium text-ink">{displayTicker(n.ticker)}</td>
                      <td className="text-[12px] text-ink-2">{n.sector}</td>
                      <td className={`n font-medium ${pctColor(n.quant)}`}>{n.quant}</td>
                      {GROUP_ORDER.map((g) => (
                        <td key={g} className="text-center"><ZBar z={n.groups?.[g]} /></td>
                      ))}
                      <td className="n text-ink-3">{n.confidence}</td>
                      <td className="pr-3.5">
                        {n.distress === "distress" ? (
                          <span className="inline-flex items-center gap-1.5 text-[11.5px] text-neg" title={`Altman-style Z ${n.altmanZ}`}><span className="dot bg-neg" />distress</span>
                        ) : n.distress === "grey" ? (
                          <span className="inline-flex items-center gap-1.5 text-[11.5px] text-warn" title={`Altman-style Z ${n.altmanZ}`}><span className="dot bg-warn" />grey</span>
                        ) : (
                          <span className="text-[11.5px] text-ink-faint">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex h-8 items-center border-t border-line-soft px-3.5 text-[11.5px] text-ink-3">
              {screenVisible.length} of {screenRows.length} · sorted by quant percentile
              {screenRows.length > 25 && (
                <button onClick={toggleScreenShowAll} className="ml-auto text-accent hover:underline">
                  {screenShowAll ? "Show top 25" : `Show top 100 (of ${screenRows.length})`}
                </button>
              )}
            </div>
          </>
        )}
      </section>

      {/* ── Consolidation Preview: WHAT-IF only — nothing here is live ── */}
      <section className="panel">
        <div className="panel-h">
          <span className="t">Consolidation preview</span>
          <span className="m">what-if · not live · Phase D decision pending</span>
        </div>
        <p className="border-b border-line-soft px-3.5 py-2 text-[11.5px] leading-5 text-ink-3">
          If the book were rated on <span className="text-ink-2">Blend 70/30</span> (0.7·quant + 0.3·judgment) today, using the same
          fractional Buy/Sell thresholds as the 41-pt system (Buy ≥ 73%, Sell ≤ 44%) — here&rsquo;s exactly what would
          change. This is a preview of the integration decision, not the decision: blend weights are earned in the
          Validation table below, and nothing switches over until the evidence and an explicit sign-off say so.
        </p>

        {!consolidation ? (
          <div className="px-3.5 py-3 text-[12.5px] text-ink-3">Needs at least 5 factor-scored book names.</div>
        ) : (
          <>
            <div className="grid grid-cols-2 divide-x divide-line-soft border-b border-line-soft sm:grid-cols-4">
              <div className="px-4 py-2.5"><div className="text-[11px] text-ink-3">Ratings would change</div><div className="mt-0.5 font-mono text-[13px] font-medium text-ink">{consolidation.changes70}<span className="text-ink-faint">/{consolidation.n}</span></div></div>
              <div className="px-4 py-2.5"><div className="text-[11px] text-ink-3">Upgrades</div><div className="mt-0.5 font-mono text-[13px] font-medium text-pos">{consolidation.up70}</div></div>
              <div className="px-4 py-2.5"><div className="text-[11px] text-ink-3">Downgrades</div><div className="mt-0.5 font-mono text-[13px] font-medium text-neg">{consolidation.down70}</div></div>
              <div className="px-4 py-2.5"><div className="text-[11px] text-ink-3">±15-mod variant</div><div className="mt-0.5 font-mono text-[13px] font-medium text-ink-2">{consolidation.changesMod} <span className="text-[11px] font-normal text-ink-3">changes</span></div></div>
            </div>
            <div className="tbl-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <ConsolTh id="ticker" label="Ticker" className="pl-3.5" />
                    <ConsolTh id="adjusted" label="41-pt" className="n" />
                    <ConsolTh id="adjusted" label="/100" className="n" title="The 41-pt adjusted score rescaled to /100 for visual comparability. NOTE: an absolute grade, not a percentile — same axis, different meaning than Quant." />
                    <ConsolTh id="rating" label="Rating now" />
                    <ConsolTh id="quant" label="Quant" className="n" />
                    <ConsolTh id="overlay" label="Overlay" className="n" />
                    <ConsolTh id="blend70" label="Blend 70/30" className="n" />
                    <ConsolTh id="changed" label="Implied rating" />
                    <ConsolTh id="rankMove" label="Rank move" className="n pr-3.5" />
                  </tr>
                </thead>
                <tbody>
                  {consolItems.map((r) => (
                    <tr key={r.ticker} className={r.changed70 ? "sel" : ""}>
                      <td className="pl-3.5">
                        <Link href={`/stock/${encodeURIComponent(r.ticker)}`} className="font-mono font-medium text-ink hover:text-accent hover:underline">
                          {displayTicker(r.ticker)}
                        </Link>
                        <span className="ml-1.5 text-[11px] text-ink-3" title={r.bucket}>{r.bucket === "Portfolio" ? "P" : "W"}</span>
                      </td>
                      <td className="n text-ink-2">{Number(r.adjusted.toFixed(1))}</td>
                      <td className="n text-ink-3">{Math.round((r.adjusted / MAX_SCORE) * 100)}</td>
                      <td className="text-ink-2">{r.rating}</td>
                      <td className={`n ${pctColor(r.quant)}`}>{r.quant}</td>
                      <td className="n text-ink-2">{r.overlay ?? "—"}</td>
                      <td className="n font-medium text-ink">{r.blend70}</td>
                      <td>
                        {r.changed70 ? (
                          <span className={`inline-flex items-center gap-1 font-medium ${r.b70 === "Buy" ? "text-pos" : r.b70 === "Sell" ? "text-neg" : "text-ink"}`}>
                            {r.rating} <AppIcon name="arrowR" size={11} strokeWidth={2} className="text-ink-3" /> {r.b70}
                          </span>
                        ) : (
                          <span className="text-ink-3">{r.b70 ?? "—"} (no change)</span>
                        )}
                      </td>
                      <td className="n pr-3.5">
                        <span className={r.rankMove > 0 ? "text-pos" : r.rankMove < 0 ? "text-neg" : "text-ink-3"} title={`41-pt rank ${r.rank41} → blend rank ${r.blendRank}`}>
                          {r.rankMove > 0 ? "+" : ""}{r.rankMove}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-line-soft px-3.5 py-2 text-[11.5px] leading-5 text-ink-3">
              All {consolidation.n} factor-scored book names (P = Portfolio, W = Watchlist). Click any header to sort.
              Highlighted rows = rating would change under Blend 70/30. Rank move = 41-pt rank minus blend rank
              (positive = the blend ranks it higher); hover for the exact ranks. Names without an overlay are
              blended as quant-only (unassessed ≠ weak).
            </div>
          </>
        )}
      </section>

      {/* ── Phase C: four-way IC validation ── */}
      <section className="panel">
        <div className="panel-h">
          <span className="t">Validation</span>
          <span className="m">
            which lens predicts forward returns?
            {validation && validation.dataDays > 0 && (
              <> · {validation.dataDays} day{validation.dataDays === 1 ? "" : "s"} of history · {validation.tickers} names · since {validation.firstDate}</>
            )}
          </span>
        </div>
        <p className="border-b border-line-soft px-3.5 py-2 text-[11.5px] leading-5 text-ink-3">
          Mean Spearman rank IC of each lens vs realized forward returns, from the nightly point-in-time log.
          Positive = higher-ranked names outperformed. This table is what earns the blend weights — no
          integration happens until it says so.
        </p>

        {!validation ? (
          <div className="p-3.5"><SkeletonTable rows={5} cols={5} /></div>
        ) : (
          <>
            <div className="px-3.5 py-2 text-[12.5px] leading-[1.5] text-ink-2">{validation.note}</div>
            {validation.horizons.some((h) => Object.keys(h.lenses).length > 0) && (
              <div className="tbl-wrap border-t border-line-soft">
                <table className="data-table max-w-2xl">
                  <thead>
                    <tr>
                      <th className="pl-3.5">Lens</th>
                      {validation.horizons.map((h) => (
                        <th key={h.horizon} className="n">{h.horizon} IC</th>
                      ))}
                      <th className="n pr-3.5">obs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {LENS_ORDER.map((lens) => {
                      const cells = validation.horizons.map((h) => h.lenses[lens]);
                      if (cells.every((c) => !c)) return null;
                      const maxObs = Math.max(...cells.map((c) => c?.nDates ?? 0));
                      return (
                        <tr key={lens}>
                          <td className="pl-3.5 text-ink">{LENS_LABEL[lens]}</td>
                          {cells.map((c, i) => (
                            <td key={i} className="n">
                              {c ? (
                                <span className={c.meanIC > 0.02 ? "text-pos" : c.meanIC < -0.02 ? "text-neg" : "text-ink-2"} title={`std ${c.icStd} · t ${c.tStat ?? "—"} · avg ${c.avgNames} names`}>
                                  {c.meanIC > 0 ? "+" : ""}{c.meanIC.toFixed(3)}
                                </span>
                              ) : (
                                <span className="text-ink-faint">—</span>
                              )}
                            </td>
                          ))}
                          <td className="n pr-3.5 text-ink-3">{maxObs || "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
