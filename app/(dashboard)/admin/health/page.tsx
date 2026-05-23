"use client";

/**
 * /admin/health — one-page status board for every external data source
 * the app depends on. Replaces the "go discover Finviz is broken via a
 * tile showing N/A" workflow with a single dashboard where each source
 * is colour-coded green / amber / red with last-checked latency.
 *
 * Calls /api/admin/health, which pings every upstream in parallel with
 * a 6-second timeout per source. Auto-refreshes every 60s when the
 * page is visible (paused on hidden tab to avoid burning rate limits).
 *
 * Read-only — no buttons here mutate data.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";

type Status = "ok" | "warn" | "fail" | "skipped";
type Category = "prices" | "sentiment" | "macro" | "ai" | "infra";

type CheckResult = {
  name: string;
  category: Category;
  status: Status;
  latencyMs: number | null;
  message: string;
  sourceUrl?: string;
};

type HealthResponse = {
  generatedAt: string;
  summary: { ok: number; warn: number; fail: number; skipped: number; total: number };
  checks: CheckResult[];
};

const STATUS_STYLES: Record<Status, { badge: string; row: string; label: string }> = {
  ok:      { badge: "bg-emerald-100 text-emerald-700 border-emerald-200", row: "border-l-emerald-400",  label: "OK" },
  warn:    { badge: "bg-amber-100 text-amber-700 border-amber-200",       row: "border-l-amber-400",    label: "WARN" },
  fail:    { badge: "bg-red-100 text-red-700 border-red-200",             row: "border-l-red-400",      label: "FAIL" },
  skipped: { badge: "bg-slate-100 text-slate-500 border-slate-200",       row: "border-l-slate-300",    label: "SKIP" },
};

const CATEGORY_LABELS: Record<Category, string> = {
  prices: "Prices & quotes",
  sentiment: "Sentiment & breadth",
  macro: "Macro & fundamentals",
  ai: "AI / scoring",
  infra: "Infrastructure",
};

function fmtRel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
}

export default function AdminHealthPage() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumps every second so relative timestamps re-render — keeps "12s ago"
  // updating without re-fetching the whole status payload.
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/health", { cache: "no-store" });
      if (!res.ok) {
        setError(`Health endpoint returned HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as HealthResponse;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh every 60s, but only while the tab is visible — no point
  // hammering Yahoo / Finviz / FRED for a tab the user isn't watching.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(interval);
    };
  }, [load]);

  // 1Hz tick so relative timestamps stay fresh between fetches.
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  // Reference tick so React keeps re-rendering. (No-op visually.)
  void tick;

  const grouped = useMemo(() => {
    if (!data) return [] as { category: Category; checks: CheckResult[] }[];
    const map = new Map<Category, CheckResult[]>();
    for (const c of data.checks) {
      if (!map.has(c.category)) map.set(c.category, []);
      map.get(c.category)!.push(c);
    }
    return (Object.keys(CATEGORY_LABELS) as Category[])
      .filter((c) => map.has(c))
      .map((category) => ({ category, checks: map.get(category)! }));
  }, [data]);

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6 space-y-5">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Health</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Status of every upstream data source. Auto-refreshes every 60 seconds.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data && (
            <span className="text-xs text-slate-400" suppressHydrationWarning>
              Updated {fmtRel(data.generatedAt)}
            </span>
          )}
          <button
            onClick={load}
            disabled={loading}
            className="rounded-lg bg-slate-800 hover:bg-slate-700 text-white px-3 py-1.5 text-xs font-semibold disabled:opacity-50 flex items-center gap-1.5"
          >
            <svg className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" /></svg>
            {loading ? "Checking..." : "Re-check now"}
          </button>
        </div>
      </header>

      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <SummaryTile label="OK" count={data.summary.ok} tone="ok" />
          <SummaryTile label="Warn" count={data.summary.warn} tone="warn" />
          <SummaryTile label="Fail" count={data.summary.fail} tone="fail" />
          <SummaryTile label="Skipped" count={data.summary.skipped} tone="skipped" />
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {grouped.map(({ category, checks }) => (
        <section key={category} className="space-y-2">
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
            {CATEGORY_LABELS[category]}
          </h2>
          <div className="space-y-1.5">
            {checks.map((c) => {
              const styles = STATUS_STYLES[c.status];
              return (
                <div
                  key={c.name}
                  className={`flex items-start gap-3 rounded-lg border border-slate-200 border-l-4 bg-white px-3 py-2 ${styles.row}`}
                >
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wider mt-0.5 ${styles.badge}`}
                  >
                    {styles.label}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-slate-800">{c.name}</span>
                      {c.latencyMs != null && (
                        <span className="text-[11px] text-slate-400">{c.latencyMs}ms</span>
                      )}
                      {c.sourceUrl && (
                        <a
                          href={c.sourceUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-[11px] text-blue-600 hover:underline"
                        >
                          source ↗
                        </a>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5 break-words">{c.message}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {!data && !error && (
        <div className="text-sm text-slate-400">Loading health checks...</div>
      )}
    </div>
  );
}

function SummaryTile({ label, count, tone }: { label: string; count: number; tone: Status }) {
  const styles = STATUS_STYLES[tone];
  return (
    <div className={`rounded-lg border bg-white px-3 py-2 ${styles.badge.replace("100", "50").replace("700", "700")} border-l-4 ${styles.row}`}>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">{label}</div>
      <div className="text-xl font-bold text-slate-800 mt-0.5">{count}</div>
    </div>
  );
}
