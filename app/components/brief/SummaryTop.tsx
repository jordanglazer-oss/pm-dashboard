"use client";

import React, { useContext } from "react";
import Link from "next/link";
import type { DailySummary } from "@/app/lib/daily-summary";
import { useStocks } from "@/app/lib/StockContext";
import { Pct, RegimeTrack, Spark, Status, TileLink, fmtPct, ordinal, regimeTone, timeAgo, toneText, useRevealFold } from "./summary-ui";
import { HedgeLedgerContext, type HedgePos } from "./hedge-ledger";

/**
 * The decision panel — ONE hairline card: the four reads (Regime · Cash ·
 * Hedging · Alpha vs core) as a 4-cell grid, and the Bottom line with the
 * "since last brief" digest beneath. Everything here is scannable in one
 * pass; the supporting detail is one click away (regime detail, narrative
 * rows, the Hedging page).
 */

/* ── helpers ─────────────────────────────────────────────────────────── */

function actionWord(a: string | null | undefined): string {
  if (!a) return "—";
  const s = a.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Consecutive trailing sessions whose committed label equals the current one. */
function settledSessions(history: { label: string }[], label: string | null | undefined): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].label === label) n++;
    else break;
  }
  return n;
}

function Cell({ label, href, children, last = false }: { label: string; href?: string; children: React.ReactNode; last?: boolean }) {
  return (
    // Hairlines between cells at every breakpoint: stacked (1-col) → a rule
    // under each; 2-col at md → rules under the top pair and right of the odd
    // cells; 4-col at xl → rules to the right only.
    <div className={`min-w-0 border-line-soft px-4 py-3 ${last ? "" : "border-b"} md:[&:nth-child(n+3)]:border-b-0 md:odd:border-r xl:border-b-0 xl:border-r xl:last:border-r-0`}>
      {href ? (
        <Link href={href} className="text-[11px] text-ink-3 hover:text-accent">
          {label}
        </Link>
      ) : (
        <div className="text-[11px] text-ink-3">{label}</div>
      )}
      {children}
    </div>
  );
}

/* ── Regime ──────────────────────────────────────────────────────────── */

function RegimeCell({ s, detailOpen, onToggleDetail }: { s: DailySummary; detailOpen: boolean; onToggleDetail: () => void }) {
  const { marketData, updateMarketData } = useStocks();
  const r = s.regime;
  const c = r?.composite;
  const posture = marketData.riskRegime;
  const engine = c?.label ?? null;
  if (!r || !c) {
    return (
      <Cell label="Regime">
        <div className="mt-1 text-[12px] text-ink-3">Regime engine hasn&apos;t computed yet.</div>
      </Cell>
    );
  }
  const tone = regimeTone(c.label);
  const settled = settledSessions(r.history, c.label);
  return (
    <Cell label="Regime">
      <div className="mb-2 mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-[20px] font-semibold leading-none text-ink">{c.score100 ?? "—"}</span>
        <span className={`text-[13px] font-medium ${toneText(tone)}`}>{c.label}</span>
        {c.pending ? (
          <span className="text-[11px] text-warn" title="The raw read has moved; the label follows after three consecutive sessions">
            reads {c.pending.label} · {c.pending.days}/{c.pending.needed} sessions
          </span>
        ) : (
          <span className="text-[11px] text-ink-3" title={r.flip && r.flip.count > 0 ? `${r.flip.count} signal${r.flip.count === 1 ? "" : "s"} from ${r.flip.target}` : undefined}>
            settled {settled} session{settled === 1 ? "" : "s"}
            {r.flip && r.flip.count > 0 && ` · ${r.flip.count} from ${r.flip.target}`}
          </span>
        )}
      </div>
      <RegimeTrack value={c.score100 ?? null} />
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
        {posture && (
          <span className="inline-flex items-center gap-1.5 text-ink-2">
            <span className="text-ink-3">Scoring posture</span>
            <Status tone={regimeTone(posture)}>{posture}</Status>
            {engine && engine !== posture ? (
              <button
                type="button"
                onClick={() => updateMarketData({ riskRegime: engine })}
                className="text-accent hover:text-accent-ink"
                title={`Set the scoring posture to ${engine} to match the regime engine. This changes the multipliers applied to every stock score.`}
              >
                Engine suggests {engine} — Apply
              </button>
            ) : (
              engine && <span className="text-ink-3">in sync</span>
            )}
          </span>
        )}
        <TileLink onClick={onToggleDetail} className="ml-auto">
          {detailOpen ? "Hide detail" : `Open detail · ${c.total} signals`}
        </TileLink>
      </div>
    </Cell>
  );
}

