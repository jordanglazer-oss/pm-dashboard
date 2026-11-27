"use client";

/**
 * Strategists (Nov 26 2026 team session). One card per source, in two groups
 * — Strategists and Technicals — from the ONE list in
 * app/lib/strategist-sources.ts (adding a source there needs no change here).
 *
 * Each card: name, firm, stance (Positive / Neutral / Negative, read from the
 * report's own wording or set by hand), 3–4 bullets, the date of the latest
 * update, and the full summary + earlier reports behind one persisted expand.
 * A source with nothing on file says "no report yet" or "source pending".
 * Reports that match no configured source are listed under "Other reports on
 * file", and the full table of everything on file stays under "All reports".
 *
 * Everything shown is the STRATEGIST'S view — never ours. Reads
 * /api/strategist-reports and /api/fundstrat-view (read-only). The only write
 * is a hand-set stance (POST /api/strategist-stance, one id at a time).
 */

import React, { useMemo, useState } from "react";
import type { ReportKind, StrategistReport } from "@/app/lib/strategist-reports";
import type { FundstratView, StrategistView } from "@/app/api/fundstrat-view/route";
import {
  GROUP_LABEL,
  STRATEGIST_SOURCES,
  fundstratKey,
  reportsFor,
  resolveStance,
  unmatchedReports,
  type SourceGroup,
  type Stance,
  type StanceOverrides,
  type StrategistSource,
} from "@/app/lib/strategist-sources";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import { useStocks } from "@/app/lib/StockContext";
import { Explain } from "@/app/components/Explain";
import { useGet } from "@/app/components/redesign/data";
import { Bullets, Card, Empty, fmtAsOf, Loading, More, Page, Table, Tag, TD } from "@/app/components/redesign/ui";

const KIND_LABEL: Record<ReportKind, string> = { strategy: "Strategy", technical: "Technical", fx: "Currency" };
type Filter = "all" | ReportKind;
const STANCES: Stance[] = ["Positive", "Neutral", "Negative"];

const firmLabel = (r: StrategistReport) => (r.firm === "Other" ? r.firmName || "Other" : r.firm === "JPM" ? "J.P. Morgan" : r.firm);
const LINK = "text-[14px] font-semibold text-accent underline";

function StanceTag({ stance, byHand }: { stance: Stance | null; byHand: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Tag kind={stance === "Positive" ? "green" : stance === "Negative" ? "red" : "neutral"} title="The strategist's stance, not ours">{stance ?? "Not stated"}</Tag>
      {byHand && <span className="text-[13px] text-ink-3">set by hand</span>}
    </span>
  );
}

/** Set, change or clear the hand-set stance for one read. */
function StanceSetter({ id, current, byHand, onSaved }: { id: string; current: Stance | null; byHand: boolean; onSaved: (o: StanceOverrides) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    fetch("/api/strategist-stance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...body }) })
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok || !d?.overrides) throw new Error(d?.error ?? "Could not save.");
        onSaved(d.overrides as StanceOverrides);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not save."))
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
      <span className="font-semibold text-ink-2">Set the stance by hand:</span>
      {STANCES.map((s) => (
        <button key={s} type="button" disabled={busy} onClick={() => send({ stance: s })} className={`h-8 rounded-control border px-3 text-[13.5px] font-semibold disabled:opacity-50 ${byHand && current === s ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink-2 hover:bg-surface-hover"}`}>
          {s}
        </button>
      ))}
      {byHand && (
        <button type="button" disabled={busy} onClick={() => send({ clear: true })} className="text-[13.5px] font-semibold text-accent underline disabled:opacity-50">
          Use the report&apos;s wording
        </button>
      )}
      {error && <span className="text-neg">{error}</span>}
    </div>
  );
}

