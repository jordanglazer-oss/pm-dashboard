"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/app/components/PageHeading";
import { AppIcon } from "@/app/components/AppIcon";
import { Skeleton } from "@/app/components/Skeleton";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import { displayTicker } from "@/app/lib/ticker";
import type { FundOnePager, FundRow } from "@/app/lib/fund-one-pagers-shared";

/**
 * /funds — a client one-pager for every fund / ETF in the PIM model: why we
 * own it, the manager, the process, the record, fees, risks and talking
 * points. AI drafts (with web research), the PM edits and signs, then prints
 * or saves as PDF from the print view.
 */

const BTN =
  "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover disabled:opacity-50";
const BUCKET_LABEL: Record<FundRow["bucket"], string> = { thematic: "Thematic", core: "Core", fixedIncome: "Fixed income", other: "Other" };

type Draft = Omit<FundOnePager, "updatedAt" | "signedAt" | "history">;

const pctOr = (v?: number) => (v == null ? "—" : `${v.toFixed(1)}%`);

function Facts({ f }: { f: FundRow["facts"] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-3">
      {f.category && <span>{f.category}</span>}
      {f.expenseRatio != null && <span>MER {f.expenseRatio}%</span>}
      {f.perf && (
        <span>
          Fund 1y/3y/5y {pctOr(f.perf.oneYear)} / {pctOr(f.perf.threeYear)} / {pctOr(f.perf.fiveYear)}
        </span>
      )}
      {f.categoryPerf && (
        <span>
          Category {pctOr(f.categoryPerf.oneYear)} / {pctOr(f.categoryPerf.threeYear)} / {pctOr(f.categoryPerf.fiveYear)}
        </span>
      )}
      {f.asOf && <span>data as of {f.asOf}</span>}
    </div>
  );
}

function Field({ label, value, onChange, rows = 2, list = false }: { label: string; value: string; onChange: (v: string) => void; rows?: number; list?: boolean }) {
  return (
    <label className="flex flex-col gap-1 text-[12px] text-ink-3">
      <span>
        {label}
        {list && <span className="text-ink-faint"> · one per line</span>}
      </span>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows} className="rounded-control border border-line bg-surface px-2.5 py-1.5 text-[13px] leading-relaxed text-ink" />
    </label>
  );
}

