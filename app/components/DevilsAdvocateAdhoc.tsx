"use client";

import React, { useCallback, useEffect, useState } from "react";
import type { DaAdhocRecord, DaVerdict } from "@/app/lib/agents/devils-advocate-shared";
import { Explain } from "@/app/components/Explain";

/**
 * On-demand devil's advocate for ONE book name we do not hold — the case
 * against BUYING it today, generated like a score or a thesis before a buy
 * decision. Reads the latest write-up from
 * GET /api/agents/devils-advocate?ticker= and writes a new one with
 * POST { ticker, adhoc: true } (a few cents, watchers' key; stored under its
 * own key, never the monthly review's). Holdings are covered by the monthly
 * run on the Monitor page instead.
 */

const BTN = "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover disabled:opacity-50";
const TONE: Record<DaVerdict, string> = { "would not buy today": "text-neg", "hold, would not add": "text-warn", "would buy today": "text-pos" };

type RunReply = { ok?: boolean; skipped?: string; error?: string; record?: DaAdhocRecord };

export default function DevilsAdvocateAdhoc({ ticker }: { ticker: string }) {
  const [record, setRecord] = useState<DaAdhocRecord | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = (await fetch(`/api/agents/devils-advocate?ticker=${encodeURIComponent(ticker)}`).then((r) => r.json())) as { record?: DaAdhocRecord | null };
      setRecord(d?.record ?? null);
    } catch {
      setRecord(null);
    }
  }, [ticker]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const generate = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const d = (await fetch("/api/agents/devils-advocate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticker, adhoc: true }) }).then((r) => r.json())) as RunReply;
      if (d.record) setRecord(d.record);
      else setMsg(d.error ?? (d.skipped ? `Not written: ${d.skipped}` : "Nothing was written."));
    } catch {
      setMsg("Could not run.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-2">
        <button className={BTN} disabled={busy || record === undefined} onClick={generate}>
          {busy ? "Writing… (up to a minute)" : record ? "Regenerate" : "Generate devil's advocate"}
        </button>
        <span className="text-ink-3">A few cents per run.</span>
      </div>
      {msg && <p className="text-ink-2">{msg}</p>}
      {record && (
        <div>
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className={`text-[13px] font-semibold ${TONE[record.verdict] ?? "text-ink-2"}`}>{record.verdict.charAt(0).toUpperCase() + record.verdict.slice(1)}</span>
            <span className="text-[12px] text-ink-faint">
              confidence {record.confidence} · written {record.at.slice(0, 10)}
              {record.kind !== "fund" && !record.onFile.thesis ? " · no signed thesis on file" : ""}
              {record.kind === "fund" && !record.onFile.onePager ? " · no signed one-pager on file" : ""}
            </span>
          </div>
          <ul className="mt-1.5 list-disc pl-5 text-[13px] leading-relaxed text-ink-2">
            {record.strongestCaseAgainst.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
          {record.weakestPillar && (
            <p className="mt-1.5 text-ink-3">
              <span className="font-semibold text-ink-2">Weakest {record.kind === "fund" ? "point" : "pillar"}:</span> {record.weakestPillar}
            </p>
          )}
          {record.whatWouldChangeMind && (
            <p className="mt-1 text-ink-3">
              <span className="font-semibold text-ink-2">What would change this:</span> {record.whatWouldChangeMind}
            </p>
          )}
          {!!record.history?.length && (
            <p className="mt-1.5 text-[12px] text-ink-faint">
              Earlier: {record.history.map((h) => `${h.at.slice(0, 10)} ${h.verdict}`).join(" · ")}
            </p>
          )}
        </div>
      )}
      {record === null && !msg && <p className="text-ink-3">None written yet.</p>}
      <Explain prefKey="explain.stock.devilsAdvocate" label="About this write-up">
        The strongest case against buying this name today, argued only from what is on file (thesis, FactSet alerts, analyst trend) with no web search. Names we already hold get theirs in the monthly run on the Monitor page.
      </Explain>
    </div>
  );
}
