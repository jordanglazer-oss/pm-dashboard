"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useStocks } from "@/app/lib/StockContext";
import Link from "next/link";
import { displayTicker } from "@/app/lib/ticker";
import { Skeleton } from "@/app/components/Skeleton";
import { EmptyState } from "@/app/components/EmptyState";
import { AppIcon } from "@/app/components/AppIcon";
import { describeCondition, type KillCheck, type KillStatus } from "@/app/lib/kill-conditions";

/**
 * /thesis — the Thesis Desk: every underwritten position's thesis and its
 * pre-registered kill conditions on one page.
 *
 * READ-ONLY by design. Writing a thesis stays on the stock page (the
 * ThesisTile is the single editor — one writer for pm:position-theses), so
 * this page monitors and links out rather than duplicating an editor whose
 * save semantics would have to be kept in sync.
 *
 * Everything renders from ONE call to /api/thesis-watch, which runs the same
 * deterministic checker the stock tile and the morning digest use — so a
 * status here can never disagree with the one on the stock page.
 *
 * Ordered alphabetically so each name keeps a stable position; urgency is
 * carried by the card's red border and TRIPPED badge rather than by position.
 * Watchlist names are absent on purpose — see the coverage note below.
 */

type Row = {
  ticker: string;
  why?: string;
  checks: KillCheck[];
  tripped: number;
  auto: number;
  underwrittenAt?: string;
  reUnderwriteBy?: string;
  aiDrafted?: boolean;
};
type CoverageRow = { ticker: string; name?: string; sector?: string; hasProse: boolean; price?: number | null };
type Payload = {
  holdings: Row[];
  coverage?: { portfolioCount: number; underwritten: number; missing: CoverageRow[] };
};

/** Status = dot + word (no pill): colour carries the meaning, the word names it. */
const STATUS_STYLE: Record<KillStatus, { dot: string; label: string }> = {
  ok: { dot: "bg-pos", label: "OK" },
  tripped: { dot: "bg-neg", label: "Tripped" },
  unknown: { dot: "bg-ink-faint", label: "No data" },
  manual: { dot: "bg-ink-faint", label: "Manual" },
};

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * "unclear" covers two situations the card must NOT show identically:
 *   PENDING    — the quarter simply has not been reported yet. The condition
 *                is fine; it resolves on the next print. Neutral styling.
 *   NO DATA    — structural: the metric is not disclosed, or not on a
 *                quarterly cadence. The condition can never resolve and needs
 *                a rewrite (which the verifier proposes).
 * Showing both as NO DATA made a healthy condition look broken and hid which
 * ones actually needed action.
 */
const unclearKind = (c: KillCheck["condition"]): "pending" | "structural" | null =>
  c.aiCheck?.status === "unclear" ? (c.aiCheck.undisclosed ? "structural" : "pending") : null;

/** localStorage, NOT pm:ui-prefs: persisting here costs no Redis write, no
 *  bytes in the nightly backup blob and no origin transfer. Trade-off is that
 *  the preference is per-device rather than synced. */
const STORAGE_KEY = "pm.thesis.collapse";

/** A card that needs a decision: a tripped condition or an overdue
 *  re-underwrite. Supplies the DEFAULT open state for a name you have never
 *  toggled; a stored choice overrides it. */
const needsAttention = (r: Row) =>
  r.tripped > 0 || (r.reUnderwriteBy ? r.reUnderwriteBy < todayIso() : false);