/** The complete summary of one emailed report, with its levels, currency views and original text on request. */
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
    <div className="flex flex-col gap-4 rounded-control bg-surface-2 px-4 py-3.5">
      {s?.full.length ? (
        s.full.map((sec, i) => (
          <div key={i}>
            {sec.heading && <div className="mb-1 text-[14px] font-bold text-ink">{sec.heading}</div>}
            <Bullets items={sec.points} />
          </div>
        ))
      ) : (
        <Empty>{r.source === "note" ? "A daily note: the original text is below." : r.summaryError ? `No summary: ${r.summaryError}` : "No summary on file for this report."}</Empty>
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
          <button type="button" onClick={loadText} className={LINK}>
            Show the original report text ({r.chars.toLocaleString()} characters)
          </button>
        )}
      </div>
    </div>
  );
}

/** A dated list of reports; one opens at a time. */
function ReportList({ reports, overrides, showFirm }: { reports: StrategistReport[]; overrides: StanceOverrides; showFirm?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      {reports.map((r) => {
        const st = resolveStance(r.summary?.stance, r.id, overrides);
        return (
          <div key={r.id} className="border-b border-line-soft py-2 last:border-b-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="w-[64px] shrink-0 text-[13px] text-ink-3">{fmtAsOf(r.date)}</span>
              <span className="min-w-0 flex-1 text-[14.5px]">
                {showFirm && <span className="font-semibold">{firmLabel(r)}{r.author ? ` · ${r.author}` : ""} · </span>}
                <span className={showFirm ? "" : "font-semibold"}>{r.summary?.stance ?? r.title}</span>
                {r.summary ? <span className="text-ink-3"> · {r.title}</span> : null}
              </span>
              {r.source !== "note" && <StanceTag stance={st.stance} byHand={st.byHand} />}
              <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} className="text-[13.5px] font-semibold text-accent underline">{open === r.id ? "Hide" : "Open"}</button>
            </div>
            {open === r.id && <div className="mt-2"><FullSummary r={r} /></div>}
          </div>
        );
      })}
    </div>
  );
}

function SourceCard({ source, reports, view, overrides, onSaved }: { source: StrategistSource; reports: StrategistReport[]; view: StrategistView | null; overrides: StanceOverrides; onSaved: (o: StanceOverrides) => void }) {
  const [open, toggle] = usePersistedOpen(`strategists.card.${source.id}`, false);
  const emailed = reports.filter((r) => r.source !== "note");
  const notes = reports.length - emailed.length;
  const fs = source.fundstrat && view ? view : null;
  const latest = fs ? null : (emailed[0] ?? null);
  const has = Boolean(fs || latest);

  const stanceText = fs ? fs.stance : (latest?.summary?.stance ?? "");
  const key = fs && source.fundstrat ? fundstratKey(source.fundstrat, fs.date) : (latest?.id ?? null);
  const st = resolveStance(stanceText, key, overrides);
  const bullets = fs ? fs.bullets : (latest?.summary?.bullets ?? []);
  const date = fs ? fs.date : latest?.date;
  const earlier = fs ? emailed : emailed.slice(1);

  return (
    <section className="flex flex-col gap-2 rounded-card border border-line-soft bg-surface px-5 py-4 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[19px] font-bold tracking-tight">{source.name}</span>
        <span className="text-[14px] text-ink-3">{source.firm}</span>
        {has ? <StanceTag stance={st.stance} byHand={st.byHand} /> : <Tag kind={source.pending ? "yellow" : "neutral"}>{source.pending ? "Source pending" : "No report yet"}</Tag>}
        <span className="ml-auto text-[13px] text-ink-3">{date ? fmtAsOf(date) : source.fundstrat ? "no recent note" : "no update on file"}</span>
      </div>

      {has ? (
        <>
          <div className="text-[15px] leading-snug text-ink-2">
            <span className="text-ink-3">In their words: </span>
            <span className="font-semibold capitalize text-ink">{stanceText || "no stance stated"}</span>
            {fs?.headline ? <span> — {fs.headline}</span> : null}
          </div>
          {latest && <div className="text-[13.5px] text-ink-3">{latest.title}</div>}
          {bullets.length ? <Bullets items={bullets.slice(0, 4)} className="mt-1" /> : <Empty>{latest?.summaryError ? `No summary: ${latest.summaryError}` : "No summary on file."}</Empty>}
        </>
      ) : (
        <div className="text-[14.5px] text-ink-2">
          {source.pending ? <p><span className="font-semibold text-ink">Source pending:</span> {source.pending}.</p> : source.fundstrat ? <p>No note in the last 30 days.</p> : <p>No report on file yet.</p>}
          {source.subject && <p className="mt-1 text-[13.5px] text-ink-3">To file one, email it to the dashboard inbox with the subject <span className="font-semibold text-ink-2">{source.subject}</span></p>}
        </div>
      )}

      {(has || earlier.length > 0 || notes > 0) && (
        <button type="button" onClick={toggle} aria-expanded={open} className={`self-start pt-1 ${LINK}`}>
          {open ? "Hide the full summary" : `Show the full summary${earlier.length ? ` and ${earlier.length} earlier ${earlier.length === 1 ? "report" : "reports"}` : ""}`}
        </button>
      )}
      {open && (
        <div className="flex flex-col gap-3 border-t border-line-soft pt-3">
          {fs && (
            <div className="flex flex-col gap-2 rounded-control bg-surface-2 px-4 py-3.5">
              <Bullets items={fs.bullets} />
              {fs.watch?.length ? <p className="text-[14.5px] text-ink-2"><span className="font-semibold text-ink">Favoured: </span>{fs.watch.join(", ")}</p> : null}
              {fs.changeVsPrior ? <p className="text-[14.5px] text-ink-2"><span className="font-semibold text-ink">Change from the prior note: </span>{fs.changeVsPrior}</p> : null}
            </div>
          )}
          {latest && <FullSummary r={latest} />}
          {key && <StanceSetter id={key} current={st.stance} byHand={st.byHand} onSaved={onSaved} />}
          {earlier.length > 0 && (
            <div>
              <div className="text-[14px] font-bold text-ink">{fs ? "Reports on file" : "Earlier reports"}</div>
              <ReportList reports={earlier} overrides={overrides} />
            </div>
          )}
        </div>
      )}
      {notes > 0 && <div className="text-[13px] text-ink-3">{notes} daily {notes === 1 ? "note" : "notes"} in the one-year archive</div>}
    </section>
  );
}

