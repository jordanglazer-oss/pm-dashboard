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
import { AppIcon } from "@/app/components/AppIcon";
import { StatStrip } from "@/app/components/StatStrip";

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

/** Status = a dot and a word. Colour carries the meaning; the word names it. */
const STATUS: Record<Status, { dot: string; text: string; word: string }> = {
  ok:      { dot: "bg-pos",       text: "text-pos",   word: "OK" },
  warn:    { dot: "bg-warn",      text: "text-warn",  word: "Warn" },
  fail:    { dot: "bg-neg",       text: "text-neg",   word: "Fail" },
  skipped: { dot: "bg-ink-faint", text: "text-ink-3", word: "Skipped" },
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
    <div className="flex flex-col gap-3.5">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[11.5px] text-ink-3">
          Status of every upstream data source · auto-refreshes every 60 seconds
          {data && (
            <span suppressHydrationWarning> · updated {fmtRel(data.generatedAt)}</span>
          )}
        </span>
        <button
          onClick={load}
          disabled={loading}
          className="ml-auto flex h-7 items-center gap-1.5 rounded-control bg-ink px-2.5 text-[12.5px] font-medium text-white transition-colors hover:bg-ink-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <AppIcon name="refresh" size={13} strokeWidth={2} className={loading ? "animate-spin" : ""} />
          {loading ? "Checking" : "Re-check now"}
        </button>
      </div>

      {data && (
        <StatStrip
          cols={4}
          items={[
            { label: "OK", value: <span className={data.summary.ok > 0 ? "text-pos" : undefined}>{data.summary.ok}</span> },
            { label: "Warn", value: <span className={data.summary.warn > 0 ? "text-warn" : undefined}>{data.summary.warn}</span> },
            { label: "Fail", value: <span className={data.summary.fail > 0 ? "text-neg" : undefined}>{data.summary.fail}</span> },
            { label: "Skipped", value: <span className="text-ink-3">{data.summary.skipped}</span> },
          ]}
        />
      )}

      {error && (
        <div className="flex items-center gap-2 text-[12.5px] text-neg">
          <span className="dot bg-neg" />
          {error}
        </div>
      )}

      {grouped.map(({ category, checks }) => {
        const okCount = checks.filter((c) => c.status === "ok").length;
        return (
          <section key={category} className="panel">
            <div className="panel-h">
              <span className="t">{CATEGORY_LABELS[category]}</span>
              <span className="m">{okCount} of {checks.length} OK</span>
            </div>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="pl-3.5">Status</th>
                    <th>Source</th>
                    <th className="n">Latency</th>
                    <th className="w-full">Message</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {checks.map((c) => {
                    const st = STATUS[c.status];
                    return (
                      <tr key={c.name}>
                        <td className="pl-3.5">
                          <span className={`inline-flex items-center gap-2 ${st.text}`}>
                            <span className={`dot ${st.dot}`} />
                            {st.word}
                          </span>
                        </td>
                        <td className="font-medium">{c.name}</td>
                        <td className="n text-ink-3">{c.latencyMs != null ? `${c.latencyMs}ms` : "—"}</td>
                        <td className="whitespace-normal text-[12px] leading-[1.45] text-ink-2">{c.message}</td>
                        <td className="pr-3.5 text-right">
                          {c.sourceUrl && (
                            <a
                              href={c.sourceUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              title="Open source"
                              aria-label="Open source"
                              className="inline-grid h-7 w-7 place-items-center rounded-control text-ink-3 transition-colors hover:bg-surface-hover hover:text-ink"
                            >
                              <AppIcon name="external" size={14} />
                            </a>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      {!data && !error && (
        <div className="text-[12.5px] text-ink-3">Loading health checks</div>
      )}
    </div>
  );
}
