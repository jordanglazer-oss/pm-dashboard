"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useStocks } from "@/app/lib/StockContext";
import { SCORE_GROUPS, MAX_SCORE, type ScoreKey } from "@/app/lib/types";
import { groupTotal } from "@/app/lib/scoring";
import { canonicalTicker, displayTicker } from "@/app/lib/ticker";
import { VERDICT_LABEL, type SynthesisResult, type StaleReason } from "@/app/lib/synthesis-screen-display";
import { describeCondition, type KillCondition } from "@/app/lib/kill-conditions";
import { AppIcon } from "./AppIcon";

/**
 * Docked inspector for the Holdings table (canvas: Main.dc.html). Selecting
 * a row opens the name beside the table — synthesis verdict, kill
 * conditions, score by group, latest FactSet alerts and the What-they-do /
 * Why-own-it text — so a PM reads a holding without leaving the list. The
 * full stock page is one click ("Open"). Read-only against every store it
 * touches: /api/synthesis-screen, /api/kv/position-theses, /api/thesis-check,
 * /api/street-takeaways; the actions call the same context methods the stock
 * page uses (moveBucket / removeStock) or deep-link to the stock page's own
 * rescore / refresh flows.
 */

type SynthRow = { ticker: string; stale: StaleReason[]; entry?: { result: SynthesisResult; generatedAt?: string } | null };
type ThesisEntry = { why: string; updatedAt: string; killConditions?: KillCondition[]; underwrittenAt?: string };
type ThesisCheck = { result?: { breaksThesis?: "direct" | "partial" | "no"; assessment?: string } };
type Takeaway = { id: string; date: string; kind?: string; headline?: string; overview?: string; keyPoints?: string[]; event?: string };

const TABS = ["Overview", "Scores", "Thesis", "Alerts"] as const;
type Tab = (typeof TABS)[number];

function verdictTone(v: string | undefined): string {
  if (v === "advance" || v === "thesis-intact") return "bg-pos-soft text-pos";
  if (v === "pass" || v === "exit-watch") return "bg-neg-soft text-neg";
  if (!v) return "bg-surface-2 text-ink-3";
  return "bg-warn-soft text-warn";
}

function Section({ title, meta, children }: { title: string; meta?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[12px] font-semibold text-ink">{title}</span>
        {meta && <span className="text-[11px] text-ink-3">{meta}</span>}
      </div>
      {children}
    </div>
  );
}

function fmtDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function HoldingInspector({
  ticker,
  previousClose,
  weight,
  onClose,
}: {
  ticker: string;
  previousClose?: number | null;
  weight?: number | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const { getStock, uiPrefs, setUiPref, moveBucket, removeStock, tickerCurrency } = useStocks();
  const s = getStock(ticker);
  const tab = (uiPrefs["holdings.inspector.tab"] as Tab) || "Overview";
  const setTab = (t: Tab) => setUiPref("holdings.inspector.tab", t);

  // Loaded data is keyed by ticker so switching names shows fresh state
  // without a synchronous reset inside the effect.
  const [synthBy, setSynth] = useState<{ t: string; v: SynthRow | null } | null>(null);
  const [thesisBy, setThesis] = useState<{ t: string; v: ThesisEntry | null } | null>(null);
  const [checkBy, setCheck] = useState<{ t: string; v: ThesisCheck | null } | null>(null);
  const [alertsBy, setAlerts] = useState<{ t: string; v: Takeaway[] } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const synth = synthBy?.t === ticker ? synthBy.v : null;
  const thesis = thesisBy?.t === ticker ? thesisBy.v : null;
  const check = checkBy?.t === ticker ? checkBy.v : null;
  const alerts = alertsBy?.t === ticker ? alertsBy.v : null;

  useEffect(() => {
    let alive = true;
    const want = canonicalTicker(ticker);
    fetch("/api/synthesis-screen")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !Array.isArray(d?.rows)) return;
        setSynth({ t: ticker, v: (d.rows as SynthRow[]).find((x) => canonicalTicker(x.ticker) === want) ?? null });
      })
      .catch(() => {});
    fetch("/api/kv/position-theses")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        const t = (d?.theses ?? {})[ticker.toUpperCase()] ?? (d?.theses ?? {})[ticker] ?? null;
        setThesis({ t: ticker, v: t });
        if (t?.killConditions?.length) {
          fetch(`/api/thesis-check?ticker=${encodeURIComponent(ticker)}`)
            .then((r) => r.json())
            .then((c) => alive && c?.check && setCheck({ t: ticker, v: c.check }))
            .catch(() => {});
        }
      })
      .catch(() => {});
    fetch(`/api/street-takeaways?ticker=${encodeURIComponent(ticker)}`)
      .then((r) => r.json())
      .then((j) => alive && setAlerts({ t: ticker, v: Array.isArray(j?.entries) ? j.entries : [] }))
      .catch(() => alive && setAlerts({ t: ticker, v: [] }));
    return () => { alive = false; };
  }, [ticker]);

  const dayChange = useMemo(() => {
    if (!s || s.price == null || previousClose == null || previousClose <= 0) return null;
    return ((s.price - previousClose) / previousClose) * 100;
  }, [s, previousClose]);

  if (!s) return null;

  const res = synth?.entry?.result;
  const verdict = res?.verdict as string | undefined;
  const conditions = thesis?.killConditions ?? [];
  const trippedIds = new Set(conditions.filter((c) => c.trippedAt).map((c) => c.id));
  const currency = tickerCurrency(ticker);
  const stockHref = `/stock/${ticker.toLowerCase()}`;
  const lastScored = s.lastScored ? fmtDate(s.lastScored) : null;

  const synthesisBlock = (
    <Section
      title="Synthesis"
      meta={
        <span className="inline-flex items-center gap-2">
          <span className={`inline-flex h-[18px] items-center rounded px-1.5 text-[11px] font-medium ${verdictTone(verdict)}`}>
            {verdict ? VERDICT_LABEL[verdict as keyof typeof VERDICT_LABEL] ?? verdict : "Not generated"}
          </span>
          {synth?.entry?.generatedAt && <span>{fmtDate(synth.entry.generatedAt)}{synth.stale.length > 0 ? " · stale" : ""}</span>}
        </span>
      }
    >
      {res ? (
        <div className="text-[12.5px] leading-[1.5] text-ink-2">
          {res.verdictReason && <span className="font-medium text-ink">{res.verdictReason} </span>}
          {res.plain?.base}
        </div>
      ) : (
        <div className="text-[12.5px] text-ink-3">
          No synthesis yet · <Link href="/synthesis" className="text-accent-ink hover:text-accent">generate on Synthesis</Link>
        </div>
      )}
    </Section>
  );

  const killBlock = (
    <Section title="Kill conditions" meta={conditions.length ? `${conditions.length} · ${trippedIds.size ? `${trippedIds.size} tripped` : "none tripped"}` : undefined}>
      {conditions.length === 0 ? (
        <div className="text-[12.5px] text-ink-3">
          {thesis ? "No kill conditions on file" : "Not underwritten"} · <Link href={stockHref} className="text-accent-ink hover:text-accent">underwrite on the stock page</Link>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 text-[12.5px]">
          {conditions.map((c) => (
            <div key={c.id} className="flex items-baseline gap-2">
              <span className={`dot mt-1 ${trippedIds.has(c.id) ? "bg-neg" : "bg-pos"}`} />
              <span className="min-w-0 flex-1 text-ink-2">{c.theme ? <span className="font-medium text-ink">{c.theme} · </span> : null}{describeCondition(c)}</span>
              {trippedIds.has(c.id) && <span className="font-mono text-[11.5px] text-neg">tripped</span>}
            </div>
          ))}
          {check?.result?.breaksThesis && check.result.breaksThesis !== "no" && (
            <div className="mt-1 rounded-control bg-neg-soft px-2.5 py-1.5 text-[12px] leading-5 text-neg">
              {check.result.breaksThesis === "direct" ? "Breaks the thesis" : "Partly breaks the thesis"}
              {check.result.assessment ? ` — ${check.result.assessment}` : ""}
            </div>
          )}
        </div>
      )}
    </Section>
  );

  const groupsBlock = (
    <Section title="Score by group">
      <div className="grid grid-cols-[100px_minmax(0,1fr)_44px] items-center gap-x-2.5 gap-y-1.5 text-[12px]">
        {SCORE_GROUPS.map((g) => {
          const a = groupTotal(s, g);
          return (
            <React.Fragment key={g.name}>
              <span className="text-ink-2">{g.name === "Company Specific" ? "Company" : g.name}</span>
              <div className="h-1 overflow-hidden rounded-full bg-line-soft">
                <div className="h-full rounded-full bg-ink-2" style={{ width: `${Math.round((a / g.maxTotal) * 100)}%` }} />
              </div>
              <span className="text-right font-mono text-ink-3">{a}<span className="text-ink-faint">/{g.maxTotal}</span></span>
            </React.Fragment>
          );
        })}
      </div>
    </Section>
  );

  const streetBlock = (
    <Section title="Street" meta={alerts && alerts.length > 0 ? `FactSet · ${alerts.length} on file` : undefined}>
      {!alerts ? (
        <div className="text-[12.5px] text-ink-3">Loading…</div>
      ) : alerts.length === 0 ? (
        <div className="text-[12.5px] text-ink-3">No FactSet alerts ingested for this name</div>
      ) : (
        <div className="flex flex-col gap-1.5 text-[12.5px] text-ink-2">
          {alerts.slice(0, tab === "Alerts" ? 12 : 3).map((e) => (
            <div key={e.id} className="flex gap-2">
              <span className="w-[42px] shrink-0 font-mono text-[11.5px] text-ink-3">{fmtDate(e.date)}</span>
              <span className="min-w-0 leading-5">{e.headline || e.overview || e.keyPoints?.[0] || e.event || "—"}</span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );

  const textBlock = (
    <>
      {s.companySummary && (
        <Section title="What they do">
          <p className="text-[12.5px] leading-[1.5] text-ink-2">{s.companySummary}</p>
        </Section>
      )}
      {s.investmentThesis && (
        <Section title="Why own it">
          <p className="text-[12.5px] leading-[1.5] text-ink-2">{s.investmentThesis}</p>
        </Section>
      )}
    </>
  );

  const scoresTab = (
    <div className="flex flex-col gap-4">
      {SCORE_GROUPS.map((g) => (
        <div key={g.name}>
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-[12px] font-semibold text-ink">{g.name}</span>
            <span className="font-mono text-[12px] text-ink-3">{groupTotal(s, g)}<span className="text-ink-faint">/{g.maxTotal}</span></span>
          </div>
          <div className="flex flex-col gap-1 text-[12px]">
            {g.categories.map((c) => {
              const v = s.scores[c.key as ScoreKey];
              return (
                <div key={c.key} className="flex items-center justify-between gap-2">
                  <span className="text-ink-2">{c.label}</span>
                  <span className="font-mono text-ink">{v == null ? <span className="text-ink-faint">—</span> : v}<span className="text-ink-faint">/{c.max}</span></span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );

  const thesisTab = (
    <div className="flex flex-col gap-4">
      {thesis?.why ? (
        <Section title="Thesis as signed" meta={thesis.underwrittenAt ? `underwritten ${fmtDate(thesis.underwrittenAt)}` : fmtDate(thesis.updatedAt)}>
          <p className="text-[12.5px] leading-[1.5] text-ink-2">{thesis.why}</p>
        </Section>
      ) : (
        <div className="text-[12.5px] text-ink-3">Not underwritten · <Link href={stockHref} className="text-accent-ink hover:text-accent">write the thesis on the stock page</Link></div>
      )}
      {killBlock}
      {textBlock}
    </div>
  );

  return (
    <aside key={ticker} className="flex w-full shrink-0 flex-col rounded-card border border-line bg-surface lg:sticky lg:top-[60px] lg:w-[380px] lg:max-h-[calc(100vh-76px)]">
      <div className="flex h-11 items-center gap-2.5 border-b border-line-soft pl-4 pr-3">
        <span className="font-mono text-[15px] font-semibold text-ink">{displayTicker(ticker)}</span>
        <span className="min-w-0 truncate text-[12.5px] text-ink-2" title={s.name}>{s.name}</span>
        <Link href={stockHref} className="ml-auto inline-flex items-center gap-1.5 text-[12px] !text-accent-ink hover:!text-accent">
          <AppIcon name="open" size={13} strokeWidth={2} />Open
        </Link>
        <button onClick={onClose} aria-label="Close inspector" className="grid h-7 w-7 place-items-center rounded-control text-ink-3 hover:bg-surface-hover hover:text-ink">
          <AppIcon name="x" size={15} strokeWidth={2} />
        </button>
      </div>

      <div className="flex items-end gap-4 border-b border-line-soft px-4 pb-3 pt-3.5">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[22px] font-semibold tracking-tight text-ink">{s.price != null ? s.price.toFixed(2) : "—"}</span>
            {dayChange != null && (
              <span className={`font-mono text-[13px] ${dayChange >= 0 ? "text-pos" : "text-neg"}`}>{dayChange >= 0 ? "+" : ""}{dayChange.toFixed(1)}%</span>
            )}
            <span className="text-[11px] text-ink-3">{currency}</span>
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-ink-3">
            {s.bucket}{s.sector ? ` · ${s.sector}` : ""}{s.beta != null ? ` · β ${s.beta.toFixed(2)}` : ""}{weight != null ? ` · wt ${weight.toFixed(1)}%` : ""}
          </div>
        </div>
        <div className="ml-auto shrink-0 text-right">
          <div className="flex items-baseline justify-end gap-0.5">
            <span className="font-mono text-[22px] font-semibold text-ink">{Number(s.adjusted.toFixed(1))}</span>
            <span className="font-mono text-[12px] text-ink-3">/{MAX_SCORE}</span>
          </div>
          <div className="text-[11.5px] text-ink-3">{s.ratingLabel || s.rating}{lastScored ? ` · ${lastScored}` : ""}</div>
        </div>
      </div>

      <div className="flex gap-0.5 border-b border-line-soft px-3 py-2">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded px-2.5 py-1 text-[12px] transition-colors ${tab === t ? "bg-line-soft font-medium text-ink" : "text-ink-2 hover:text-ink"}`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 grow flex-col gap-4 overflow-y-auto px-4 py-3.5">
        {tab === "Overview" && (<>{synthesisBlock}{killBlock}{groupsBlock}{streetBlock}</>)}
        {tab === "Scores" && scoresTab}
        {tab === "Thesis" && thesisTab}
        {tab === "Alerts" && streetBlock}
      </div>

      <div className="flex items-center gap-2 border-t border-line-soft bg-surface-2 px-4 py-2.5">
        <Link href={`${stockHref}?action=rescore`} className="inline-flex h-7 items-center rounded-control bg-ink px-2.5 text-[12.5px] font-medium !text-white hover:bg-ink-2">Rescore</Link>
        <Link href={stockHref} className="inline-flex h-7 items-center rounded-control border border-line bg-surface px-2.5 text-[12.5px] !text-ink-2 hover:bg-surface-hover hover:!text-ink">Refresh data</Link>
        <div className="relative ml-auto">
          <button onClick={() => setMenuOpen((v) => !v)} aria-label="More actions" className="grid h-7 w-7 place-items-center rounded-control border border-line bg-surface text-ink-2 hover:bg-surface-hover hover:text-ink">
            <AppIcon name="more" size={14} strokeWidth={2} />
          </button>
          {menuOpen && (
            <div className="absolute bottom-9 right-0 z-30 w-52 rounded-card border border-line bg-surface p-1 shadow-[var(--shadow-pop)]">
              <button
                onClick={() => { moveBucket(ticker); setMenuOpen(false); }}
                className="block w-full rounded-[5px] px-2.5 py-1.5 text-left text-[12.5px] text-ink-2 hover:bg-surface-hover hover:text-ink"
              >
                Move to {s.bucket === "Portfolio" ? "watchlist" : "portfolio"}
              </button>
              <button
                onClick={() => { router.push(stockHref); setMenuOpen(false); }}
                className="block w-full rounded-[5px] px-2.5 py-1.5 text-left text-[12.5px] text-ink-2 hover:bg-surface-hover hover:text-ink"
              >
                Open full page
              </button>
              <button
                onClick={() => {
                  if (window.confirm(`Remove ${displayTicker(ticker)} from the ${s.bucket}? This deletes its scores and history from pm:stocks.`)) {
                    removeStock(ticker);
                    onClose();
                  }
                  setMenuOpen(false);
                }}
                className="block w-full rounded-[5px] px-2.5 py-1.5 text-left text-[12.5px] text-neg hover:bg-neg-soft"
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
