"use client";

/**
 * Market Brief — a roll-up (Nov 26 2026 team session): one short line per
 * feeder page (Strategists, Technicals, Sentiment, Hedging), each with the
 * date of its newest input and an expander for the detail. No opinions of
 * our own, no wall of text, no performance section (that is on the home page).
 *
 * READ-ONLY: reads what the feeder pages already have on file. It makes no
 * model call and no option-price request (Hedging reads the saved history).
 */

import React, { useMemo } from "react";
import Link from "next/link";
import type { StrategistReport } from "@/app/lib/strategist-reports";
import type { FundstratView } from "@/app/api/fundstrat-view/route";
import type { HedgingHistory } from "@/app/api/kv/hedging-history/route";
import { STRATEGIST_SOURCES, latestRead, resolveStance, strategistRollup, type FundstratReads, type StanceOverrides } from "@/app/lib/strategist-sources";
import { HEADLINE_DEFAULT, hedgeHeadline } from "@/app/lib/hedging-headline";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import { Explain } from "@/app/components/Explain";
import { useFacts, useGet } from "@/app/components/redesign/data";
import { Card, Page, fmtAsOf } from "@/app/components/redesign/ui";

const SENTIMENT_RULE = { fearAtOrBelow: 25, greedAtOrAbove: 75 };

function Line({ id, label, line, date, href, hrefLabel, children }: { id: string; label: string; line: string; date: string | null; href: string; hrefLabel: string; children?: React.ReactNode }) {
  const [open, toggle] = usePersistedOpen(`marketbrief.${id}`, false);
  return (
    <div className="border-b border-line-soft px-5 py-3.5 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="w-[120px] shrink-0 text-[13px] font-semibold uppercase tracking-wide text-ink-3">{label}</span>
        <span className="min-w-0 flex-1 text-[17px] font-semibold leading-snug text-ink">{line}</span>
        <span className="text-[13px] text-ink-3">{date ? `newest input ${fmtAsOf(date)}` : "no data yet"}</span>
        <button type="button" onClick={toggle} aria-expanded={open} className="h-7 rounded-control border border-line bg-surface px-2.5 text-[12.5px] font-medium text-ink-2 hover:bg-surface-hover">{open ? "Hide detail" : "Detail"}</button>
      </div>
      {open && (
        <div className="mt-2.5 pl-0 text-[14px] text-ink-2 sm:pl-[136px]">
          {children}
          <Link href={href} className="mt-2 inline-block text-[14px] font-semibold !text-accent underline">{hrefLabel}</Link>
        </div>
      )}
    </div>
  );
}

