"use client";

import React, { useCallback, useEffect, useState } from "react";
import type { FundstratView, StrategistView } from "@/app/api/fundstrat-view/route";
import { useCollapsed } from "@/app/lib/useCollapsed";
import { AppIcon } from "../AppIcon";
import { Skeleton } from "../Skeleton";
import { Status, timeAgo } from "./summary-ui";

/**
 * Fundstrat view — Mark Newton's and Tom Lee's latest notes distilled into a
 * few bullets each, side by side, near the top of the Brief. Reads
 * GET /api/fundstrat-view (hash-gated: spends one AI call only when a new
 * note arrives). Read-only; collapse state persists in pm:ui-prefs.
 */

const STANCE_TONE: Record<StrategistView["stance"], "pos" | "neutral" | "warn"> = {
  constructive: "pos",
  neutral: "neutral",
  cautious: "warn",
};

/** "Oct 24" from YYYY-MM-DD. */
const shortDate = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ymd;
};

function Column({ who, role, v }: { who: string; role: string; v: StrategistView | null }) {
  return (
    <div className="min-w-0 px-5 py-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[14px] font-semibold text-ink">{who}</span>
        <span className="text-[11.5px] text-ink-3">{role}</span>
        {v && (
          <span className="ml-auto flex items-center gap-2">
            <Status tone={STANCE_TONE[v.stance]}>{v.stance}</Status>
            <span className="text-[11.5px] text-ink-3">{shortDate(v.date)}</span>
          </span>
        )}
      </div>
      {!v ? (
        <p className="m-0 mt-3 text-[12.5px] text-ink-3">No recent note on file.</p>
      ) : (
        <>
          {v.headline && <p className="m-0 mt-2.5 text-[13.5px] font-semibold leading-[1.45] text-ink">{v.headline}</p>}
          <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
            {v.bullets.map((b, i) => (
              <li key={i} className="flex gap-2.5 text-[13px] leading-[1.5] text-ink-2">
                <span className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                <span className="min-w-0">{b}</span>
              </li>
            ))}
          </ul>
          {v.watch && v.watch.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink-3">Watch</span>
              {v.watch.map((w) => (
                <span key={w} className="rounded-pill border border-line bg-surface-2 px-2.5 py-0.5 text-[11.5px] text-ink-2">
                  {w}
                </span>
              ))}
            </div>
          )}
          {v.changeVsPrior && (
            <p className="m-0 mt-3 text-[12px] leading-[1.5] text-ink-3">
              <span className="font-semibold text-ink-2">Since the last note: </span>
              {v.changeVsPrior}
            </p>
          )}
        </>
      )}
    </div>
  );
}

type Payload = { result: FundstratView | null; empty?: boolean; error?: string };
const fetchView = (force: boolean): Promise<Payload> =>
  fetch(`/api/fundstrat-view${force ? "?refresh=1" : ""}`, { cache: "no-store" }).then((r) => r.json() as Promise<Payload>);

export function FundstratPanel({ refreshKey }: { refreshKey?: string | null }) {
  const [collapsed, toggle] = useCollapsed("brief.fundstrat.collapsed");
  const [data, setData] = useState<FundstratView | null>(null);
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const apply = useCallback((j: Payload) => {
    setData(j.result);
    setEmpty(Boolean(j.empty));
    setError(j.error ?? null);
  }, []);
  useEffect(() => {
    let alive = true;
    fetchView(false)
      .then((j) => alive && apply(j))
      .catch(() => alive && setError("Could not load the Fundstrat summary."))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [apply, refreshKey]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      apply(await fetchView(true));
    } catch {
      setError("Could not refresh the Fundstrat summary.");
    }
    setRefreshing(false);
  };

  return (
    <section className="panel" id="s-fundstrat" style={{ scrollMarginTop: 64 }}>
      <div className="panel-h">
        <span className="t-mark bg-accent" />
        <span className="t">Fundstrat view</span>
        <span className="m min-w-0 truncate">
          Newton &amp; Lee, latest notes{data?.generatedAt ? ` · summarized ${timeAgo(data.generatedAt)}` : ""}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {!collapsed && (
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing || loading}
              className="grid h-7 w-7 place-items-center rounded-pill border border-line bg-surface text-ink-2 hover:border-accent-border hover:bg-accent-soft hover:text-accent disabled:opacity-50"
              title="Re-summarize the latest notes"
              aria-label="Re-summarize the latest notes"
            >
              <AppIcon name="refresh" size={13} className={refreshing ? "animate-spin" : ""} />
            </button>
          )}
          <button
            type="button"
            onClick={toggle}
            className="grid h-7 w-7 place-items-center rounded-pill border border-line bg-surface text-ink-2 hover:border-accent-border hover:bg-accent-soft hover:text-accent"
            title={collapsed ? "Show the Fundstrat view" : "Hide the Fundstrat view"}
            aria-label={collapsed ? "Show the Fundstrat view" : "Hide the Fundstrat view"}
            aria-expanded={!collapsed}
          >
            <AppIcon name={collapsed ? "chevD" : "chevU"} size={14} />
          </button>
        </div>
      </div>

      {!collapsed &&
        (loading ? (
          <div className="grid grid-cols-1 gap-4 p-5 lg:grid-cols-2">
            <Skeleton className="h-[150px]" />
            <Skeleton className="h-[150px]" />
          </div>
        ) : empty ? (
          <p className="m-0 px-5 py-4 text-[12.5px] text-ink-3">
            No Newton or Lee notes yet. They appear here once a note arrives by email or is pasted into the Daily input.
          </p>
        ) : !data ? (
          <p className="m-0 px-5 py-4 text-[12.5px] text-neg">{error ?? "No summary available."}</p>
        ) : (
          <>
            <div className="grid grid-cols-1 divide-y divide-line-soft lg:grid-cols-2 lg:divide-x lg:divide-y-0">
              <Column who="Mark Newton" role="Technical strategy" v={data.newton} />
              <Column who="Tom Lee" role="Head of research" v={data.lee} />
            </div>
            {(data.together || error) && (
              <div className="border-t border-line-soft bg-surface-2 px-5 py-3 text-[12.5px] leading-[1.5] text-ink-2">
                {data.together && (
                  <>
                    <span className="font-semibold text-ink">Together: </span>
                    {data.together}
                  </>
                )}
                {error && <span className="ml-2 text-warn">Showing the previous summary: {error}</span>}
              </div>
            )}
          </>
        ))}
    </section>
  );
}
