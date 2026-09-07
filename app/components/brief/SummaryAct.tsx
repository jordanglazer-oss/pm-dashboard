"use client";

import React, { useState } from "react";
import Link from "next/link";
import type { DailySummary } from "@/app/lib/daily-summary";
import type { ActionItem } from "@/app/lib/daily-summary/actions";
import { Card, CardHeader, Empty, Pct, Pill, TickerLink, timeAgo } from "./summary-ui";

/**
 * The queue is rendered in GROUPS, not one priority-sorted list. Interleaved,
 * the brief's own recommendations got scattered among kill trips and change
 * events and were easy to miss — they lead now, in their own tinted block,
 * and every other source follows under its own header.
 */
const GROUPS: { key: string; title: string; sources: ActionItem["source"][]; lead?: boolean }[] = [
  { key: "brief", title: "The brief recommends", sources: ["ai"], lead: true },
  { key: "thesis", title: "Thesis", sources: ["kill", "coverage"] },
  { key: "prints", title: "Prints", sources: ["earnings"] },
  { key: "entry", title: "Entry", sources: ["entry"] },
  { key: "alerts", title: "Alerts", sources: ["alert"] },
  { key: "changes", title: "Changes", sources: ["change"] },
];

const SOURCE_LABEL: Record<ActionItem["source"], { label: string; tone: "pos" | "neg" | "warn" | "accent" | "neutral" | "violet" }> = {
  kill: { label: "Kill", tone: "neg" },
  alert: { label: "Alert", tone: "warn" },
  entry: { label: "Entry", tone: "pos" },
  coverage: { label: "Thesis", tone: "violet" },
  change: { label: "Change", tone: "neutral" },
  earnings: { label: "Print", tone: "accent" },
  ai: { label: "Brief", tone: "accent" },
};

