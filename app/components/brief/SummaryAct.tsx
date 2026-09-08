"use client";

import React, { useState } from "react";
import Link from "next/link";
import type { DailySummary } from "@/app/lib/daily-summary";
import type { ActionItem } from "@/app/lib/daily-summary/actions";
import { useStocks } from "@/app/lib/StockContext";
import { AppIcon } from "../AppIcon";
import { Card, Empty, IconButton, Pct, RowButton, Status, TickerLink, timeAgo } from "./summary-ui";

/**
 * The Brief's queue lists ONLY the brief's own recommendations.
 *
 * Everything else the queue used to interleave — kill trips, coverage gaps,
 * alerts, entry-ready setups, change events, prints — belongs to a page that
 * already owns it. Listing them here made the brief's own calls hard to find
 * and pushed the genuinely useful panels (model returns, market returns, main
 * contributors) into a narrow rail. They are not lost: the "Elsewhere" strip
 * under the queue carries one entry per remaining source with its count and
 * highest priority, links to the page that owns it, and can be opened in
 * place (persisted) so Done / Snooze still reach every item.
 */

/** Sources the brief itself writes — the only ones listed in the queue. */
const BRIEF_SOURCE: ActionItem["source"] = "ai";

type Elsewhere = {
  key: string;
  title: string;
  sources: ActionItem["source"][];
  /** The page that owns these items today. */
  href?: string;
  where?: string;
};

const ELSEWHERE: Elsewhere[] = [
  // Kill trips and coverage gaps are the Thesis desk's job.
  { key: "thesis", title: "Thesis", sources: ["kill", "coverage"], href: "/thesis", where: "Thesis desk" },
  // Alerts and change events are per-holding; Holdings carries the attention
  // row and the Changes panel.
  { key: "alerts", title: "Alerts", sources: ["alert"], href: "/", where: "Holdings" },
  { key: "changes", title: "Changes", sources: ["change"], href: "/", where: "Holdings" },
  // Prints are read off the Calendar on this page, then actioned on the name.
  { key: "prints", title: "Prints", sources: ["earnings"], href: "#s-calendar", where: "Calendar" },
  // Entry-ready names are worked in the Pipeline.
  { key: "entry", title: "Entry", sources: ["entry"], href: "/funnel", where: "Pipeline" },
];

/** Every source claimed above (plus the brief's own) — anything else falls
 *  into "Other" so a new source can never make items disappear. */
const CLAIMED = new Set<ActionItem["source"]>([BRIEF_SOURCE, ...ELSEWHERE.flatMap((g) => g.sources)]);

const ELSEWHERE_PREF = "brief.actions.elsewhere";

const PRIORITY_RANK: Record<ActionItem["priority"], number> = { high: 0, medium: 1, low: 2 };

function priorityDot(p: ActionItem["priority"]): string {
  return p === "high" ? "bg-neg" : p === "medium" ? "bg-warn" : "bg-ink-faint";
}

function topPriority(items: ActionItem[]): ActionItem["priority"] {
  return items.reduce<ActionItem["priority"]>((best, it) => (PRIORITY_RANK[it.priority] < PRIORITY_RANK[best] ? it.priority : best), "low");
}

const SOURCE_LABEL: Record<ActionItem["source"], string> = {
  kill: "Kill",
  alert: "Alerts",
  entry: "Entry",
  coverage: "Thesis",
  change: "Change",
  earnings: "Print",
  ai: "Brief",
};

/** One queue row — used by the brief list and by the opened Elsewhere groups,
 *  so Done / Snooze / Restore behave identically wherever an item appears. */
