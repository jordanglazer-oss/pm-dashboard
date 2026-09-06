"use client";

import React from "react";
import Link from "next/link";
import type { DailySummary } from "@/app/lib/daily-summary";
import { Card, Dial, DivergingBar, Metric, Pct, Pill, Spark, fmtPct, regimeTone, timeAgo } from "./summary-ui";

/**
 * The decision band — the four reads that answer the daily questions, sized to
 * sit above the fold together. Everything here is scannable in one pass; the
 * supporting detail lives behind the rails below.
 */

/* ── What changed since the last session ─────────────────────────────── */

export function ChangedStrip({ s }: { s: DailySummary }) {
  const c = s.changed;
  if (!c) return null;
  const chips: { label: string; tone: "pos" | "neg" | "warn" | "accent" | "neutral" }[] = [];
  if (c.regime.changed) chips.push({ label: `Regime ${c.regime.prev} → ${c.regime.now}`, tone: regimeTone(c.regime.now) });
  else if (c.regime.pending) chips.push({ label: `Regime leaning ${c.regime.pending.label} · ${c.regime.pending.days}/${c.regime.pending.needed} sessions`, tone: "warn" });
  if (c.hedging.changed) chips.push({ label: `Hedge call ${c.hedging.prev} → ${c.hedging.now}`, tone: c.hedging.now === "ADD" ? "neg" : "accent" });
  if (c.cash.changed) chips.push({ label: `Cash ${c.cash.prev} → ${c.cash.now}`, tone: c.cash.now === "DEPLOY" ? "pos" : "warn" });
  else if (c.cash.prevScore != null && c.cash.nowScore != null && c.cash.prevScore !== c.cash.nowScore)
    chips.push({ label: `Cash score ${c.cash.prevScore} → ${c.cash.nowScore}`, tone: c.cash.nowScore > c.cash.prevScore ? "pos" : "neutral" });
  if (c.alphaSpread1d != null) chips.push({ label: `Alpha vs core 1d ${c.alphaSpread1d > 0 ? "+" : ""}${c.alphaSpread1d.toFixed(2)}pp`, tone: c.alphaSpread1d >= 0 ? "pos" : "neg" });
  if (c.newTrips > 0) chips.push({ label: `${c.newTrips} kill condition${c.newTrips === 1 ? "" : "s"} tripped`, tone: "neg" });
  if (c.newlyReady.length > 0) chips.push({ label: `Entry ready: ${c.newlyReady.join(", ")}`, tone: "pos" });
  if (!c.briefIsToday) chips.push({ label: "Brief is from a previous day", tone: "warn" });
  if (chips.length === 0) chips.push({ label: "Nothing structural changed since the last session", tone: "neutral" });
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3">Since last session</span>
      {chips.map((ch, i) => (
        <Pill key={i} tone={ch.tone} className="normal-case tracking-normal">
          {ch.label}
        </Pill>
      ))}
    </div>
  );
}

/* ── Alpha vs core ───────────────────────────────────────────────────── */

const PERIODS = [
  ["1d", "1D"],
  ["1w", "1W"],
  ["1m", "1M"],
  ["3m", "3M"],
  ["ytd", "YTD"],
] as const;

