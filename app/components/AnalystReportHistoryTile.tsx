"use client";

import React, { useEffect, useState } from "react";
import { CollapsibleSection } from "@/app/components/CollapsibleSection";
import { Explain } from "@/app/components/Explain";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import {
  FULL_DETAIL_KEEP,
  changeBetween,
  type ReportHistoryEntry,
  type ReportSource,
  type TickerReportHistory,
} from "@/app/lib/analyst-report-history";
import type { AnalystRating } from "@/app/lib/analyst-snapshots";

/**
 * Analyst Report History — every RBC / JPM / Morningstar report on file for
 * one name, from pm:analyst-report-history (read-only). Shows each report's
 * rating and target with the change from the bank's previous report; the
 * thesis and risks of the most recent reports sit behind one persisted
 * expander. Not part of the score.
 */

const BANK_LABEL: Record<ReportSource, string> = { rbc: "RBC", jpm: "JPM", morningstar: "Morningstar" };
const RATING_LABEL: Record<"rbc" | "jpm", Record<AnalystRating, string>> = {
  rbc: { outperform: "Outperform", neutral: "Sector Perform", underperform: "Underperform", "not-covered": "Not covered" },
  jpm: { outperform: "Overweight", neutral: "Neutral", underperform: "Underweight", "not-covered": "Not covered" },
};
const ratingTone = (r?: AnalystRating) => (r === "outperform" ? "text-pos" : r === "underperform" ? "text-neg" : "text-ink-2");

const fmtDay = (e: ReportHistoryEntry) => {
  const d = e.asOf ?? (e.extractedAt ?? e.recordedAt).slice(0, 10);
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : d;
};
const money = (n?: number, cur?: string) => (n == null ? "—" : `${n.toFixed(2)}${cur ? ` ${cur}` : ""}`);
const signedPct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;

function ChangeCell({ prev, cur, bank }: { prev?: ReportHistoryEntry; cur: ReportHistoryEntry; bank: ReportSource }) {
  if (!prev) return <span className="text-ink-faint">first on file</span>;
  const c = changeBetween(prev, cur);
  const parts: React.ReactNode[] = [];
  if (c.rating && bank !== "morningstar") {
    const up = (r?: AnalystRating) => (r === "outperform" ? 2 : r === "neutral" ? 1 : r === "underperform" ? 0 : -1);
    parts.push(
      <span key="r" className={up(c.rating.to) > up(c.rating.from) ? "text-pos" : "text-neg"}>
        {up(c.rating.to) > up(c.rating.from) ? "Upgrade" : "Downgrade"}
      </span>,
    );
  }
  if (c.targetPct != null) parts.push(<span key="t" className={c.targetPct > 0 ? "text-pos" : "text-neg"}>target {signedPct(c.targetPct)}</span>);
  if (c.stars) parts.push(<span key="s" className={(c.stars.to ?? 0) > (c.stars.from ?? 0) ? "text-pos" : "text-neg"}>{c.stars.from ?? "—"}★ → {c.stars.to ?? "—"}★</span>);
  if (c.fairValuePct != null) parts.push(<span key="f" className={c.fairValuePct > 0 ? "text-pos" : "text-neg"}>fair value {signedPct(c.fairValuePct)}</span>);
  if (c.moat) parts.push(<span key="m">moat {c.moat.from ?? "—"} → {c.moat.to ?? "—"}</span>);
  if (c.valuationBasisChanged) parts.push(<span key="v" className="text-ink-2">new valuation basis</span>);
  if (!parts.length) return <span className="text-ink-faint">no change</span>;
  return <span className="flex flex-wrap gap-x-2">{parts}</span>;
}

