"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  KILL_TEMPLATES,
  checkAll,
  describeCondition,
  trippedCount,
  type KillCondition,
  type KillSignals,
  type KillStatus,
} from "@/app/lib/kill-conditions";

/**
 * Thesis tile (stock page) — the pre-registration surface of the
 * thesis-discipline build (preview-only).
 *
 * Shows the human "why I own it" (pm:position-theses, shared with the
 * Portfolio page's Thesis Watch — same key, same note) plus the structured
 * kill conditions, each evaluated LIVE against signals the page already has.
 * Evaluation is deterministic (app/lib/kill-conditions) — no tokens.
 *
 * Trip persistence: when a check transitions OK→TRIPPED the tile stamps
 * trippedAt via one background POST (read-merge-write server-side), so
 * "TRIPPED Jul 24" survives reloads; recovery clears it the same way. A
 * throttle ref ensures at most one stamp POST per mount per state change.
 *
 * Trip response: acknowledging (Hold) or flagging (Trim / exit) writes a
 * decision-journal entry with the score snapshot embedded — the raw material
 * for the attribution loop (phase ③).
 */

type ThesisEntry = {
  why: string;
  updatedAt: string;
  killConditions?: KillCondition[];
  underwrittenAt?: string;
  underwritePrice?: number | null;
  reUnderwriteBy?: string;
};