/* ── Cash ────────────────────────────────────────────────────────────── */

function CashCell({ s }: { s: DailySummary }) {
  const reveal = useRevealFold();
  const cash = s.brief?.cash;
  const call = cash?.call;
  if (!call) {
    return (
      <Cell label="Cash">
        <div className="mt-1 text-[12px] text-ink-3">No cash call in the current brief.</div>
      </Cell>
    );
  }
  const met = call.triggersMet ?? [];
  const missing = call.triggersMissing ?? [];
  const total = met.length + missing.length;
  const delta = cash?.priorScore != null ? call.score - cash.priorScore : null;
  return (
    <Cell label="Cash">
      <div className="mb-1 mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[16px] font-semibold leading-tight text-ink">{actionWord(call.action)}</span>
        <span className="font-mono text-[12px] text-ink-3" title={[met.length ? `Met: ${met.join(" · ")}` : null, missing.length ? `Missing: ${missing.join(" · ")}` : null].filter(Boolean).join("\n")}>
          {total > 0 ? `${met.length} of ${total} triggers` : call.window}
          {typeof call.score === "number" && ` · score ${call.score}`}
          {delta != null && delta !== 0 && <span className={delta > 0 ? "text-pos" : "text-neg"}> ({delta > 0 ? "+" : ""}{delta})</span>}
        </span>
      </div>
      <div className="line-clamp-2 text-[12px] leading-[1.45] text-ink-2" title={call.reason}>
        {call.reason}
      </div>
      {total > 0 && (
        <div className="mt-1 truncate text-[11px] text-ink-3" title={`Met: ${met.join(" · ") || "—"}\nMissing: ${missing.join(" · ") || "—"}`}>
          {met.length > 0 && <span className="text-ink-2">met {met.join(" · ")}</span>}
          {met.length > 0 && missing.length > 0 && " · "}
          {missing.length > 0 && <>missing {missing.join(" · ")}</>}
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-3 text-[11.5px]">
        <span className="text-ink-3">{call.window}</span>
        <TileLink onClick={() => reveal("briefNarrativeCash")} className="ml-auto">How the score was built</TileLink>
      </div>
    </Cell>
  );
}

/* ── Hedging ─────────────────────────────────────────────────────────── */

function HedgeCell({ s }: { s: DailySummary }) {
  const reveal = useRevealFold();
  const ledger = useContext(HedgeLedgerContext);
  const h = s.brief?.hedging;
  const call = h?.call;
  const bucket = h?.detail?.buckets.find((b) => /2-4/.test(b.bucket)) ?? h?.detail?.buckets[0];
  const anchor = h?.detail?.anchors.find((a) => a.daysToExpiry >= 60 && a.daysToExpiry <= 120) ?? h?.detail?.anchors[0];
  const active = h?.active ?? [];
  const first = active[0];
  return (
    <Cell label="Hedging" href="/hedging">
      <div className="mb-1 mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[16px] font-semibold leading-tight text-ink">{call ? actionWord(call.action) : "—"}</span>
        <span className="font-mono text-[12px] text-ink-3">
          {active.length > 0 ? `${active.length} active${first ? ` · ${first.label}` : ""}` : "unhedged"}
        </span>
      </div>
      <div className="text-[12px] leading-[1.45] text-ink-2">
        {bucket?.otm5Percentile != null ? (
          <>Premium <span className={bucket.otm5Percentile <= 30 ? "text-pos" : bucket.otm5Percentile >= 70 ? "text-neg" : ""}>{ordinal(bucket.otm5Percentile)}</span> pctile of ledger{h?.detail ? ` (${h.detail.sessions} sessions)` : ""}</>
        ) : (
          <>Premium unranked</>
        )}
        {h?.detail?.volAnchor?.vix3m && <>; VIX3M {ordinal(h.detail.volAnchor.vix3m.percentile)} pctile of {h.detail.volAnchor.vix3m.years}y</>}
        {anchor?.otm5PctOfSpot != null && <>; 5% OTM <span className="font-mono">{anchor.otm5PctOfSpot.toFixed(2)}%</span>{anchor.expiryLabel ? ` ${anchor.expiryLabel}` : ""}</>}
        .
      </div>
      {call ? (
        <div className="mt-0.5 line-clamp-1 text-[11.5px] text-ink-3" title={call.reason}>
          {call.action !== "SKIP" && (call.strike || call.tenor) && <span className="text-ink-2">{[call.strike, call.tenor].filter(Boolean).join(" · ")} — </span>}
          {call.reason}
        </div>
      ) : (
        <div className="mt-0.5 text-[11.5px] text-ink-3">No hedging call in the current brief.</div>
      )}
      {active.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-[11.5px]">
          {active.slice(0, 2).map((a) => (
            <li key={a.id} className="flex items-center gap-2">
              <span className="min-w-0 truncate text-ink-2">{a.label}</span>
              {a.daysToExpiry != null && <span className={`shrink-0 font-mono ${a.daysToExpiry <= 14 ? "text-neg" : "text-ink-3"}`}>{a.daysToExpiry}d</span>}
              <span className={`ml-auto shrink-0 font-mono ${a.unrealizedUsd == null ? "text-ink-3" : a.unrealizedUsd >= 0 ? "text-pos" : "text-neg"}`}>
                {a.unrealizedUsd == null ? "unmarked" : `${a.unrealizedUsd >= 0 ? "+" : "−"}$${Math.abs(a.unrealizedUsd).toLocaleString()}`}
              </span>
              {ledger && (
                <button type="button" onClick={() => ledger.close(a.id)} className="shrink-0 text-[11px] text-ink-3 hover:text-neg" title="Mark this hedge closed">
                  close
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11.5px]">
        {ledger && (
          <button type="button" onClick={ledger.showForm ? ledger.cancelForm : ledger.openForm} className="text-accent hover:text-accent-ink">
            {ledger.showForm ? "Cancel" : active.length > 0 ? "Log another" : "Log a hedge"}
          </button>
        )}
        {h?.refreshedAt && <span className="text-ink-3">repriced {timeAgo(h.refreshedAt)}</span>}
        <TileLink onClick={() => reveal("briefNarrativeHedgeBasis")} className="ml-auto">Premium basis</TileLink>
      </div>
    </Cell>
  );
}

/** The log-a-hedge form, rendered as a full-width row under the four cells
 *  while open. Inline form — deliberately transient. */
function HedgeLogForm() {
  const ledger = useContext(HedgeLedgerContext);
  if (!ledger || !ledger.showForm) return null;
  const inputCls = "h-7 w-full rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink outline-none focus:border-accent-border";
  return (
    <div className="border-t border-line-soft px-4 py-3">
      <div className="mb-2 text-[12.5px] font-medium text-ink">Log an implemented hedge</div>
      <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
        {([
          ["implementedAt", "Date implemented", "date"],
          ["tenorLabel", "Tenor (e.g. 3 months)", "text"],
          ["strikePctOtm", "Strike % OTM", "number"],
          ["strikePrice", "Strike price $", "number"],
          ["premiumUsd", "Premium $ / contract", "number"],
          ["premiumPctOfSpot", "Premium % of spot", "number"],
          ["contracts", "# Contracts", "number"],
          ["expiry", "Expiry (YYYY-MM-DD)", "date"],
        ] as [keyof HedgePos, string, string][]).map(([key, label, type]) => (
          <label key={key} className="flex flex-col gap-1">
            <span className="text-ink-3">{label}</span>
            <input
              type={type}
              value={(ledger.form[key] as string | number | undefined) ?? ""}
              onChange={(e) => ledger.setForm((f) => ({ ...f, [key]: e.target.value }))}
              className={inputCls}
            />
          </label>
        ))}
        <label className="col-span-2 flex flex-col gap-1 sm:col-span-4">
          <span className="text-ink-3">Notes</span>
          <input type="text" value={ledger.form.notes ?? ""} onChange={(e) => ledger.setForm((f) => ({ ...f, notes: e.target.value }))} className={inputCls} />
        </label>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <button type="button" onClick={ledger.save} disabled={ledger.saving} className="inline-flex h-7 items-center rounded-control bg-ink px-3 text-[12.5px] font-medium text-white hover:bg-ink-2 disabled:opacity-50">
          {ledger.saving ? "Saving…" : "Save hedge"}
        </button>
        <button type="button" onClick={ledger.cancelForm} className="inline-flex h-7 items-center rounded-control border border-line bg-surface px-3 text-[12.5px] text-ink-2 hover:bg-surface-hover">
          Cancel
        </button>
        <span className="text-[11px] text-ink-3">Confirming a hedge here is what tells the brief protection is on — it will only say HOLD while an active position exists.</span>
      </div>
    </div>
  );
}

/* ── Alpha vs core ───────────────────────────────────────────────────── */

const PERIODS = [
  ["1w", "1W"],
  ["1m", "1M"],
  ["3m", "3M"],
  ["ytd", "YTD"],
] as const;

const DAY_MODELS: [string, string][] = [
  ["balanced", "Balanced"],
  ["growth", "Growth"],
  ["allEquity", "All-Eq"],
];

function AlphaCell({ s }: { s: DailySummary }) {
  const p = s.performance?.alphaCore;
  const rows = s.performance?.models ?? [];
  const group = rows.some((r) => r.groupId === "pim") ? "pim" : rows[0]?.groupId;
  const dayReturns = DAY_MODELS.map(([profile, label]) => ({ label, v: rows.find((r) => r.groupId === group && r.profile === profile)?.returns["1d"] ?? null }));
  const hasModels = dayReturns.some((d) => d.v != null);
  if (!p || !p.available) {
    return (
      <Cell label="Alpha vs core" href="/aa-performance" last>
        <div className="mt-1 text-[12px] text-ink-3">No alpha / core series yet.</div>
        {hasModels && <ModelsLine rows={dayReturns} />}
      </Cell>
    );
  }
  const d1 = p.spread["1d"];
  const mom = p.momentum.direction;
  return (
    <Cell label="Alpha vs core" href="/aa-performance" last>
      <div className="mb-1 mt-1 flex items-baseline gap-2">
        <span className={`font-mono text-[20px] font-semibold leading-none ${d1 == null ? "text-ink-3" : d1 > 0 ? "text-pos" : d1 < 0 ? "text-neg" : "text-ink"}`}>{fmtPct(d1)}</span>
        <span className="text-[11px] text-ink-3">today{mom ? ` · ${mom}` : ""}</span>
        {p.spark.length > 2 && <Spark points={p.spark.map((x) => x.value)} baseline={100} width={72} height={22} className="ml-auto shrink-0" />}
      </div>
      {hasModels && <ModelsLine rows={dayReturns} />}
      <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-ink-3">
        {PERIODS.map(([k, label]) => (
          <span key={k}>
            {label} <Pct v={p.spread[k]} pp deadband={0.05} />
          </span>
        ))}
        {p.momentum.prior != null && <span title="1-month spread five sessions ago">was {fmtPct(p.momentum.prior).replace("%", "pp")} a week ago</span>}
      </div>
    </Cell>
  );
}

function ModelsLine({ rows }: { rows: { label: string; v: number | null }[] }) {
  return (
    <div className="text-[12px] text-ink-2">
      {rows.map((r, i) => (
        <span key={r.label}>
          {i > 0 && " · "}
          {r.label} <Pct v={r.v} />
        </span>
      ))}
    </div>
  );
}

/* ── Bottom line + since last brief ──────────────────────────────────── */

function digestParts(s: DailySummary): string[] {
  const c = s.changed;
  if (!c) return [];
  const out: string[] = [];
  if (c.regime.changed) out.push(`Regime ${c.regime.prev} → ${c.regime.now}`);
  else if (c.regime.pending) out.push(`Regime leaning ${c.regime.pending.label} (${c.regime.pending.days}/${c.regime.pending.needed} sessions)`);
  if (c.hedging.changed) out.push(`Hedge ${c.hedging.prev} → ${c.hedging.now}`);
  if (c.cash.changed) out.push(`Cash ${actionWord(c.cash.prev)} → ${actionWord(c.cash.now)}`);
  else if (c.cash.prevScore != null && c.cash.nowScore != null && c.cash.prevScore !== c.cash.nowScore) out.push(`Cash score ${c.cash.prevScore} → ${c.cash.nowScore}`);
  if (c.alphaSpread1d != null) out.push(`Alpha vs core ${c.alphaSpread1d > 0 ? "+" : ""}${c.alphaSpread1d.toFixed(2)}pp`);
  if (c.newTrips > 0) out.push(`${c.newTrips} kill condition${c.newTrips === 1 ? "" : "s"} tripped`);
  if (c.newlyReady.length > 0) out.push(`Entry ready: ${c.newlyReady.join(", ")}`);
  const a = s.actions;
  if (a && (a.counts.open > 0 || a.counts.cleared > 0)) out.push(`${a.counts.open} open action${a.counts.open === 1 ? "" : "s"}, ${a.counts.cleared} cleared`);
  return out;
}

function BottomLine({ s }: { s: DailySummary }) {
  const b = s.brief;
  const stale = s.changed && !s.changed.briefIsToday;
  const parts = digestParts(s);
  return (
    <div className="flex flex-col gap-3 border-t border-line-soft px-4 pb-3.5 pt-3 lg:flex-row lg:gap-6">
      <div className="min-w-0 flex-1 text-[13.5px] leading-[1.5] text-ink">
        <span className="font-semibold">Bottom line.</span>{" "}
        {b?.bottomLine ? b.bottomLine : <span className="text-ink-3">No brief generated yet — Regenerate writes one from today&apos;s inputs.</span>}
        {b?.regimeVerdict && <span className="block mt-1 text-[12.5px] text-ink-2">{b.regimeVerdict}</span>}
        {(stale || b?.generatedAt) && (
          <span className="mt-1 block text-[11px] text-ink-3">
            {stale && <Status tone="warn" className="mr-2">previous day&apos;s brief</Status>}
            {b?.generatedAt && `brief ${timeAgo(b.generatedAt)}`}
          </span>
        )}
      </div>
      <div className="w-full shrink-0 border-t border-line-soft pt-3 text-[12px] leading-[1.5] text-ink-2 lg:w-[300px] lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
        <span className="text-ink-3">Since last brief</span>
        <br />
        {parts.length > 0 ? parts.join(" · ") : "Nothing structural changed since the last session"}
        {b?.whatChanged && <p className="mt-1">{b.whatChanged}</p>}
      </div>
    </div>
  );
}

/* ── the panel ───────────────────────────────────────────────────────── */

export function DecisionPanel({ s, regimeDetailOpen, onToggleRegimeDetail }: { s: DailySummary; regimeDetailOpen: boolean; onToggleRegimeDetail: () => void }) {
  return (
    <section id="s-today" className="panel" style={{ scrollMarginTop: 64 }}>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4">
        <RegimeCell s={s} detailOpen={regimeDetailOpen} onToggleDetail={onToggleRegimeDetail} />
        <CashCell s={s} />
        <HedgeCell s={s} />
        <AlphaCell s={s} />
      </div>
      <HedgeLogForm />
      <BottomLine s={s} />
    </section>
  );
}

/* ── Benchmarks (the Market panel's full view) ───────────────────────── */

export function BenchmarkStrip({ s }: { s: DailySummary }) {
  const rows = s.performance?.benchmarks ?? [];
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11.5px]">
      {rows.map((b) => (
        <span key={b.key} className="inline-flex items-baseline gap-1.5">
          <span className="text-ink-3">{b.label}</span>
          <Pct v={b.returns["1d"]} className="text-[12.5px] font-medium" />
          <span className="text-ink-faint">
            1W <Pct v={b.returns["1w"]} /> · YTD <Pct v={b.returns.ytd} />
          </span>
        </span>
      ))}
      <Link href="/aa-performance" className="ml-auto text-accent hover:text-accent-ink">
        All performance
      </Link>
    </div>
  );
}

export { fmtPct };
