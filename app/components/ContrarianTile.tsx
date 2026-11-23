"use client";

import React, { useEffect, useState } from "react";
import { CollapsibleSection } from "@/app/components/CollapsibleSection";
import type { ContrarianLabel, ContrarianRead, ContrarianStatus } from "@/app/lib/contrarian";

/**
 * Contrarian setup — four tests read from data on file, shown BESIDE the
 * score (GET /api/contrarian). READ-ONLY and never part of the score. The
 * stock-page tile's collapse state persists via CollapsibleSection
 * (pm:ui-prefs); the chip is for table rows.
 */

type Row = { ticker: string } & ContrarianRead;
type Payload = { rows?: Row[] };

const labelTone = (l: ContrarianLabel) => (l === "Contrarian setup" ? "text-pos" : l === "Partial" ? "text-accent-ink" : "text-ink-3");
const STATUS_WORD: Record<ContrarianStatus, string> = { met: "Yes", "not-met": "No", "no-data": "No data" };
const statusTone = (s: ContrarianStatus) => (s === "met" ? "text-pos" : s === "not-met" ? "text-neg" : "text-ink-3");
const same = (a: string, b: string) => a.trim().toUpperCase().replace(/(-T|\.TO)$/, "") === b.trim().toUpperCase().replace(/(-T|\.TO)$/, "");

export default function ContrarianTile({ ticker }: { ticker: string }) {
  const [data, setData] = useState<Row | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    fetch(`/api/contrarian?ticker=${encodeURIComponent(ticker)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Payload | null) => {
        if (live) setData(d?.rows?.[0] ?? null);
      })
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [ticker]);

  if (data === undefined || data === null) return null; // loading, or not an individual stock in the book

  return (
    <CollapsibleSection prefKey="stock.contrarian" title="Contrarian setup" subtitle="Signs of a possible contrarian pick · not part of the score">
      <div className="flex flex-col gap-2.5 text-[12.5px]">
        <div>
          <div className="text-[15px] font-medium">
            <span className={labelTone(data.label)}>{data.label}</span>
            <span className="ml-2 text-[12.5px] font-normal text-ink-3">
              {data.score} of {data.of} test{data.of === 1 ? "" : "s"} with data
            </span>
          </div>
          <p className="text-ink-2">{data.why}</p>
        </div>
        <div className="flex flex-col gap-2">
          {data.tests.map((t) => (
            <div key={t.id} className="border-t border-line pt-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium text-ink">{t.title}</span>
                <span className="shrink-0 text-[12px]">
                  <span className={statusTone(t.status)}>{STATUS_WORD[t.status]}</span>
                </span>
              </div>
              <p className="text-ink-2">{t.summary}</p>
              {t.numbers.length > 0 && (
                <table className="mt-1 w-full tabular-nums">
                  <tbody>
                    {t.numbers.map((n) => (
                      <tr key={n.label}>
                        <td className="py-0.5 pr-3 text-[11.5px] text-ink-3">{n.label}</td>
                        <td className="py-0.5 text-right text-[12px]">{n.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
        <p className="border-t border-line pt-2 text-[11px] text-ink-3">{data.caution}</p>
      </div>
    </CollapsibleSection>
  );
}

/** One fetch of the whole book's read, for table rows. Null until loaded. */
export function useContrarianBook(): Row[] | null {
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/contrarian")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Payload | null) => live && setRows(d?.rows ?? []))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, []);
  return rows;
}

/** A small marker beside a ticker: shown only for a full or partial setup. */
export function ContrarianChip({ ticker, rows }: { ticker: string; rows: Row[] | null }) {
  const r = rows?.find((x) => same(x.ticker, ticker));
  if (!r || (r.label !== "Contrarian setup" && r.label !== "Partial")) return null;
  const title = `${r.label}: ${r.why} ${r.tests.filter((t) => t.status === "met").map((t) => t.title).join("; ")}. Not part of the score.`;
  return (
    <span className="ml-1.5 text-[11px] font-medium" title={title}>
      <span className={labelTone(r.label)}>{r.label === "Contrarian setup" ? "Contrarian" : "Contrarian (partial)"}</span>
    </span>
  );
}