export default function StrategistsPage() {
  const { uiPrefs, setUiPref } = useStocks();
  const reports = useGet<StrategistReport[]>("/api/strategist-reports", (raw) => (raw as { reports?: StrategistReport[] })?.reports ?? null);
  const fs = useGet<FundstratView>("/api/fundstrat-view", (raw) => (raw as { result?: FundstratView | null })?.result ?? null);
  const stored = useGet<StanceOverrides>("/api/strategist-stance");
  const [saved, setSaved] = useState<StanceOverrides | null>(null);
  // What was just saved in this tab wins over the copy loaded with the page.
  const overrides = saved ?? stored.data ?? {};
  const filter: Filter = (["strategy", "technical", "fx"] as const).find((k) => k === uiPrefs["strategists.filter"]) ?? "all";

  const all = useMemo(() => reports.data ?? [], [reports.data]);
  const { bySource, other, table } = useMemo(() => {
    const emailed = all.filter((r) => r.source !== "note");
    return {
      bySource: new Map(STRATEGIST_SOURCES.map((s) => [s.id, reportsFor(s, all)])),
      other: unmatchedReports(emailed),
      table: emailed,
    };
  }, [all]);
  const shown = filter === "all" ? table : table.filter((r) => r.kind === filter);

  const pill = (id: Filter, label: string) => (
    <button key={id} type="button" onClick={() => setUiPref("strategists.filter", id)} className={`h-9 rounded-control border px-3.5 text-[14px] font-semibold ${filter === id ? "border-accent bg-accent text-white" : "border-line bg-surface text-ink-2 hover:bg-surface-hover"}`}>{label}</button>
  );
  const group = (g: SourceGroup) => (
    <div key={g} className="flex flex-col gap-3">
      <h2 className="px-1 text-[20px] font-bold tracking-tight text-ink">{GROUP_LABEL[g]}</h2>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {STRATEGIST_SOURCES.filter((s) => s.group === g).map((s) => (
          <SourceCard key={s.id} source={s} reports={bySource.get(s.id) ?? []} view={s.fundstrat ? (fs.data?.[s.fundstrat] ?? null) : null} overrides={overrides} onSaved={setSaved} />
        ))}
      </div>
    </div>
  );

  return (
    <Page title="Strategists" lede="What each strategist is saying. Their views, not ours.">
      {reports.loading && <Card><Loading what="Loading reports" /></Card>}
      {group("strategists")}
      {group("technicals")}

      <Explain prefKey="explain.strategists.stance" label="How the stance is set" className="px-1">
        <p className="text-[13px]">Positive, Neutral or Negative is read from the report&apos;s own wording (for example &ldquo;constructive&rdquo; reads Positive, &ldquo;cautious&rdquo; reads Negative; the first such word decides). Wording that fits none shows &ldquo;Not stated&rdquo;. It is the author&apos;s view, never ours. Open a card to set the stance by hand; that is marked &ldquo;set by hand&rdquo; and can be undone. Summaries are extracted from each report by AI. Newton and Lee come from the Fundstrat daily notes; the summary covers their latest note. No economists are listed.</p>
      </Explain>

      {other.length > 0 && (
        <Card title="Other reports on file" sub={`${other.length} not tied to a listed strategist`}>
          <ReportList reports={other} overrides={overrides} showFirm />
        </Card>
      )}

      <Card title="All reports" sub={`${table.length} on file · kept one year`} pad={false}>
        {!reports.loading && !table.length ? (
          <div className="px-5 py-4">
            <Empty>No RBC, J.P. Morgan or other reports on file yet.</Empty>
            <Bullets
              items={[
                <>Forward the report (PDF attached, or the text pasted in) to the dashboard inbox address.</>,
                <>Start the subject with what it is and who it is from: <span className="font-semibold">Strategy: RBC – …</span>, <span className="font-semibold">Technical: JPM – …</span>, <span className="font-semibold">FX: RBC – …</span>, <span className="font-semibold">Strategy: Other – BCA Research – …</span></>,
                <>It appears here within about five minutes, with a short summary and a full one. Reports are kept for a year.</>,
              ]}
            />
          </div>
        ) : (
          <More prefKey="strategists.allReports" label="every report on file" count={table.length}>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {pill("all", "All")}
              {pill("strategy", "Strategy")}
              {pill("technical", "Technical")}
              {pill("fx", "Currency")}
            </div>
            <div className="-mx-5">
              <Table head={[{ label: "Date" }, { label: "Firm" }, { label: "Author" }, { label: "Type" }, { label: "Stance" }, { label: "In their words" }, { label: "Title" }]} minWidth={980}>
                {shown.map((r) => {
                  const st = resolveStance(r.summary?.stance, r.id, overrides);
                  return (
                    <tr key={r.id}>
                      <td className={`${TD} whitespace-nowrap`}>{fmtAsOf(r.date)}</td>
                      <td className={`${TD} whitespace-nowrap font-semibold`}>{firmLabel(r)}</td>
                      <td className={`${TD} whitespace-nowrap`}>{r.author || "—"}</td>
                      <td className={TD}>{KIND_LABEL[r.kind]}</td>
                      <td className={`${TD} whitespace-nowrap`}><StanceTag stance={st.stance} byHand={st.byHand} /></td>
                      <td className={`${TD} max-w-[240px] text-[14.5px]`}>{r.summary?.stance ?? <span className="text-ink-3">no summary</span>}</td>
                      <td className={`${TD} max-w-[300px] text-[14px] text-ink-2`}>{r.title}</td>
                    </tr>
                  );
                })}
                {!shown.length && (
                  <tr><td colSpan={7} className={`${TD} text-ink-3`}>No reports of this type on file.</td></tr>
                )}
              </Table>
            </div>
          </More>
        )}
      </Card>
    </Page>
  );
}