function BankTable({ bank, entries }: { bank: ReportSource; entries: ReportHistoryEntry[] }) {
  const rows = entries.map((e, i) => ({ e, prev: entries[i - 1] })).reverse();
  const ms = bank === "morningstar";
  return (
    <div>
      <div className="mb-1 text-[12px] font-medium text-ink">{BANK_LABEL[bank]} <span className="font-normal text-ink-3">· {entries.length} report{entries.length === 1 ? "" : "s"}</span></div>
      <ul className="flex flex-col divide-y divide-line text-[12px] tabular-nums">
        {rows.map(({ e, prev }) => (
          <li key={e.hash} className="py-1.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="w-[92px] shrink-0 text-ink-3">{fmtDay(e)}</span>
              <span className={`font-medium ${ms ? "text-ink" : ratingTone(e.rating)}`}>
                {ms ? (e.stars != null ? `${e.stars}★` : "—") : e.rating ? RATING_LABEL[bank as "rbc" | "jpm"][e.rating] : "—"}
              </span>
              <span className="ml-auto text-ink">
                {ms ? "FV " : "PT "}
                {ms ? money(e.fairValue) : money(e.target, e.targetCurrency)}
              </span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 pl-[100px] text-[11.5px]">
              <ChangeCell prev={prev} cur={e} bank={bank} />
              {e.priceAtReport != null && <span className="ml-auto text-ink-3">price then {e.priceAtReport.toFixed(2)}</span>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReportText({ bank, e }: { bank: ReportSource; e: ReportHistoryEntry }) {
  const d = e.detail;
  if (!d) return null;
  return (
    <div className="rounded-control border border-line px-3 py-2">
      <div className="mb-1 text-[12px] font-medium text-ink">
        {BANK_LABEL[bank]} · {fmtDay(e)}
        {e.valuationBasis && <span className="font-normal text-ink-3"> · {e.valuationBasis}</span>}
      </div>
      {d.thesis?.length ? (
        <div className="mb-1.5">
          <div className="text-[11px] text-ink-3">Thesis</div>
          <ul className="list-disc pl-4 text-[12px] leading-snug">{d.thesis.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      ) : null}
      {d.risks?.length ? (
        <div>
          <div className="text-[11px] text-ink-3">Risks</div>
          <ul className="list-disc pl-4 text-[12px] leading-snug">{d.risks.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}

export default function AnalystReportHistoryTile({ ticker }: { ticker: string }) {
  const [history, setHistory] = useState<TickerReportHistory | null | undefined>(undefined);
  const [showText, toggleText] = usePersistedOpen("stock.reportHistory.text", false);

  useEffect(() => {
    let live = true;
    fetch(`/api/kv/analyst-report-history?ticker=${encodeURIComponent(ticker)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { history?: TickerReportHistory } | null) => live && setHistory(d?.history ?? null))
      .catch(() => live && setHistory(null));
    return () => {
      live = false;
    };
  }, [ticker]);

  if (history === undefined) return null; // loading — secondary tile, no layout jump
  const banks = (["rbc", "jpm", "morningstar"] as const).filter((b) => (history?.[b]?.length ?? 0) > 0);
  const withText = banks
    .flatMap((b) => (history?.[b] ?? []).filter((e) => e.detail).map((e) => ({ b, e })))
    .sort((x, y) => ((y.e.asOf ?? y.e.recordedAt) > (x.e.asOf ?? x.e.recordedAt) ? 1 : -1));

  return (
    <CollapsibleSection prefKey="stock.reportHistory" title="Analyst Report History" subtitle="Not part of the score">
      {banks.length === 0 ? (
        <p className="text-[12.5px] text-ink-3">No bank reports recorded yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {banks.map((b) => <BankTable key={b} bank={b} entries={history?.[b] ?? []} />)}
          {withText.length > 0 && (
            <div>
              <button type="button" onClick={toggleText} aria-expanded={showText} className="text-[12px] font-medium text-accent hover:underline">
                {showText ? "Hide thesis & risks" : `Show thesis & risks (${withText.length} report${withText.length === 1 ? "" : "s"})`}
              </button>
              {showText && <div className="mt-2 flex flex-col gap-2">{withText.map(({ b, e }) => <ReportText key={`${b}-${e.hash}`} bank={b} e={e} />)}</div>}
            </div>
          )}
          <Explain prefKey="explain.stock.reportHistory" label="About this record">
            Every RBC, JPM and Morningstar report received since 23 Nov 2026 (plus any recovered from the nightly backups), newest first. Targets are as printed in the report, in the report&apos;s currency; a % change is shown only between two targets in the same currency. &quot;Price then&quot; is the share price on the day the report was received. Full thesis and risks are kept for the latest {FULL_DETAIL_KEEP} reports per bank; older reports keep the rating, target and dates.
          </Explain>
        </div>
      )}
    </CollapsibleSection>
  );
}
