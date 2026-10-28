"use client";

import React, { useCallback, useEffect, useState } from "react";
import type { FundstratView, StrategistView } from "@/app/api/fundstrat-view/route";
import { DROP_AFTER_DAYS, FADE_AFTER_DAYS, type ActiveLevel } from "@/app/lib/fundstrat-levels";
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

const KIND_WORD: Record<ActiveLevel["kind"], string> = { support: "support", resistance: "resistance", target: "target", other: "level" };
const KIND_TONE: Record<ActiveLevel["kind"], string> = {
  support: "border-pos-border bg-pos-soft text-pos",
  resistance: "border-neg-border bg-neg-soft text-neg",
  target: "border-accent-border bg-accent-soft text-accent",
  other: "border-line bg-surface-2 text-ink-2",
};
const age = (d: number) => (d === 0 ? "today" : d < 7 ? `${d}d ago` : `${Math.floor(d / 7)}w ago`);

/** Levels in force for one strategist, one row per instrument. A level stays
 *  until a newer note names the same instrument + kind; old ones fade. */
function Levels({ levels, who }: { levels: ActiveLevel[]; who: string }) {
  const [collapsed, toggle] = useCollapsed(`brief.fundstrat.levels.${who.split(" ").pop()?.toLowerCase()}.collapsed`);
  if (!levels.length) return null;
  const bySubject = new Map<string, ActiveLevel[]>();
  for (const l of levels) bySubject.set(l.subject, [...(bySubject.get(l.subject) ?? []), l]);
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink-3 hover:text-ink-2"
      >
        <AppIcon name={collapsed ? "chevD" : "chevU"} size={12} />
        <span>Levels in force</span>
        <span className="font-medium normal-case tracking-normal">
          · {levels.length} across {bySubject.size} {bySubject.size === 1 ? "instrument" : "instruments"}
        </span>
      </button>
      {!collapsed && <div className="flex flex-col gap-1.5">
        {[...bySubject].map(([subject, ls]) => (
          <div key={subject} className="flex flex-wrap items-center gap-1.5">
            <span className="w-11 shrink-0 font-mono text-[11.5px] font-semibold text-ink">{subject}</span>
            {ls.map((l, i) => (
              <span
                key={`${l.kind}-${l.value}-${i}`}
                title={`${who}, note of ${shortDate(l.noteDate)}${l.note ? ` · ${l.note}` : ""}. Stays until a newer note names a ${KIND_WORD[l.kind]} for ${subject}.`}
                className={`inline-flex items-center gap-1 rounded-pill border px-2.5 py-0.5 text-[11.5px] ${KIND_TONE[l.kind]} ${l.fading ? "opacity-55" : ""}`}
              >
                <span className="font-medium">{KIND_WORD[l.kind]}</span>
                <span className="font-mono">{l.value}</span>
                {l.note && <span className="opacity-75">· {l.note}</span>}
                {l.ageDays > 0 && <span className="opacity-70">· {age(l.ageDays)}</span>}
              </span>
            ))}
          </div>
        ))}
      </div>}
    </div>
  );
}

function Column({ who, role, v, levels }: { who: string; role: string; v: StrategistView | null; levels: ActiveLevel[] }) {
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
              <span className="mr-0.5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink-3">Favours</span>
              {v.watch.map((w) => (
                <span key={w} className="rounded-pill border border-line bg-surface-2 px-2.5 py-0.5 text-[11.5px] text-ink-2">
                  {w}
                </span>
              ))}
            </div>
          )}
          <Levels levels={levels} who={who} />
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

type Payload = { result: FundstratView | null; empty?: boolean; error?: string; levels?: ActiveLevel[] };
const fetchView = (force: boolean): Promise<Payload> =>
  fetch(`/api/fundstrat-view${force ? "?refresh=1" : ""}`, { cache: "no-store" }).then((r) => r.json() as Promise<Payload>);

export function FundstratPanel({ refreshKey }: { refreshKey?: string | null }) {
  const [collapsed, toggle] = useCollapsed("brief.fundstrat.collapsed");
  const [data, setData] = useState<FundstratView | null>(null);
  const [levels, setLevels] = useState<ActiveLevel[]>([]);
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const apply = useCallback((j: Payload) => {
    setData(j.result);
    setLevels(Array.isArray(j.levels) ? j.levels : []);
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
              <Column who="Mark Newton" role="Technical strategy" v={data.newton} levels={levels.filter((l) => l.author === "newton")} />
              <Column who="Tom Lee" role="Head of research" v={data.lee} levels={levels.filter((l) => l.author === "lee")} />
            </div>
            {levels.length > 0 && (
              <p className="m-0 border-t border-line-soft px-5 py-2 text-[11px] text-ink-3">
                Levels stay until a newer note names a new one for the same instrument. Faded after {FADE_AFTER_DAYS / 7} weeks, dropped after {DROP_AFTER_DAYS / 7}.
              </p>
            )}
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
