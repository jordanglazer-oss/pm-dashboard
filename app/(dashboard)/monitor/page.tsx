"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { displayTicker } from "@/app/lib/ticker";
import { Skeleton } from "@/app/components/Skeleton";
import { EmptyState } from "@/app/components/EmptyState";
import { StatStrip } from "@/app/components/StatStrip";
import { AppIcon } from "@/app/components/AppIcon";
import { PageHeading } from "@/app/components/PageHeading";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import type { AgentFlag } from "@/app/lib/agents/flags";
import type { CompareRun, CompareAnswer } from "@/app/lib/agents/earnings-compare";
import type { HoldingsDay, HoldingsEvent } from "@/app/lib/agents/holdings-watch";
import type { StanceState } from "@/app/lib/agents/stance-watch";
import type { ManagerState } from "@/app/lib/agents/manager-watch";
import type { Memo } from "@/app/lib/agents/sunday-memo";

/**
 * /monitor — the watchers' desk. What they flagged (Act / Dismiss / note),
 * what they cost this month against the stop line, and which model each one
 * runs on. Watchers suggest only; acting on a flag here records the PM's
 * decision on the flag, it never trades or changes the book.
 */

type Status = {
  key: "ok" | "missing" | "same-as-main";
  paused: boolean;
  spend: {
    month: string;
    totalUsd: number;
    capUsd: number;
    stopUsd: number;
    stopped: boolean;
    byWatcher: { id: string; usd: number; calls: number }[];
    recent: { at: string; watcher: string; model: string; usd: number; inputTokens: number; outputTokens: number; searches: number; note?: string }[];
  };
  watchers: { id: string; label: string; phase: number; what: string; model: "haiku" | "sonnet"; defaultModel: "haiku" | "sonnet"; shadow: string | null; on: boolean }[];
};

const PRIORITY_DOT: Record<AgentFlag["priority"], string> = { high: "bg-neg", medium: "bg-warn", low: "bg-ink-faint" };
const PRIORITY_RANK: Record<AgentFlag["priority"], number> = { high: 0, medium: 1, low: 2 };

const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const BTN =
  "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover disabled:opacity-50";