export function ActionQueue({
  s,
  onMark,
  scrollable = false,
}: {
  s: DailySummary;
  onMark: (id: string, status: "done" | "snoozed" | "clear") => Promise<void>;
  /** Cap the list and scroll INSIDE it, so a long queue never grows the page. */
  scrollable?: boolean;
}) {
  const a = s.actions;
  const [showCleared, setShowCleared] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const mark = async (id: string, status: "done" | "snoozed" | "clear") => {
    setBusy(id);
    try {
      await onMark(id, status);
    } finally {
      setBusy(null);
    }
  };
  const shown = showCleared ? [...(a?.items ?? []), ...(a?.dismissed ?? [])] : a?.items ?? [];
  return (
    <Card className={scrollable ? "flex min-h-[260px] flex-col" : ""}>
      <CardHeader
        title="Action queue"
        sub={a ? `${a.counts.open} open · ${a.counts.high} high` : "loading"}
        right={
          a && a.counts.cleared > 0 ? (
            <button onClick={() => setShowCleared((v) => !v)} className="text-[11px] text-ink-3 hover:text-ink">
              {showCleared ? "hide" : "show"} {a.counts.cleared} cleared
            </button>
          ) : null
        }
      />
      {!a ? (
        <Empty>Action sources unavailable.</Empty>
      ) : a.items.length === 0 && !showCleared ? (
        <Empty>Nothing needs a decision right now.</Empty>
      ) : (
        <div className={scrollable ? "min-h-0 flex-1 basis-0 overflow-y-auto" : ""}>
          {GROUPS.map((g) => {
            const items = shown.filter((it) => g.sources.includes(it.source));
            if (items.length === 0) return null;
            return (
              <div key={g.key} className={g.lead ? "border-b border-accent-border bg-accent-soft/40" : "border-b border-line-soft last:border-b-0"}>
                <div className={`flex items-baseline gap-2 px-4 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wide ${g.lead ? "text-accent-ink" : "text-ink-3"}`}>
                  {g.title}
                  <span className="font-mono normal-case tracking-normal text-ink-faint">{items.length}</span>
                </div>
                <ul className="divide-y divide-line-soft">
                  {items.map((it) => (
                    <li key={it.id} className={`flex items-start gap-3 px-4 py-2.5 ${it.state ? "opacity-55" : ""}`}>
                      <span className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${it.priority === "high" ? "bg-neg" : it.priority === "medium" ? "bg-warn" : "bg-ink-faint"}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <Pill tone={SOURCE_LABEL[it.source].tone}>{SOURCE_LABEL[it.source].label}</Pill>
                          {it.ticker && <TickerLink ticker={it.ticker} />}
                          <span className={`text-[12.5px] text-ink ${it.state?.status === "done" ? "line-through" : ""}`}>{it.title}</span>
                          {it.at && <span className="text-[10.5px] text-ink-faint">{timeAgo(it.at)}</span>}
                        </div>
                        {it.detail && <div className="mt-0.5 text-[11.5px] leading-snug text-ink-2">{it.detail}</div>}
                        {it.tags && it.tags.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {it.tags.filter(Boolean).slice(0, 3).map((t, i) => (
                              <span key={i} className="rounded-[4px] bg-surface-2 px-1.5 py-[1px] font-mono text-[10px] text-ink-3">{t}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {it.href && !it.state && (
                          <Link href={it.href} className="rounded-[6px] px-2 py-1 text-[11px] text-accent hover:bg-accent-soft">open</Link>
                        )}
                        {it.state ? (
                          <button disabled={busy === it.id} onClick={() => mark(it.id, "clear")} className="rounded-[6px] px-2 py-1 text-[11px] text-ink-3 hover:bg-surface-hover hover:text-ink disabled:opacity-50">
                            restore
                          </button>
                        ) : (
                          <>
                            <button disabled={busy === it.id} onClick={() => mark(it.id, "snoozed")} title="Snooze until tomorrow" className="rounded-[6px] px-2 py-1 text-[11px] text-ink-3 hover:bg-surface-hover hover:text-ink disabled:opacity-50">
                              later
                            </button>
                            <button disabled={busy === it.id} onClick={() => mark(it.id, "done")} className="rounded-[6px] border border-line px-2 py-1 text-[11px] font-semibold text-ink-2 hover:border-ink hover:text-ink disabled:opacity-50">
                              done
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
      {a && scrollable && shown.length > 3 && (
        <div className="border-t border-line-soft px-4 py-1 text-[10.5px] text-ink-3">
          {shown.length} item{shown.length === 1 ? "" : "s"} — scroll the list, the page stays put
        </div>
      )}
    </Card>
  );
}

export function ThesisBookCard({ s, bare = false }: { s: DailySummary; bare?: boolean }) {
  const t = s.actions?.thesis;
  const b = s.book;
  const th = b?.thesis;
  const Wrap = bare ? BareWrap : Card;
  return (
    <Wrap>
      {!bare && <CardHeader title="Thesis & book" sub="monitoring" href="/thesis" />}
      <div className="px-4 pt-3 pb-2 text-[12px]">
        {th && (
          <div className="flex items-center gap-2">
            <Count n={th.intact} label="intact" tone="pos" />
            <Count n={th.eroding} label="eroding" tone="warn" />
            <Count n={th.broken} label="broken" tone="neg" />
            {t && <span className="ml-auto text-[11px] text-ink-3">{t.underwritten}/{t.portfolioCount} underwritten</span>}
          </div>
        )}
        {t && t.tripped.length > 0 && (
          <ul className="mt-2.5 space-y-1.5">
            {t.tripped.map((row) => (
              <li key={row.ticker} className="rounded-control border border-neg-border bg-neg-soft px-2.5 py-1.5">
                <div className="flex items-center gap-2">
                  <TickerLink ticker={row.ticker} />
                  <span className="text-[11px] font-semibold text-neg">{row.conditions.length} tripped</span>
                </div>
                {row.conditions.slice(0, 2).map((c, i) => (
                  <div key={i} className="mt-0.5 truncate text-[11px] text-ink-2" title={`${c.note} — ${c.reading}`}>{c.note} <span className="text-ink-3">— {c.reading}</span></div>
                ))}
              </li>
            ))}
          </ul>
        )}
        {t && t.tripped.length === 0 && th && <div className="mt-2 text-[11px] text-ink-3">No kill conditions tripped.</div>}
        {t && t.coverageMissing.length > 0 && (
          <div className="mt-2 text-[11px] text-ink-3">
            Missing thesis: {t.coverageMissing.map((m) => m.ticker).join(", ")}
          </div>
        )}
      </div>
      {b && (
        <div className="border-t border-line-soft px-4 py-2.5 text-[11px]">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-ink-2">
            <span>β <b className="font-mono text-ink">{b.weightedBeta ?? "—"}</b></span>
            <span>vol <b className="font-mono text-ink">{b.annVol != null ? `${b.annVol}%` : "—"}</b></span>
            <span>top-5 <b className="font-mono text-ink">{b.top5Weight != null ? `${Math.round(b.top5Weight * 100)}%` : "—"}</b></span>
            {b.betaScenario && <span>{b.betaScenario.label} <Pct v={b.betaScenario.portfolioImpact} className="font-semibold" digits={1} /></span>}
          </div>
          {b.topRisk.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-ink-3">
              <span>Risk contributors:</span>
              {b.topRisk.slice(0, 4).map((r) => (
                <span key={r.ticker} className="inline-flex items-baseline gap-1">
                  <TickerLink ticker={r.ticker} className="text-[11px]" />
                  <span className="font-mono">{r.ctrPct != null ? `${r.ctrPct}%` : ""}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </Wrap>
  );
}

/** Renders children with no card chrome — for use inside a Fold, which already
 *  supplies the card and the header. */
function BareWrap({ children }: { children: React.ReactNode }) {
  return <div className="min-w-0">{children}</div>;
}

function Count({ n, label, tone }: { n: number; label: string; tone: "pos" | "warn" | "neg" }) {
  const cls = tone === "pos" ? "text-pos" : tone === "warn" ? "text-warn" : "text-neg";
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={`font-mono text-[15px] font-semibold ${n === 0 ? "text-ink-faint" : cls}`}>{n}</span>
      <span className="text-[11px] text-ink-3">{label}</span>
    </span>
  );
}