function Editor({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  const set = (k: keyof Draft, v: unknown) => onChange({ ...draft, [k]: v });
  const lines = (v: string) => v.split("\n").map((x) => x.trim()).filter(Boolean);
  return (
    <div className="grid gap-2.5 md:grid-cols-2">
      <Field label="Fund name" value={draft.name} onChange={(v) => set("name", v)} rows={1} />
      <Field label="Headline (the one sentence a client takes away)" value={draft.headline} onChange={(v) => set("headline", v)} />
      <Field label="Why we own it" value={draft.whyWeOwn.join("\n")} onChange={(v) => set("whyWeOwn", lines(v))} rows={4} list />
      <Field label="Talking points" value={draft.talkingPoints.join("\n")} onChange={(v) => set("talkingPoints", lines(v))} rows={4} list />
      <Field label="Manager — firm" value={draft.manager.firm} onChange={(v) => set("manager", { ...draft.manager, firm: v })} rows={1} />
      <Field label="Manager — team and tenure" value={`${draft.manager.team}${draft.manager.since ? `\n${draft.manager.since}` : ""}`} onChange={(v) => { const [team, ...rest] = v.split("\n"); set("manager", { ...draft.manager, team: team ?? "", since: rest.join(" ") }); }} />
      <Field label="Philosophy" value={draft.manager.philosophy} onChange={(v) => set("manager", { ...draft.manager, philosophy: v })} rows={3} />
      <Field label="Process" value={draft.process} onChange={(v) => set("process", v)} rows={3} />
      <Field label="Role in our portfolio" value={draft.role} onChange={(v) => set("role", v)} />
      <Field label="Record vs category" value={draft.record} onChange={(v) => set("record", v)} rows={3} />
      <Field label="Fees" value={draft.fees} onChange={(v) => set("fees", v)} rows={1} />
      <Field label="Risks" value={draft.risks.join("\n")} onChange={(v) => set("risks", lines(v))} rows={3} list />
      <Field label="What would make us reconsider (internal — not printed)" value={draft.watch} onChange={(v) => set("watch", v)} />
    </div>
  );
}

function FundCard({ fund, pager, onSaved }: { fund: FundRow; pager?: FundOnePager; onSaved: (p: FundOnePager) => void }) {
  const [open, toggle] = usePersistedOpen(`funds.card.${fund.symbol}`, false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<"draft" | "save" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const draftAI = async () => {
    setBusy("draft");
    setErr(null);
    try {
      const d = await fetch("/api/fund-one-pagers/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: fund.symbol }) }).then((r) => r.json());
      if (d?.draft) setDraft(d.draft as Draft);
      else setErr(d?.error ?? "Draft failed.");
    } finally {
      setBusy(null);
    }
  };
  const sign = async () => {
    if (!draft) return;
    setBusy("save");
    setErr(null);
    try {
      const d = await fetch("/api/fund-one-pagers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: fund.symbol, pager: draft }) }).then((r) => r.json());
      if (d?.pager) {
        onSaved(d.pager as FundOnePager);
        setDraft(null);
      } else setErr(d?.error ?? "Save failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel">
      <div className="panel-h flex-wrap gap-y-1.5">
        <span className="font-mono text-[13px] font-medium text-ink">{displayTicker(fund.symbol)}</span>
        <span className="t">{pager?.name || fund.name || ""}</span>
        <span className="m">
          {BUCKET_LABEL[fund.bucket]} · {(fund.weightInClass * 100).toFixed(1)}% of {fund.assetClass === "equity" ? "equity" : "the class"}
          {pager?.signedAt ? <> · signed <span className="font-mono">{pager.signedAt.slice(0, 10)}</span>{pager.aiDrafted ? " · AI-drafted" : ""}</> : " · no one-pager yet"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button className={BTN} disabled={!!busy} onClick={draftAI} title="Researches the fund and manager and drafts the page. Nothing is saved until you sign.">
            <AppIcon name="spark" size={13} />
            {busy === "draft" ? "Researching… (~1 min)" : pager ? "Redraft with AI" : "Draft with AI"}
          </button>
          {pager && !draft && (
            <button className={BTN} onClick={() => setDraft({ ...pager })}>
              <AppIcon name="edit" size={13} /> Edit
            </button>
          )}
          {pager && (
            <Link href={`/print/fund/${encodeURIComponent(fund.symbol)}`} target="_blank" className={`${BTN} !text-ink-2`}>
              <AppIcon name="download" size={13} /> Print / PDF
            </Link>
          )}
          <button type="button" onClick={toggle} className="grid h-7 w-7 place-items-center rounded-pill border border-line bg-surface text-ink-2" aria-label={open ? "Collapse" : "Expand"} aria-expanded={open}>
            <AppIcon name={open ? "chevU" : "chevD"} size={14} />
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-2.5 px-3.5 py-2.5">
        <Facts f={fund.facts} />
        {err && <p className="text-[12.5px] text-neg">{err}</p>}
        {draft ? (
          <>
            <p className="text-[12.5px] text-ink-3">Review every line before signing — this page goes to clients. Figures come from the fund data on file.</p>
            <Editor draft={draft} onChange={setDraft} />
            <div className="flex gap-2">
              <button className={BTN} disabled={!!busy} onClick={sign}>
                <AppIcon name="check" size={13} /> {busy === "save" ? "Signing…" : "Sign one-pager"}
              </button>
              <button className={BTN} onClick={() => setDraft(null)}>Discard</button>
            </div>
          </>
        ) : pager && open ? (
          <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-ink-2">
            <p className="font-medium text-ink">{pager.headline}</p>
            <div>
              <div className="text-[11.5px] uppercase tracking-wide text-ink-3">Why we own it</div>
              <ul className="list-disc pl-5">{pager.whyWeOwn.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
            <div>
              <div className="text-[11.5px] uppercase tracking-wide text-ink-3">Talking points</div>
              <ul className="list-disc pl-5">{pager.talkingPoints.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
            {pager.watch && <p className="text-[12px] text-ink-3">Internal — would make us reconsider: {pager.watch}</p>}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default function FundsPage() {
  const [data, setData] = useState<{ funds: FundRow[]; pagers: Record<string, FundOnePager> } | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await fetch("/api/fund-one-pagers").then((r) => r.json()));
    } catch {
      setData({ funds: [], pagers: {} });
    }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const signed = data ? data.funds.filter((f) => data.pagers[f.symbol.toUpperCase()]).length : 0;
  return (
    <main className="flex flex-col gap-3.5 text-ink">
      <PageHeading lede={`Why we own each fund and ETF — a one-page explainer for clients. ${data ? `${signed} of ${data.funds.length} signed.` : ""}`} />
      {!data ? (
        <Skeleton className="h-40 w-full" />
      ) : data.funds.length === 0 ? (
        <p className="text-[13px] text-ink-3">No funds found in the PIM model.</p>
      ) : (
        data.funds.map((f) => (
          <FundCard key={f.symbol} fund={f} pager={data.pagers[f.symbol.toUpperCase()]} onSaved={(p) => setData((d) => (d ? { ...d, pagers: { ...d.pagers, [f.symbol.toUpperCase()]: p } } : d))} />
        ))
      )}
    </main>
  );
}
