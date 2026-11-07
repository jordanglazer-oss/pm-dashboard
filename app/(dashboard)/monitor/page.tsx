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
  watchers: { id: string; label: string; phase: number; what: string; model: "haiku" | "sonnet"; defaultModel: "haiku" | "sonnet"; shadow: string | null }[];
};

const PRIORITY_DOT: Record<AgentFlag["priority"], string> = { high: "bg-neg", medium: "bg-warn", low: "bg-ink-faint" };
const PRIORITY_RANK: Record<AgentFlag["priority"], number> = { high: 0, medium: 1, low: 2 };

const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const BTN =
  "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover disabled:opacity-50";

function FlagCard({ flag, labelOf, onUpdate }: { flag: AgentFlag; labelOf: (id: string) => string; onUpdate: (id: string, action: string, note?: string) => Promise<void> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
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
          placeholder={open ? "Optional note — what you did or why not" : "Add a note"}
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
        <button className={BTN} disabled={busy || !note.trim()} onClick={() => run("note")}>
          Add note
        </button>
      </div>
    </div>
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

  const setModel = async (watcher: string, model: string) => {
    await fetch("/api/agents/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ watcher, model }) });
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
          openFlags.map((f) => <FlagCard key={f.id} flag={f} labelOf={labelOf} onUpdate={updateFlag} />)
        )}
      </section>

      {resolved.length > 0 && (
        <section className="panel">
          <button className="panel-h w-full text-left" onClick={toggleResolved}>
            <span className="t">Resolved</span>
            <span className="m">{resolved.length} · {resolvedOpen ? "hide" : "show"}</span>
          </button>
          {resolvedOpen && resolved.map((f) => <FlagCard key={f.id} flag={f} labelOf={labelOf} onUpdate={updateFlag} />)}
        </section>
      )}

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
                  <th className="pl-3.5">Watcher</th>
                  <th>What it does</th>
                  <th>Phase</th>
                  <th>Model</th>
                  <th className="n">Spend</th>
                  <th className="n">Calls</th>
                </tr>
              </thead>
              <tbody>
                {status.watchers.map((w) => (
                  <tr key={w.id}>
                    <td className="pl-3.5 font-medium">{w.label}</td>
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