const STATUS_STYLE: Record<KillStatus, { dot: string; pill: string; label: string }> = {
  ok: { dot: "bg-pos", pill: "bg-pos-soft text-pos border-pos-border", label: "OK" },
  tripped: { dot: "bg-neg", pill: "bg-neg-soft text-neg border-neg-border", label: "TRIPPED" },
  unknown: { dot: "bg-ink-faint", pill: "bg-surface-2 text-ink-3 border-line", label: "NO DATA" },
  manual: { dot: "bg-ink-faint", pill: "bg-surface-2 text-ink-2 border-line", label: "MANUAL" },
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function ThesisTile({
  ticker,
  signals,
  className,
}: {
  ticker: string;
  /** Live inputs for the deterministic checks, assembled by the stock page. */
  signals: KillSignals;
  className?: string;
}) {
  const [entry, setEntry] = useState<ThesisEntry | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftWhy, setDraftWhy] = useState("");
  const [draftConds, setDraftConds] = useState<KillCondition[]>([]);
  const [addKind, setAddKind] = useState(KILL_TEMPLATES[0].kind);
  const [addThreshold, setAddThreshold] = useState<string>("");
  const [addNote, setAddNote] = useState("");
  const [journalNote, setJournalNote] = useState<string | null>(null);

  // On-trip Claude thesis check (phase ④). GET reads the cache only — zero
  // spend; the POST behind the button is hash-gated server-side, so a
  // re-click on unchanged facts is also free.
  type ThesisCheck = {
    hash: string;
    analyzedAt: string;
    result: { breaksThesis: "direct" | "partial" | "no"; assessment: string; bearCase: string; restore: string; suggestedAction: string };
  };
  const [check, setCheck] = useState<ThesisCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState<string | null>(null);

  // 45d composite delta for the score_decay condition, from pm:score-history.
  const [scoreDelta45d, setScoreDelta45d] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    fetch("/api/kv/score-history")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        const hist: { date: string; total: number }[] = (d?.[ticker.toUpperCase()] ?? d?.[ticker] ?? [])
          .filter((e: { date?: string; total?: number }) => e && typeof e.total === "number" && typeof e.date === "string")
          .sort((a: { date: string }, b: { date: string }) => (a.date < b.date ? -1 : 1));
        if (hist.length < 2) {
          setScoreDelta45d(null);
          return;
        }
        const latest = hist[hist.length - 1];
        const cutoffMs = Date.parse(`${latest.date}T00:00:00Z`) - 45 * 86400_000;
        let baseline = hist[0].total;
        for (const e of hist) if (Date.parse(`${e.date}T00:00:00Z`) <= cutoffMs) baseline = e.total;
        setScoreDelta45d(latest.total - baseline);
      })
      .catch(() => alive && setScoreDelta45d(null));
    return () => {
      alive = false;
    };
  }, [ticker]);

  const liveSignals = useMemo<KillSignals>(
    () => ({ ...signals, scoreDelta45d: scoreDelta45d === undefined ? signals.scoreDelta45d : scoreDelta45d }),
    [signals, scoreDelta45d],
  );

  useEffect(() => {
    let alive = true;
    fetch("/api/kv/position-theses")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        const t = (d?.theses ?? {})[ticker.toUpperCase()] ?? (d?.theses ?? {})[ticker];
        setEntry(t ?? null);
        setLoaded(true);
        if (t?.killConditions?.length) {
          fetch(`/api/thesis-check?ticker=${encodeURIComponent(ticker)}`)
            .then((r) => r.json())
            .then((c) => c?.check && setCheck(c.check))
            .catch(() => {});
        }
      })
      .catch(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [ticker]);

  const conditions = useMemo(() => entry?.killConditions ?? [], [entry]);
  const checks = useMemo(() => checkAll(conditions, liveSignals), [conditions, liveSignals]);
  const { tripped, auto } = trippedCount(checks);

  // ── Persist OK→TRIPPED / TRIPPED→OK transitions (one POST when needed) ──
  const stampedRef = React.useRef(false);
  useEffect(() => {
    if (!loaded || !entry || stampedRef.current) return;
    const today = todayIso();
    let changed = false;
    const next = conditions.map((c) => {
      const check = checks.find((k) => k.condition.id === c.id);
      if (!check) return c;
      if (check.status === "tripped" && !c.trippedAt) {
        changed = true;
        return { ...c, trippedAt: today };
      }
      if (check.status === "ok" && c.trippedAt) {
        changed = true;
        return { ...c, trippedAt: null };
      }
      return c;
    });
    if (!changed) return;
    stampedRef.current = true;
    setEntry((e) => (e ? { ...e, killConditions: next } : e));
    fetch("/api/kv/position-theses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker, killConditions: next }),
    }).catch(() => {});
  }, [loaded, entry, conditions, checks, ticker]);

  const startEdit = () => {
    setDraftWhy(entry?.why ?? "");
    setDraftConds(conditions.map((c) => ({ ...c })));
    setEditing(true);
  };

  const addCondition = () => {
    const tpl = KILL_TEMPLATES.find((t) => t.kind === addKind);
    if (!tpl) return;
    if (addKind === "custom" && !addNote.trim()) return;
    const th = addThreshold.trim() === "" ? tpl.defaultThreshold : Number(addThreshold);
    setDraftConds((cs) => [
      ...cs,
      {
        id: `${addKind}-${Date.now()}`,
        kind: addKind,
        threshold: typeof th === "number" && isFinite(th) ? th : tpl.defaultThreshold,
        note: addKind === "custom" ? addNote.trim() : undefined,
        addedAt: todayIso(),
      },
    ]);
    setAddThreshold("");
    setAddNote("");
  };

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        ticker,
        why: draftWhy.trim(),
        killConditions: draftConds,
      };
      if (!entry?.underwrittenAt) {
        // First underwrite: stamp date + price, and set the quarterly clock.
        body.underwrittenAt = todayIso();
        if (signals.price != null) body.underwritePrice = signals.price;
        const due = new Date();
        due.setDate(due.getDate() + 90);
        body.reUnderwriteBy = due.toISOString().slice(0, 10);
      }
      await fetch("/api/kv/position-theses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setEntry((e) => ({
        why: draftWhy.trim(),
        updatedAt: new Date().toISOString(),
        killConditions: draftConds,
        underwrittenAt: e?.underwrittenAt ?? (body.underwrittenAt as string | undefined),
        underwritePrice: e?.underwritePrice ?? (body.underwritePrice as number | undefined) ?? null,
        reUnderwriteBy: e?.reUnderwriteBy ?? (body.reUnderwriteBy as string | undefined),
      }));
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }, [ticker, draftWhy, draftConds, entry, signals.price]);

  const runCheck = useCallback(async () => {
    setChecking(true);
    setCheckErr(null);
    try {
      const r = await fetch("/api/thesis-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker }),
      });
      const d = await r.json();
      if (d?.check) setCheck(d.check);
      else setCheckErr(d?.error || "check failed");
    } catch {
      setCheckErr("check failed");
    } finally {
      setChecking(false);
    }
  }, [ticker]);

  /** Log the response to a trip in the decision journal, with the score
   *  snapshot embedded so attribution can reconstruct decision-time state. */
  const logDecision = useCallback(
    async (action: "hold" | "trim") => {
      const snap = [
        signals.score != null ? `score ${signals.score.toFixed(1)}` : null,
        signals.netRevisions != null ? `rev net ${signals.netRevisions}` : null,
        signals.price != null ? `px ${signals.price.toFixed(2)}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const trippedNames = checks
        .filter((k) => k.status === "tripped")
        .map((k) => describeCondition(k.condition))
        .join("; ");
      await fetch("/api/kv/decision-journal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker,
          action,
          rationale:
            action === "hold"
              ? `Acknowledged kill-condition trip (${trippedNames}) — holding. [${snap}]`
              : `Kill-condition trip (${trippedNames}) — flagged for trim/exit review. [${snap}]`,
          confidence: "medium",
        }),
      }).catch(() => {});
      setJournalNote(action === "hold" ? "Logged: hold acknowledged" : "Logged: flagged for trim/exit");
    },
    [ticker, signals, checks],
  );

  if (!loaded) return null;

  const reDue = entry?.reUnderwriteBy;
  const overdue = reDue ? reDue < todayIso() : false;

  return (
    <section className={`rounded-card border border-line bg-white shadow-sm ${className || ""}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <span className="text-xs font-bold uppercase tracking-[0.22em] text-ink-3">Thesis</span>
        {auto > 0 && (
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${
              tripped > 0 ? STATUS_STYLE.tripped.pill : STATUS_STYLE.ok.pill
            }`}
          >
            {tripped > 0 ? `${tripped} of ${auto} tripped` : `${auto} conditions OK`}
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-ink-faint">
          {entry?.underwrittenAt ? (
            <>
              underwritten {entry.underwrittenAt}
              {entry.underwritePrice != null ? ` · $${entry.underwritePrice.toFixed(2)}` : ""}
              {reDue ? (
                <span className={overdue ? "text-neg font-semibold" : ""}>
                  {" "}
                  · re-underwrite {overdue ? "OVERDUE" : "due"} {reDue}
                </span>
              ) : null}
            </>
          ) : (
            "not underwritten yet"
          )}
        </span>
        {!editing && (
          <button
            onClick={startEdit}
            className="rounded-control border border-line bg-white px-2.5 py-1 text-xs font-semibold text-ink-2 hover:text-ink"
          >
            {entry ? "Edit" : "Underwrite"}
          </button>
        )}
      </div>

      {!editing && (
        <>
          {entry?.why ? (
            <p className="border-b border-line-soft px-4 py-3 text-[13.5px] leading-6 text-ink">
              {entry.why}
            </p>
          ) : (
            <p className="border-b border-line-soft px-4 py-3 text-[13px] text-ink-3">
              No thesis registered. Write why you own {ticker} and pre-register the conditions
              that would make you wrong — they are checked automatically from data already
              tracked here.
            </p>
          )}

          {checks.length > 0 && (
            <div className="divide-y divide-line-soft">
              {checks.map((k) => {
                const st = STATUS_STYLE[k.status];
                return (
                  <div key={k.condition.id} className="flex items-start gap-2.5 px-4 py-2">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${st.dot}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-ink">
                        {describeCondition(k.condition)}
                      </div>
                      <div className="text-[11px] text-ink-3">{k.reading}</div>
                    </div>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold ${st.pill}`}>
                      {k.status === "tripped" && k.condition.trippedAt
                        ? `TRIPPED ${k.condition.trippedAt.slice(5)}`
                        : st.label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {tripped > 0 && check && (
            <div className="border-t border-line px-4 py-3">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-3">Thesis check</span>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${
                  check.result.breaksThesis === "direct"
                    ? "border-neg-border bg-neg-soft text-neg"
                    : check.result.breaksThesis === "partial"
                      ? "border-warn-border bg-warn-soft text-warn"
                      : "border-pos-border bg-pos-soft text-pos"
                }`}>
                  {check.result.breaksThesis === "direct" ? "hits the thesis" : check.result.breaksThesis === "partial" ? "partial hit" : "noise vs thesis"}
                </span>
                <span className="ml-auto font-mono text-[10px] text-ink-faint">
                  claude · {check.analyzedAt.slice(0, 10)}
                </span>
              </div>
              <p className="text-[13px] leading-5 text-ink-2">{check.result.assessment}</p>
              <p className="mt-1.5 text-[12px] leading-5 text-ink-3">
                <span className="font-semibold text-ink-2">Bear case:</span> {check.result.bearCase}{" "}
                <span className="font-semibold text-ink-2">Restores it:</span> {check.result.restore}
              </p>
              <p className="mt-1.5 rounded-lg border border-warn-border bg-warn-soft px-2.5 py-1.5 text-[12px] font-medium leading-5 text-ink">
                {check.result.suggestedAction}
              </p>
            </div>
          )}
          {tripped > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-t border-line bg-neg-soft/40 px-4 py-2.5">
              <span className="text-[12px] font-semibold text-neg">
                A pre-registered exit condition is tripped — respond and it&apos;s logged.
              </span>
              <div className="ml-auto flex gap-2">
                {!check && (
                  <button
                    onClick={runCheck}
                    disabled={checking}
                    title="One hash-gated model call (~$0.03) — re-runs only when the facts change"
                    className="rounded-control border border-line bg-white px-2.5 py-1 text-xs font-semibold text-accent disabled:opacity-50"
                  >
                    {checking ? "Writing…" : "Run thesis check"}
                  </button>
                )}
                <button
                  onClick={() => logDecision("hold")}
                  className="rounded-control border border-line bg-white px-2.5 py-1 text-xs font-semibold text-ink-2 hover:text-ink"
                >
                  Acknowledge — hold
                </button>
                <button
                  onClick={() => logDecision("trim")}
                  className="rounded-control border border-neg-border bg-white px-2.5 py-1 text-xs font-semibold text-neg"
                >
                  Flag trim / exit
                </button>
              </div>
              {journalNote && <span className="w-full text-right text-[11px] text-ink-3">{journalNote}</span>}
              {checkErr && <span className="w-full text-right text-[11px] text-neg">{checkErr}</span>}
            </div>
          )}
        </>
      )}

      {editing && (
        <div className="space-y-3 px-4 py-3">
          <textarea
            value={draftWhy}
            onChange={(e) => setDraftWhy(e.target.value)}
            rows={3}
            placeholder={`Why do you own ${ticker}? State it falsifiably: "buying because X, expecting Y, wrong if K."`}
            className="w-full rounded-lg border border-line bg-white px-3 py-2 text-[13px] leading-5 text-ink placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <div className="space-y-1.5">
            {draftConds.map((c) => (
              <div key={c.id} className="flex items-center gap-2 text-[13px]">
                <span className="flex-1 text-ink">{describeCondition(c)}</span>
                <button
                  onClick={() => setDraftConds((cs) => cs.filter((x) => x.id !== c.id))}
                  className="text-[11px] text-ink-3 hover:text-neg"
                >
                  remove
                </button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <select
                value={addKind}
                onChange={(e) => setAddKind(e.target.value as KillCondition["kind"])}
                className="rounded-control border border-line bg-white px-2 py-1 text-xs text-ink"
              >
                {KILL_TEMPLATES.map((t) => (
                  <option key={t.kind} value={t.kind}>
                    {t.label}
                  </option>
                ))}
              </select>
              {addKind !== "custom" && KILL_TEMPLATES.find((t) => t.kind === addKind)?.defaultThreshold != null && (
                <input
                  value={addThreshold}
                  onChange={(e) => setAddThreshold(e.target.value)}
                  placeholder={String(KILL_TEMPLATES.find((t) => t.kind === addKind)?.defaultThreshold)}
                  className="w-20 rounded-control border border-line bg-white px-2 py-1 text-xs text-ink"
                />
              )}
              {addKind === "custom" && (
                <input
                  value={addNote}
                  onChange={(e) => setAddNote(e.target.value)}
                  placeholder="e.g. Two NIM guidance cuts"
                  className="w-64 rounded-control border border-line bg-white px-2 py-1 text-xs text-ink"
                />
              )}
              <button
                onClick={addCondition}
                className="rounded-control border border-line bg-white px-2.5 py-1 text-xs font-semibold text-ink-2 hover:text-ink"
              >
                + Add condition
              </button>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-line-soft pt-2.5">
            <button
              onClick={() => setEditing(false)}
              className="rounded-control px-2.5 py-1 text-xs font-semibold text-ink-3 hover:text-ink"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="rounded-control bg-ink px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              {saving ? "Saving…" : entry ? "Save thesis" : "Underwrite position"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