function QueueRow({
  it,
  i,
  busy,
  mark,
  showSource,
}: {
  it: ActionItem;
  i: number;
  busy: string | null;
  mark: (id: string, status: "done" | "snoozed" | "clear") => void;
  showSource: boolean;
}) {
  return (
    <li style={{ "--i": Math.min(i, 8) } as React.CSSProperties} className={`flex items-start gap-3 border-b border-line-soft px-3.5 py-2.5 last:border-b-0 ${it.state ? "opacity-55" : ""}`}>
      <span className={`dot mt-[7px] ${priorityDot(it.priority)}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {it.ticker && <TickerLink ticker={it.ticker} />}
          <span className={`min-w-0 break-words text-[13px] font-medium text-ink ${it.state?.status === "done" ? "line-through" : ""}`}>{it.title}</span>
          {it.at && <span className="text-[11px] text-ink-faint">{timeAgo(it.at)}</span>}
          {showSource && <span className="ml-auto text-[11px] text-ink-3">{SOURCE_LABEL[it.source]}</span>}
        </div>
        {it.detail && <div className="mt-0.5 break-words text-[12.5px] leading-[1.45] text-ink-2">{it.detail}</div>}
        {it.tags && it.tags.length > 0 && (
          <div className="mt-0.5 break-words font-mono text-[10.5px] text-ink-3">{it.tags.filter(Boolean).slice(0, 3).join(" · ")}</div>
        )}
      </div>
      <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
        {it.href && !it.state && <RowButton href={it.href}>Open</RowButton>}
        {it.state ? (
          <RowButton disabled={busy === it.id} onClick={() => mark(it.id, "clear")}>Restore</RowButton>
        ) : (
          <>
            <RowButton disabled={busy === it.id} onClick={() => mark(it.id, "done")}>Done</RowButton>
            <RowButton disabled={busy === it.id} onClick={() => mark(it.id, "snoozed")} title="Snooze until tomorrow">Snooze</RowButton>
          </>
        )}
      </div>
    </li>
  );
}

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
  const { uiPrefs, setUiPref } = useStocks();
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
  const briefItems = shown.filter((it) => it.source === BRIEF_SOURCE);
  const rest = shown.filter((it) => it.source !== BRIEF_SOURCE);
  // Groups in a fixed reading order; the incoming list is already
  // priority-sorted, so each group keeps the global order within it.
  const groups = [
    ...ELSEWHERE.map((g) => ({ ...g, items: rest.filter((it) => g.sources.includes(it.source)) })),
    { key: "other", title: "Other", sources: [] as ActionItem["source"][], href: undefined, where: undefined, items: rest.filter((it) => !CLAIMED.has(it.source)) },
  ].filter((g) => g.items.length > 0);

  const openBrief = (a?.items ?? []).filter((it) => it.source === BRIEF_SOURCE);
  const cleared = a?.counts.cleared ?? 0;
  const meta = !a
    ? "loading"
    : openBrief.length === 0
      ? "today's brief"
      : `${openBrief.filter((i) => i.priority === "high").length} high · ${openBrief.filter((i) => i.priority === "medium").length} medium · ${openBrief.filter((i) => i.priority === "low").length} low`;
  const elsewhereOpen = (uiPrefs[ELSEWHERE_PREF] ?? "1") !== "1";

  return (
    <Card className={`animate-panel-in ${scrollable ? "flex flex-col self-start" : ""}`}>
      <div className="panel-h">
        <span className="t-mark bg-hub-today" />
        <span className="t">Action queue</span>
        <span className="m">{meta}</span>
        {cleared > 0 && (
          <button type="button" onClick={() => setShowCleared((v) => !v)} className="m ml-auto hover:text-ink" title={showCleared ? "Hide the cleared items" : "Show the cleared items"}>
            {cleared} cleared today{showCleared ? " · hide" : ""}
          </button>
        )}
      </div>
      {!a ? (
        <Empty>Action sources unavailable.</Empty>
      ) : briefItems.length === 0 ? (
        <Empty>The brief has no open recommendations{rest.length > 0 ? " — everything below is owned elsewhere." : " right now."}</Empty>
      ) : (
        <ul className={`stagger ${scrollable ? "max-h-[520px] min-h-0 overflow-y-auto" : ""}`}>
          {briefItems.map((it, i) => (
            <QueueRow key={it.id} it={it} i={i} busy={busy} mark={mark} showSource={false} />
          ))}
        </ul>
      )}

      {groups.length > 0 && (
        <div className="border-t border-line-soft bg-[var(--h-soft,var(--color-surface-2))] px-3.5 py-2.5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-[12px] font-semibold text-[var(--h,var(--color-ink))]">Elsewhere</span>
            {groups.map((g) =>
              g.href ? (
                <Link key={g.key} href={g.href} className="group inline-flex items-center gap-1.5 text-[12px] text-ink-2 transition-colors hover:text-accent" title={`${g.items.length} ${g.title.toLowerCase()} item${g.items.length === 1 ? "" : "s"} — open ${g.where}`}>
                  <span className={`dot ${priorityDot(topPriority(g.items))}`} />
                  <span className="min-w-0 break-words">{g.title}</span>
                  <span className="font-mono text-ink">{g.items.length}</span>
                  <span className="text-[11px] text-ink-3 transition-colors group-hover:text-accent">{g.where}</span>
                  <AppIcon name="arrowR" size={11} />
                </Link>
              ) : (
                <span key={g.key} className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
                  <span className={`dot ${priorityDot(topPriority(g.items))}`} />
                  <span className="min-w-0 break-words">{g.title}</span>
                  <span className="font-mono text-ink">{g.items.length}</span>
                </span>
              )
            )}
            <button
              type="button"
              onClick={() => setUiPref(ELSEWHERE_PREF, elsewhereOpen ? "1" : "0")}
              aria-expanded={elsewhereOpen}
              className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-accent transition-colors hover:text-accent-ink"
              title={elsewhereOpen ? "Hide these items" : "Read and clear these items without leaving the brief"}
            >
              <AppIcon name={elsewhereOpen ? "chevU" : "chevD"} size={12} />
              {elsewhereOpen ? "Hide" : `Show ${rest.length} here`}
            </button>
          </div>
        </div>
      )}

      {groups.length > 0 && elsewhereOpen && (
        <div className="animate-panel-in border-t border-line-soft">
          {groups.map((g) => {
            // The per-group collapse pref survives — each Elsewhere group is
            // still individually collapsible, persisted in pm:ui-prefs.
            const prefKey = `brief.actions.grp.${g.key}`;
            const open = (uiPrefs[prefKey] ?? "0") !== "1";
            const top = topPriority(g.items);
            return (
              <div key={g.key}>
                <button
                  type="button"
                  onClick={() => setUiPref(prefKey, open ? "1" : "0")}
                  aria-expanded={open}
                  title={open ? `Collapse ${g.title}` : `Expand ${g.title}`}
                  className="flex w-full items-center gap-2 border-b border-line-soft bg-surface-2 px-3.5 py-1.5 text-left text-[11.5px] text-ink-2 transition-colors hover:bg-surface-hover"
                >
                  <AppIcon name={open ? "chevD" : "chevR"} size={12} className="shrink-0 text-ink-3" />
                  <span className="min-w-0 break-words">{g.title}</span>
                  <span className="shrink-0 font-mono text-ink-faint">{g.items.length}</span>
                  {g.where && <span className="shrink-0 text-[11px] text-ink-3">{g.where}</span>}
                  <span className={`dot ml-auto shrink-0 ${priorityDot(top)}`} />
                  <span className="shrink-0 text-[11px] text-ink-3">{top}</span>
                </button>
                {open && (
                  <ul className="stagger">
                    {g.items.map((it, i) => (
                      <QueueRow key={it.id} it={it} i={i} busy={busy} mark={mark} showSource />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/** Thesis & book — the summary panel; the chevron opens the full card in place (persisted). */
export function ThesisBookPanel({ s }: { s: DailySummary }) {
  const { uiPrefs, setUiPref } = useStocks();
  const PREF = "brief.summary.thesis";
  const open = (uiPrefs[PREF] ?? "1") !== "1";
  const t = s.actions?.thesis;
  const b = s.book;
  const th = b?.thesis;
  const trips = t?.tripped.length ?? 0;
  const notUnderwritten = t ? Math.max(0, t.portfolioCount - t.underwritten) : null;
  return (
    <Card className="animate-panel-in">
      <div className="panel-h">
        <span className="t-mark bg-hub-portfolio" />
        <Link href="/thesis" className="t hover:text-accent">Thesis &amp; book</Link>
        <span className="m">monitoring</span>
        <div className="ml-auto flex items-center gap-2">
          <IconButton onClick={() => setUiPref(PREF, open ? "1" : "0")} title={open ? "Hide the full read" : "Show the full read"} icon={open ? "chevU" : "chevD"} active={open} />
        </div>
      </div>
      {!t && !b ? (
        <Empty>Thesis monitoring unavailable.</Empty>
      ) : (
        <div className="flex flex-col gap-1 px-3.5 pb-3 pt-2 text-[12.5px] text-ink-2">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            {th && (
              <>
                <Status tone="pos">{th.intact} intact</Status> ·{" "}
                <Status tone="warn">{th.eroding} eroding</Status> ·{" "}
                <Status tone={th.broken > 0 ? "neg" : "neutral"}>{th.broken} broken</Status>
              </>
            )}
            {trips > 0 && (
              <>
                {th && " · "}
                <span className="text-neg">{trips} tripped: {t!.tripped.map((x) => x.ticker).join(", ")}</span>
              </>
            )}
            {notUnderwritten != null && notUnderwritten > 0 && <> · {notUnderwritten} not underwritten</>}
          </div>
          <div>
            {t && <>{t.underwritten} of {t.portfolioCount} underwritten</>}
            {t && b?.weightedBeta != null && " · "}
            {b?.weightedBeta != null && <>book β <span className="font-mono text-ink">{b.weightedBeta}</span></>}
          </div>
        </div>
      )}
      {open && (
        <div className="border-t border-line-soft">
          <ThesisBookCard s={s} bare />
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
      {!bare && (
        <div className="panel-h">
          <span className="t-mark bg-hub-portfolio" />
          <Link href="/thesis" className="t hover:text-accent">Thesis &amp; book</Link>
          <span className="m">monitoring</span>
        </div>
      )}
      <div className="px-3.5 pb-2 pt-3 text-[12.5px]">
        {th && (
          <div className="flex items-center gap-3">
            <Count n={th.intact} label="intact" tone="pos" />
            <Count n={th.eroding} label="eroding" tone="warn" />
            <Count n={th.broken} label="broken" tone="neg" />
            {t && <span className="ml-auto text-[11.5px] text-ink-3">{t.underwritten}/{t.portfolioCount} underwritten</span>}
          </div>
        )}
        {t && t.tripped.length > 0 && (
          <ul className="mt-2.5 space-y-1.5">
            {t.tripped.map((row) => (
              <li key={row.ticker} className="rounded-control border border-line-soft bg-surface-2 px-2.5 py-1.5">
                <div className="flex items-center gap-2">
                  <TickerLink ticker={row.ticker} />
                  <Status tone="neg" className="text-[11.5px] text-neg">{row.conditions.length} tripped</Status>
                </div>
                {row.conditions.slice(0, 2).map((c, i) => (
                  <div key={i} className="mt-0.5 truncate text-[11.5px] text-ink-2" title={`${c.note} — ${c.reading}`}>{c.note} <span className="text-ink-3">— {c.reading}</span></div>
                ))}
              </li>
            ))}
          </ul>
        )}
        {t && t.tripped.length === 0 && th && <div className="mt-2 text-[11.5px] text-ink-3">No kill conditions tripped.</div>}
        {t && t.coverageMissing.length > 0 && (
          <div className="mt-2 text-[11.5px] text-ink-3">
            Missing thesis: {t.coverageMissing.map((m) => m.ticker).join(", ")}
          </div>
        )}
      </div>
      {b && (
        <div className="border-t border-line-soft px-3.5 py-2.5 text-[11.5px]">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-ink-2">
            <span>β <b className="font-mono font-medium text-ink">{b.weightedBeta ?? "—"}</b></span>
            <span>vol <b className="font-mono font-medium text-ink">{b.annVol != null ? `${b.annVol}%` : "—"}</b></span>
            <span>top-5 <b className="font-mono font-medium text-ink">{b.top5Weight != null ? `${Math.round(b.top5Weight * 100)}%` : "—"}</b></span>
            {b.betaScenario && <span>{b.betaScenario.label} <Pct v={b.betaScenario.portfolioImpact} className="font-medium" digits={1} /></span>}
          </div>
          {b.topRisk.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-ink-3">
              <span>Risk contributors:</span>
              {b.topRisk.slice(0, 4).map((r) => (
                <span key={r.ticker} className="inline-flex items-baseline gap-1">
                  <TickerLink ticker={r.ticker} className="text-[11.5px]" />
                  <span className="font-mono">{r.ctrPct != null ? `${r.ctrPct}%` : ""}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {!bare && (
        <Link href="/thesis" className="flex h-8 items-center gap-1 border-t border-line-soft px-3.5 text-[11.5px] text-accent hover:text-accent-ink">
          Thesis desk <AppIcon name="arrowR" size={12} />
        </Link>
      )}
    </Wrap>
  );
}

/** Renders children with no card chrome — for use inside a panel that already
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