export default function MarketBriefRollup() {
  const reports = useGet<StrategistReport[]>("/api/strategist-reports", (raw) => (raw as { reports?: StrategistReport[] })?.reports ?? null);
  const fs = useGet<FundstratView>("/api/fundstrat-view", (raw) => (raw as { result?: FundstratView | null })?.result ?? null);
  const overrides = useGet<StanceOverrides>("/api/strategist-stance");
  const hedgeHist = useGet<HedgingHistory>("/api/kv/hedging-history");
  const { facts } = useFacts();

  const strat = useMemo(() => {
    const all = reports.data ?? [];
    const reads: FundstratReads = { newton: fs.data?.newton ? { stance: fs.data.newton.stance, date: fs.data.newton.date } : null, lee: fs.data?.lee ? { stance: fs.data.lee.stance, date: fs.data.lee.date } : null };
    const ov = overrides.data ?? {};
    const rollup = strategistRollup(STRATEGIST_SOURCES, all, ov, reads);
    const detail = (group: "strategists" | "technicals") =>
      STRATEGIST_SOURCES.filter((s) => s.group === group).map((s) => {
        const read = latestRead(s, all, reads, STRATEGIST_SOURCES);
        const stance = read ? resolveStance(read.stanceText, read.key, ov).stance : null;
        return { name: s.name, firm: s.firm, text: read ? `${stance ?? "Not stated"} · ${read.date}` : s.pending ? `source pending: ${s.pending}` : "no report yet" };
      });
    return { s: rollup.find((r) => r.group === "strategists"), t: rollup.find((r) => r.group === "technicals"), detail };
  }, [reports.data, fs.data, overrides.data]);

  const sentiment = useMemo(() => {
    const fg = facts.find((f) => f.id === "fearGreed");
    const v = fg && !fg.missing ? parseFloat(fg.value) : NaN;
    const line = !Number.isFinite(v) ? "no data yet" : v <= SENTIMENT_RULE.fearAtOrBelow ? `Contrarian positive (Fear & Greed ${v.toFixed(0)}: extreme fear)` : v >= SENTIMENT_RULE.greedAtOrAbove ? `Contrarian negative (Fear & Greed ${v.toFixed(0)}: extreme greed)` : `Neutral (Fear & Greed ${v.toFixed(0)})`;
    const rows = ["fearGreed", "aaii", "putCall", "oscillator", "vix"].map((id) => facts.find((f) => f.id === id)).filter((f): f is NonNullable<typeof f> => Boolean(f));
    return { line, date: Number.isFinite(v) ? (fg?.asOf ?? null) : null, rows };
  }, [facts]);

  const hedge = useMemo(() => {
    const snaps = [...(hedgeHist.data?.snapshots ?? [])].sort((a, b) => a.date.localeCompare(b.date));
    const now = snaps[snaps.length - 1];
    if (!now) return { line: "no data yet", date: null as string | null, h: null };
    const h = hedgeHeadline(now, snaps.slice(0, -1));
    const pctText = h.pct == null ? "" : `${h.pct.toFixed(2)}% of exposure`;
    const line = h.pct == null ? "no price on file for the 3-month put" : h.vsAvg === "near" ? `Hedge cost near its 3-month average (${pctText})` : h.vsAvg ? `Hedge cost ${h.vsAvg} vs. its 3-month average (${pctText})` : `Hedge cost ${pctText} (too little history for an average)`;
    return { line, date: now.date, h };
  }, [hedgeHist.data]);

  return (
    <Page title="Market Brief" lede="One line from each page. Open a line for the detail.">
      <Card pad={false}>
        <Line id="strategists" label="Strategists" line={strat.s?.line ?? "no data yet"} date={strat.s?.newest ?? null} href="/strategists" hrefLabel="Open Strategists">
          <ul className="list-disc pl-5">{strat.detail("strategists").map((d) => <li key={d.name}><span className="font-semibold text-ink">{d.name}</span> ({d.firm}): {d.text}</li>)}</ul>
        </Line>
        <Line id="technicals" label="Technicals" line={strat.t?.line ?? "no data yet"} date={strat.t?.newest ?? null} href="/strategists" hrefLabel="Open Strategists">
          <ul className="list-disc pl-5">{strat.detail("technicals").map((d) => <li key={d.name}><span className="font-semibold text-ink">{d.name}</span> ({d.firm}): {d.text}</li>)}</ul>
        </Line>
        <Line id="sentiment" label="Sentiment" line={sentiment.line} date={sentiment.date} href="/sentiment" hrefLabel="Open Sentiment">
          <ul className="list-disc pl-5">{sentiment.rows.map((f) => <li key={f.id}><span className="font-semibold text-ink">{f.label}</span>: {f.value}{f.asOf ? ` · ${fmtAsOf(f.asOf)}` : " · no data yet"}</li>)}</ul>
        </Line>
        <Line id="hedging" label="Hedging" line={hedge.line} date={hedge.date} href="/hedging" hrefLabel="Open Hedging">
          {hedge.h ? (
            <ul className="list-disc pl-5">
              <li>{HEADLINE_DEFAULT.months}-month SPY put, 5% out of the money{hedge.h.expiry ? ` (expiry ${hedge.h.expiry})` : ""}: {hedge.h.pct == null ? "no price" : `${hedge.h.pct.toFixed(2)}% of exposure`}</li>
              <li>A week earlier: {hedge.h.weekAgo ? `${hedge.h.weekAgo.pct.toFixed(2)}% (${hedge.h.weekAgo.date})` : "no saved day"}</li>
              <li>A month earlier: {hedge.h.monthAgo ? `${hedge.h.monthAgo.pct.toFixed(2)}% (${hedge.h.monthAgo.date})` : "no saved day"}</li>
              <li>3-month average: {hedge.h.avg3m ? `${hedge.h.avg3m.pct.toFixed(2)}% over ${hedge.h.avg3m.days} saved days` : "fewer than 5 saved days"}</li>
            </ul>
          ) : (
            <p>No saved option prices yet.</p>
          )}
        </Line>
      </Card>
      <Explain prefKey="explain.marketbrief.rules" label="How each line is written">
        <p>Strategists and Technicals: each source&apos;s latest stance, read from its own wording (or set by hand on the Strategists page). Four or more are counted; three or fewer are named.</p>
        <p className="mt-1">Sentiment: a fixed rule on CNN Fear &amp; Greed. At or below {SENTIMENT_RULE.fearAtOrBelow} reads &ldquo;contrarian positive&rdquo;, at or above {SENTIMENT_RULE.greedAtOrAbove} &ldquo;contrarian negative&rdquo;, otherwise neutral. It is a rule, not a view; the team can change it.</p>
        <p className="mt-1">Hedging: the 3-month, 5% out-of-the-money SPY put as % of exposure from the newest saved prices, against its average over the last three months of saved days (&ldquo;low&rdquo; or &ldquo;high&rdquo; = more than 10% away).</p>
        <p className="mt-1">The earlier, longer brief is still at <Link href="/brief" className="font-semibold !text-accent underline">Brief (current)</Link>.</p>
      </Explain>
    </Page>
  );
}