export function AlphaCoreCard({ s }: { s: DailySummary }) {
  const p = s.performance?.alphaCore;
  if (!p || !p.available) {
    return (
      <Card>
        <TileHead title="Alpha vs core" sub="sleeve spread" href="/aa-performance" />
        <p className="px-4 py-7 text-center text-[12px] text-ink-3">No alpha / core series yet.</p>
      </Card>
    );
  }
  const m1 = p.spread["1m"];
  const m3 = p.spread["3m"];
  const adding = m1 != null ? m1 > 0.1 : m3 != null ? m3 > 0.1 : null;
  const detracting = m1 != null ? m1 < -0.1 : m3 != null ? m3 < -0.1 : null;
  const tone = adding ? "pos" : detracting ? "neg" : "warn";
  const mom = p.momentum.direction;
  return (
    <Card tone={tone}>
      <TileHead
        title="Alpha vs core"
        sub={p.asOf ?? undefined}
        href="/aa-performance"
        right={mom ? <Pill tone={mom === "improving" ? "pos" : mom === "fading" ? "neg" : "neutral"}>{mom}</Pill> : undefined}
      />
      <div className="flex items-end gap-2 px-4 pt-2">
        <div className="min-w-0">
          <div className={`text-[15px] font-semibold ${tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : "text-warn"}`}>
            {adding ? "Alpha adding" : detracting ? "Alpha detracting" : "Alpha flat"}
          </div>
          <div className="font-mono text-[11px] text-ink-2">
            1M spread <Pct v={m1} pp className="font-semibold" />
          </div>
          {p.momentum.prior != null && (
            <div className="font-mono text-[11px] text-ink-3">was {p.momentum.prior > 0 ? "+" : ""}{p.momentum.prior.toFixed(2)}pp a week ago</div>
          )}
        </div>
        <Spark points={p.spark.map((x) => x.value)} baseline={100} width={104} height={34} className="ml-auto shrink-0" />
      </div>
      <div className="mt-2 grid grid-cols-5 gap-1 border-t border-line-soft px-4 pt-1.5 pb-2.5">
        {PERIODS.map(([k, label]) => (
          <div key={k}>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">{label}</div>
            <Pct v={p.spread[k]} pp digits={2} deadband={0.05} className="text-[11px]" />
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ── Regime ──────────────────────────────────────────────────────────── */

export function RegimeCard({ s, onOpenDetail, detailOpen }: { s: DailySummary; onOpenDetail: () => void; detailOpen: boolean }) {
  const r = s.regime;
  const c = r?.composite;
  if (!r || !c) {
    return (
      <Card>
        <TileHead title="Regime" sub="engine" />
        <p className="px-4 py-7 text-center text-[12px] text-ink-3">Regime engine hasn&apos;t computed yet.</p>
      </Card>
    );
  }
  const tone = regimeTone(c.label);
  const lead = r.horizons.filter((h) => h.score != null).sort((a, b) => Math.abs(b.score as number) - Math.abs(a.score as number))[0];
  return (
    <Card tone={tone}>
      <TileHead
        title="Regime"
        sub={r.computedAt ? timeAgo(r.computedAt) : "weighted vote"}
        right={<Pill tone={tone}>{c.label}</Pill>}
      />
      <button type="button" onClick={onOpenDetail} className="flex w-full items-start gap-2 px-4 pt-1 pb-2 text-left transition-colors hover:bg-surface-hover">
        <Dial value={c.score100 ?? null} label={c.label} size={116} />
        <div className="min-w-0 flex-1 space-y-0.5 pt-2 text-[11px] leading-snug text-ink-2">
          {c.pending ? (
            <div className="text-warn">
              Data reads <b>{c.pending.label}</b> — {c.pending.days}/{c.pending.needed} sessions
            </div>
          ) : r.flip && r.flip.count > 0 ? (
            <div className={r.flip.target === "Risk-On" ? "font-semibold text-pos" : r.flip.target === "Risk-Off" ? "font-semibold text-neg" : "font-semibold text-warn"}>
              {r.flip.count} signal{r.flip.count === 1 ? "" : "s"} from {r.flip.target}
            </div>
          ) : (
            <div>Settled</div>
          )}
          {lead && (
            <div className="truncate">
              {lead.label.replace(/ \(.*\)/, "")} carrying it{" "}
              <span className="font-mono">{lead.score! >= 0 ? "+" : ""}{lead.score!.toFixed(2)}</span>
            </div>
          )}
          <div className="font-mono text-[10.5px] text-ink-3">
            {c.score}↑ {c.signals.filter((x) => x.direction === "risk-off").length}↓{" "}
            {c.signals.filter((x) => x.direction === "neutral").length}· / {c.total}
          </div>
          <div className="pt-0.5 text-[11px] font-semibold text-accent">
            {detailOpen ? "Hide contributions ↑" : `See all ${c.total} contributions →`}
          </div>
        </div>
      </button>
      <div className="space-y-1 border-t border-line-soft px-4 py-2">
        {r.horizons.map((h) => (
          <div key={h.id} className="grid grid-cols-[74px_minmax(0,1fr)_38px] items-center gap-2 text-[10.5px]">
            <span className="truncate text-ink-2">{h.label.replace(/ \(.*\)/, "")}</span>
            <DivergingBar v={h.score} />
            <span className={`text-right font-mono ${h.label_ === "Risk-On" ? "text-pos" : h.label_ === "Risk-Off" ? "text-neg" : "text-ink-3"}`}>
              {h.score == null ? "—" : `${h.score >= 0 ? "+" : ""}${h.score.toFixed(2)}`}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ── Cash ────────────────────────────────────────────────────────────── */

export function CashCard({ s }: { s: DailySummary }) {
  const cash = s.brief?.cash;
  const call = cash?.call;
  if (!call) {
    return (
      <Card>
        <TileHead title="Cash" sub="brief call" />
        <p className="px-4 py-7 text-center text-[12px] text-ink-3">No cash call in the current brief.</p>
      </Card>
    );
  }
  const tone = call.action === "DEPLOY" ? "pos" : call.action === "DEPLOY_PARTIAL" ? "warn" : undefined;
  const score = Math.max(0, Math.min(100, call.score));
  const delta = cash?.priorScore != null ? call.score - cash.priorScore : null;
  return (
    <Card tone={tone}>
      <TileHead title="Cash" sub={call.window} right={<Pill tone={tone ?? "neutral"}>{call.action.replace("_", " ")}</Pill>} />
      <div className="flex items-start gap-2.5 px-4 pt-2">
        <div className="relative h-[54px] w-[54px] shrink-0">
          <svg viewBox="0 0 36 36" className="h-[54px] w-[54px] -rotate-90">
            <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="3.5" className="stroke-line-soft" />
            <circle
              cx="18"
              cy="18"
              r="15.5"
              fill="none"
              strokeWidth="3.5"
              strokeLinecap="round"
              className={tone === "pos" ? "stroke-pos" : tone === "warn" ? "stroke-warn" : "stroke-ink-3"}
              strokeDasharray={`${(score / 100) * 97.4} 97.4`}
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center font-mono text-[15px] font-semibold">{call.score}</span>
        </div>
        <div className="min-w-0 text-[11.5px] leading-snug text-ink-2">
          <span className="line-clamp-3">{call.reason}</span>
          {delta != null && delta !== 0 && (
            <span className={`ml-1 font-mono text-[11px] ${delta > 0 ? "text-pos" : "text-neg"}`}>({delta > 0 ? "+" : ""}{delta} vs prior)</span>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1 border-t border-line-soft px-4 pt-2 pb-2.5">
        {call.triggersMet.slice(0, 3).map((t) => (
          <Pill key={`m-${t}`} tone="pos" className="normal-case tracking-normal">{t}</Pill>
        ))}
        {call.triggersMissing.slice(0, 2).map((t) => (
          <Pill key={`x-${t}`} tone="neutral" className="normal-case tracking-normal line-through decoration-ink-faint">{t}</Pill>
        ))}
      </div>
    </Card>
  );
}

/* ── Hedging ─────────────────────────────────────────────────────────── */

export function HedgeCard({ s }: { s: DailySummary }) {
  const h = s.brief?.hedging;
  const call = h?.call;
  const tone = call?.action === "ADD" ? "neg" : call?.action === "HOLD" ? "accent" : undefined;
  const bucket = h?.detail?.buckets.find((b) => /2-4/.test(b.bucket)) ?? h?.detail?.buckets[0];
  const anchor = h?.detail?.anchors.find((a) => a.daysToExpiry >= 60 && a.daysToExpiry <= 120) ?? h?.detail?.anchors[0];
  return (
    <Card tone={tone}>
      <TileHead
        title="Hedging"
        sub={h?.refreshedAt ? `repriced ${timeAgo(h.refreshedAt)}` : h?.detail ? timeAgo(h.detail.fetchedAt) : "brief call"}
        href="/hedging"
        right={call ? <Pill tone={tone ?? "neutral"}>{call.action}</Pill> : undefined}
      />
      <div className="px-4 pt-2 text-[11.5px] leading-snug text-ink-2">
        {call ? (
          <>
            {call.action !== "SKIP" && (call.strike || call.tenor) && (
              <b className="text-ink">{[call.strike, call.tenor].filter(Boolean).join(" · ")} — </b>
            )}
            <span className="line-clamp-2">{call.reason}</span>
          </>
        ) : (
          <span className="text-ink-3">No hedging call in the current brief.</span>
        )}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5 px-4">
        <Metric label="5% OTM" value={anchor?.otm5PctOfSpot != null ? `${anchor.otm5PctOfSpot.toFixed(2)}%` : "—"} sub={anchor?.expiryLabel} />
        <Metric
          label="Prem %ile"
          value={bucket?.otm5Percentile != null ? `${Math.round(bucket.otm5Percentile)}th` : "—"}
          sub={h?.detail ? `${h.detail.sessions} sessions` : undefined}
          tone={bucket?.otm5Percentile != null ? (bucket.otm5Percentile <= 30 ? "pos" : bucket.otm5Percentile >= 70 ? "neg" : undefined) : undefined}
        />
        <Metric
          label="VIX3M %ile"
          value={h?.detail?.volAnchor?.vix3m ? `${Math.round(h.detail.volAnchor.vix3m.percentile)}th` : "—"}
          sub={h?.detail?.volAnchor?.vix3m ? `${h.detail.volAnchor.vix3m.years}y` : undefined}
        />
      </div>
      <div className="mt-2 border-t border-line-soft px-4 py-2 text-[11px]">
        {h && h.active.length > 0 ? (
          <ul className="space-y-0.5">
            {h.active.slice(0, 2).map((a) => (
              <li key={a.id} className="flex items-center gap-2">
                <span className="min-w-0 truncate text-ink-2">{a.label}</span>
                {a.daysToExpiry != null && <span className="shrink-0 font-mono text-ink-3">{a.daysToExpiry}d</span>}
                <span className={`ml-auto shrink-0 font-mono ${a.unrealizedUsd == null ? "text-ink-3" : a.unrealizedUsd >= 0 ? "text-pos" : "text-neg"}`}>
                  {a.unrealizedUsd == null ? "unmarked" : `${a.unrealizedUsd >= 0 ? "+" : "−"}$${Math.abs(a.unrealizedUsd).toLocaleString()}`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-ink-3">No protection on the books.</span>
        )}
      </div>
    </Card>
  );
}

/* ── shared tile header ──────────────────────────────────────────────── */

function TileHead({ title, sub, right, href }: { title: string; sub?: string; right?: React.ReactNode; href?: string }) {
  return (
    <header className="flex items-baseline gap-1.5 px-4 pt-2.5 pb-1">
      {href ? (
        <Link href={href} className="text-[13px] font-bold tracking-tight text-ink hover:text-accent">{title}</Link>
      ) : (
        <h3 className="text-[13px] font-bold tracking-tight text-ink">{title}</h3>
      )}
      {sub && <span className="min-w-0 truncate text-[11px] text-ink-3">· {sub}</span>}
      {right && <span className="ml-auto shrink-0">{right}</span>}
    </header>
  );
}

/* ── Bottom line ─────────────────────────────────────────────────────── */

export function BottomLineCard({ s }: { s: DailySummary }) {
  const b = s.brief;
  if (!b?.bottomLine) return null;
  const stale = s.changed && !s.changed.briefIsToday;
  return (
    <Card tone="accent">
      <div className="px-4 py-2.5">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-[13px] font-bold tracking-tight text-ink">Bottom line</h3>
          <span className="text-[11px] text-ink-3">· brief {b.generatedAt ? timeAgo(b.generatedAt) : ""}</span>
          {stale && <Pill tone="warn">previous day</Pill>}
          {b.regime && <Pill tone={regimeTone(b.regime)} className="ml-auto">{b.regime}</Pill>}
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-ink">{b.bottomLine}</p>
        {b.whatChanged && (
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-2">
            <span className="font-semibold text-ink-3">Since last brief: </span>
            {b.whatChanged}
          </p>
        )}
      </div>
    </Card>
  );
}

/* ── Benchmarks ──────────────────────────────────────────────────────── */

export function BenchmarkStrip({ s }: { s: DailySummary }) {
  const rows = s.performance?.benchmarks ?? [];
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px]">
      {rows.map((b) => (
        <span key={b.key} className="inline-flex items-baseline gap-1.5">
          <span className="text-ink-3">{b.label}</span>
          <Pct v={b.returns["1d"]} className="text-[12px] font-semibold" />
          <span className="text-ink-faint">
            1W <Pct v={b.returns["1w"]} /> · YTD <Pct v={b.returns.ytd} />
          </span>
        </span>
      ))}
      <Link href="/aa-performance" className="ml-auto text-accent hover:underline">
        All performance →
      </Link>
    </div>
  );
}

export { fmtPct };
