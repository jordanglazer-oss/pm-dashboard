"use client";

/**
 * Strategists — the BASE page (Nov 2026 hackathon). One card per strategist:
 * name, firm, a few-word stance, the date of the latest update, the short
 * summary, and the full summary / original text on request.
 *
 * Sources are DATA-DRIVEN: a card appears for every (firm, author) that has a
 * report on file, so a new source needs no code change — just email it in
 * ("Strategy: RBC – …", "Technical: JPM – …", "FX: Other – …").
 *
 * Everything shown is the STRATEGIST'S view, extracted from their report —
 * never ours. READ-ONLY: reads /api/strategist-reports and the existing
 * /api/fundstrat-view. The team will decide what the final page includes.
 */

import React, { useMemo, useState } from "react";
import type { ReportKind, StrategistReport } from "@/app/lib/strategist-reports";
import type { FundstratView, StrategistView } from "@/app/api/fundstrat-view/route";
import { useGet } from "@/app/components/redesign/data";
import { Bullets, Card, Empty, fmtAsOf, Loading, Page, Table, Tag, TD } from "@/app/components/redesign/ui";

const KIND_LABEL: Record<ReportKind, string> = { strategy: "Strategy", technical: "Technical", fx: "Currency" };
type Filter = "all" | ReportKind;

const firmLabel = (r: StrategistReport) => (r.firm === "Other" ? r.firmName || "Other" : r.firm === "JPM" ? "J.P. Morgan" : r.firm);

function FullSummary({ r }: { r: StrategistReport }) {
  const [text, setText] = useState<{ id: string; body: string | null; loading: boolean } | null>(null);
  const s = r.summary;
  const loadText = () => {
    setText({ id: r.id, body: null, loading: true });
    fetch(`/api/strategist-reports?id=${encodeURIComponent(r.id)}`, { cache: "no-store" })
      .then((x) => (x.ok ? x.json() : null))
      .then((d) => setText({ id: r.id, body: d?.report?.fullText ?? null, loading: false }))
      .catch(() => setText({ id: r.id, body: null, loading: false }));
  };
  return (
    <div className="mt-3 flex flex-col gap-4 rounded-control bg-surface-2 px-4 py-3.5">
      {s?.full.length ? (
        s.full.map((sec, i) => (
          <div key={i}>
            {sec.heading && <div className="mb-1 text-[14px] font-bold text-ink">{sec.heading}</div>}
            <Bullets items={sec.points} />
          </div>
        ))
      ) : (
        <Empty>{r.summaryError ? `No summary: ${r.summaryError}` : "No summary on file for this report."}</Empty>
      )}
      {s && s.levels.length > 0 && (
        <div>
          <div className="mb-1 text-[14px] font-bold">Levels named in the report</div>
          <Bullets items={s.levels.map((l) => <><span className="font-semibold">{l.instrument}</span> · {l.kind} {l.value}{l.note ? ` — ${l.note}` : ""}</>)} />
        </div>
      )}
      {s && s.fx.length > 0 && (
        <div>
          <div className="mb-1 text-[14px] font-bold">Currency views</div>
          <Bullets items={s.fx.map((f) => <><span className="font-semibold">{f.pair}</span> · {f.view}{f.forecast ? ` · ${f.forecast}` : ""}{f.horizon ? ` (${f.horizon})` : ""}</>)} />
        </div>
      )}
      <div>
        {text?.id === r.id && text.loading ? (
          <Loading what="Loading the original text" />
        ) : text?.id === r.id && text.body ? (
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-control border border-line bg-surface p-3 text-[13px] leading-relaxed text-ink-2">{text.body}</pre>
        ) : text?.id === r.id ? (
          <Empty>The original text is not available.</Empty>
        ) : (
          <button type="button" onClick={loadText} className="text-[14px] font-semibold text-accent underline">
            Show the original report text ({r.chars.toLocaleString()} characters)
          </button>
        )}
      </div>
    </div>
  );
}

