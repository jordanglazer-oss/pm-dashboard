"use client";

import React from "react";
import Link from "next/link";
import type { DailySummary } from "@/app/lib/daily-summary";
import { Card, CardHeader, Dial, DivergingBar, Pct, Pill, Spark, fmtPct, regimeTone, timeAgo } from "./summary-ui";

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
      <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Since last session</span>
      {chips.map((ch, i) => (
        <Pill key={i} tone={ch.tone} className="normal-case tracking-normal">
          {ch.label}
        </Pill>
      ))}
    </div>
  );
}

/* ── Alpha vs core ───────────────────────────────────────────────────── */

const PERIOD_LABELS = { "1d": "1D", "1w": "1W", "1m": "1M", "3m": "3M", ytd: "YTD" } as const;

export function AlphaCoreCard({ s }: { s: DailySummary }) {
  const p = s.performance?.alphaCore;
  if (!p || !p.available) {
    return (
      <Card>
        <CardHeader title="Alpha vs core" sub="sleeve spread" href="/aa-performance" />
        <p className="px-4 py-6 text-center text-[12px] text-ink-3">No alpha / core series yet.</p>
      </Card>
    );
  }
  const m1 = p.spread["1m"];
  const m3 = p.spread["3m"];
  const adding = m1 != null ? m1 > 0.1 : m3 != null ? m3 > 0.1 : null;
  const detracting = m1 != null ? m1 < -0.1 : m3 != null ? m3 < -0.1 : null;
  const verdict = adding ? "Alpha adding" : detracting ? "Alpha detracting" : "Alpha flat";
  const mom = p.momentum.direction;
  const tone = adding ? "pos" : detracting ? "neg" : "warn";
  return (
    <Card tone={tone}>
      <CardHeader
        title="Alpha vs core"
        sub={`equity sleeves · as of ${p.asOf ?? "—"}`}
        href="/aa-performance"
        right={mom && <Pill tone={mom === "improving" ? "pos" : mom === "fading" ? "neg" : "neutral"}>{mom}</Pill>}
      />
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className={`text-[15px] font-semibold ${tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : "text-warn"}`}>{verdict}</div>
            <div className="text-[11px] text-ink-3">
              1M spread <Pct v={m1} pp /> {p.momentum.prior != null && <>· was <Pct v={p.momentum.prior} pp className="text-ink-3" /> a week ago</>}
            </div>
          </div>
          <Spark points={p.spark.map((x) => x.value)} baseline={100} width={120} height={34} />
        </div>
        <table className="mt-3 w-full text-[12px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-ink-3">
              <th className="pb-1 text-left font-semibold"></th>
              {(Object.keys(PERIOD_LABELS) as (keyof typeof PERIOD_LABELS)[]).map((k) => (
                <th key={k} className="pb-1 text-right font-semibold">{PERIOD_LABELS[k]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(["alpha", "core", "spread"] as const).map((row) => (
              <tr key={row} className={`border-t border-line-soft ${row === "spread" ? "font-semibold" : ""}`}>
                <td className="py-1 text-ink-2 capitalize">{row === "spread" ? "Spread" : row}</td>
                {(Object.keys(PERIOD_LABELS) as (keyof typeof PERIOD_LABELS)[]).map((k) => (
                  <td key={k} className="py-1 text-right">
                    <Pct v={p[row][k]} pp={row === "spread"} deadband={row === "spread" ? 0.05 : 0} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {p.sinceRebalance.date && (
          <div className="mt-2 text-[11px] text-ink-3">
            Since rebalance {p.sinceRebalance.date}: alpha <Pct v={p.sinceRebalance.alpha} /> · core <Pct v={p.sinceRebalance.core} />
          </div>
        )}
      </div>
    </Card>
  );
}

/* ── Regime ──────────────────────────────────────────────────────────── */

export function RegimeCard({ s }: { s: DailySummary }) {
  const r = s.regime;
  const c = r?.composite;
  if (!r || !c) {
    return (
      <Card>
        <CardHeader title="Regime" sub="engine" />
        <p className="px-4 py-6 text-center text-[12px] text-ink-3">Regime engine hasn&apos;t computed yet.</p>
      </Card>
    );
  }
  const tone = regimeTone(c.label);
  const shed = c.signalsToShed;
  return (
    <Card tone={tone}>
      <CardHeader
        title="Regime"
        sub={`weighted vote · ${timeAgo(r.computedAt)}`}
        right={<Pill tone={tone}>{c.label}</Pill>}
      />
      <div className="flex items-start gap-3 px-4 pt-2 pb-2">
        <Dial value={c.score100 ?? null} label={c.label} size={136} />
        <div className="min-w-0 flex-1 space-y-1.5 pt-1 text-[11px] text-ink-2">
          {c.pending ? (
            <div className="rounded-control border border-warn-border bg-warn-soft px-2 py-1 text-warn">
              Data reads <b>{c.pending.label}</b> — flips after {c.pending.needed} sessions ({c.pending.days}/{c.pending.needed})
            </div>
          ) : (
            <div>
              Raw read agrees · {shed != null && isFinite(shed) ? `${shed} signal${shed === 1 ? "" : "s"} from a change` : "settled"}
            </div>
          )}
          <div className="font-mono text-ink-3">
            {c.score}↑ {c.signals.filter((x) => x.direction === "risk-off").length}↓ {c.signals.filter((x) => x.direction === "neutral").length}· / {c.total}
          </div>
          {r.transition && r.transition.leaning !== "stable" && (
            <div className="text-ink-2">
              Transition <b>{r.transition.likelihood.toLowerCase()}</b> {r.transition.leaning}
            </div>
          )}
        </div>
      </div>
      <div className="space-y-1.5 border-t border-line-soft px-4 py-2.5">
        {r.horizons.map((h) => (
          <div key={h.id} className="grid grid-cols-[88px_1fr_44px] items-center gap-2 text-[11px]">
            <span className="text-ink-2">{h.label.replace(/ \(.*\)/, "")} <span className="text-ink-faint">{h.shortLabel}</span></span>
            <DivergingBar v={h.score} />
            <span className={`text-right font-mono ${h.label_ === "Risk-On" ? "text-pos" : h.label_ === "Risk-Off" ? "text-neg" : "text-ink-3"}`}>{h.score == null ? "—" : (h.score >= 0 ? "+" : "") + h.score.toFixed(2)}</span>
          </div>
        ))}
      </div>
      {r.history.length > 2 && (
        <div className="flex items-center justify-between border-t border-line-soft px-4 py-2">
          <span className="text-[10.5px] text-ink-3">Dial, last {r.history.length} sessions</span>
          <Spark points={r.history.map((h) => h.score100 ?? 50)} baseline={50} width={150} height={28} />
        </div>
      )}
    </Card>
  );
}

/* ── Cash deployment ─────────────────────────────────────────────────── */

export function CashCard({ s }: { s: DailySummary }) {
  const c = s.brief?.cash;
  const call = c?.call;
  if (!call) {
    return (
      <Card>
        <CardHeader title="Cash deployment" sub="brief call" />
        <p className="px-4 py-6 text-center text-[12px] text-ink-3">No cash call in the current brief.</p>
      </Card>
    );
  }
  const tone = call.action === "DEPLOY" ? "pos" : call.action === "DEPLOY_PARTIAL" ? "warn" : "neutral";
  const score = Math.max(0, Math.min(100, call.score));
  const delta = c?.priorScore != null ? call.score - c.priorScore : null;
  return (
    <Card tone={tone === "neutral" ? undefined : tone}>
      <CardHeader title="Cash deployment" sub={call.window} right={<Pill tone={tone}>{call.action.replace("_", " ")}</Pill>} />
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-center gap-3">
          <div className="relative h-14 w-14 shrink-0">
            <svg viewBox="0 0 36 36" className="h-14 w-14 -rotate-90">
              <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="3.5" className="stroke-line-soft" />
              <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="3.5" strokeLinecap="round" className={tone === "pos" ? "stroke-pos" : tone === "warn" ? "stroke-warn" : "stroke-ink-3"} strokeDasharray={`${(score / 100) * 97.4} 97.4`} />
            </svg>
            <span className="absolute inset-0 flex items-center justify-center font-mono text-[15px] font-semibold text-ink">{call.score}</span>
          </div>
          <div className="min-w-0 text-[12px] leading-snug text-ink-2">
            {call.reason}
            {delta != null && delta !== 0 && (
              <span className={`ml-1 font-mono text-[11px] ${delta > 0 ? "text-pos" : "text-neg"}`}>({delta > 0 ? "+" : ""}{delta} vs prior)</span>
            )}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1">
          {call.triggersMet.map((t) => (
            <Pill key={`m-${t}`} tone="pos" className="normal-case tracking-normal">{t}</Pill>
          ))}
          {call.triggersMissing.map((t) => (
            <Pill key={`x-${t}`} tone="neutral" className="normal-case tracking-normal line-through decoration-ink-faint">{t}</Pill>
          ))}
        </div>
        {call.newtonPersistence && <div className="mt-2 text-[11px] text-ink-3">Newton: {call.newtonPersistence}</div>}
      </div>
    </Card>
  );
}

/* ── Hedging ─────────────────────────────────────────────────────────── */

export function HedgeCard({ s }: { s: DailySummary }) {
  const h = s.brief?.hedging;
  const call = h?.call;
  const tone = call?.action === "ADD" ? "neg" : call?.action === "HOLD" ? "accent" : "neutral";
  const bucket = h?.detail?.buckets.find((b) => /2-4/.test(b.bucket)) ?? h?.detail?.buckets[0];
  const anchor = h?.detail?.anchors.find((a) => a.daysToExpiry >= 60 && a.daysToExpiry <= 120) ?? h?.detail?.anchors[0];
  return (
    <Card tone={tone === "neutral" ? undefined : tone}>
      <CardHeader
        title="Hedging"
        sub={h?.refreshedAt ? `repriced ${timeAgo(h.refreshedAt)}` : h?.detail ? `priced ${timeAgo(h.detail.fetchedAt)}` : "brief call"}
        href="/hedging"
        right={call && <Pill tone={tone}>{call.action}</Pill>}
      />
      <div className="px-4 pt-3 pb-2 text-[12px]">
        {call ? (
          <>
            <div className="text-ink">
              {call.action !== "SKIP" && (call.strike || call.tenor) && (
                <span className="font-semibold">{[call.strike, call.tenor].filter(Boolean).join(" · ")} — </span>
              )}
              <span className="text-ink-2">{call.reason}</span>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
              <Stat label="5% OTM" value={anchor?.otm5PctOfSpot != null ? `${anchor.otm5PctOfSpot.toFixed(2)}%` : "—"} sub={anchor ? anchor.expiryLabel : "of spot"} />
              <Stat label="Premium %ile" value={bucket?.otm5Percentile != null ? `${Math.round(bucket.otm5Percentile)}th` : "—"} sub={h?.detail ? `${h.detail.sessions} sessions` : ""} tone={bucket?.otm5Percentile != null ? (bucket.otm5Percentile <= 30 ? "pos" : bucket.otm5Percentile >= 70 ? "neg" : undefined) : undefined} />
              <Stat label="VIX3M %ile" value={h?.detail?.volAnchor?.vix3m ? `${Math.round(h.detail.volAnchor.vix3m.percentile)}th` : "—"} sub={h?.detail?.volAnchor?.vix3m ? `${h.detail.volAnchor.vix3m.years}y history` : ""} />
            </div>
          </>
        ) : (
          <div className="text-ink-3">No hedging call in the current brief.</div>
        )}
      </div>
      <div className="border-t border-line-soft px-4 py-2.5 text-[11px]">
        {h && h.active.length > 0 ? (
          <ul className="space-y-1">
            {h.active.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-ink-2">{a.label}</span>
                <span className="shrink-0 font-mono text-ink-3">{a.daysToExpiry != null ? `${a.daysToExpiry}d` : ""}</span>
                <span className={`shrink-0 font-mono ${a.unrealizedUsd == null ? "text-ink-3" : a.unrealizedUsd >= 0 ? "text-pos" : "text-neg"}`}>
                  {a.unrealizedUsd == null ? "unmarked" : `${a.unrealizedUsd >= 0 ? "+" : "−"}$${Math.abs(a.unrealizedUsd).toLocaleString()}`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-ink-3">No protection on the books.</div>
        )}
        {h && (h.year.premiumPaidUsd > 0 || h.year.closedCount > 0) && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 text-ink-3">
            <span>YTD premium ${h.year.premiumPaidUsd.toLocaleString()}</span>
            <span>realized <b className={h.year.realizedUsd >= 0 ? "text-pos" : "text-neg"}>{h.year.realizedUsd >= 0 ? "+" : "−"}${Math.abs(h.year.realizedUsd).toLocaleString()}</b></span>
            {h.year.unrealizedUsd != null && <span>open <b className={h.year.unrealizedUsd >= 0 ? "text-pos" : "text-neg"}>{h.year.unrealizedUsd >= 0 ? "+" : "−"}${Math.abs(h.year.unrealizedUsd).toLocaleString()}</b></span>}
          </div>
        )}
      </div>
    </Card>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "pos" | "neg" }) {
  return (
    <div className="rounded-control border border-line-soft bg-surface-2 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-ink-3">{label}</div>
      <div className={`font-mono text-[13px] font-semibold ${tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : "text-ink"}`}>{value}</div>
      {sub && <div className="truncate text-[10px] text-ink-faint">{sub}</div>}
    </div>
  );
}

/* ── Bottom line (the AI's synthesis) ────────────────────────────────── */

export function BottomLineCard({ s }: { s: DailySummary }) {
  const b = s.brief;
  if (!b?.bottomLine) return null;
  const stale = s.changed && !s.changed.briefIsToday;
  return (
    <Card tone="accent">
      <div className="px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-bold tracking-tight text-ink">Bottom line</h3>
          <span className="text-xs text-ink-3">· brief {b.generatedAt ? timeAgo(b.generatedAt) : ""}</span>
          {stale && <Pill tone="warn">previous day</Pill>}
          {b.regime && <Pill tone={regimeTone(b.regime)} className="ml-auto">{b.regime}</Pill>}
        </div>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink">{b.bottomLine}</p>
        {b.whatChanged && <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2"><span className="font-semibold text-ink-3">Since last brief: </span>{b.whatChanged}</p>}
        {b.regimeVerdict && <p className="mt-1.5 font-mono text-[11px] text-ink-3">{b.regimeVerdict}</p>}
      </div>
    </Card>
  );
}

/* ── Benchmarks strip (used by the market zone) ──────────────────────── */

export function BenchmarkStrip({ s }: { s: DailySummary }) {
  const rows = s.performance?.benchmarks ?? [];
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px]">
      {rows.map((b) => (
        <span key={b.key} className="inline-flex items-baseline gap-1.5">
          <span className="text-ink-3">{b.label}</span>
          <Pct v={b.returns["1d"]} className="text-[12px] font-semibold" />
          <span className="text-ink-faint">1W <Pct v={b.returns["1w"]} /> · YTD <Pct v={b.returns.ytd} /></span>
        </span>
      ))}
      <Link href="/aa-performance" className="ml-auto text-accent hover:underline">All performance →</Link>
    </div>
  );
}

export { fmtPct };