function FlagCard({ flag, labelOf, onUpdate, onReplaced }: { flag: AgentFlag; labelOf: (id: string) => string; onUpdate: (id: string, action: string, note?: string) => Promise<void>; onReplaced: (f: AgentFlag) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [replyErr, setReplyErr] = useState<string | null>(null);
  const reply = async () => {
    if (!note.trim()) return;
    setBusy(true);
    setReplyErr(null);
    try {
      const d = await fetch(`/api/agents/flags/${flag.id}/reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: note.trim() }) }).then((r) => r.json());
      if (d?.flag) onReplaced(d.flag as AgentFlag);
      if (d?.error) setReplyErr(d.error);
      setNote("");
    } finally {
      setBusy(false);
    }
  };
  const run = async (action: string) => {
    setBusy(true);
    try {
      await onUpdate(flag.id, action, note.trim() || undefined);
      setNote("");
    } finally {
      setBusy(false);
    }
  };
  const open = flag.status === "open";
  return (
    <div className="flex flex-col gap-2 border-t border-line-soft px-3.5 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[flag.priority]}`} />
        {flag.ticker && (
          <Link href={`/stock/${encodeURIComponent(flag.ticker)}`} className="font-mono text-[12.5px] font-medium text-ink hover:text-accent">
            {displayTicker(flag.ticker)}
          </Link>
        )}
        <span className="text-[13.5px] font-medium text-ink">{flag.title}</span>
        <span className="ml-auto text-[11.5px] text-ink-3">
          {labelOf(flag.watcher)} · {when(flag.createdAt)}
          {!open && <> · <span className={flag.status === "acted" ? "text-pos" : "text-ink-3"}>{flag.status === "acted" ? "acted on" : "dismissed"}</span></>}
        </span>
      </div>
      <p className="text-[13px] leading-relaxed text-ink-2">{flag.detail}</p>
      {flag.suggestion && (
        <p className="text-[13px] leading-relaxed text-ink-2">
          <span className="font-medium text-ink">Suggests: </span>
          {flag.suggestion}
        </p>
      )}
      {flag.factCheck && (
        <p className={`text-[12px] ${flag.factCheck.verdict === "supported" ? "text-pos" : flag.factCheck.verdict === "partly" ? "text-warn" : "text-ink-3"}`}>
          {flag.factCheck.verdict === "supported"
            ? "Fact-checked against the sources: every figure matches."
            : flag.factCheck.verdict === "partly"
              ? `Fact-check found problems: ${flag.factCheck.problems.join("; ")}`
              : `Not fact-checked${flag.factCheck.note ? ` (${flag.factCheck.note})` : ""}.`}
        </p>
      )}
      {flag.evidence && flag.evidence.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-3">
          {flag.evidence.map((e, i) =>
            e.url ? (
              <a key={i} href={e.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                {e.label}
              </a>
            ) : (
              <span key={i}>{e.label}</span>
            )
          )}
        </div>
      )}
      {flag.thread.length > 0 && (
        <div className="flex flex-col gap-1 border-l-2 border-line pl-3">
          {flag.thread.map((m, i) => (
            <div key={i} className="text-[12.5px] text-ink-2">
              <span className="font-medium text-ink">{m.from === "pm" ? "You" : labelOf(flag.watcher)}</span>
              <span className="ml-1.5 text-[11px] text-ink-3">{when(m.at)}</span>
              <div>{m.text}</div>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={flag.conversation ? "Reply to the watcher, or a note on your decision" : open ? "Optional note — what you did or why not" : "Add a note"}
          className="h-7 min-w-[220px] flex-1 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink placeholder:text-ink-faint"
        />
        {open ? (
          <>
            <button className={BTN} disabled={busy} onClick={() => run("act")}>
              <AppIcon name="check" size={13} /> Act
            </button>
            <button className={BTN} disabled={busy} onClick={() => run("dismiss")}>
              <AppIcon name="x" size={13} /> Dismiss
            </button>
          </>
        ) : (
          <button className={BTN} disabled={busy} onClick={() => run("reopen")}>
            Reopen
          </button>
        )}
        {flag.conversation && open && (
          <button className={BTN} disabled={busy || !note.trim()} onClick={reply} title="Sends your reply; the watcher answers in the thread with the latest data.">
            {busy ? "Thinking…" : "Reply"}
          </button>
        )}
        <button className={BTN} disabled={busy || !note.trim()} onClick={() => run("note")}>
          Add note
        </button>
      </div>
      {replyErr && <p className="text-[12px] text-neg">{replyErr}</p>}
      {flag.conversation && open && <p className="text-[11.5px] text-ink-faint">Act or Dismiss with a note records your decision in the decision journal; the next review of this theme starts from it.</p>}
    </div>
  );
}

type CompareData = { runs: CompareRun[]; previewTickers: { ticker: string; latest: string; event: string | null }[] };

function Answer({ a }: { a?: CompareAnswer }) {
  if (!a) return <span className="text-ink-faint">—</span>;
  if (!a.result) return <span className="text-neg" title={a.error}>failed</span>;
  const r = a.result;
  return (
    <span title={r.detail}>
      {r.verdict} · guide {r.guidance} · thesis {r.thesisImpact}
      {r.flag && <span className="ml-1 text-warn">· flag ({r.priority})</span>}
    </span>
  );
}

function agrees(run: CompareRun): string {
  const a = run.primary.result, b = run.shadow?.result;
  if (!a || !b) return "—";
  const same = a.verdict === b.verdict && a.guidance === b.guidance && a.thesisImpact === b.thesisImpact && a.flag === b.flag;
  return same ? "yes" : "no";
}

function EarningsCompareSection() {
  const [data, setData] = useState<CompareData | null>(null);
  const [open, toggle] = usePersistedOpen("monitor.compare.open", true);
  const [ticker, setTicker] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData((await fetch("/api/agents/earnings-compare").then((r) => r.json())) as CompareData);
    } catch {
      setData({ runs: [], previewTickers: [] });
    }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const compareNow = async () => {
    const tk = ticker.trim().toUpperCase();
    if (!tk) return;
    setBusy(true);
    setMsg(null);
    try {
      const d = await fetch("/api/agents/earnings-compare", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticker: tk }) }).then((r) => r.json());
      if (d?.ok) {
        const r = d.run as CompareRun;
        setMsg(`${displayTicker(r.ticker)}: ${r.primary.result ? `${r.primary.result.verdict}, guide ${r.primary.result.guidance}` : `failed (${r.primary.error ?? "no answer"})`}${r.flagId ? " — flagged above" : r.factCheck?.verdict === "unsupported" ? ` — NOT flagged: the fact-checker found ${r.factCheck.problems.join("; ") || "facts not in the sources"}` : " — nothing flagged"}${r.previewId ? "" : " (no preview on file, judged against the recap's own consensus)"}.`);
      } else setMsg(d?.skipped ?? d?.error ?? "Could not run.");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const runs = data?.runs ?? [];
  return (
    <section className="panel">
      <button className="panel-h w-full text-left" onClick={toggle}>
        <span className="t">Earnings comparisons</span>
        <span className="m">
          {runs.length} runs · {data?.previewTickers.length ?? 0} previews on file · {open ? "hide" : "show"}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2.5 px-3.5 py-3">
          <p className="text-[12.5px] leading-relaxed text-ink-3">
            Runs by itself when a FactSet results recap arrives for a book name, comparing it with the preview that came before. During the comparison period both models read the same inputs; only Haiku&apos;s answer can raise a flag.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && compareNow()}
              placeholder="Ticker, e.g. CLS"
              className="h-7 w-[140px] rounded-control border border-line bg-surface px-2.5 font-mono text-[12.5px] text-ink placeholder:text-ink-faint"
            />
            <button className={BTN} disabled={busy || !ticker.trim()} onClick={compareNow}>
              {busy ? "Comparing…" : "Compare latest results now"}
            </button>
            {msg && <span className="text-[12.5px] text-ink-2">{msg}</span>}
          </div>
          {data?.previewTickers.length ? (
            <div className="text-[12px] text-ink-3">
              Previews on file:{" "}
              {data.previewTickers.map((p) => `${displayTicker(p.ticker)} (${p.latest})`).join(", ")}
            </div>
          ) : null}
        </div>
      )}
      {open && runs.length > 0 && (
        <div className="tbl-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="pl-3.5">When</th>
                <th>Ticker</th>
                <th>Quarter</th>
                <th>Preview</th>
                <th>Haiku</th>
                <th>Sonnet (shadow)</th>
                <th>Agree</th>
                <th className="n">Cost</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="pl-3.5 font-mono text-ink-3">{when(r.at)}</td>
                  <td className="font-mono">{displayTicker(r.ticker)}</td>
                  <td className="text-ink-2">{r.event ?? r.recapDate}</td>
                  <td className="text-ink-3">{r.previewDate ?? "none"}</td>
                  <td className="!whitespace-normal text-ink-2"><Answer a={r.primary} /></td>
                  <td className="!whitespace-normal text-ink-2"><Answer a={r.shadow} /></td>
                  <td>{agrees(r)}</td>
                  <td className="n">${(r.primary.usd + (r.shadow?.usd ?? 0)).toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function StanceSection() {
  const [state, setState] = useState<StanceState | null | undefined>(undefined);
  const [open, toggle] = usePersistedOpen("monitor.stance.open", true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(((await fetch("/api/agents/stance-watch").then((r) => r.json())) as { state: StanceState | null }).state);
    } catch {
      setState(null);
    }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const runNow = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const d = await fetch("/api/agents/stance-watch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) }).then((r) => r.json());
      setMsg(d?.ok ? `Done: ${d.state?.changes?.length ?? 0} changed since the last check.` : d?.error ?? "Could not run.");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const hw = state?.hedgeWindow;
  const windowText = hw ? (hw.window === "open" ? <span className="text-pos">open</span> : hw.window === "closed" ? <span>closed</span> : <span className="text-ink-3">unknown</span>) : null;
  return (
    <section className="panel">
      <button className="panel-h w-full text-left" onClick={toggle}>
        <span className="t">Stance &amp; hedge window</span>
        <span className="m">
          {state ? <>checked {state.date} · hedge window {windowText}</> : state === null ? "not run yet" : "…"} · {open ? "hide" : "show"}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2.5 px-3.5 py-3">
          <p className="text-[12.5px] leading-relaxed text-ink-3">
            Runs by itself after each close. Plain rules, no AI cost; the watcher writes a short read only when a reading changes. The hedge window opens only when all four tests pass, and it is flagged once when it opens.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button className={BTN} disabled={busy} onClick={runNow}>
              {busy ? "Checking…" : "Check now"}
            </button>
            {msg && <span className="text-[12.5px] text-ink-2">{msg}</span>}
          </div>
          {state && (
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <div className="mb-1 text-[11.5px] uppercase tracking-wide text-ink-3">Readings</div>
                <ul className="flex flex-col gap-1 text-[12.5px] text-ink-2">
                  {Object.entries(state.signalText).map(([k, v]) => (
                    <li key={k} className={state.changes?.some((c) => c.startsWith(v)) ? "font-medium text-ink" : ""}>{v}</li>
                  ))}
                </ul>
              </div>
              {hw && (
                <div>
                  <div className="mb-1 text-[11.5px] uppercase tracking-wide text-ink-3">Hedge window: {windowText}</div>
                  <ul className="flex flex-col gap-1 text-[12.5px] text-ink-2">
                    {hw.tests.map((t) => (
                      <li key={t.id}>
                        <span className={t.pass === true ? "text-pos" : t.pass === false ? "text-neg" : "text-ink-3"}>{t.pass === true ? "✓" : t.pass === false ? "✗" : "?"}</span> {t.label} <span className="text-ink-3">— {t.detail}</span>
                      </li>
                    ))}
                  </ul>
                  {hw.contract && (
                    <div className="mt-1.5 text-[12px] text-ink-3">
                      Priced: SPY {hw.contract.expiryLabel} ${hw.contract.strike} put, ~${hw.contract.premium?.toFixed(2) ?? "?"} ({hw.contract.pctOfSpot?.toFixed(2) ?? "?"}% of spot)
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const SEVERITY_TEXT = { ok: <span className="text-pos">OK</span>, watch: <span className="text-warn">Watch</span>, concern: <span className="text-neg">Review</span> } as const;

function ManagerSection() {
  const [state, setState] = useState<ManagerState | null | undefined>(undefined);
  const [open, toggle] = usePersistedOpen("monitor.manager.open", false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(((await fetch("/api/agents/manager-watch").then((r) => r.json())) as { state: ManagerState | null }).state);
    } catch {
      setState(null);
    }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const runNow = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const d = await fetch("/api/agents/manager-watch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) }).then((r) => r.json());
      setMsg(d?.skipped ? d.skipped : d?.ok ? `Done: ${d.state?.reviews?.length ?? 0} funds reviewed.` : d?.error ?? "Could not run.");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const reviews = state?.reviews ?? [];
  const tripped = reviews.filter((r) => r.severity !== "ok").length;
  return (
    <section className="panel">
      <button className="panel-h w-full text-left" onClick={toggle}>
        <span className="t">Manager watch</span>
        <span className="m">
          {state ? `${state.quarter} · ${reviews.length} Thematic funds · ${tripped} to look at` : state === null ? "not run yet" : "…"} · {open ? "hide" : "show"}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2.5 px-3.5 py-3">
          <p className="text-[12.5px] leading-relaxed text-ink-3">
            Once a quarter, each Thematic fund against its category over 1, 3 and 5 years, plus any fee, category or rating change since the last review. Uses the fund data on PIM Model; refresh it there first if it is old. One weak year is a watch, not a case.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button className={BTN} disabled={busy} onClick={runNow}>
              {busy ? "Reviewing…" : "Review funds now"}
            </button>
            {msg && <span className="text-[12.5px] text-ink-2">{msg}</span>}
          </div>
        </div>
      )}
      {open && reviews.length > 0 && (
        <div className="tbl-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="pl-3.5">Fund</th>
                <th className="n">1y vs cat.</th>
                <th className="n">3y vs cat.</th>
                <th className="n">5y vs cat.</th>
                <th className="n">Fee</th>
                <th>Read</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {reviews.map((r) => (
                <tr key={r.symbol}>
                  <td className="pl-3.5">
                    <span className="font-mono">{displayTicker(r.symbol)}</span>
                    {r.name && <div className="text-[11.5px] text-ink-3">{r.name}</div>}
                  </td>
                  <td className="n">{r.gaps.oneYear == null ? "—" : `${r.gaps.oneYear > 0 ? "+" : ""}${r.gaps.oneYear}`}</td>
                  <td className="n">{r.gaps.threeYear == null ? "—" : `${r.gaps.threeYear > 0 ? "+" : ""}${r.gaps.threeYear}`}</td>
                  <td className="n">{r.gaps.fiveYear == null ? "—" : `${r.gaps.fiveYear > 0 ? "+" : ""}${r.gaps.fiveYear}`}</td>
                  <td className="n">{r.expenseRatio != null ? `${r.expenseRatio}%` : "—"}</td>
                  <td className="!whitespace-normal text-ink-2">
                    {r.read ?? (r.findings.length ? r.findings.join("; ") : "No rule tripped")}
                    {r.dataAsOf && <div className="text-[11.5px] text-ink-faint">Fund data as of {r.dataAsOf}</div>}
                  </td>
                  <td className="text-[12.5px]">{SEVERITY_TEXT[r.severity]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function MemoSection() {
  const [memos, setMemos] = useState<Memo[] | null>(null);
  const [open, toggle] = usePersistedOpen("monitor.memo.open", true);
  const [showAll, toggleAll] = usePersistedOpen("monitor.memo.all", false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMemos(((await fetch("/api/agents/sunday-memo").then((r) => r.json())) as { memos: Memo[] }).memos ?? []);
    } catch {
      setMemos([]);
    }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const writeNow = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const d = await fetch("/api/agents/sunday-memo", { method: "POST" }).then((r) => r.json());
      setMsg(d?.ok ? null : d?.error ?? "Could not write the memo.");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const list = memos ?? [];
  const shown = showAll ? list : list.slice(0, 1);
  return (
    <section className="panel">
      <button className="panel-h w-full text-left" onClick={toggle}>
        <span className="t">Sunday memo</span>
        <span className="m">{list[0] ? `latest ${list[0].date} · ${list.length} in the archive` : memos === null ? "…" : "none yet"} · {open ? "hide" : "show"}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 px-3.5 py-3">
          <p className="text-[12.5px] leading-relaxed text-ink-3">Written every Sunday evening for the Monday meeting (and emailed), from what the dashboard already knows: the week, open flags, company moves, the stance, weak pillars and the coming week&apos;s earnings. No web search.</p>
          <div className="flex flex-wrap items-center gap-2">
            <button className={BTN} disabled={busy} onClick={writeNow}>
              {busy ? "Writing… (~1 min)" : "Write this week's memo now"}
            </button>
            {list.length > 1 && (
              <button className={BTN} onClick={toggleAll}>
                {showAll ? "Latest only" : `Show all ${list.length}`}
              </button>
            )}
            {msg && <span className="text-[12.5px] text-neg">{msg}</span>}
          </div>
          {shown.map((m) => (
            <div key={m.date} className="flex flex-col gap-1.5 border-t border-line-soft pt-2.5">
              <div className="text-[12px] text-ink-3">
                {m.date}
                {m.emailed ? " · emailed" : ""}
              </div>
              {m.headline && <p className="text-[13.5px] font-medium text-ink">{m.headline}</p>}
              <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[13px] text-ink-2">
                {m.items.map((i, n) => (
                  <li key={n}>
                    <span className="font-medium text-ink">{i.title}.</span> {i.detail}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const signed = (n: number | null | undefined) => (n == null ? "?" : `${n > 0 ? "+" : ""}${n.toFixed(1)}%`);
const CLASS_LABEL: Record<HoldingsEvent["class"], string> = { market: "Market", sector: "Sector", company: "Company", fund: "Fund" };

function eventStatus(e: HoldingsEvent): React.ReactNode {
  if (e.reconciled) return e.reconciled.verdict === "confirmed" ? <span className="text-pos">FactSet confirmed</span> : <span className="text-warn">FactSet corrected</span>;
  if (e.provisional) return <span className="text-warn">Provisional, FactSet pending</span>;
  if (e.flagId) return <span>Flagged</span>;
  if (e.error) return <span className="text-neg">Error</span>;
  return <span className="text-ink-3">Logged</span>;
}

function HoldingsWatchSection() {
  const [data, setData] = useState<{ days: HoldingsDay[]; events: HoldingsEvent[] } | null>(null);
  const [open, toggle] = usePersistedOpen("monitor.holdings.open", true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetch("/api/agents/holdings-watch").then((r) => r.json()));
    } catch {
      setData({ days: [], events: [] });
    }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const runNow = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const d = await fetch("/api/agents/holdings-watch", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((r) => r.json());
      setMsg(d?.skipped ? `Skipped: ${d.skipped}` : d?.ok ? `Done: ${d.day?.checked ?? 0} holdings checked, ${d.events?.length ?? 0} new moves looked at.` : d?.error ?? "Could not run.");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const events = data?.events ?? [];
  const waiting = events.filter((e) => e.provisional && !e.reconciled);
  const last = data?.days[0];
  return (
    <section className="panel">
      <button className="panel-h w-full text-left" onClick={toggle}>
        <span className="t">Holdings watch</span>
        <span className="m">
          {last ? `last run ${last.date} · ${last.company} company moves · ${last.flagged} flagged` : "not run yet"}
          {waiting.length ? ` · ${waiting.length} waiting on FactSet` : ""} · {open ? "hide" : "show"}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2.5 px-3.5 py-3">
          <p className="text-[12.5px] leading-relaxed text-ink-3">
            Runs by itself after each close. A holding that moved −4% or +5% is first set against the market and its sector (free). Only a company-specific move goes further: the FactSet alerts, SEC filings and earnings date already on hand, then, for a large move still unexplained, at most 3 web searches marked provisional until FactSet confirms. It flags only when a move touches a thesis pillar, or a large move stays unexplained.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button className={BTN} disabled={busy} onClick={runNow}>
              {busy ? "Running… (up to 2 min)" : "Run today's check now"}
            </button>
            {last && (
              <span className="text-[12.5px] text-ink-3">
                {last.date}: S&amp;P 500 {signed(last.marketPct)} · Nasdaq {signed(last.nasdaqPct)} · TSX {signed(last.tsxPct)} · cost ${last.usd.toFixed(3)}
              </span>
            )}
            {msg && <span className="text-[12.5px] text-ink-2">{msg}</span>}
          </div>
        </div>
      )}
      {open && events.length > 0 && (
        <div className="tbl-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="pl-3.5">Day</th>
                <th>Ticker</th>
                <th className="n">Move</th>
                <th className="n">After market</th>
                <th>Read</th>
                <th>What happened</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="pl-3.5 font-mono text-ink-3">{e.date.slice(5)}</td>
                  <td className="font-mono">{displayTicker(e.ticker)}</td>
                  <td className="n">{signed(e.movePct)}</td>
                  <td className="n">{signed(e.residualPct)}</td>
                  <td>{CLASS_LABEL[e.class]}</td>
                  <td className="!whitespace-normal text-ink-2">
                    {e.cause ?? e.notFlaggedReason ?? "—"}
                    {e.pillars?.filter((p) => p.effect !== "neutral").map((p) => (
                      <div key={p.pillarId} className="text-[12px] text-ink-3">
                        {p.effect === "challenges" ? "Challenges" : "Supports"} “{p.title ?? p.pillarId}”: {p.why}
                      </div>
                    ))}
                    {e.reconciled?.note && <div className="text-[12px] text-ink-3">FactSet: {e.reconciled.note}</div>}
                    {!e.flagId && e.notFlaggedReason && e.cause && <div className="text-[12px] text-ink-faint">Not flagged: {e.notFlaggedReason}</div>}
                  </td>
                  <td className="text-[12.5px]">{eventStatus(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function MonitorPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [flags, setFlags] = useState<AgentFlag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolvedOpen, toggleResolved] = usePersistedOpen("monitor.resolved.open", false);
  const [callsOpen, toggleCalls] = usePersistedOpen("monitor.calls.open", false);

  const load = useCallback(async () => {
    try {
      const [s, f] = await Promise.all([fetch("/api/agents/status").then((r) => r.json()), fetch("/api/agents/flags").then((r) => r.json())]);
      if (s?.error) setError(s.error);
      else setStatus(s as Status);
      setFlags((f?.flags ?? []) as AgentFlag[]);
    } catch {
      setError("Could not load the watchers' status.");
    }
  }, []);

  useEffect(() => {
    // Deferred a tick so the effect body itself sets no state.
    void Promise.resolve().then(load);
  }, [load]);

  const updateFlag = async (id: string, action: string, note?: string) => {
    const r = await fetch(`/api/agents/flags/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, note }) });
    const d = await r.json();
    if (d?.flag) setFlags((prev) => (prev ?? []).map((f) => (f.id === id ? (d.flag as AgentFlag) : f)));
  };

  const replaceFlag = (flag: AgentFlag) => setFlags((prev) => (prev ?? []).map((f) => (f.id === flag.id ? flag : f)));

  const setModel = async (watcher: string, model: string) => {
    await fetch("/api/agents/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ watcher, model }) });
    load();
  };

  const setOn = async (watcher: string, enabled: boolean) => {
    await fetch("/api/agents/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ watcher, enabled }) });
    load();
  };

  const togglePause = async () => {
    if (!status) return;
    await fetch("/api/agents/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused: !status.paused }) });
    load();
  };

  const labelOf = (id: string) => status?.watchers.find((w) => w.id === id)?.label ?? id;
  const openFlags = (flags ?? []).filter((f) => f.status === "open").sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.createdAt.localeCompare(a.createdAt));
  const resolved = (flags ?? []).filter((f) => f.status !== "open");
  const spendOf = (id: string) => status?.spend.byWatcher.find((w) => w.id === id);

  const keyText =
    status?.key === "ok" ? <span className="text-pos">Connected</span> : status?.key === "same-as-main" ? <span className="text-neg">Same as main key — refused</span> : <span className="text-neg">Not set — watchers off</span>;

  return (
    <main className="flex flex-col gap-3.5 text-ink">
      <PageHeading
        lede="What the watchers flagged, what they cost this month, and which model each runs on. They suggest; you decide."
        actions={
          status && (
            <button className={BTN} onClick={togglePause}>
              <AppIcon name={status.paused ? "play" : "stop"} size={13} />
              {status.paused ? "Resume watchers" : "Pause all watchers"}
            </button>
          )
        }
      />

      {error && <p className="text-[13px] text-neg">{error}</p>}
      {!status && !error && <Skeleton className="h-24 w-full" />}

      {status && (
        <StatStrip
          cols={3}
          items={[
            { label: "Agents key", value: <span className="text-[15px]">{keyText}{status.paused && <span className="ml-2 text-[12px] text-warn">paused</span>}</span> },
            {
              label: `Spend · ${status.spend.month}`,
              value: (
                <>
                  {usd(status.spend.totalUsd)}
                  <span className="ml-2 font-sans text-[11.5px] font-normal text-ink-3">
                    of the {usd(status.spend.stopUsd)} stop line ({usd(status.spend.capUsd)} hard cap)
                    {status.spend.stopped && <span className="text-neg"> · stopped for the month</span>}
                  </span>
                </>
              ),
            },
            { label: "Open flags", value: openFlags.length },
          ]}
        />
      )}

      <section className="panel">
        <div className="panel-h">
          <span className="t">Open flags</span>
          <span className="m">{openFlags.length}</span>
        </div>
        {flags === null ? (
          <Skeleton className="m-3.5 h-16" />
        ) : openFlags.length === 0 ? (
          <EmptyState glyph={<AppIcon name="eye" size={18} />} title="Nothing flagged" body="When a watcher finds something worth your attention it appears here and in the Brief's action queue." />
        ) : (
          openFlags.map((f) => <FlagCard key={f.id} flag={f} labelOf={labelOf} onUpdate={updateFlag} onReplaced={replaceFlag} />)
        )}
      </section>

      {resolved.length > 0 && (
        <section className="panel">
          <button className="panel-h w-full text-left" onClick={toggleResolved}>
            <span className="t">Resolved</span>
            <span className="m">{resolved.length} · {resolvedOpen ? "hide" : "show"}</span>
          </button>
          {resolvedOpen && resolved.map((f) => <FlagCard key={f.id} flag={f} labelOf={labelOf} onUpdate={updateFlag} onReplaced={replaceFlag} />)}
        </section>
      )}

      <StanceSection />
      <HoldingsWatchSection />
      <ManagerSection />
      <MemoSection />
      <EarningsCompareSection />

      {status && (
        <section className="panel">
          <div className="panel-h">
            <span className="t">Watchers</span>
            <span className="m">model choice takes effect on the next run</span>
          </div>
          <div className="tbl-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="pl-3.5">On</th>
                  <th>Watcher</th>
                  <th>What it does</th>
                  <th>Phase</th>
                  <th>Model</th>
                  <th className="n">Spend</th>
                  <th className="n">Calls</th>
                </tr>
              </thead>
              <tbody>
                {status.watchers.map((w) => (
                  <tr key={w.id} className={w.on ? "" : "opacity-60"}>
                    <td className="pl-3.5">
                      <input type="checkbox" checked={w.on} onChange={(e) => setOn(w.id, e.target.checked)} aria-label={`${w.label} on`} title={w.on ? "Switch this watcher off" : "Switch this watcher on"} />
                    </td>
                    <td className="font-medium">{w.label}</td>
                    <td className="max-w-[380px] !whitespace-normal py-2 text-ink-2">
                      {w.what}
                      {w.shadow && <span className="ml-1 text-[11.5px] text-ink-3">(compared against {w.shadow === "sonnet" ? "Sonnet" : "Haiku"} for 2 weeks)</span>}
                    </td>
                    <td className="font-mono text-ink-3">{w.phase}</td>
                    <td>
                      <select
                        value={w.model === w.defaultModel ? "default" : w.model}
                        onChange={(e) => setModel(w.id, e.target.value)}
                        className="h-7 rounded-control border border-line bg-surface px-1.5 text-[12.5px] text-ink"
                      >
                        <option value="default">{w.defaultModel === "sonnet" ? "Sonnet" : "Haiku"} (plan)</option>
                        <option value={w.defaultModel === "sonnet" ? "haiku" : "sonnet"}>{w.defaultModel === "sonnet" ? "Haiku" : "Sonnet"}</option>
                      </select>
                    </td>
                    <td className="n">{usd(spendOf(w.id)?.usd ?? 0)}</td>
                    <td className="n">{spendOf(w.id)?.calls ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {status && (
        <section className="panel">
          <button className="panel-h w-full text-left" onClick={toggleCalls}>
            <span className="t">Recent calls</span>
            <span className="m">{status.spend.recent.length} · {callsOpen ? "hide" : "show"}</span>
          </button>
          {callsOpen &&
            (status.spend.recent.length === 0 ? (
              <div className="px-3.5 py-3 text-[12.5px] text-ink-3">No calls yet this month.</div>
            ) : (
              <div className="tbl-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="pl-3.5">When</th>
                      <th>Watcher</th>
                      <th>Model</th>
                      <th>About</th>
                      <th className="n">Tokens in / out</th>
                      <th className="n">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.spend.recent.map((c, i) => (
                      <tr key={i}>
                        <td className="pl-3.5 font-mono text-ink-3">{when(c.at)}</td>
                        <td>{labelOf(c.watcher)}</td>
                        <td className="text-ink-3">{c.model.includes("haiku") ? "Haiku" : "Sonnet"}</td>
                        <td className="text-ink-2">{c.note ?? "—"}</td>
                        <td className="n">{c.inputTokens.toLocaleString()} / {c.outputTokens.toLocaleString()}</td>
                        <td className="n">${c.usd.toFixed(4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
        </section>
      )}
    </main>
  );
}
