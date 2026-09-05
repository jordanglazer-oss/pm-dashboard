"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { isScoreable } from "@/app/lib/scoring";
import { displayTicker } from "@/app/lib/ticker";
import TickerLink from "@/app/components/TickerLink";
import { rankResearch, SUGGESTED_MIN_LISTS, type RankedRow } from "@/app/lib/research-ranked";
import type { ResearchState } from "@/app/lib/defaults";
import type { SuggestedRow } from "@/app/lib/suggested-watchlist";
import { VERDICT_LABEL, type SynthesisVerdict } from "@/app/lib/synthesis-screen-display";
import type { ThesisHealth } from "@/app/lib/thesis-health";

/**
 * Funnel — the one page that shows the idea pipeline as a PIPELINE:
 *
 *   Research (ranked lists) → Suggested (2+ lists) → Synthesis (AI base/bull/
 *   bear) → Watchlist → Portfolio → Underwritten (thesis + kill conditions)
 *   → monitored (thesis health, kill-condition sweep) → Review queue.
 *
 * Every number is read from the surface that owns it (same endpoints, no new
 * stores), so this page can never disagree with the stage it summarises. It
 * writes nothing.
 */

type SynthRow = {
  ticker: string;
  displayTicker?: string;
  name: string;
  bucket: "Portfolio" | "Watchlist" | "Suggested";
  entry: { generatedAt: string; result: { verdict: SynthesisVerdict; verdictReason?: string } } | null;
  stale: string[];
  decision?: { verdict: "advance" | "watch" | "pass"; expiresOn: string } | null;
};

type KillRow = { ticker: string; tripped: number; auto: number; underwrittenAt?: string; reUnderwriteBy?: string; checks: Array<{ status: string; reading: string; condition: { kind: string; theme?: string; note?: string } }> };
type Coverage = { portfolioCount: number; underwritten: number; missing: Array<{ ticker: string; name?: string; hasProse: boolean }> };
type Health = { counts: { broken: number; eroding: number; intact: number }; holdings: Array<ThesisHealth & { name?: string }> };

function StageCard({ title, count, sub, href, tone = "ink" }: { title: string; count: number | string; sub?: React.ReactNode; href: string; tone?: "ink" | "accent" | "pos" | "warn" | "neg" }) {
  const toneCls = { ink: "text-ink", accent: "text-accent", pos: "text-pos", warn: "text-warn", neg: "text-neg" }[tone];
  return (
    <Link href={href} className="group flex min-w-[150px] flex-1 flex-col rounded-card border border-line bg-white px-4 py-3 shadow-card transition-colors hover:border-accent-border">
      <span className="text-[10px] font-bold uppercase tracking-wide text-ink-3 group-hover:text-accent">{title}</span>
      <span className={`mt-1 font-mono text-2xl font-bold tabular-nums ${toneCls}`}>{count}</span>
      {sub && <span className="mt-0.5 text-[11px] leading-snug text-ink-2">{sub}</span>}
    </Link>
  );
}

const Arrow = () => <span className="hidden shrink-0 self-center text-ink-faint md:block">→</span>;

function Section({ title, sub, count, children }: { title: string; sub?: string; count: number; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-white shadow-card">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <div>
          <h2 className="text-[13px] font-bold text-ink">{title} <span className="ml-1 font-mono text-xs font-normal text-ink-3">{count}</span></h2>
          {sub && <p className="text-[11px] text-ink-3">{sub}</p>}
        </div>
      </div>
      <div className="divide-y divide-line-soft">{children}</div>
    </section>
  );
}

const Empty = ({ text }: { text: string }) => <p className="px-4 py-4 text-center text-xs text-ink-3">{text}</p>;

