"use client";

/**
 * Redesign › Thesis. The team said the AI-drafted theses ("revenue should
 * stay above X") are not useful and nobody reads them. Two directions:
 *
 *  A = keep the section, reworked: ONE short plain-language statement per
 *      holding, AI drafts clearly marked "draft" until a team member
 *      approves, the long text and pillars one click away.
 *  B = cut the section: no thesis page. The statement lives only on each
 *      stock page; what is left here is a coverage checklist.
 *
 * READ-ONLY. Reads pm:position-theses through the existing GET. Writing or
 * approving a thesis stays on the current stock page (its editor saves
 * pillars and conditions together; a second editor here could drop them).
 */

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { displayTicker } from "@/app/lib/ticker";
import type { ScoredStock } from "@/app/lib/types";
import { useGet } from "./data";
import { BTN, Bullets, Card, Empty, Figure, fmtAsOf, Loading, More, Page, Table, Tag, TD, type OptionDef } from "./ui";

export const THESIS_OPTIONS: OptionDef[] = [
  { id: "a", label: "One sentence each", blurb: "Keep the section, simplified: one plain-language statement per holding. Theses that started as AI drafts are marked." },
  { id: "b", label: "Cut the section", blurb: "No thesis page. The statement lives on each stock page; this becomes a short checklist of which holdings have one written by the team." },
];

type Pillar = { title?: string; claim?: string; status?: "intact" | "watch" | "broken"; statusNote?: string };
type Thesis = { why?: string; updatedAt?: string; aiDrafted?: boolean; pillars?: Pillar[] };
type Status = "team" | "draft" | "none";
type Row = { s: ScoredStock; t: Thesis | undefined; status: Status; sentence: string };

/** The first sentence of the thesis — the "statement". */
function firstSentence(text: string | undefined): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const m = t.match(/^(.{20,240}?[.!?])(\s|$)/);
  return m ? m[1] : t.length > 240 ? `${t.slice(0, 237)}…` : t;
}

function useRows(): { rows: Row[]; loading: boolean } {
  const { portfolioStocks } = useStocks();
  const { data, loading } = useGet<Record<string, Thesis>>("/api/kv/position-theses", (raw) => (raw as { theses?: Record<string, Thesis> })?.theses ?? null);
  const rows = useMemo(
    () =>
      portfolioStocks
        .filter((s) => !s.instrumentType || s.instrumentType === "stock")
        .map((s): Row => {
          const t = data?.[s.ticker.toUpperCase()];
          const status: Status = !t?.why ? "none" : t.aiDrafted ? "draft" : "team";
          return { s, t, status, sentence: firstSentence(t?.why) };
        })
        .sort((a, b) => a.s.ticker.localeCompare(b.s.ticker)),
    [portfolioStocks, data],
  );
  return { rows, loading };
}

function StatusTag({ st }: { st: Status }) {
  if (st === "team") return <Tag kind="green">Written by the team</Tag>;
  if (st === "draft") return <Tag kind="yellow" title="This thesis started from an AI draft. The system does not yet record a separate team approval.">Started as an AI draft</Tag>;
  return <Tag kind="red">Not written</Tag>;
}

const stockHref = (t: string) => `/stock/${encodeURIComponent(t.toLowerCase())}`;

function Counts({ rows }: { rows: Row[] }) {
  const n = (st: Status) => rows.filter((r) => r.status === st).length;
  return (
    <Card>
      <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
        <Figure label="Stocks we own" value={rows.length} />
        <Figure label="Written by the team" value={n("team")} valueClass="text-pos" />
        <Figure label="Started as AI drafts" value={n("draft")} valueClass={n("draft") ? "text-warn" : ""} />
        <Figure label="Not written" value={n("none")} valueClass={n("none") ? "text-neg" : ""} />
      </div>
    </Card>
  );
}

