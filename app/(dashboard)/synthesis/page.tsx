"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { displayTicker } from "@/app/lib/ticker";
import {
  VERDICT_LABEL,
  STALE_LABEL,
  type SynthesisEntry,
  type SynthesisBullet,
  type StaleReason,
} from "@/app/lib/synthesis-screen-display";
import type { SectorLeadership, LeadershipRow } from "@/app/lib/sector-leadership";

/**
 * Synthesis screen — per-name AI base/bull/bear evidence synthesis.
 * The front-door triage view: watchlist names get Advance/Watch/Pass,
 * portfolio names get Thesis intact/Review/Exit watch. Generation is
 * manual (per-name or "refresh stale"); staleness badges show which
 * names have new inputs, a big price move, or earnings since last run.
 */

type Row = {
  ticker: string;
  displayTicker?: string;
  name: string;
  bucket: "Portfolio" | "Watchlist";
  sector: string;
  currentPrice?: number;
  earningsDate?: string;
  entry: SynthesisEntry | null;
  stale: StaleReason[];
};

type ScreenData = { rows: Row[]; leadership: SectorLeadership };

const VERDICT_STYLE: Record<string, string> = {
  advance: "bg-pos-soft text-pos border-pos-border",
  watch: "bg-warn-soft text-warn border-warn-border",
  pass: "bg-surface-2 text-ink-3 border-line",
  "thesis-intact": "bg-pos-soft text-pos border-pos-border",
  review: "bg-warn-soft text-warn border-warn-border",
  "exit-watch": "bg-neg-soft text-neg border-neg-border",
};

/** Sort weight: most actionable verdicts first within a section. */
const VERDICT_ORDER: Record<string, number> = {
  advance: 0,
  watch: 1,
  pass: 2,
  "exit-watch": 0,
  review: 1,
  "thesis-intact": 2,
};

