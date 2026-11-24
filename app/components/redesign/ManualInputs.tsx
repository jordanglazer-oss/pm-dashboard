"use client";

/**
 * Redesign › Update manual inputs. One short screen any team member can
 * finish in about two minutes: each hand-entered number, where to find it,
 * what is on file, and when it was last updated and by whom.
 *
 * WRITES (the only redesign page besides the watch list that does): through
 * the existing `updateMarketData` → PUT /api/kv/market, which MERGES the
 * fields sent into pm:market. Only the fields typed here are sent. Breadth
 * values keep the existing `breadthOverride.editedAt` stamps; the two
 * top-level values (put/call, oscillator) get a stamp in the additive
 * `manualEditedAt` map; `manualEditedBy` records the name typed in.
 */

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import type { MarketData } from "@/app/lib/types";
import { manualStatus, type ManualStatus } from "./facts";
import { BTN, BTN_PRIMARY, Card, fmtAsOf, INPUT, Page, Tag, todayET } from "./ui";

type Stamps = Record<string, string | undefined>;
type Extra = { manualEditedAt?: Stamps; manualEditedBy?: Stamps; manualLastBy?: string };

export default function ManualInputs() {
  const { marketData, updateMarketData, loading } = useStocks();
  const today = todayET();
  const rows = useMemo(() => manualStatus(marketData, today), [marketData, today]);
  const extra = marketData as unknown as Extra;
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [who, setWho] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const name = who ?? extra.manualLastBy ?? "";

  const pending = rows.filter((r) => {
    const v = parseFloat(draft[r.field.id] ?? "");
    return Number.isFinite(v);
  });
  const done = rows.filter((r) => r.today).length;

  const save = () => {
    if (!pending.length) return;
    const now = new Date().toISOString();
    const by = name.trim();
    const updates: Record<string, unknown> = {};
    const prevBo = (marketData.breadthOverride ?? {}) as Record<string, unknown> & { editedAt?: Stamps };
    const bo: Record<string, unknown> = { ...prevBo, date: today };
    const boStamps: Stamps = { ...(prevBo.editedAt ?? {}) };
    const topStamps: Stamps = { ...(extra.manualEditedAt ?? {}) };
    const byMap: Stamps = { ...(extra.manualEditedBy ?? {}) };
    let touchedBreadth = false;
    for (const r of pending) {
      const v = parseFloat(draft[r.field.id]);
      if (r.field.store === "breadth") {
        bo[r.field.key] = v;
        boStamps[r.field.key] = now;
        touchedBreadth = true;
      } else {
        updates[r.field.key] = v;
        topStamps[r.field.key] = now;
      }
      if (by) byMap[r.field.id] = by;
    }
    if (touchedBreadth) updates.breadthOverride = { ...bo, editedAt: boStamps };
    updates.manualEditedAt = topStamps;
    updates.manualEditedBy = byMap;
    if (by) updates.manualLastBy = by;
    updateMarketData(updates as Partial<MarketData>);
    setDraft({});
    setSavedAt(now);
  };

  const status = (r: ManualStatus) => {
    if (r.value == null) return <Tag kind="red">Not entered</Tag>;
    if (r.today) return <Tag kind="green">Updated today</Tag>;
    return r.editedAt ? <Tag kind="yellow">Last updated {fmtAsOf(r.editedAt)}</Tag> : <Tag kind="yellow" title="Entered before dates were recorded for this number">Date not recorded</Tag>;
  };

  return (
    <Page
      title="Update manual inputs"
      lede="The numbers nobody can fetch automatically. About two minutes."
      right={<Link href="/redesign/market/a" className={BTN}>Back to market facts</Link>}
    >
      <Card>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div>
            <div className="figure text-[26px]">
              {done} <span className="text-ink-3">of {rows.length}</span>
            </div>
            <div className="text-[13px] text-ink-3">updated today</div>
          </div>
          <label className="flex min-w-[220px] flex-col gap-1 text-[13px] text-ink-3">
            Your name (saved with each number)
            <input value={name} onChange={(e) => setWho(e.target.value)} placeholder="e.g. Rob" className={INPUT} />
          </label>
          <div className="ml-auto flex items-center gap-3">
            {savedAt && !pending.length && <span className="text-[14px] font-medium text-pos">Saved {fmtAsOf(savedAt)}</span>}
            <button onClick={save} disabled={!pending.length || loading} className={BTN_PRIMARY}>
              Save {pending.length || ""} {pending.length === 1 ? "number" : "numbers"}
            </button>
          </div>
        </div>
      </Card>

      <Card pad={false}>
        {rows.map((r) => {
          const by = extra.manualEditedBy?.[r.field.id];
          return (
            <div key={r.field.id} className="grid items-center gap-x-5 gap-y-2 border-b border-line-soft px-5 py-4 last:border-b-0 md:grid-cols-[1fr_150px_170px]">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[16px] font-semibold">{r.field.label}</span>
                  {status(r)}
                </div>
                <div className="mt-0.5 text-[14px] text-ink-2">
                  {r.field.how}
                  {r.field.url && (
                    <>
                      {" · "}
                      <a href={r.field.url} target="_blank" rel="noreferrer" className="font-medium !text-accent underline">
                        Open source
                      </a>
                    </>
                  )}
                </div>
                {r.editedAt && by && <div className="mt-0.5 text-[12.5px] text-ink-3">Entered by {by}</div>}
              </div>
              <div>
                <div className="text-[12.5px] text-ink-3">On file</div>
                <div className="figure text-[22px]">{r.value == null ? "—" : r.value}</div>
              </div>
              <label className="flex flex-col gap-1 text-[12.5px] text-ink-3">
                New value
                <input
                  type="number"
                  inputMode="decimal"
                  step={r.field.step ?? "0.1"}
                  value={draft[r.field.id] ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, [r.field.id]: e.target.value }))}
                  placeholder={r.field.placeholder}
                  className={INPUT}
                />
              </label>
            </div>
          );
        })}
      </Card>
      <p className="px-1 text-[13px] text-ink-3">
        Fetched automatically, so not on this screen: VIX, CNN Fear &amp; Greed, AAII survey, credit spreads, yields, P/E, sector ratios, the 10-month average. Leave a box empty to keep the number on file.
      </p>
    </Page>
  );
}
