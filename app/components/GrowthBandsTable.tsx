"use client";

/** Live peer-group growth bands for the Methodology page (read-only, /api/growth-bands). */

import React, { useEffect, useState } from "react";
import { usePersistedOpen } from "@/app/lib/useCollapsed";

type Cut = { n: number; p20: number | null; median: number | null; p85: number | null } | null;
type Row = { group: string; names: number; ownGroup?: boolean; rule?: string | null; cutPoints: Record<string, Cut> };
type Resp = { stored: boolean; calibratedAt?: string; universeSize?: number; groups?: Row[]; sectors?: Row[] };

const METRICS: [string, string][] = [["fwdSales", "Forward sales"], ["fwdEps", "Forward EPS"], ["ltg", "3–5y estimate"], ["delivered", "Delivered 3y"]];
const f = (v: number | null | undefined) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

function Table({ rows, showRule }: { rows: Row[]; showRule: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-[12px]">
        <thead>
          <tr className="border-b border-line text-left text-[10.5px] uppercase tracking-wide text-ink-3">
            <th className="py-1.5 pr-2">Group</th><th className="px-2 text-right">Names</th>
            {METRICS.map(([k, l]) => <th key={k} className="px-2 text-right">{l}<div className="font-normal normal-case tracking-normal">20th · median · 85th</div></th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.group} className="border-b border-line align-top">
              <td className="py-1.5 pr-2 text-ink">
                {r.group}
                {showRule && r.ownGroup === false && <div className="text-[11px] text-ink-3">too small to rank in — its sector is used</div>}
                {showRule && r.rule && <div className="text-[11px] text-ink-3">{r.rule}</div>}
              </td>
              <td className="px-2 text-right tabular-nums">{r.names}</td>
              {METRICS.map(([k]) => {
                const c = r.cutPoints[k];
                return <td key={k} className="px-2 text-right tabular-nums">{c ? `${f(c.p20)} · ${f(c.median)} · ${f(c.p85)}` : "not used"}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function GrowthBandsTable() {
  const [data, setData] = useState<Resp | null>(null);
  const [open, toggle] = usePersistedOpen("methodology.growthBands.open", false);
  useEffect(() => { fetch("/api/growth-bands").then((r) => r.json()).then(setData).catch(() => setData({ stored: false })); }, []);
  if (!data) return <p className="text-ink-3">Loading the current bands…</p>;
  if (!data.stored) return <p className="text-warn">The peer-group bands have not been calibrated yet, so growth is currently parked as a data gap on every rescore. Run the calibration from the admin route to switch it on.</p>;
  return (
    <div className="max-w-none">
      <p>
        Bands last calibrated <b>{data.calibratedAt?.slice(0, 10)}</b> from <b>{data.universeSize}</b> companies.{" "}
        <button type="button" onClick={toggle} className="text-accent hover:underline">{open ? "Hide" : "Show"} every group&rsquo;s cut points</button>{" · "}
        <a href="/methodology/growth-data" className="text-accent hover:underline">See every company&rsquo;s numbers, the FactSet formulas and the arithmetic</a>
      </p>
      {open && (
        <div className="mt-2 flex flex-col gap-4">
          <Table rows={data.groups ?? []} showRule />
          <div>
            <p className="mb-1 text-ink-3">Sector-level bands (used when a group has too few names to rank in):</p>
            <Table rows={data.sectors ?? []} showRule={false} />
          </div>
        </div>
      )}
    </div>
  );
}