function VerdictChip({ entry }: { entry: SynthesisEntry }) {
  const v = entry.result.verdict;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${VERDICT_STYLE[v] ?? "bg-surface-2 text-ink-2 border-line"}`}>
      {VERDICT_LABEL[v] ?? v}
    </span>
  );
}

function SkewPill({ skew }: { skew: number }) {
  const cls = skew > 0 ? "text-pos" : skew < 0 ? "text-neg" : "text-ink-3";
  const label = skew > 0 ? `Bull +${skew}` : skew < 0 ? `Bear ${skew}` : "Balanced";
  return <span className={`font-mono text-[10px] font-semibold ${cls}`} title="Risk/reward skew (−2 bear-heavy … +2 bull-heavy)">{label}</span>;
}

function StaleBadges({ stale }: { stale: StaleReason[] }) {
  if (stale.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {stale.map((r) => (
        <span key={r} className="inline-flex items-center rounded-full border border-warn-border bg-warn-soft px-1.5 py-0.5 text-[9px] font-medium text-warn">
          {STALE_LABEL[r]}
        </span>
      ))}
    </span>
  );
}

function Bullets({ title, bullets, tone, plain }: { title: string; bullets: SynthesisBullet[]; tone: string; plain?: string }) {
  return (
    <div>
      <div className={`mb-1 text-[10px] font-bold uppercase tracking-wide ${tone}`}>{title}</div>
      <ul className="space-y-1">
        {bullets.length === 0 && <li className="text-xs text-ink-3">—</li>}
        {bullets.map((b, i) => (
          <li key={i} className="text-xs leading-snug text-ink-2">
            {b.text} <span className="text-[9px] text-ink-3">[{b.source}]</span>
          </li>
        ))}
      </ul>
      {plain && (
        <div className="mt-2 border-t border-line pt-1.5 text-xs italic leading-snug text-ink">
          {plain}
        </div>
      )}
    </div>
  );
}

const fmtPct = (v: number | null) => (v == null ? "–" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

function LeadershipStrip({ data }: { data: SectorLeadership }) {
  const [open, setOpen] = useState(false);
  const sectors = useMemo(
    () => [...data.rows.filter((r) => r.kind === "sector")].sort((a, b) => (b.r3m ?? -999) - (a.r3m ?? -999)),
    [data],
  );
  const industries = useMemo(
    () => [...data.rows.filter((r) => r.kind === "industry" && r.r3m != null)].sort((a, b) => (b.r3m ?? 0) - (a.r3m ?? 0)),
    [data],
  );
  const cell = (r: LeadershipRow, metric: "r1w" | "r1m" | "r3m") => {
    const v = r[metric];
    const cls = v == null ? "text-ink-3" : v >= 0 ? "text-pos" : "text-neg";
    return <td key={metric} className={`px-2 py-1 text-right font-mono text-[11px] ${cls}`}>{fmtPct(v)}</td>;
  };
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-ink">
          Sector leadership <span className="font-normal text-ink-3">(3M, as of {data.builtAt.slice(0, 10)})</span>
        </div>
        <button onClick={() => setOpen(!open)} className="text-[11px] text-accent hover:underline">
          {open ? "Collapse" : "Full table"}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {sectors.slice(0, 3).map((r) => (
          <span key={r.symbol} className="rounded-full border border-pos-border bg-pos-soft px-2 py-0.5 text-[10px] text-pos">
            {r.label} {fmtPct(r.r3m)}
          </span>
        ))}
        {sectors.slice(-3).map((r) => (
          <span key={r.symbol} className="rounded-full border border-neg-border bg-neg-soft px-2 py-0.5 text-[10px] text-neg">
            {r.label} {fmtPct(r.r3m)}
          </span>
        ))}
        {industries.slice(0, 3).map((r) => (
          <span key={r.symbol} className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] text-ink-2">
            ▲ {r.label} {fmtPct(r.r3m)}
          </span>
        ))}
        {industries.slice(-2).map((r) => (
          <span key={r.symbol} className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] text-ink-2">
            ▼ {r.label} {fmtPct(r.r3m)}
          </span>
        ))}
      </div>
      {open && (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-[420px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-ink-3">
                <th className="px-2 py-1 text-left">Group</th>
                <th className="px-2 py-1 text-right">1W</th>
                <th className="px-2 py-1 text-right">1M</th>
                <th className="px-2 py-1 text-right">3M</th>
              </tr>
            </thead>
            <tbody>
              {[...sectors, ...industries].map((r) => (
                <tr key={r.symbol} className="border-t border-line">
                  <td className="px-2 py-1 text-xs text-ink-2">
                    {r.label} <span className="font-mono text-[10px] text-ink-3">{r.symbol}</span>
                    {r.kind === "industry" && <span className="ml-1 text-[9px] text-ink-3">(industry)</span>}
                  </td>
                  {cell(r, "r1w")}
                  {cell(r, "r1m")}
                  {cell(r, "r3m")}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default function SynthesisPage() {
  const [data, setData] = useState<ScreenData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [generating, setGenerating] = useState<Set<string>>(new Set());
  const [genErrors, setGenErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/synthesis-screen");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as ScreenData);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "load failed");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = useCallback(
    async (tickers: string[], opts?: { force?: boolean; webFill?: boolean }) => {
      setGenerating((prev) => new Set([...prev, ...tickers]));
      setGenErrors((prev) => {
        const next = { ...prev };
        for (const t of tickers) delete next[t];
        return next;
      });
      try {
        for (const batch of chunk(tickers, 5)) {
          const res = await fetch("/api/synthesis-screen", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tickers: batch, force: opts?.force ?? true, webFill: opts?.webFill ?? false }),
          });
          const json = (await res.json()) as {
            results?: Array<{ ticker: string; status: string; entry?: SynthesisEntry; error?: string }>;
            error?: string;
          };
          if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
          setData((prev) => {
            if (!prev) return prev;
            const byTicker = new Map((json.results ?? []).map((r) => [r.ticker, r]));
            return {
              ...prev,
              rows: prev.rows.map((row) => {
                const r = byTicker.get(row.ticker);
                if (!r?.entry) return row;
                return { ...row, entry: r.entry, stale: [] };
              }),
            };
          });
          setGenErrors((prev) => {
            const next = { ...prev };
            for (const r of json.results ?? []) if (r.status === "error" && r.error) next[r.ticker] = r.error;
            return next;
          });
          setGenerating((prev) => {
            const next = new Set(prev);
            for (const t of batch) next.delete(t);
            return next;
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "generation failed";
        setGenErrors((prev) => {
          const next = { ...prev };
          for (const t of tickers) if (!(t in next)) next[t] = msg;
          return next;
        });
        setGenerating((prev) => {
          const next = new Set(prev);
          for (const t of tickers) next.delete(t);
          return next;
        });
      }
    },
    [],
  );

  const toggle = (ticker: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });

  const sections: Array<{ title: string; bucket: "Portfolio" | "Watchlist" }> = [
    { title: "Watchlist", bucket: "Watchlist" },
    { title: "Portfolio", bucket: "Portfolio" },
  ];

  const sortRows = (rows: Row[]) =>
    [...rows].sort((a, b) => {
      const av = a.entry ? (VERDICT_ORDER[a.entry.result.verdict] ?? 9) : -1;
      const bv = b.entry ? (VERDICT_ORDER[b.entry.result.verdict] ?? 9) : -1;
      // Never-generated first (they need attention), then verdict order, then skew desc.
      if (av !== bv) return av - bv;
      const as = a.entry?.result.skew ?? 0;
      const bs = b.entry?.result.skew ?? 0;
      if (as !== bs) return bs - as;
      return a.ticker.localeCompare(b.ticker);
    });

  if (loadError) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="rounded-lg border border-neg-border bg-neg-soft p-4 text-sm text-neg">
          Failed to load synthesis screen: {loadError}
        </div>
      </div>
    );
  }
  if (!data) {
    return <div className="mx-auto max-w-5xl px-4 py-8 text-sm text-ink-3">Loading synthesis screen…</div>;
  }

  const staleTickers = data.rows.filter((r) => r.stale.length > 0).map((r) => r.ticker);

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-ink">Synthesis</h1>
          <p className="text-xs text-ink-3">
            Evidence-bound base / bull / bear per name — FactSet, analyst reports, revisions, street takeaways,
            research lists, technicals. Score and factors deliberately excluded.
          </p>
        </div>
        <button
          onClick={() => void generate(staleTickers)}
          disabled={staleTickers.length === 0 || generating.size > 0}
          className="rounded-md border border-accent-border bg-accent-soft px-3 py-1.5 text-xs font-semibold text-accent disabled:opacity-40"
        >
          Refresh stale ({staleTickers.length})
        </button>
      </div>

      <LeadershipStrip data={data.leadership} />

      {sections.map(({ title, bucket }) => {
        const rows = sortRows(data.rows.filter((r) => r.bucket === bucket));
        if (rows.length === 0) return null;
        return (
          <div key={bucket} className="rounded-lg border border-line bg-surface">
            <div className="border-b border-line px-3 py-2 text-xs font-bold uppercase tracking-wide text-ink-2">
              {title} <span className="font-normal text-ink-3">({rows.length})</span>
            </div>
            <div className="divide-y divide-line">
              {rows.map((row) => {
                const isOpen = expanded.has(row.ticker);
                const busy = generating.has(row.ticker);
                const r = row.entry?.result;
                return (
                  <Fragment key={row.ticker}>
                    <div
                      className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 hover:bg-surface-2"
                      onClick={() => toggle(row.ticker)}
                    >
                      <div className="w-20 shrink-0 font-mono text-xs font-bold text-ink">
                        {displayTicker(row.displayTicker ?? row.ticker)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {row.entry && r ? (
                            <>
                              <VerdictChip entry={row.entry} />
                              <SkewPill skew={r.skew} />
                              <span className="truncate text-xs text-ink-2">{r.verdictReason}</span>
                            </>
                          ) : (
                            <span className="text-xs italic text-ink-3">Not yet generated</span>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2">
                          <StaleBadges stale={row.stale} />
                          {row.entry && (
                            <span className="text-[9px] text-ink-3">
                              {row.entry.generatedAt.slice(0, 10)}
                              {row.entry.webFillUsed ? " · web" : ""}
                            </span>
                          )}
                          {genErrors[row.ticker] && (
                            <span className="text-[9px] text-neg">Error: {genErrors[row.ticker]}</span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void generate([row.ticker]);
                        }}
                        disabled={busy}
                        className="rounded-md border border-line bg-surface-2 px-2 py-1 text-[10px] font-medium text-ink-2 hover:text-ink disabled:opacity-40"
                      >
                        {busy ? "Generating…" : row.entry ? "Regenerate" : "Generate"}
                      </button>
                    </div>
                    {isOpen && r && (
                      <div className="space-y-3 bg-surface-2/50 px-4 py-3">
                        {row.entry?.targets && row.entry.targets.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[10px] font-bold uppercase tracking-wide text-ink-3">Targets</span>
                            {row.entry.targets.map((t) => (
                              <span
                                key={t.source}
                                className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] text-ink-2"
                                title={t.asOf ? `as of ${t.asOf}` : undefined}
                              >
                                {t.source} <span className="font-mono font-semibold text-ink">{t.target}</span>
                                {t.upsidePct != null && (
                                  <span className={`font-mono ${t.upsidePct >= 0 ? "text-pos" : "text-neg"}`}>
                                    {t.upsidePct >= 0 ? "+" : ""}
                                    {t.upsidePct.toFixed(0)}%
                                  </span>
                                )}
                              </span>
                            ))}
                          </div>
                        )}
                        {r.nextStep && (
                          <div className="rounded-md border border-accent-border bg-accent-soft px-2.5 py-1.5 text-xs text-accent">
                            <span className="font-bold uppercase tracking-wide text-[10px]">Next step</span>{" "}
                            {r.nextStep}
                          </div>
                        )}
                        <div className="grid gap-4 sm:grid-cols-3">
                          <Bullets title="Base" bullets={r.base} tone="text-ink-2" plain={r.plain?.base} />
                          <Bullets title="Bull" bullets={r.bull} tone="text-pos" plain={r.plain?.bull} />
                          <Bullets title="Bear" bullets={r.bear} tone="text-neg" plain={r.plain?.bear} />
                        </div>
                        {r.priceAction && (
                          <div>
                            <div className="text-[10px] font-bold uppercase tracking-wide text-ink-3">Price action — name &amp; sector</div>
                            <div className="text-xs text-ink-2">{r.priceAction}</div>
                          </div>
                        )}
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div>
                            <div className="text-[10px] font-bold uppercase tracking-wide text-ink-3">Key debate</div>
                            <div className="text-xs text-ink-2">{r.keyDebate || "—"}</div>
                          </div>
                          <div>
                            <div className="text-[10px] font-bold uppercase tracking-wide text-ink-3">Catalysts</div>
                            {r.catalysts.length === 0 ? (
                              <div className="text-xs text-ink-3">None identified in the data</div>
                            ) : (
                              <ul className="text-xs text-ink-2">
                                {r.catalysts.map((c, i) => (
                                  <li key={i}>{c.date ? `${c.date}: ` : ""}{c.event}</li>
                                ))}
                              </ul>
                            )}
                          </div>
                          <div>
                            <div className="text-[10px] font-bold uppercase tracking-wide text-ink-3">Would change the call</div>
                            <ul className="text-xs text-ink-2">
                              {r.wouldChangeCall.length === 0 && <li className="text-ink-3">—</li>}
                              {r.wouldChangeCall.map((w, i) => (
                                <li key={i}>{w}</li>
                              ))}
                            </ul>
                          </div>
                          <div>
                            <div className="text-[10px] font-bold uppercase tracking-wide text-ink-3">Data gaps</div>
                            <ul className="text-xs text-ink-2">
                              {r.dataGaps.length === 0 && <li className="text-ink-3">None declared</li>}
                              {r.dataGaps.map((g, i) => (
                                <li key={i}>{g}</li>
                              ))}
                            </ul>
                          </div>
                        </div>
                        <div className="flex justify-end">
                          <button
                            onClick={() => void generate([row.ticker], { force: true, webFill: true })}
                            disabled={busy}
                            className="rounded-md border border-line bg-surface px-2 py-1 text-[10px] text-ink-3 hover:text-ink disabled:opacity-40"
                            title="Regenerate with web search allowed to fill declared data gaps (reputable sources only)"
                          >
                            Regenerate with web fill
                          </button>
                        </div>
                      </div>
                    )}
                    {isOpen && !r && (
                      <div className="bg-surface-2/50 px-4 py-3 text-xs text-ink-3">
                        No synthesis yet — hit Generate to build one from the current evidence.
                      </div>
                    )}
                  </Fragment>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
