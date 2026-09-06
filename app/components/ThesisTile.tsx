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
  type ThesisPillar,
} from "@/app/lib/kill-conditions";
import type { ThesisReview, ReviewChange } from "@/app/lib/thesis-review";

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
  /** True when the saved thesis started from an AI draft (PM still signed it). */
  aiDrafted?: boolean;
  /** The 2-4 things the case rests on; conditions link to them via pillarId. */
  pillars?: ThesisPillar[];
  history?: Array<{ savedAt: string; reason: string }>;
};

const PILLAR_STATUS_STYLE: Record<string, string> = {
  confirmed: "border-pos-border bg-pos-soft text-pos",
  contested: "border-warn-border bg-warn-soft text-warn",
  broken: "border-neg-border bg-neg-soft text-neg",
  unknown: "border-line bg-surface-2 text-ink-3",
};

/** Kinds the PM can add by hand. `metric` needs a recap line to bind to, so it
 *  arrives only via Draft with AI / a review (which validate the line exists). */
const MANUAL_TEMPLATES = KILL_TEMPLATES.filter((t) => t.kind !== "metric");

/** Turn a review change's `after` into a condition row for the editor. */
function conditionFromChange(after: NonNullable<ReviewChange["after"]>, base?: KillCondition): KillCondition {
  return {
    id: base?.id ?? `${after.kind ?? "custom"}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    kind: after.kind ?? base?.kind ?? "custom",
    threshold: after.threshold ?? (after.kind && after.kind !== base?.kind ? undefined : base?.threshold),
    note: after.note ?? (after.kind === "custom" ? base?.note : undefined),
    theme: after.theme ?? base?.theme,
    pillarId: after.pillarId ?? base?.pillarId,
    metric: after.metric ?? (after.kind === "metric" ? base?.metric : undefined),
    addedAt: base?.addedAt ?? todayIso(),
    trippedAt: null,
  };
}

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
  earningsDate,
  className,
}: {
  ticker: string;
  /** Live inputs for the deterministic checks, assembled by the stock page. */
  signals: KillSignals;
  /** Next earnings date (YYYY-MM-DD) — sets the re-underwrite clock to the
   *  print + 7 days, so the review shows up when the evidence does. */
  earningsDate?: string | null;
  className?: string;
}) {
  const [entry, setEntry] = useState<ThesisEntry | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftWhy, setDraftWhy] = useState("");
  const [draftConds, setDraftConds] = useState<KillCondition[]>([]);
  const [draftPillars, setDraftPillars] = useState<ThesisPillar[]>([]);
  const [addKind, setAddKind] = useState(MANUAL_TEMPLATES[0].kind);
  const [addPillar, setAddPillar] = useState<string>("");
  // Server-resolved signals (metric readings off the ingested recap, SIA /
  // Equate / MarketEdge) — the half of KillSignals the page can't compute.
  const [extras, setExtras] = useState<Partial<KillSignals>>({});
  // Post-earnings review (app/lib/thesis-review): pillar statuses + a diff.
  const [review, setReview] = useState<ThesisReview | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewErr, setReviewErr] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [versionReason, setVersionReason] = useState<string>("edit");
  const [addThreshold, setAddThreshold] = useState<string>("");
  const [addNote, setAddNote] = useState("");
  const [journalNote, setJournalNote] = useState<string | null>(null);

  // AI draft (Alfa-style generation). The route PROPOSES a thesis + conditions
  // from the rescore-generated investmentThesis/bearCase and live signals; it
  // persists nothing. The draft lands in this editor and the PM signs by
  // saving — pre-registration stays a human commitment.
  const [drafting, setDrafting] = useState(false);
  const [draftErr, setDraftErr] = useState<string | null>(null);
  const [aiDrafted, setAiDrafted] = useState(false);
  const draftWithAi = useCallback(async () => {
    setDrafting(true);
    setDraftErr(null);
    try {
      const r = await fetch("/api/thesis-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker }),
      });
      const d = await r.json();
      if (!d?.draft?.why) {
        setDraftErr(d?.error || "draft failed");
        return;
      }
      setDraftWhy(d.draft.why);
      const pillars: ThesisPillar[] = Array.isArray(d.draft.pillars) ? d.draft.pillars : [];
      setDraftPillars(pillars);
      setDraftConds(
        (
          d.draft.conditions as { kind: KillCondition["kind"]; threshold?: number; note?: string; theme?: string; pillarId?: string; metric?: KillCondition["metric"] }[]
        ).map((c, i) => ({
          id: `${c.kind}-${Date.now()}-${i}`,
          kind: c.kind,
          threshold: c.threshold,
          note: c.note,
          theme: c.theme,
          pillarId: c.pillarId,
          metric: c.metric,
          addedAt: todayIso(),
        })),
      );
      setAiDrafted(true);
      setVersionReason(entry ? "redrafted with AI" : "underwrite");
      setEditing(true);
    } catch {
      setDraftErr("draft failed");
    } finally {
      setDrafting(false);
    }
  }, [ticker, entry]);

  // "Thesis required" banner → "Draft with AI": the banner sits outside this
  // tile, so it asks via a window event rather than a prop drilled through
  // the stock page. Same draftWithAi, same draft-never-commit rule.
  useEffect(() => {
    const onDraft = (e: Event) => {
      const t = (e as CustomEvent<{ ticker?: string }>).detail?.ticker;
      if (!t || t.toUpperCase() === ticker.toUpperCase()) void draftWithAi();
    };
    window.addEventListener("thesis:draft", onDraft);
    return () => window.removeEventListener("thesis:draft", onDraft);
  }, [ticker, draftWithAi]);

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
    () => ({ ...signals, ...extras, scoreDelta45d: scoreDelta45d === undefined ? signals.scoreDelta45d : scoreDelta45d }),
    [signals, extras, scoreDelta45d],
  );

  // Server-resolved signals + the cached review, re-read whenever the entry
  // changes (a save can add metric conditions the resolver must now read).
  useEffect(() => {
    let alive = true;
    fetch(`/api/thesis-signals?ticker=${encodeURIComponent(ticker)}`)
      .then((r) => r.json())
      .then((d) => alive && d?.extras && setExtras(d.extras))
      .catch(() => {});
    fetch(`/api/thesis-review?ticker=${encodeURIComponent(ticker)}`)
      .then((r) => r.json())
      .then((d) => alive && setReview(d?.review ?? null))
      .catch(() => {});
    return () => { alive = false; };
  }, [ticker, entry?.updatedAt]);

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
    setDraftPillars((entry?.pillars ?? []).map((p) => ({ ...p })));
    setAiDrafted(false);
    setVersionReason(entry ? "edit" : "underwrite");
    setEditing(true);
  };

  /** Open the editor with the ACCEPTED review changes applied. Nothing is
   *  saved until the PM signs — the review only ever proposes. */
  const applyReview = () => {
    if (!review) return;
    let conds = conditions.map((c) => ({ ...c }));
    let pillars = (entry?.pillars ?? []).map((p) => ({ ...p }));
    for (const ch of review.changes) {
      if (!accepted.has(ch.id)) continue;
      if (ch.type === "drop" && ch.conditionId) conds = conds.filter((c) => c.id !== ch.conditionId);
      else if ((ch.type === "tighten" || ch.type === "loosen" || ch.type === "replace") && ch.conditionId && ch.after) {
        conds = conds.map((c) => (c.id === ch.conditionId ? conditionFromChange(ch.after!, c) : c));
      } else if (ch.type === "add" && ch.after) conds.push(conditionFromChange(ch.after));
      else if (ch.type === "pillar" && ch.after?.title && ch.after.claim) {
        if (ch.pillarId && pillars.some((p) => p.id === ch.pillarId)) {
          pillars = pillars.map((p) => (p.id === ch.pillarId ? { ...p, title: ch.after!.title!, claim: ch.after!.claim! } : p));
        } else {
          pillars.push({ id: `${ch.after.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32)}-${pillars.length + 1}`, title: ch.after.title, claim: ch.after.claim });
        }
      }
    }
    setDraftWhy(entry?.why ?? "");
    setDraftConds(conds);
    setDraftPillars(pillars);
    setAiDrafted(false);
    setVersionReason("review applied");
    setEditing(true);
  };

  const runReview = useCallback(async (force = false) => {
    setReviewing(true);
    setReviewErr(null);
    try {
      const r = await fetch("/api/thesis-review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticker, force }) });
      const d = await r.json();
      if (d?.review) setReview(d.review);
      else setReviewErr(d?.error || "review failed");
    } catch {
      setReviewErr("review failed");
    } finally {
      setReviewing(false);
    }
  }, [ticker]);

  const dismissChange = async (id: string) => {
    setReview((r) => (r ? { ...r, dismissed: [...(r.dismissed ?? []), id] } : r));
    setAccepted((s) => { const n = new Set(s); n.delete(id); return n; });
    await fetch("/api/thesis-review", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticker, dismiss: [id] }) }).catch(() => {});
  };

  const addCondition = () => {
    const tpl = MANUAL_TEMPLATES.find((t) => t.kind === addKind);
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
        pillarId: addPillar || undefined,
        theme: addPillar ? draftPillars.find((p) => p.id === addPillar)?.title : undefined,
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
        pillars: draftPillars,
        aiDrafted, // provenance: started from an AI draft (PM edited + signed)
        versionReason, // the server versions the PRIOR signed state under this reason
      };
      // Re-underwrite clock: the next print + 7 days when known (the review
      // shows up when the evidence does), else 90 days. Reset on every signed
      // save so a review-applied thesis gets a fresh clock.
      const nextDue = (() => {
        if (earningsDate && /^\d{4}-\d{2}-\d{2}/.test(earningsDate)) {
          const d = new Date(`${earningsDate.slice(0, 10)}T00:00:00Z`);
          if (d.getTime() > Date.now()) {
            d.setUTCDate(d.getUTCDate() + 7);
            return d.toISOString().slice(0, 10);
          }
        }
        const due = new Date();
        due.setDate(due.getDate() + 90);
        return due.toISOString().slice(0, 10);
      })();
      body.reUnderwriteBy = nextDue;
      if (!entry?.underwrittenAt) {
        // First underwrite: stamp date + price.
        body.underwrittenAt = todayIso();
        if (signals.price != null) body.underwritePrice = signals.price;
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
        pillars: draftPillars,
        underwrittenAt: e?.underwrittenAt ?? (body.underwrittenAt as string | undefined),
        underwritePrice: e?.underwritePrice ?? (body.underwritePrice as number | undefined) ?? null,
        reUnderwriteBy: body.reUnderwriteBy as string | undefined,
        aiDrafted,
        history: e?.history,
      }));
      if (versionReason === "review applied") {
        setReview((r) => (r ? { ...r, appliedAt: new Date().toISOString() } : r));
        setAccepted(new Set());
        fetch("/api/thesis-review", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticker, applied: true }) }).catch(() => {});
      }
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }, [ticker, draftWhy, draftConds, draftPillars, entry, signals.price, aiDrafted, versionReason, earningsDate]);

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

  // On-demand AI verification of custom conditions (web-search Sonnet call;
  // the nightly chain does the same automatically post-earnings / weekly).
  const [verifying, setVerifying] = useState(false);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);
  const verifyCustoms = useCallback(async () => {
    setVerifying(true);
    setVerifyErr(null);
    try {
      const res = await fetch("/api/custom-condition-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, force: true }),
      }).then((r) => r.json());
      // A verification that produced nothing usable used to look identical to
      // success — the row simply didn't change. Say so instead.
      if (res?.error || (res?.failed > 0 && !res?.checked?.length)) {
        setVerifyErr(res?.error || "couldn't verify — try again");
      }
      const d = await fetch("/api/kv/position-theses").then((r) => r.json());
      const t = (d?.theses ?? {})[ticker.toUpperCase()] ?? (d?.theses ?? {})[ticker];
      if (t) setEntry(t);
    } catch {
      setVerifyErr("couldn't verify — try again");
    } finally {
      setVerifying(false);
    }
  }, [ticker]);

  if (!loaded) return null;

  const reDue = entry?.reUnderwriteBy;
  const overdue = reDue ? reDue < todayIso() : false;

  return (
    <section id="thesis-tile" className={`scroll-mt-24 rounded-card border border-line bg-white shadow-sm ${className || ""}`}>
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
              {entry.aiDrafted ? " · AI-assisted" : ""}
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
          <>
            <button
              onClick={draftWithAi}
              disabled={drafting}
              title="One model call — proposes a thesis + kill conditions from this name's generated thesis, bear case, and live signals. Nothing is saved until you sign it."
              className="rounded-control border border-line bg-white px-2.5 py-1 text-xs font-semibold text-accent disabled:opacity-50"
            >
              {drafting ? "Drafting…" : "✦ Draft with AI"}
            </button>
            {entry?.why && (
              <button
                onClick={() => runReview(!!review)}
                disabled={reviewing}
                title="One hash-gated model call — reads the thesis pillar by pillar against the latest report, recap and synthesis, and proposes changes you accept or reject. Runs automatically after new evidence lands."
                className="rounded-control border border-line bg-white px-2.5 py-1 text-xs font-semibold text-ink-2 hover:text-ink disabled:opacity-50"
              >
                {reviewing ? "Reviewing…" : review ? "Re-review" : "Review vs evidence"}
              </button>
            )}
            <button
              onClick={startEdit}
              className="rounded-control border border-line bg-white px-2.5 py-1 text-xs font-semibold text-ink-2 hover:text-ink"
            >
              {entry ? "Edit" : "Underwrite"}
            </button>
          </>
        )}
      </div>
      {reviewErr && !editing && <p className="border-b border-line-soft px-4 py-2 text-[11px] text-neg">{reviewErr}</p>}
      {draftErr && !editing && (
        <p className="border-b border-line-soft px-4 py-2 text-[11px] text-neg">{draftErr}</p>
      )}

      {!editing && (
        <>
          {entry?.why ? (
            <p className="whitespace-pre-line border-b border-line-soft px-4 py-3 text-[13.5px] leading-6 text-ink">
              {entry.why}
            </p>
          ) : (
            <p className="border-b border-line-soft px-4 py-3 text-[13px] text-ink-3">
              No thesis registered. Write why you own {ticker} and pre-register the conditions
              that would make you wrong — they are checked automatically from data already
              tracked here.{" "}
              <a href="/methodology" className="text-accent hover:underline">How this works</a>
            </p>
          )}

          {(checks.length > 0 || (entry?.pillars?.length ?? 0) > 0) && (
            <div className="divide-y divide-line-soft">
              {(() => {
                const pillars = entry?.pillars ?? [];
                const byPillar = new Map<string, typeof checks>();
                const loose: typeof checks = [];
                for (const k of checks) {
                  const pid = k.condition.pillarId;
                  if (pid && pillars.some((p) => p.id === pid)) byPillar.set(pid, [...(byPillar.get(pid) ?? []), k]);
                  else loose.push(k);
                }
                const groups: Array<{ pillar: ThesisPillar | null; rows: typeof checks }> = [
                  ...pillars.map((p) => ({ pillar: p, rows: byPillar.get(p.id) ?? [] })),
                  ...(loose.length ? [{ pillar: null, rows: loose }] : []),
                ];
                return groups.map(({ pillar, rows }) => {
                  const rs = pillar && review ? review.pillars.find((x) => x.pillarId === pillar.id) : undefined;
                  return (
                    <div key={pillar?.id ?? "loose"}>
                      {pillar ? (
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 bg-surface-2/60 px-4 py-1.5">
                          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-accent">{pillar.title}</span>
                          <span className="min-w-0 flex-1 text-[12px] text-ink-2">{pillar.claim}</span>
                          {rs && (
                            <span className={`rounded-full border px-1.5 py-px text-[9px] font-bold uppercase ${PILLAR_STATUS_STYLE[rs.status]}`} title={rs.reading}>
                              {rs.status}
                            </span>
                          )}
                          {rows.length === 0 && <span className="text-[10px] text-warn">no condition guards this pillar</span>}
                        </div>
                      ) : pillars.length > 0 ? (
                        <div className="bg-surface-2/60 px-4 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-3">Position &amp; other</div>
                      ) : null}
              {rows.map((k) => {
                const st = STATUS_STYLE[k.status];
                return (
                  <div key={k.condition.id} className="flex items-start gap-2.5 px-4 py-2">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${st.dot}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-ink">
                        {describeCondition(k.condition)}
                      </div>
                      <div className="text-[11px] text-ink-3">
                        {k.reading}
                        {k.condition.kind === "custom" && (
                          <button
                            onClick={verifyCustoms}
                            disabled={verifying}
                            title="One web-search model call — checks this condition against the latest reported figures. Also runs automatically after each earnings report."
                            className="ml-2 font-semibold text-accent hover:underline disabled:opacity-50"
                          >
                            {verifying ? "verifying…" : "verify now"}
                          </button>
                        )}
                        {k.condition.kind === "custom" && verifyErr && (
                          <span className="ml-2 text-neg">{verifyErr}</span>
                        )}
                      </div>
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
                  );
                });
              })()}
            </div>
          )}

          {/* ── Post-earnings review: pillar verdicts + a diff to accept/reject ── */}
          {review && (() => {
            const applied = !!review.appliedAt && review.appliedAt >= review.generatedAt;
            const open = review.changes.filter((c) => !(review.dismissed ?? []).includes(c.id));
            const CHANGE_LABEL: Record<ReviewChange["type"], string> = { tighten: "Tighten", loosen: "Loosen", replace: "Replace", add: "Add", drop: "Drop", pillar: "Pillar" };
            return (
              <div className="border-t border-line px-4 py-3">
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-3">Review vs evidence</span>
                  {review.pillars.map((p) => (
                    <span key={p.pillarId} className={`rounded-full border px-1.5 py-px text-[9px] font-bold uppercase ${PILLAR_STATUS_STYLE[p.status]}`} title={`${p.title}: ${p.reading}`}>
                      {p.title} · {p.status}
                    </span>
                  ))}
                  <span className="ml-auto font-mono text-[10px] text-ink-faint">
                    claude · {review.generatedAt.slice(0, 10)}{review.evidenceAt ? ` · evidence ${review.evidenceAt.slice(0, 10)}` : ""}
                  </span>
                </div>
                <p className="text-[13px] leading-5 text-ink-2">{review.summary}</p>
                {open.length === 0 ? (
                  <p className="mt-1.5 text-[11px] text-ink-3">{applied ? "Changes applied and re-signed." : "No changes proposed — the thesis stands as written."}</p>
                ) : applied ? (
                  <p className="mt-1.5 text-[11px] text-ink-3">Applied and re-signed on {review.appliedAt!.slice(0, 10)}.</p>
                ) : (
                  <div className="mt-2 space-y-1.5">
                    {open.map((ch) => {
                      const on = accepted.has(ch.id);
                      const afterText = ch.after
                        ? ch.type === "pillar"
                          ? `${ch.after.title}: ${ch.after.claim}`
                          : describeCondition({ id: "x", kind: ch.after.kind ?? "custom", threshold: ch.after.threshold, note: ch.after.note, metric: ch.after.metric, addedAt: "" })
                        : null;
                      return (
                        <div key={ch.id} className={`flex items-start gap-2.5 rounded-lg border px-2.5 py-2 ${on ? "border-accent-border bg-accent-soft/40" : "border-line bg-white"}`}>
                          <button
                            onClick={() => setAccepted((s) => { const n = new Set(s); if (n.has(ch.id)) n.delete(ch.id); else n.add(ch.id); return n; })}
                            className={`mt-0.5 h-4 w-4 shrink-0 rounded border text-[10px] font-bold leading-none ${on ? "border-accent bg-accent text-white" : "border-line bg-white text-transparent"}`}
                            aria-pressed={on}
                            title={on ? "Accepted — will be applied" : "Accept this change"}
                          >
                            ✓
                          </button>
                          <div className="min-w-0 flex-1 text-[12px]">
                            <span className="mr-1.5 rounded bg-surface-2 px-1.5 py-px text-[9px] font-bold uppercase text-ink-2">{CHANGE_LABEL[ch.type]}</span>
                            {ch.before && <span className="text-ink-3 line-through">{ch.before}</span>}
                            {ch.before && afterText && <span className="mx-1 text-ink-faint">→</span>}
                            {afterText && <span className="font-medium text-ink">{afterText}</span>}
                            <div className="text-[11px] text-ink-3">{ch.reason}</div>
                          </div>
                          <button onClick={() => dismissChange(ch.id)} className="shrink-0 text-[11px] text-ink-3 hover:text-neg" title="Dismiss — won't be proposed again from this review">dismiss</button>
                        </div>
                      );
                    })}
                    <div className="flex items-center justify-end gap-2 pt-1">
                      <span className="mr-auto text-[11px] text-ink-3">Accepted changes open in the editor; nothing changes until you re-sign.</span>
                      <button
                        onClick={applyReview}
                        disabled={accepted.size === 0}
                        className="rounded-control bg-ink px-3 py-1 text-xs font-semibold text-white disabled:opacity-40"
                      >
                        Apply {accepted.size || ""} &amp; re-sign
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

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
            rows={5}
            placeholder={`Why do you own ${ticker}? State it falsifiably: "buying because X, expecting Y, wrong if K."`}
            className="w-full rounded-lg border border-line bg-white px-3 py-2 text-[13px] leading-5 text-ink placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent"
          />
          {/* Pillars — the 2-4 things the case rests on. Conditions bind to one. */}
          <div className="space-y-1.5 rounded-lg border border-line bg-surface-2/40 px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-3">Pillars</span>
              <button
                onClick={() => setDraftPillars((ps) => [...ps, { id: `pillar-${Date.now()}`, title: "", claim: "" }])}
                className="text-[11px] font-semibold text-accent hover:underline"
              >
                + Add pillar
              </button>
            </div>
            {draftPillars.length === 0 && (
              <p className="text-[11px] text-ink-3">No pillars yet — name the 2-4 things this case rests on, then guard each with a condition. Draft with AI proposes them from the synthesis.</p>
            )}
            {draftPillars.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-2">
                <input
                  value={p.title}
                  onChange={(e) => setDraftPillars((ps) => ps.map((x) => (x.id === p.id ? { ...x, title: e.target.value } : x)))}
                  placeholder="Pillar (2-5 words)"
                  className="w-44 rounded-control border border-line bg-white px-2 py-1 text-xs font-semibold text-ink"
                />
                <input
                  value={p.claim}
                  onChange={(e) => setDraftPillars((ps) => ps.map((x) => (x.id === p.id ? { ...x, claim: e.target.value } : x)))}
                  placeholder="One falsifiable sentence with the figure it rests on"
                  className="min-w-[16rem] flex-1 rounded-control border border-line bg-white px-2 py-1 text-xs text-ink"
                />
                <button
                  onClick={() => {
                    setDraftPillars((ps) => ps.filter((x) => x.id !== p.id));
                    setDraftConds((cs) => cs.map((c) => (c.pillarId === p.id ? { ...c, pillarId: undefined } : c)));
                  }}
                  className="text-[11px] text-ink-3 hover:text-neg"
                >
                  remove
                </button>
              </div>
            ))}
          </div>
          <div className="space-y-1.5">
            {draftConds.map((c) => (
              <div key={c.id} className="flex items-center gap-2 text-[13px]">
                <select
                  value={c.pillarId ?? ""}
                  onChange={(e) => setDraftConds((cs) => cs.map((x) => (x.id === c.id ? { ...x, pillarId: e.target.value || undefined, theme: draftPillars.find((p) => p.id === e.target.value)?.title ?? x.theme } : x)))}
                  className="w-36 shrink-0 rounded-control border border-line bg-white px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent"
                  title="Which pillar this condition guards"
                >
                  <option value="">— no pillar —</option>
                  {draftPillars.map((p) => (
                    <option key={p.id} value={p.id}>{p.title || "(untitled)"}</option>
                  ))}
                </select>
                <span className="flex-1 text-ink">
                  {describeCondition(c)}
                  {c.kind === "metric" && <span className="ml-1.5 rounded bg-pos-soft px-1 py-px text-[9px] font-bold uppercase text-pos">reported metric</span>}
                </span>
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
                value={addPillar}
                onChange={(e) => setAddPillar(e.target.value)}
                className="rounded-control border border-line bg-white px-2 py-1 text-xs text-ink"
                title="Pillar the new condition guards"
              >
                <option value="">— pillar —</option>
                {draftPillars.map((p) => (
                  <option key={p.id} value={p.id}>{p.title || "(untitled)"}</option>
                ))}
              </select>
              <select
                value={addKind}
                onChange={(e) => setAddKind(e.target.value as KillCondition["kind"])}
                className="rounded-control border border-line bg-white px-2 py-1 text-xs text-ink"
              >
                {MANUAL_TEMPLATES.map((t) => (
                  <option key={t.kind} value={t.kind}>
                    {t.label}
                  </option>
                ))}
              </select>
              {addKind !== "custom" && MANUAL_TEMPLATES.find((t) => t.kind === addKind)?.defaultThreshold != null && (
                <input
                  value={addThreshold}
                  onChange={(e) => setAddThreshold(e.target.value)}
                  placeholder={String(MANUAL_TEMPLATES.find((t) => t.kind === addKind)?.defaultThreshold)}
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
            {aiDrafted ? (
              <span className="mr-auto text-[11px] text-ink-3">
                AI draft — review, edit, and sign it; nothing is saved until you underwrite.
              </span>
            ) : versionReason === "review applied" ? (
              <span className="mr-auto text-[11px] text-ink-3">
                Review changes applied — check them, then re-sign. The prior version is kept.
              </span>
            ) : null}
            <button
              onClick={draftWithAi}
              disabled={drafting}
              className="rounded-control px-2.5 py-1 text-xs font-semibold text-accent disabled:opacity-50"
            >
              {drafting ? "Drafting…" : aiDrafted ? "Redraft" : "✦ Draft with AI"}
            </button>
            {draftErr && <span className="text-[11px] text-neg">{draftErr}</span>}
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