export default function ThesisDeskPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/thesis-watch", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (alive) setData(d as Payload);
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  // Alphabetical: a monitor you scan for a SPECIFIC name, so a stable
  // position beats a ranking that reshuffles whenever a condition trips.
  // Urgency is still unmissable — tripped cards carry a red border and a
  // TRIPPED badge, and the summary strip counts them.
  const rows = useMemo(
    () => [...(data?.holdings ?? [])].sort((a, b) => a.ticker.localeCompare(b.ticker)),
    [data],
  );

  /**
   * Collapse state. Cards default to COLLAPSED except those that need
   * attention (a tripped condition or an overdue re-underwrite) — the page is
   * a monitor, so the calm names should be a compact index and the ones asking
   * for a decision should already be open.
   *
   * Persisted to localStorage (see STORAGE_KEY) so choices survive a refresh
   * without costing a Redis write or backup bytes.
   *
   * Once you toggle a card the stored choice wins permanently, including for
   * tripped names — attention only sets the default for names never toggled.
   *
   * Collapsing never hides a problem: the tripped/OK badge and the red card
   * border live in the HEADER, which stays visible when collapsed. Only the
   * thesis prose and per-condition readings are hidden.
   */
  /** Per-ticker overrides of the default; absent = follow the default.
   *
   *  Read from storage in a LAZY INITIALIZER rather than an effect. That is
   *  safe here specifically because this page renders no cards during SSR —
   *  it is still `loading` until the client fetch returns — so there is no
   *  server/client markup to mismatch. It also avoids setState-inside-effect,
   *  which cascades renders. */
  // Open/closed state now persists in pm:ui-prefs (Redis-backed, synced
  // across devices + refreshes); the old localStorage blob remains only as a
  // one-time fallback default for names never toggled since the migration.
  const { uiPrefs, setUiPref } = useStocks();
  const [overrides, setOverrides] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, boolean>)
        : {};
    } catch {
      return {}; // private mode / disabled storage → defaults
    }
  });
  const persist = (next: Record<string, boolean>) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* quota or disabled — collapse still works for this session */
    }
  };

  // A stored choice ALWAYS wins; needsAttention only supplies the default for
  // a name you have never toggled. Deliberate: an earlier version force-opened
  // anything tripped on every load, which meant a tripped name could not be
  // collapsed at all — it reopened on the next refresh. Safe because the
  // TRIPPED badge and red border sit in the header, which stays visible when
  // collapsed; only the prose and per-condition readings are hidden.
  const isOpen = (r: Row) => {
    const pref = uiPrefs[`thesis.open.${r.ticker}`];
    if (pref === "1") return true;
    if (pref === "0") return false;
    return overrides[r.ticker] ?? needsAttention(r);
  };

  const toggle = (ticker: string) => {
    const row = rows.find((x) => x.ticker === ticker);
    const current = row ? isOpen(row) : false;
    setUiPref(`thesis.open.${ticker}`, current ? "0" : "1");
    // Keep the legacy blob in sync so a pref-less session shows the same state.
    const next = { ...overrides, [ticker]: !current };
    setOverrides(next);
    persist(next);
  };

  const setAll = (open: boolean) => {
    // MUST write the pref too: isOpen() gives uiPrefs priority over the legacy
    // blob, so writing only the blob left any previously-toggled name stuck
    // open — "Collapse all" appeared to work, then came back on refresh.
    rows.forEach((r) => setUiPref(`thesis.open.${r.ticker}`, open ? "1" : "0"));
    const next = Object.fromEntries(rows.map((r) => [r.ticker, open]));
    setOverrides(next);
    persist(next);
  };

  const anyOpen = rows.some(isOpen);

  const totals = useMemo(() => {
    const trippedNames = rows.filter((r) => r.tripped > 0).length;
    const dueNames = rows.filter((r) => r.reUnderwriteBy && r.reUnderwriteBy < todayIso()).length;
    // AI drafts you have not edited yet. Editing a name on its stock page
    // clears the flag, so this doubles as a review queue that empties itself.
    const unreviewed = rows.filter((r) => r.aiDrafted).length;
    return { trippedNames, dueNames, unreviewed };
  }, [rows]);

  const cov = data?.coverage;

  /**
   * Bulk draft — generate AND SAVE a thesis for every not-yet-underwritten
   * name in one pass.
   *
   * This is the ONE place the "AI proposes, PM signs" rule is relaxed, at
   * Jordan's request, to bootstrap a book that would otherwise need ~16
   * separate stock-page visits. Mitigations: it only ever touches names with
   * NO conditions (a signed thesis is never overwritten), and every entry it
   * writes carries `aiDrafted: true`, which the card shows as "AI-assisted"
   * and the summary counts as awaiting review. Editing a name on its stock
   * page clears that flag, so the tag doubles as a review queue.
   *
   * Sequential, one request per name: a single draft is a full Sonnet call, so
   * batching them server-side would blow the function time limit. Sequential
   * also keeps it under any concurrency limit and makes progress meaningful.
   */
  /**
   * Names carrying a custom condition that has never been verified (status
   * "manual"). These DO verify themselves — the nightly sweep treats a
   * never-checked custom as due — but it processes at most 10 a night, so a
   * fresh bulk draft takes a few nights to clear. This button does it now.
   */
  const unverified = useMemo(
    () => rows.filter((r) => r.checks.some((k) => k.status === "manual")).map((r) => r.ticker),
    [rows],
  );
  const [verifying, setVerifying] = useState<{ done: number; total: number } | null>(null);
  const verifyAll = async () => {
    if (unverified.length === 0 || verifying) return;
    setVerifying({ done: 0, total: unverified.length });
    for (let i = 0; i < unverified.length; i++) {
      try {
        await fetch("/api/custom-condition-check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticker: unverified[i] }),
        });
      } catch {
        /* one name failing must not stop the rest */
      }
      setVerifying({ done: i + 1, total: unverified.length });
    }
    try {
      const fresh = await fetch("/api/thesis-watch", { cache: "no-store" }).then((r) => r.json());
      setData(fresh as Payload);
    } catch {
      /* a refresh picks it up */
    }
    setVerifying(null);
  };

  /**
   * Accept a proposed rewrite for a condition the company does not disclose.
   *
   * PROPOSED, never automatic: silently rewriting a pre-registered condition
   * would mean a later TRIPPED fires against a rule the PM never signed, and
   * the audit trail would show a criterion nobody chose. One click instead —
   * and the wording it replaced is kept on the condition (rewrittenFrom).
   */
  const [applying, setApplying] = useState<string | null>(null);
  const applyRewrite = async (row: Row, conditionId: string, suggestion: string) => {
    if (applying) return;
    setApplying(conditionId);
    try {
      const next = row.checks.map((k) => {
        const c = k.condition;
        if (c.id !== conditionId) return c;
        return {
          ...c,
          note: suggestion,
          rewrittenFrom: c.note,
          rewrittenAt: todayIso(),
          // Drop the stale verdict so the rewritten rule is checked fresh.
          aiCheck: undefined,
          trippedAt: null,
        };
      });
      await fetch("/api/kv/position-theses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: row.ticker,
          killConditions: next,
          // Remember the dead end so a future draft cannot propose it again.
          unverifiableNotes: [row.checks.find((k) => k.condition.id === conditionId)?.condition.note].filter(Boolean),
        }),
      });
      // Verify the new wording immediately, then reload.
      await fetch("/api/custom-condition-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: row.ticker, force: true }),
      }).catch(() => {});
      const fresh = await fetch("/api/thesis-watch", { cache: "no-store" }).then((r) => r.json());
      setData(fresh as Payload);
    } catch {
      /* leave the suggestion in place so it can be retried */
    } finally {
      setApplying(null);
    }
  };

  /** Every condition carrying a proposed rewrite, across all names. */
  const pendingRewrites = useMemo(
    () =>
      rows.flatMap((r) =>
        r.checks
          .filter((k) => k.condition.aiCheck?.undisclosed && k.condition.aiCheck.suggestedNote)
          .map((k) => ({ ticker: r.ticker, conditionId: k.condition.id })),
      ),
    [rows],
  );
  const [bulkRewriting, setBulkRewriting] = useState<{ done: number; total: number } | null>(null);
  const applyAllRewrites = async () => {
    if (pendingRewrites.length === 0 || bulkRewriting) return;
    // Group by ticker: one read-merge-write per name rather than per condition.
    const byTicker = new Map<string, Set<string>>();
    for (const p of pendingRewrites) {
      if (!byTicker.has(p.ticker)) byTicker.set(p.ticker, new Set());
      byTicker.get(p.ticker)!.add(p.conditionId);
    }
    const tickers = [...byTicker.keys()];
    setBulkRewriting({ done: 0, total: tickers.length });
    for (let i = 0; i < tickers.length; i++) {
      const tk = tickers[i];
      const row = rows.find((r) => r.ticker === tk);
      const ids = byTicker.get(tk)!;
      if (row) {
        try {
          const next = row.checks.map((k) => {
            const c = k.condition;
            if (!ids.has(c.id) || !c.aiCheck?.suggestedNote) return c;
            return {
              ...c,
              note: c.aiCheck.suggestedNote,
              rewrittenFrom: c.note,
              rewrittenAt: todayIso(),
              aiCheck: undefined,
              trippedAt: null,
            };
          });
          await fetch("/api/kv/position-theses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ticker: tk,
              killConditions: next,
              unverifiableNotes: row.checks
                .filter((k) => ids.has(k.condition.id))
                .map((k) => k.condition.note)
                .filter(Boolean),
            }),
          });
          await fetch("/api/custom-condition-check", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ticker: tk, force: true }),
          }).catch(() => {});
        } catch {
          /* one name failing must not stop the rest */
        }
      }
      setBulkRewriting({ done: i + 1, total: tickers.length });
    }
    try {
      const fresh = await fetch("/api/thesis-watch", { cache: "no-store" }).then((r) => r.json());
      setData(fresh as Payload);
    } catch {
      /* a refresh picks it up */
    }
    setBulkRewriting(null);
  };

  const [bulk, setBulk] = useState<{ done: number; total: number; failed: string[] } | null>(null);
  /**
   * mode "missing" → only names with no conditions yet (safe, additive).
   * mode "all"     → also REDRAFTS every existing thesis, overwriting the
   *                  prose and conditions currently saved. That destroys hand
   *                  edits, so it is confirmed explicitly first — the same bar
   *                  CLAUDE.md sets for anything that overwrites user data.
   */
  const draftBulk = async (mode: "missing" | "all") => {
    const missing = cov?.missing ?? [];
    const targets =
      mode === "missing"
        ? missing
        : [...rows.map((r) => ({ ticker: r.ticker, price: null as number | null })), ...missing];
    if (targets.length === 0 || bulk) return;
    if (mode === "all" && rows.length > 0) {
      const ok = window.confirm(
        `Redraft ALL ${targets.length} theses?\n\nThis OVERWRITES the ${rows.length} thesis${rows.length === 1 ? "" : "es"} already saved, including any wording or conditions you edited by hand. Trip history and re-underwrite dates are rewritten too. This cannot be undone.`,
      );
      if (!ok) return;
    }
    setBulk({ done: 0, total: targets.length, failed: [] });
    const failed: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      try {
        const d = await fetch("/api/thesis-draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticker: t.ticker }),
        }).then((r) => r.json());
        if (!d?.draft?.why) throw new Error(d?.error || "no draft");
        const due = new Date();
        due.setDate(due.getDate() + 90);
        const res = await fetch("/api/kv/position-theses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ticker: t.ticker,
            why: d.draft.why,
            killConditions: (
              d.draft.conditions as { kind: string; threshold?: number; note?: string; theme?: string }[]
            ).map((c, n) => ({
              id: `${c.kind}-${Date.now()}-${n}`,
              kind: c.kind,
              threshold: c.threshold,
              note: c.note,
              theme: c.theme,
              addedAt: todayIso(),
            })),
            underwrittenAt: todayIso(),
            ...(typeof t.price === "number" ? { underwritePrice: t.price } : {}),
            reUnderwriteBy: due.toISOString().slice(0, 10),
            aiDrafted: true,
          }),
        });
        if (!res.ok) throw new Error("save failed");
      } catch {
        failed.push(t.ticker);
      }
      setBulk({ done: i + 1, total: targets.length, failed: [...failed] });
    }
    // Reload so the new cards appear with their live condition readings.
    try {
      const fresh = await fetch("/api/thesis-watch", { cache: "no-store" }).then((r) => r.json());
      setData(fresh as Payload);
    } catch {
      /* the page still shows the pre-run state; a refresh picks it up */
    }
    setBulk((b) => (b ? { ...b, done: b.total } : b));
  };

  const btnSecondary =
    "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover disabled:opacity-50";

  return (
    <main className="flex flex-col gap-3.5 text-ink">
      {/* Toolbar: summary as dot + word, bulk actions right-aligned. */}
      {!loading && (
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 text-[12.5px] text-ink-2">
          <span className="inline-flex items-center gap-1.5">
            <span className="dot bg-ink-3" />
            {cov ? `${cov.underwritten} of ${cov.portfolioCount} stocks underwritten` : `${rows.length} underwritten`}
          </span>
          {totals.trippedNames > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span className="dot bg-neg" />
              {totals.trippedNames} with a tripped condition
            </span>
          )}
          {totals.dueNames > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span className="dot bg-warn" />
              {totals.dueNames} re-underwrite overdue
            </span>
          )}
          {totals.unreviewed > 0 && (
            <span
              className="inline-flex items-center gap-1.5"
              title="Written by the AI bulk draft and not edited since. Open a name and save it on its stock page to mark it reviewed."
            >
              <span className="dot bg-accent" />
              {totals.unreviewed} AI-drafted, unreviewed
            </span>
          )}
          <Link href="/methodology" className="text-[12px] text-accent hover:underline">
            How this works
          </Link>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {pendingRewrites.length > 0 && !bulk && (
              <button
                onClick={applyAllRewrites}
                disabled={!!bulkRewriting}
                title={`Applies every proposed rewrite (${pendingRewrites.length}) — only conditions the company does NOT disclose. Each keeps the wording it replaced, and is re-verified immediately.`}
                className={btnSecondary}
              >
                {bulkRewriting
                  ? `Rewriting ${bulkRewriting.done + 1} of ${bulkRewriting.total}…`
                  : `Apply ${pendingRewrites.length} rewrite${pendingRewrites.length === 1 ? "" : "s"}`}
              </button>
            )}
            {unverified.length > 0 && !bulk && (
              <button
                onClick={verifyAll}
                disabled={!!verifying}
                title={`Runs the AI web check now on every unverified custom condition across ${unverified.length} name${unverified.length === 1 ? "" : "s"}. They would verify themselves within a few nights anyway — this skips the wait.`}
                className={btnSecondary}
              >
                {verifying
                  ? `Verifying ${verifying.done + 1} of ${verifying.total}…`
                  : `Verify ${unverified.length} unverified`}
              </button>
            )}
            {bulk ? (
              <span className="inline-flex h-7 items-center text-[12.5px] text-ink-2">
                {bulk.done < bulk.total
                  ? `Drafting ${bulk.done + 1} of ${bulk.total}…`
                  : `Done — ${bulk.total - bulk.failed.length} drafted`}
              </span>
            ) : (
              <>
                {cov && cov.missing.length > 0 && (
                  <button
                    onClick={() => draftBulk("missing")}
                    title={`Generates and SAVES an AI thesis for the ${cov.missing.length} name${cov.missing.length === 1 ? "" : "s"} with no conditions yet. Existing theses are NOT touched.`}
                    className={btnSecondary}
                  >
                    <AppIcon name="spark" size={13} />
                    Draft {cov.missing.length} missing
                  </button>
                )}
                {rows.length > 0 && (
                  <button
                    onClick={() => draftBulk("all")}
                    title={`Redrafts ALL ${rows.length + (cov?.missing.length ?? 0)}, OVERWRITING the ${rows.length} already saved — including hand edits. Asks for confirmation first.`}
                    className={btnSecondary}
                  >
                    <AppIcon name="refresh" size={13} />
                    Redraft all {rows.length + (cov?.missing.length ?? 0)}
                  </button>
                )}
              </>
            )}
            {rows.length > 0 && (
              <button onClick={() => setAll(!anyOpen)} className={btnSecondary}>
                {anyOpen ? "Collapse all" : "Expand all"}
              </button>
            )}
          </div>
        </div>
      )}

      {bulk && bulk.failed.length > 0 && (
        <p className="text-[11.5px] text-neg">
          Could not draft: {bulk.failed.join(", ")} — open those names individually.
        </p>
      )}

      {loading && (
        <div className="flex flex-col gap-3.5">
          <Skeleton className="h-32 w-full rounded-card" />
          <Skeleton className="h-32 w-full rounded-card" />
        </div>
      )}

      {!loading && rows.length === 0 && (
        <section className="panel">
          <EmptyState
            glyph={<AppIcon name="filecheck" size={18} />}
            title="No positions underwritten yet"
            body={
              <>
                Open a holding&apos;s stock page and use <span className="font-medium text-ink">Draft with AI</span> in the
                Thesis tile — it proposes a thesis and exit conditions from that name&apos;s own research, and you edit and sign it.
              </>
            }
          />
        </section>
      )}

      {/* One panel-style collapsible row per underwritten name.
          Grid rather than a stack so expanding two or three names no longer
          pushes the others off-screen. ROW-MAJOR on purpose: cards read
          left-to-right in alphabetical order, so a name is where you expect
          it. items-start keeps a tall expanded card from stretching its
          neighbours to match. Open state persists per name in pm:ui-prefs
          (`thesis.open.<ticker>`, unchanged). */}
      {rows.length > 0 && (
        <div className="grid items-start gap-3.5 lg:grid-cols-2 2xl:grid-cols-3">
          {rows.map((r) => {
            const overdue = r.reUnderwriteBy ? r.reUnderwriteBy < todayIso() : false;
            const open = isOpen(r);
            return (
              <section key={r.ticker} className="panel">
                <div
                  className={`flex min-h-[38px] flex-wrap items-center gap-2.5 px-3.5 py-1.5 ${open ? "border-b border-line-soft" : ""}`}
                >
                  <button
                    onClick={() => toggle(r.ticker)}
                    aria-expanded={open}
                    aria-label={`${open ? "Collapse" : "Expand"} ${displayTicker(r.ticker)}`}
                    title={open ? "Collapse" : "Expand"}
                    className="grid h-5 w-5 shrink-0 place-items-center text-ink-3 transition-colors hover:text-ink"
                  >
                    <AppIcon name={open ? "chevD" : "chevR"} size={14} strokeWidth={2} />
                  </button>
                  <Link href={`/stock/${encodeURIComponent(r.ticker)}`} className="font-mono text-[13px] font-semibold text-ink hover:text-accent">
                    {displayTicker(r.ticker)}
                  </Link>
                  {/* Status: dot + word, one column. Precedence tripped › ok. */}
                  {r.auto > 0 && (
                    <span className={`inline-flex items-center gap-1.5 text-[12px] ${r.tripped > 0 ? "text-neg" : "text-ink-2"}`}>
                      <span className={`dot ${r.tripped > 0 ? "bg-neg" : "bg-pos"}`} />
                      {r.tripped > 0 ? `${r.tripped} of ${r.auto} tripped` : `${r.auto} conditions OK`}
                    </span>
                  )}
                  {r.aiDrafted && <span className="text-[11.5px] text-ink-3">AI draft</span>}
                  <span className="ml-auto font-mono text-[11px] text-ink-3">
                    {r.underwrittenAt ? `underwritten ${r.underwrittenAt}` : ""}
                    {r.reUnderwriteBy ? (
                      <span className={overdue ? "text-warn" : ""}>
                        {" · re-underwrite "}
                        {overdue ? "overdue" : "due"} {r.reUnderwriteBy}
                      </span>
                    ) : null}
                  </span>
                </div>

                {open && r.why && (
                  <p className="whitespace-pre-line border-b border-line-soft px-3.5 py-2.5 text-[12.5px] leading-[1.5] text-ink-2">
                    {r.why}
                  </p>
                )}

                {open && (
                  <div className="divide-y divide-line-soft">
                    {r.checks.map((k, i) => {
                      const st = STATUS_STYLE[k.status];
                      const uk = unclearKind(k.condition);
                      const pending = uk === "pending";
                      const statusWord =
                        k.status === "tripped" && k.condition.trippedAt
                          ? `Tripped ${k.condition.trippedAt.slice(5)}`
                          : pending
                            ? "Pending"
                            : st.label;
                      const statusTone =
                        k.status === "tripped" ? "text-neg" : k.status === "ok" ? "text-ink-2" : "text-ink-3";
                      const dotTone = pending ? "bg-ink-faint" : st.dot;
                      return (
                        <div key={`${r.ticker}-${i}`} className="flex items-start gap-2.5 px-3.5 py-2">
                          <span className={`dot mt-[7px] ${dotTone}`} aria-hidden />
                          <div className="min-w-0 flex-1">
                            {k.condition.theme && (
                              <div className="text-[11px] text-ink-3">{k.condition.theme}</div>
                            )}
                            <div className="text-[12.5px] font-medium text-ink">{describeCondition(k.condition)}</div>
                            <div className="text-[11.5px] text-ink-3">{k.reading}</div>
                            {k.condition.aiCheck?.undisclosed && k.condition.aiCheck.suggestedNote && (
                              <div className="mt-1.5 rounded-control border border-line bg-surface-2 px-2.5 py-1.5">
                                <div className="text-[11px] text-warn">Not disclosed — can never verify</div>
                                <div className="mt-0.5 text-[12px] leading-5 text-ink-2">
                                  Suggested: {k.condition.aiCheck.suggestedNote}
                                </div>
                                <button
                                  onClick={() => applyRewrite(r, k.condition.id, k.condition.aiCheck!.suggestedNote!)}
                                  disabled={applying === k.condition.id}
                                  className="mt-1 inline-flex items-center gap-1 text-[11.5px] font-medium text-accent hover:underline disabled:opacity-50"
                                >
                                  {applying === k.condition.id ? "Applying…" : "Apply rewrite"}
                                  <AppIcon name="arrowR" size={12} />
                                </button>
                              </div>
                            )}
                            {k.condition.rewrittenFrom && (
                              <div className="mt-0.5 text-[11px] text-ink-faint">
                                rewritten {k.condition.rewrittenAt} · was: {k.condition.rewrittenFrom}
                              </div>
                            )}
                          </div>
                          <span
                            className={`shrink-0 text-[11.5px] ${statusTone}`}
                            title={pending ? "Waiting on the next report — the condition is fine, the figure just isn't out yet." : undefined}
                          >
                            {statusWord}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {open && r.tripped > 0 && (
                  <div className="flex items-center gap-2 border-t border-line-soft px-3.5 py-2">
                    <span className="dot bg-neg" />
                    <span className="text-[12px] text-neg">A pre-registered exit condition is tripped.</span>
                    <Link
                      href={`/stock/${encodeURIComponent(r.ticker)}`}
                      className="ml-auto inline-flex h-7 items-center gap-1 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover"
                    >
                      Respond on {displayTicker(r.ticker)}
                      <AppIcon name="arrowR" size={12} />
                    </Link>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {/* Coverage gap — the actionable part: what you own but haven't underwritten */}
      {!loading && cov && cov.missing.length > 0 && (
        <section className="panel">
          <div className="panel-h">
            <span className="t">Not underwritten</span>
            <span className="m">
              <span className="font-mono">{cov.missing.length}</span> · stocks with no pre-registered exit conditions — nothing is watching these
            </span>
          </div>
          {/* Multi-column: at full width a single list of tickers is mostly dead
              space, and this is the checklist the PM works down. */}
          <div className="grid md:grid-cols-2 2xl:grid-cols-3">
            {cov.missing.map((m) => (
              <div key={m.ticker} className="flex h-[34px] items-center gap-3 border-b border-line-soft px-3.5">
                <Link
                  href={`/stock/${encodeURIComponent(m.ticker)}`}
                  className="font-mono text-[12.5px] font-medium text-ink hover:text-accent"
                >
                  {displayTicker(m.ticker)}
                </Link>
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
                  {m.name}
                  {m.sector ? ` · ${m.sector}` : ""}
                </span>
                {m.hasProse && <span className="shrink-0 text-[11.5px] text-warn">note only — no conditions</span>}
                <Link
                  href={`/stock/${encodeURIComponent(m.ticker)}`}
                  className="inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-accent hover:underline"
                >
                  Underwrite
                  <AppIcon name="arrowR" size={12} />
                </Link>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="text-[11.5px] leading-5 text-ink-3">
        Individual stocks you own. Kill conditions are exit criteria, so the coverage count is
        what you hold; ETFs and funds are excluded (no company thesis to underwrite), and
        watchlist names are tracked on{" "}
        <Link href="/conviction" className="text-accent hover:underline">
          Pipeline
        </Link>{" "}
        instead.
      </p>
    </main>
  );
}