function OptionA({ rows }: { rows: Row[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card title="Why we own each stock" sub="one statement per holding" pad={false}>
      {rows.map((r) => {
        const isOpen = open === r.s.ticker;
        const pillars = (r.t?.pillars ?? []).filter((p) => p.title || p.claim);
        const hasMore = Boolean(r.t?.why && (r.t.why.trim().length > r.sentence.length || pillars.length));
        return (
          <div key={r.s.ticker} className="border-b border-line-soft px-5 py-4 last:border-b-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Link href={stockHref(r.s.ticker)} className="text-[17px] font-bold !text-ink hover:underline">{displayTicker(r.s.ticker)}</Link>
              <span className="text-[14px] text-ink-3">{r.s.name}</span>
              <StatusTag st={r.status} />
              {r.t?.updatedAt && <span className="text-[12.5px] text-ink-3">updated {fmtAsOf(r.t.updatedAt)}</span>}
            </div>
            <p className="mt-1.5 max-w-[85ch] text-[16px] leading-relaxed">{r.sentence || <span className="text-ink-3">No statement yet.</span>}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-4 text-[14px]">
              {hasMore && (
                <button type="button" onClick={() => setOpen(isOpen ? null : r.s.ticker)} className="font-semibold text-accent underline">
                  {isOpen ? "Hide the full text" : "Read the full text"}
                </button>
              )}
              <Link href={stockHref(r.s.ticker)} className="font-semibold !text-accent underline">
                {r.status === "none" ? "Write it" : r.status === "draft" ? "Review" : "Edit"}
              </Link>
            </div>
            {isOpen && (
              <div className="mt-3 rounded-control bg-surface-2 px-4 py-3">
                <p className="max-w-[85ch] whitespace-pre-line text-[15px] leading-relaxed">{r.t?.why}</p>
                {pillars.length > 0 && (
                  <Bullets
                    className="mt-3"
                    items={pillars.map((p, i) => (
                      <span key={i}>
                        <span className="font-semibold">{p.title || p.claim}</span>
                        {p.status ? <span className="text-ink-2"> · {p.status}</span> : null}
                        {p.statusNote ? <span className="text-ink-2"> — {p.statusNote}</span> : null}
                      </span>
                    ))}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </Card>
  );
}

function OptionB({ rows }: { rows: Row[] }) {
  const todo = rows.filter((r) => r.status !== "team");
  const done = rows.filter((r) => r.status === "team");
  const table = (list: Row[]) => (
    <Table head={[{ label: "Stock" }, { label: "Status" }, { label: "Last updated" }, { label: "" }]} minWidth={560}>
      {list.map((r) => (
        <tr key={r.s.ticker}>
          <td className={TD}>
            <span className="font-bold">{displayTicker(r.s.ticker)}</span>
            <span className="ml-2 text-[13.5px] text-ink-3">{r.s.name}</span>
          </td>
          <td className={TD}><StatusTag st={r.status} /></td>
          <td className={`${TD} text-ink-2`}>{r.t?.updatedAt ? fmtAsOf(r.t.updatedAt) : "—"}</td>
          <td className={`${TD} text-right`}>
            <Link href={`/redesign/stock/a/${encodeURIComponent(r.s.ticker.toLowerCase())}`} className="font-semibold !text-accent underline">Open stock page</Link>
          </td>
        </tr>
      ))}
    </Table>
  );
  return (
    <>
      <Card title="What would change" >
        <Bullets
          items={[
            "The Thesis page leaves the menu. Nothing is deleted: every thesis stays on file.",
            "Each stock page keeps one short \"Why we own it\" statement, written or approved by the team.",
            "Pillars, kill conditions and AI reviews move behind an expandable section on the stock page.",
            "This checklist is all that remains: which holdings still need a statement.",
          ]}
        />
      </Card>
      <Card title="Still need a team-written statement" sub={`${todo.length} of ${rows.length}`} pad={false}>
        {todo.length ? table(todo) : <div className="px-5"><Empty>Every holding has a team-written statement.</Empty></div>}
      </Card>
      <Card title="Done" pad={false}>
        <More prefKey="redesign.thesis.b.done" label="holdings with a team-written statement" count={done.length}>
          <div className="-mx-5">{done.length ? table(done) : <div className="px-5"><Empty>None yet.</Empty></div>}</div>
        </More>
      </Card>
    </>
  );
}

export default function ThesisView({ opt }: { opt: string }) {
  const { rows, loading } = useRows();
  return (
    <Page title="Thesis" lede="Why we own each stock, in plain language." right={<Link href="/thesis" className={BTN}>Current Thesis page</Link>}>
      {loading ? (
        <Card><Loading what="Loading theses" /></Card>
      ) : !rows.length ? (
        <Card><Empty>No stocks in the portfolio.</Empty></Card>
      ) : (
        <>
          <Counts rows={rows} />
          {opt === "b" ? <OptionB rows={rows} /> : <OptionA rows={rows} />}
        </>
      )}
      <p className="px-1 text-[13px] text-ink-3">
        The system records whether a thesis started as an AI draft, not whether the team has since approved it — an &quot;Approve&quot; step would need adding. View only here; writing happens on the stock page.
      </p>
    </Page>
  );
}
