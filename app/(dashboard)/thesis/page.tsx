"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { displayTicker } from "@/app/lib/ticker";
import { Skeleton } from "@/app/components/Skeleton";
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
 * Ordering is by what needs attention: tripped conditions first, then overdue
 * re-underwrites, then unwatchable (NO DATA) conditions, then alphabetical.
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
};
type CoverageRow = { ticker: string; name?: string; sector?: string; hasProse: boolean };
type Payload = {
  holdings: Row[];
  coverage?: { portfolioCount: number; underwritten: number; missing: CoverageRow[] };
};

const STATUS_STYLE: Record<KillStatus, { dot: string; pill: string; label: string }> = {
  ok: { dot: "bg-pos", pill: "bg-pos-soft text-pos border-pos-border", label: "OK" },
  tripped: { dot: "bg-neg", pill: "bg-neg-soft text-neg border-neg-border", label: "TRIPPED" },
  unknown: { dot: "bg-ink-faint", pill: "bg-surface-2 text-ink-3 border-line", label: "NO DATA" },
  manual: { dot: "bg-ink-faint", pill: "bg-surface-2 text-ink-2 border-line", label: "MANUAL" },
};

const todayIso = () => new Date().toISOString().slice(0, 10);

/** localStorage, NOT pm:ui-prefs: persisting here costs no Redis write, no
 *  bytes in the nightly backup blob and no origin transfer. Trade-off is that
 *  the preference is per-device rather than synced. */
const STORAGE_KEY = "pm.thesis.collapse";