export default function FunnelPage() {
  const { stocks } = useStocks();
  const [research, setResearch] = useState<Partial<ResearchState> | null>(null);
  const [suggested, setSuggested] = useState<{ rows: SuggestedRow[]; passed: SuggestedRow[] } | null>(null);
  const [synth, setSynth] = useState<SynthRow[] | null>(null);
  const [kill, setKill] = useState<{ holdings: KillRow[]; coverage: Coverage } | null>(null);
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let alive = true;
    const get = (url: string) => fetch(url, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    get("/api/kv/research").then((j) => alive && setResearch((j?.research ?? {}) as Partial<ResearchState>));
    get("/api/suggested-watchlist").then((j) => alive && setSuggested({ rows: j?.rows ?? [], passed: j?.passed ?? [] }));
    get("/api/synthesis-screen").then((j) => alive && setSynth(Array.isArray(j?.rows) ? j.rows : []));
    get("/api/thesis-watch").then((j) => alive && setKill({ holdings: j?.holdings ?? [], coverage: j?.coverage ?? { portfolioCount: 0, underwritten: 0, missing: [] } }));
    get("/api/thesis-health").then((j) => alive && setHealth(j?.thesisHealth ?? null));
    return () => { alive = false; };
  }, []);

  const ranked: RankedRow[] = useMemo(() => (research ? rankResearch(research, stocks) : []), [research, stocks]);
  const portfolio = stocks.filter((s) => s.bucket === "Portfolio" && isScoreable(s));
  const watchlist = stocks.filter((s) => s.bucket === "Watchlist" && isScoreable(s));

  const suggestedRows = suggested?.rows ?? [];
  const synthByTicker = useMemo(() => new Map((synth ?? []).map((r) => [r.ticker.toUpperCase(), r])), [synth]);
  const suggestedSynth = (synth ?? []).filter((r) => r.bucket === "Suggested");
  const generatedSuggested = suggestedSynth.filter((r) => r.entry);
  const verdictCounts = generatedSuggested.reduce<Record<string, number>>((acc, r) => {
    const v = r.entry!.result.verdict;
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});

  // Action lists.
  const awaitingSynthesis = suggestedRows
    .filter((r) => !synthByTicker.get(r.ticker.toUpperCase())?.entry && r.decision?.verdict !== "watch")
    .slice(0, 12);
  const readyToAdvance = suggestedSynth.filter((r) => r.entry?.result.verdict === "advance" && !r.decision);
  const thesisMissing = kill?.coverage.missing ?? [];
  const review = useMemo(() => {
    const rows: Array<{ ticker: string; name?: string; reasons: string[]; tone: "neg" | "warn" }> = [];
    const byTicker = new Map<string, { name?: string; reasons: string[]; tone: "neg" | "warn" }>();
    const add = (t: string, reason: string, tone: "neg" | "warn", name?: string) => {
      const k = t.toUpperCase();
      const e = byTicker.get(k) ?? { name, reasons: [], tone };
      e.reasons.push(reason);
      if (tone === "neg") e.tone = "neg";
      if (name && !e.name) e.name = name;
      byTicker.set(k, e);
    };
    for (const h of health?.holdings ?? []) {
      if (h.verdict === "broken") add(h.ticker, `Thesis health: BROKEN — ${h.summary}`, "neg", h.name);
      else if (h.verdict === "eroding") add(h.ticker, `Thesis health: eroding — ${h.summary}`, "warn", h.name);
    }
    for (const k of kill?.holdings ?? []) {
      if (k.tripped > 0) {
        const tripped = k.checks.filter((c) => c.status === "tripped").map((c) => `${c.condition.theme ?? c.condition.kind}: ${c.reading}`);
        add(k.ticker, `${k.tripped} of ${k.auto} kill condition${k.auto === 1 ? "" : "s"} tripped — ${tripped.join("; ")}`, "neg");
      }
      if (k.reUnderwriteBy && k.reUnderwriteBy < new Date().toISOString().slice(0, 10)) add(k.ticker, `Re-underwrite overdue (due ${k.reUnderwriteBy})`, "warn");
    }
    for (const s of synth ?? []) {
      if (s.bucket === "Portfolio" && s.entry?.result.verdict === "exit-watch") add(s.ticker, `Synthesis: Exit watch — ${s.entry.result.verdictReason ?? ""}`, "neg", s.name);
      else if (s.bucket === "Portfolio" && s.entry?.result.verdict === "review") add(s.ticker, `Synthesis: Review — ${s.entry.result.verdictReason ?? ""}`, "warn", s.name);
    }
    for (const [ticker, e] of byTicker) rows.push({ ticker, ...e });
    rows.sort((a, b) => (a.tone === b.tone ? b.reasons.length - a.reasons.length : a.tone === "neg" ? -1 : 1));
    return rows;
  }, [health, kill, synth]);

  const underwritten = kill?.coverage.underwritten ?? 0;
  const portfolioCount = kill?.coverage.portfolioCount ?? portfolio.length;
  const loading = !research || !suggested || !synth || !kill;

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 md:px-6">
      <div className="mb-4">
        <h1 className="text-[15px] font-bold text-ink">Funnel</h1>
        <p className="text-xs text-ink-3">
          One path from research to a monitored position. Each count is read from the stage that owns it; click a stage to work it.
        </p>
      </div>

      {/* ── Stage strip ── */}
      <div className="flex flex-col gap-2 md:flex-row md:items-stretch">
        <StageCard title="Research" count={ranked.length} href="/research" sub={<>{ranked.filter((r) => r.currency === "CAD").length} CAD · {ranked.filter((r) => r.currency === "USD").length} USD · ranked by list count</>} />
        <Arrow />
        <StageCard title="Suggested" count={suggestedRows.length} href="/?bucket=Suggested" tone="accent" sub={<>{SUGGESTED_MIN_LISTS}+ lists · {suggestedRows.filter((r) => r.isNew).length} new · {suggested?.passed.length ?? 0} passed (30d)</>} />
        <Arrow />
        <StageCard title="Synthesis" count={`${generatedSuggested.length}/${suggestedSynth.length}`} href="/synthesis" sub={<>{verdictCounts.advance ?? 0} advance · {verdictCounts.watch ?? 0} watch · {verdictCounts.pass ?? 0} pass</>} />
        <Arrow />
        <StageCard title="Watchlist" count={watchlist.length} href="/?bucket=Watchlist" sub={<>{(synth ?? []).filter((r) => r.bucket === "Watchlist" && r.entry).length} with a synthesis</>} />
        <Arrow />
        <StageCard title="Portfolio" count={portfolio.length} href="/" sub="scoreable stocks (ETFs / funds excluded)" />
        <Arrow />
        <StageCard title="Underwritten" count={`${underwritten}/${portfolioCount}`} href="/thesis" tone={thesisMissing.length > 0 ? "warn" : "pos"} sub={thesisMissing.length > 0 ? <>{thesisMissing.length} owe a thesis</> : "every position monitored"} />
        <Arrow />
        <StageCard title="Review" count={review.length} href="#review" tone={review.some((r) => r.tone === "neg") ? "neg" : review.length > 0 ? "warn" : "pos"} sub={<>{health?.counts.broken ?? 0} broken · {health?.counts.eroding ?? 0} eroding · {(kill?.holdings ?? []).filter((k) => k.tripped > 0).length} tripped</>} />
      </div>

      {loading && <p className="mt-4 text-xs text-ink-3">Loading stages…</p>}

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {/* ── Review queue ── */}
        <div id="review" className="scroll-mt-24 lg:col-span-2">
          <Section title="Review queue" count={review.length} sub="Portfolio names whose thesis is under pressure — broken/eroding health, tripped kill conditions, an Exit-watch or Review synthesis, or an overdue re-underwrite. Leads to the Sell decision.">
            {review.length === 0 ? <Empty text="Nothing under review — every monitored thesis is intact." /> : review.map((r) => (
              <div key={r.ticker} className="flex flex-wrap items-start gap-3 px-4 py-2.5">
                <div className="w-28 shrink-0">
                  <div className="font-mono text-xs font-bold text-ink"><TickerLink ticker={r.ticker}>{displayTicker(r.ticker)}</TickerLink></div>
                  {r.name && <div className="truncate text-[10px] text-ink-3">{r.name}</div>}
                </div>
                <ul className="min-w-0 flex-1 space-y-0.5 text-xs text-ink-2">
                  {r.reasons.map((reason, i) => (
                    <li key={i} className={reason.includes("BROKEN") || reason.includes("tripped") || reason.includes("Exit watch") ? "text-neg" : ""}>{reason}</li>
                  ))}
                </ul>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Link href={`/stock/${encodeURIComponent(r.ticker)}#thesis-tile`} className="rounded-md border border-line bg-surface px-2 py-1 text-[10px] font-semibold !text-ink-2 hover:!text-ink">Thesis</Link>
                  <Link href={`/synthesis?ticker=${encodeURIComponent(r.ticker)}`} className="rounded-md border border-line bg-surface px-2 py-1 text-[10px] font-semibold !text-ink-2 hover:!text-ink">Synthesis</Link>
                  <Link href="/portfolio" className="rounded-md border border-neg-border bg-neg-soft px-2 py-1 text-[10px] font-semibold !text-neg hover:bg-neg hover:!text-white">Buy / Sell</Link>
                </div>
              </div>
            ))}
          </Section>
        </div>

        {/* ── Thesis required ── */}
        <Section title="Thesis required" count={thesisMissing.length} sub="Portfolio positions with no kill conditions on file — unmonitored until underwritten.">
          {thesisMissing.length === 0 ? <Empty text="Every Portfolio stock is underwritten." /> : thesisMissing.map((m) => (
            <div key={m.ticker} className="flex items-center gap-3 px-4 py-2">
              <span className="w-28 shrink-0 font-mono text-xs font-bold text-ink"><TickerLink ticker={m.ticker}>{displayTicker(m.ticker)}</TickerLink></span>
              <span className="min-w-0 flex-1 truncate text-xs text-ink-2">{m.name ?? ""}{m.hasProse ? " · written, no kill conditions" : " · no thesis"}</span>
              <Link href={`/stock/${encodeURIComponent(m.ticker)}#thesis-tile`} className="rounded-md border border-warn-border bg-warn-soft px-2 py-1 text-[10px] font-semibold !text-warn hover:bg-warn hover:!text-white">Underwrite →</Link>
            </div>
          ))}
        </Section>

        {/* ── Ready to advance ── */}
        <Section title="Ready to advance" count={readyToAdvance.length} sub="Suggested names whose synthesis says Advance and that you haven't acted on yet.">
          {readyToAdvance.length === 0 ? <Empty text="No Advance verdicts waiting." /> : readyToAdvance.map((r) => (
            <div key={r.ticker} className="flex items-center gap-3 px-4 py-2">
              <span className="w-28 shrink-0 font-mono text-xs font-bold text-ink"><TickerLink ticker={r.ticker}>{displayTicker(r.displayTicker ?? r.ticker)}</TickerLink></span>
              <span className="min-w-0 flex-1 truncate text-xs text-ink-2" title={r.entry?.result.verdictReason}>{r.entry?.result.verdictReason ?? r.name}</span>
              <Link href={`/synthesis?ticker=${encodeURIComponent(r.ticker)}`} className="rounded-md border border-pos-border bg-pos-soft px-2 py-1 text-[10px] font-semibold !text-pos hover:bg-pos hover:!text-white">Decide →</Link>
            </div>
          ))}
        </Section>

        {/* ── Awaiting synthesis ── */}
        <Section title="Awaiting synthesis" count={awaitingSynthesis.length} sub="Suggested names with no synthesis yet (Watch-decided names excluded), strongest confluence first.">
          {awaitingSynthesis.length === 0 ? <Empty text="Every Suggested name has a synthesis." /> : awaitingSynthesis.map((r) => (
            <div key={r.key} className="flex items-center gap-3 px-4 py-2">
              <span className="w-28 shrink-0 font-mono text-xs font-bold text-ink"><TickerLink ticker={r.ticker}>{displayTicker(r.ticker)}</TickerLink></span>
              <span className="min-w-0 flex-1 truncate text-xs text-ink-2">{r.name || ""} · {r.listCount} lists{r.improving.length > 0 ? " · ▲ improving" : ""}{r.coverageRequestedAt ? " · coverage requested" : ""}</span>
              <Link href={`/synthesis?ticker=${encodeURIComponent(r.ticker)}`} className="rounded-md border border-accent-border bg-accent-soft px-2 py-1 text-[10px] font-semibold !text-accent hover:bg-accent hover:!text-white">Generate →</Link>
            </div>
          ))}
        </Section>

        {/* ── Watched (quiet) ── */}
        <Section title="Watching (30-day quiet)" count={suggestedRows.filter((r) => r.decision?.verdict === "watch").length} sub="Suggested names you marked Watch — kept on the list, not nagged for a fresh synthesis until the memory expires.">
          {suggestedRows.filter((r) => r.decision?.verdict === "watch").length === 0 ? <Empty text="None." /> : suggestedRows.filter((r) => r.decision?.verdict === "watch").map((r) => (
            <div key={r.key} className="flex items-center gap-3 px-4 py-2">
              <span className="w-28 shrink-0 font-mono text-xs font-bold text-ink"><TickerLink ticker={r.ticker}>{displayTicker(r.ticker)}</TickerLink></span>
              <span className="min-w-0 flex-1 truncate text-xs text-ink-2">{r.name || ""} · {r.listCount} lists{r.improving.length > 0 ? " · ▲ improving" : ""}</span>
              <span className="text-[10px] text-ink-3">until {r.decision?.expiresOn}</span>
              {(() => { const s = synthByTicker.get(r.ticker.toUpperCase()); return s?.entry ? <span className="text-[10px] font-semibold text-ink-3">{VERDICT_LABEL[s.entry.result.verdict]}</span> : null; })()}
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}