function SourceCard({ reports }: { reports: StrategistReport[] }) {
  const latest = reports[0];
  const [open, setOpen] = useState<string | null>(null);
  const [showOlder, setShowOlder] = useState(false);
  const older = reports.slice(1);
  return (
    <section className="flex flex-col gap-2 rounded-card border border-line-soft bg-surface px-5 py-4 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[19px] font-bold tracking-tight">{latest.author || firmLabel(latest)}</span>
        <span className="text-[14px] text-ink-3">{firmLabel(latest)}</span>
        <Tag kind="blue">{KIND_LABEL[latest.kind]}</Tag>
        <span className="ml-auto text-[13px] text-ink-3">{fmtAsOf(latest.date)}</span>
      </div>
      <div className="text-[17px] font-semibold leading-snug text-ink">{latest.summary?.stance ?? "No stance extracted"}</div>
      <div className="text-[13.5px] text-ink-3">{latest.title}</div>
      {latest.summary?.bullets.length ? <Bullets items={latest.summary.bullets} className="mt-1" /> : null}
      <div className="flex flex-wrap items-center gap-4 pt-1 text-[14px]">
        <button type="button" onClick={() => setOpen(open === latest.id ? null : latest.id)} className="font-semibold text-accent underline">
          {open === latest.id ? "Hide the full summary" : "Show the full summary"}
        </button>
        {older.length > 0 && (
          <button type="button" onClick={() => setShowOlder(!showOlder)} className="font-semibold text-accent underline">
            {showOlder ? "Hide earlier reports" : `${older.length} earlier ${older.length === 1 ? "report" : "reports"}`}
          </button>
        )}
      </div>
      {open === latest.id && <FullSummary r={latest} />}
      {showOlder && (
        <div className="mt-1 border-t border-line-soft pt-2">
          {older.map((r) => (
            <div key={r.id} className="border-b border-line-soft py-2 last:border-b-0">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="w-[64px] shrink-0 text-[13px] text-ink-3">{fmtAsOf(r.date)}</span>
                <span className="min-w-0 flex-1 text-[14.5px]">
                  <span className="font-semibold">{r.summary?.stance ?? r.title}</span>
                  {r.summary ? <span className="text-ink-3"> · {r.title}</span> : null}
                </span>
                <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} className="text-[13.5px] font-semibold text-accent underline">{open === r.id ? "Hide" : "Open"}</button>
              </div>
              {open === r.id && <FullSummary r={r} />}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function FundstratCard({ who, firm, v, archive }: { who: string; firm: string; v: StrategistView | null; archive: number }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-2 rounded-card border border-line-soft bg-surface px-5 py-4 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[19px] font-bold tracking-tight">{who}</span>
        <span className="text-[14px] text-ink-3">{firm}</span>
        <Tag kind="blue">{who.includes("Newton") ? "Technical" : "Strategy"}</Tag>
        <span className="ml-auto text-[13px] text-ink-3">{v ? fmtAsOf(v.date) : "no recent note"}</span>
      </div>
      {v ? (
        <>
          <div className="text-[17px] font-semibold capitalize leading-snug">{v.stance}{v.headline ? <span className="font-normal normal-case text-ink-2"> — {v.headline}</span> : null}</div>
          <Bullets items={v.bullets.slice(0, open ? 99 : 3)} className="mt-1" />
          {open && v.watch?.length ? <p className="text-[14.5px] text-ink-2"><span className="font-semibold text-ink">Favoured: </span>{v.watch.join(", ")}</p> : null}
          {open && v.changeVsPrior ? <p className="text-[14.5px] text-ink-2"><span className="font-semibold text-ink">Change from the prior note: </span>{v.changeVsPrior}</p> : null}
          {(v.bullets.length > 3 || v.watch?.length || v.changeVsPrior) && (
            <button type="button" onClick={() => setOpen(!open)} className="self-start text-[14px] font-semibold text-accent underline">{open ? "Show less" : "Show the full summary"}</button>
          )}
        </>
      ) : (
        <Empty>No note in the last 30 days.</Empty>
      )}
      <div className="text-[12.5px] text-ink-3">{archive} daily {archive === 1 ? "note" : "notes"} in the one-year archive</div>
    </section>
  );
}

export default function Strategists() {
  const reports = useGet<StrategistReport[]>("/api/strategist-reports", (raw) => (raw as { reports?: StrategistReport[] })?.reports ?? null);
  const fs = useGet<FundstratView>("/api/fundstrat-view", (raw) => (raw as { result?: FundstratView | null })?.result ?? null);
  const [filter, setFilter] = useState<Filter>("all");

  const { sources, newtonArchive, leeArchive, table } = useMemo(() => {
    const all = reports.data ?? [];
    const emailed = all.filter((r) => r.source !== "note");
    const groups = new Map<string, StrategistReport[]>();
    for (const r of emailed) {
      if (filter !== "all" && r.kind !== filter) continue;
      const key = `${r.firm}|${r.firmName ?? ""}|${(r.author ?? "").toLowerCase()}|${r.kind}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    return {
      sources: [...groups.values()].sort((a, b) => b[0].date.localeCompare(a[0].date)),
      newtonArchive: all.filter((r) => r.source === "note" && r.author === "Mark Newton").length,
      leeArchive: all.filter((r) => r.source === "note" && r.author === "Tom Lee").length,
      table: emailed,
    };
  }, [reports.data, filter]);

  const pill = (id: Filter, label: string) => (
    <button key={id} type="button" onClick={() => setFilter(id)} className={`h-9 rounded-control border px-3.5 text-[14px] font-semibold ${filter === id ? "border-accent bg-accent text-white" : "border-line bg-surface text-ink-2 hover:bg-surface-hover"}`}>{label}</button>
  );
  const showFundstrat = filter === "all" || filter === "strategy" || filter === "technical";

  return (
    <Page title="Strategists" lede="What each strategist is saying, in their own terms. Their views, not ours.">
      <div className="flex flex-wrap items-center gap-2">
        {pill("all", "All")}
        {pill("strategy", "Strategy")}
        {pill("technical", "Technical")}
        {pill("fx", "Currency")}
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        {showFundstrat && filter !== "strategy" && <FundstratCard who="Mark Newton" firm="Fundstrat" v={fs.data?.newton ?? null} archive={newtonArchive} />}
        {showFundstrat && filter !== "technical" && <FundstratCard who="Tom Lee" firm="Fundstrat" v={fs.data?.lee ?? null} archive={leeArchive} />}
        {sources.map((g) => <SourceCard key={g[0].id} reports={g} />)}
      </div>

      {reports.loading ? (
        <Card><Loading what="Loading reports" /></Card>
      ) : !table.length ? (
        <Card title="No RBC, J.P. Morgan or other reports on file yet">
          <Bullets
            items={[
              <>Forward the report (PDF attached, or the text pasted in) to the dashboard inbox address.</>,
              <>Start the subject with what it is and who it is from: <span className="font-semibold">Strategy: RBC – …</span>, <span className="font-semibold">Technical: JPM – …</span>, <span className="font-semibold">FX: RBC – …</span>, <span className="font-semibold">Strategy: Other – BCA Research – …</span></>,
              <>It appears here within about five minutes, with a short summary and a full one. Reports are kept for a year.</>,
            ]}
          />
        </Card>
      ) : (
        <Card title="Everything on file" sub={`${table.length} reports · kept one year`} pad={false}>
          <Table head={[{ label: "Date" }, { label: "Firm" }, { label: "Author" }, { label: "Type" }, { label: "Stance" }, { label: "Title" }]} minWidth={860}>
            {table.map((r) => (
              <tr key={r.id}>
                <td className={`${TD} whitespace-nowrap`}>{fmtAsOf(r.date)}</td>
                <td className={`${TD} whitespace-nowrap font-semibold`}>{firmLabel(r)}</td>
                <td className={`${TD} whitespace-nowrap`}>{r.author || "—"}</td>
                <td className={TD}>{KIND_LABEL[r.kind]}</td>
                <td className={`${TD} max-w-[260px] text-[14.5px]`}>{r.summary?.stance ?? <span className="text-ink-3">no summary</span>}</td>
                <td className={`${TD} max-w-[320px] text-[14px] text-ink-2`}>{r.title}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      <p className="px-1 text-[13px] text-ink-3">
        Stance and summaries are extracted from each report by AI and reflect the author&apos;s view only. Newton and Lee come from the Fundstrat daily notes; the summary covers their latest note.
      </p>
    </Page>
  );
}