/** A card that needs a decision: a tripped condition or an overdue
 *  re-underwrite. Drives both the default open state and the stale-collapse
 *  guard in isOpen. */
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

  const rows = useMemo(() => {
    const list = [...(data?.holdings ?? [])];
    const overdue = (r: Row) => (r.reUnderwriteBy ? (r.reUnderwriteBy < todayIso() ? 1 : 0) : 0);
    const noData = (r: Row) => r.checks.filter((c) => c.status === "unknown").length;
    list.sort(
      (a, b) =>
        b.tripped - a.tripped ||
        overdue(b) - overdue(a) ||
        noData(b) - noData(a) ||
        a.ticker.localeCompare(b.ticker),
    );
    return list;
  }, [data]);

  /**
   * Collapse state. Cards default to COLLAPSED except those that need
   * attention (a tripped condition or an overdue re-underwrite) — the page is
   * a monitor, so the calm names should be a compact index and the ones asking
   * for a decision should already be open.
   *
   * Persisted to localStorage (see STORAGE_KEY) so choices survive a refresh
   * without costing a Redis write or backup bytes.
   *
   * STALE-COLLAPSE GUARD: a "collapsed" remembered from a previous visit is
   * IGNORED for any name that now needs attention. Without it a preference set
   * weeks ago would keep a freshly-tripped name closed — the exact failure a
   * remembered preference invites once it outlives its reason. Your choice
   * still sticks for every calm name, and for a name you collapse yourself in
   * the current session.
   *
   * Collapsing never hides a problem regardless: the tripped/OK badge and the
   * red card border live in the HEADER, which stays visible when collapsed.
   * Only the thesis prose and per-condition readings are hidden.
   */
  /** Per-ticker overrides of the default; absent = follow the default.
   *
   *  Read from storage in a LAZY INITIALIZER rather than an effect. That is
   *  safe here specifically because this page renders no cards during SSR —
   *  it is still `loading` until the client fetch returns — so there is no
   *  server/client markup to mismatch. It also avoids setState-inside-effect,
   *  which cascades renders. */
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
  /** Tickers toggled in THIS session — see the stale-collapse guard in isOpen. */
  const [touched, setTouched] = useState<Set<string>>(() => new Set());

  const persist = (next: Record<string, boolean>) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* quota or disabled — collapse still works for this session */
    }
  };

  const isOpen = (r: Row) => {
    // Stale-collapse guard: a collapse remembered from a previous visit must
    // not keep a name closed that has SINCE started asking for a decision.
    // An explicit collapse made this session is still honoured.
    if (needsAttention(r) && !touched.has(r.ticker)) return true;
    return overrides[r.ticker] ?? needsAttention(r);
  };

  const toggle = (ticker: string) => {
    const row = rows.find((x) => x.ticker === ticker);
    const current = row ? isOpen(row) : false;
    const next = { ...overrides, [ticker]: !current };
    setOverrides(next);
    setTouched((t) => new Set(t).add(ticker));
    persist(next);
  };

  const setAll = (open: boolean) => {
    const next = Object.fromEntries(rows.map((r) => [r.ticker, open]));
    setOverrides(next);
    setTouched(new Set(rows.map((r) => r.ticker)));
    persist(next);
  };

  const anyOpen = rows.some(isOpen);

  const totals = useMemo(() => {
    const trippedNames = rows.filter((r) => r.tripped > 0).length;
    const dueNames = rows.filter((r) => r.reUnderwriteBy && r.reUnderwriteBy < todayIso()).length;
    return { trippedNames, dueNames };
  }, [rows]);

  const cov = data?.coverage;

  return (
    <main className="min-h-screen bg-ground px-4 py-6 text-ink md:px-8 md:py-8">
      {/* Wide container: this is a monitor, not a reading page. At max-w-5xl
          two expanded cards already pushed the rest below the fold. */}
      <div className="mx-auto max-w-[1600px]">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-ink">Thesis Desk</h1>
          {/* Capped to a readable measure — the GRID uses the full width, prose shouldn't. */}
          <p className="mt-1 max-w-3xl text-sm text-ink-3">
            Every underwritten position, its thesis as signed, and the pre-registered conditions
            that would make you wrong — checked automatically.{" "}
            <Link href="/methodology" className="text-accent hover:underline">
              How this works
            </Link>
          </p>
        </div>

        {/* Summary strip */}
        {!loading && (
          <div className="mb-5 flex flex-wrap items-center gap-2 text-[12px]">
            <span className="rounded-full border border-line bg-white px-2.5 py-1 font-semibold text-ink-2">
              {cov ? `${cov.underwritten} of ${cov.portfolioCount} stocks underwritten` : `${rows.length} underwritten`}
            </span>
            {totals.trippedNames > 0 && (
              <span className="rounded-full border border-neg-border bg-neg-soft px-2.5 py-1 font-semibold text-neg">
                {totals.trippedNames} with a tripped condition
              </span>
            )}
            {totals.dueNames > 0 && (
              <span className="rounded-full border border-warn-border bg-warn-soft px-2.5 py-1 font-semibold text-warn">
                {totals.dueNames} re-underwrite overdue
              </span>
            )}
            {rows.length > 0 && (
              <button
                onClick={() => setAll(!anyOpen)}
                className="ml-auto rounded-control border border-line bg-white px-2.5 py-1 text-[11px] font-semibold text-ink-2 hover:text-ink"
              >
                {anyOpen ? "Collapse all" : "Expand all"}
              </button>
            )}
          </div>
        )}

        {loading && (
          <div className="space-y-3">
            <Skeleton className="h-32 w-full rounded-card" />
            <Skeleton className="h-32 w-full rounded-card" />
          </div>
        )}

        {!loading && rows.length === 0 && (
          <section className="rounded-card border border-line bg-white px-5 py-10 text-center shadow-sm">
            <p className="text-sm font-semibold text-ink">No positions underwritten yet</p>
            <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-6 text-ink-3">
              Open a holding&apos;s stock page and use <span className="font-semibold text-ink-2">✦ Draft with AI</span>{" "}
              in the Thesis tile — it proposes a thesis and exit conditions from that name&apos;s own
              research, and you edit and sign it.
            </p>
          </section>
        )}

        {/* One card per underwritten name.
            Grid rather than a stack so expanding two or three names no longer
            pushes the others off-screen. ROW-MAJOR on purpose: the rows are
            sorted by urgency (tripped → overdue → no-data → alphabetical), and
            a grid preserves that in reading order left-to-right. CSS columns
            would pack denser but reorder priority down each column instead.
            items-start keeps a tall expanded card from stretching its
            neighbours to match. */}
        <div className="grid items-start gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {rows.map((r) => {
            const overdue = r.reUnderwriteBy ? r.reUnderwriteBy < todayIso() : false;
            const open = isOpen(r);
            return (
              <section
                key={r.ticker}
                className={`overflow-hidden rounded-card border bg-white shadow-sm ${
                  r.tripped > 0 ? "border-neg-border" : "border-line"
                }`}
              >
                <div className={`flex flex-wrap items-center gap-2 px-4 py-3 ${open ? "border-b border-line" : ""}`}>
                  <button
                    onClick={() => toggle(r.ticker)}
                    aria-expanded={open}
                    aria-label={`${open ? "Collapse" : "Expand"} ${displayTicker(r.ticker)}`}
                    title={open ? "Collapse" : "Expand"}
                    className="shrink-0 text-ink-3 transition-colors hover:text-ink"
                  >
                    <span className={`inline-block text-[11px] transition-transform ${open ? "rotate-90" : ""}`} aria-hidden>
                      ▶
                    </span>
                  </button>
                  <Link href={`/stock/${encodeURIComponent(r.ticker)}`} className="font-mono text-sm font-bold text-ink hover:text-accent">
                    {displayTicker(r.ticker)}
                  </Link>
                  {r.auto > 0 && (
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${
                        r.tripped > 0 ? STATUS_STYLE.tripped.pill : STATUS_STYLE.ok.pill
                      }`}
                    >
                      {r.tripped > 0 ? `${r.tripped} of ${r.auto} tripped` : `${r.auto} conditions OK`}
                    </span>
                  )}
                  <span className="ml-auto font-mono text-[11px] text-ink-faint">
                    {r.underwrittenAt ? `underwritten ${r.underwrittenAt}` : ""}
                    {r.reUnderwriteBy ? (
                      <span className={overdue ? "font-semibold text-neg" : ""}>
                        {" · re-underwrite "}
                        {overdue ? "OVERDUE" : "due"} {r.reUnderwriteBy}
                      </span>
                    ) : null}
                  </span>
                </div>

                {open && r.why && (
                  <p className="whitespace-pre-line border-b border-line-soft px-4 py-3 text-[13px] leading-6 text-ink-2">
                    {r.why}
                  </p>
                )}

                {open && <div className="divide-y divide-line-soft">
                  {r.checks.map((k, i) => {
                    const st = STATUS_STYLE[k.status];
                    return (
                      <div key={`${r.ticker}-${i}`} className="flex items-start gap-2.5 px-4 py-2">
                        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${st.dot}`} aria-hidden />
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium text-ink">{describeCondition(k.condition)}</div>
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
                </div>}

                {open && r.tripped > 0 && (
                  <div className="flex items-center gap-2 border-t border-line bg-neg-soft/40 px-4 py-2.5">
                    <span className="text-[12px] font-semibold text-neg">
                      A pre-registered exit condition is tripped.
                    </span>
                    <Link
                      href={`/stock/${encodeURIComponent(r.ticker)}`}
                      className="ml-auto rounded-control border border-line bg-white px-2.5 py-1 text-xs font-semibold text-ink-2 hover:text-ink"
                    >
                      Respond on {displayTicker(r.ticker)} →
                    </Link>
                  </div>
                )}
              </section>
            );
          })}
        </div>

        {/* Coverage gap — the actionable part: what you own but haven't underwritten */}
        {!loading && cov && cov.missing.length > 0 && (
          <section className="mt-6 rounded-card border border-line bg-white shadow-sm">
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
              <span className="text-xs font-bold uppercase tracking-[0.22em] text-ink-3">Not underwritten</span>
              <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] font-bold text-ink-2">
                {cov.missing.length}
              </span>
              <span className="ml-auto text-[11px] text-ink-3">
                Stocks with no pre-registered exit conditions — nothing is watching these.
              </span>
            </div>
            {/* Multi-column: at 1600px a single list of tickers is mostly dead
                space, and this is the checklist the PM works down. */}
            <div className="grid md:grid-cols-2 2xl:grid-cols-3">
              {cov.missing.map((m) => (
                <div key={m.ticker} className="flex items-center gap-3 border-b border-line-soft px-4 py-2">
                  <Link
                    href={`/stock/${encodeURIComponent(m.ticker)}`}
                    className="font-mono text-[13px] font-semibold text-ink hover:text-accent"
                  >
                    {displayTicker(m.ticker)}
                  </Link>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
                    {m.name}
                    {m.sector ? ` · ${m.sector}` : ""}
                  </span>
                  {m.hasProse && (
                    <span className="shrink-0 rounded-full border border-warn-border bg-warn-soft px-2 py-0.5 text-[10px] font-semibold text-warn">
                      note only — no conditions
                    </span>
                  )}
                  <Link
                    href={`/stock/${encodeURIComponent(m.ticker)}`}
                    className="shrink-0 text-[11px] font-semibold text-accent hover:underline"
                  >
                    Underwrite →
                  </Link>
                </div>
              ))}
            </div>
          </section>
        )}

        <p className="mt-6 text-[11px] leading-5 text-ink-faint">
          Individual stocks you own. Kill conditions are exit criteria, so the coverage count is
          what you hold; ETFs and funds are excluded (no company thesis to underwrite), and
          watchlist names are tracked on{" "}
          <Link href="/conviction" className="text-accent hover:underline">
            Pipeline
          </Link>{" "}
          instead.
        </p>
      </div>
    </main>
  );
}
