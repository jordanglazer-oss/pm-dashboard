"use client";

import React, { useState } from "react";
import Link from "next/link";
import type { DailySummary } from "@/app/lib/daily-summary";
import type { DriverRow } from "@/app/lib/market-drivers";
import { useStocks } from "@/app/lib/StockContext";
import { BenchmarkStrip } from "./SummaryTop";
import { Card, CardHeader, Empty, IconButton, Pct, TickerLink, timeAgo } from "./summary-ui";

/* ── Market — the summary panel ───────────────────────────────────────── */

const PREF = "brief.summary.market";

function driversSentence(s: DailySummary, win: "1d" | "1w"): React.ReactNode {
  const d = s.drivers;
  const idx = d?.indexes.find((i) => i.key === "spx");
  if (!idx || idx.namesPriced === 0) return <span className="text-ink-3">{d?.error ?? "not built yet — rebuild from FactSet with the refresh control"}</span>;
  const top = (win === "1d" ? idx.top1d : idx.top1w).slice(0, 3);
  const contrib = (r: DriverRow) => (win === "1d" ? r.contrib1d : r.contrib1w) ?? 0;
  const carried = top.reduce((sum, r) => sum + contrib(r), 0);
  const ret = win === "1d" ? idx.ret1d : idx.ret1w;
  const sectors = [...idx.sectors].sort((a, b) => ((win === "1d" ? a.ret1d : a.ret1w) ?? 0) - ((win === "1d" ? b.ret1d : b.ret1w) ?? 0));
  const worst = sectors[0];
  const worstV = worst ? (win === "1d" ? worst.ret1d : worst.ret1w) : null;
  const bottom = (win === "1d" ? idx.bottom1d : idx.bottom1w)[0];
  const bottomC = bottom ? contrib(bottom) : 0;
  const heldInTop = (win === "1d" ? idx.top1d : idx.top1w).filter((r) => r.held === "Portfolio").length;
  return (
    <>
      {top.length > 0 && (
        <>
          <span className="font-mono text-ink">{top.map((r) => r.ticker).join(", ")}</span> carried <span className="font-mono">{carried > 0 ? "+" : ""}{carried.toFixed(2)}</span> of the S&amp;P&apos;s <Pct v={ret} digits={1} />
        </>
      )}
      {worst && worstV != null && worstV < 0 && (
        <>; {worst.sector} the weakest sector (<Pct v={worstV} digits={1} />)</>
      )}
      {bottom && bottomC < 0 && (
        <>; <span className="font-mono text-ink">{bottom.ticker}</span> dragged <span className="font-mono">{bottomC.toFixed(2)}</span></>
      )}
      {heldInTop > 0 && <>; you hold {heldInTop} of the top 10</>}.
    </>
  );
}

export function MarketPanel({ s, onRefresh, refreshing }: { s: DailySummary; onRefresh: () => void; refreshing: boolean }) {
  const { uiPrefs, setUiPref } = useStocks();
  const open = (uiPrefs[PREF] ?? "1") !== "1";
  const [win, setWin] = useState<"1d" | "1w">("1d");
  const bench = s.performance?.benchmarks ?? [];
  const info = s.regime?.informational;
  const levels: { label: string; v: number | null; dp: number }[] = info
    ? [
        { label: "10Y", v: info.tnx, dp: 2 },
        { label: "DXY", v: info.dxy, dp: 1 },
        { label: "WTI", v: info.oil, dp: 2 },
        { label: "STOXX", v: info.stoxx, dp: 0 },
        { label: "Nikkei", v: info.nikkei, dp: 0 },
      ].filter((x) => x.v != null)
    : [];
  return (
    <Card>
      <div className="panel-h" id="s-market" style={{ scrollMarginTop: 64 }}>
        <span className="t-mark bg-hub-research" />
        <span className="t">Market</span>
        <span className="m">{win === "1d" ? "today" : "this week"}</span>
        <div className="ml-auto flex items-center gap-2">
          <div className="seg">
            <button type="button" className={win === "1d" ? "on" : ""} onClick={() => setWin("1d")}>1d</button>
            <button type="button" className={win === "1w" ? "on" : ""} onClick={() => setWin("1w")}>1w</button>
          </div>
          <IconButton onClick={onRefresh} disabled={refreshing} spin={refreshing} title="Rebuild the market drivers from FactSet" icon="refresh" />
          <IconButton onClick={() => setUiPref(PREF, open ? "1" : "0")} title={open ? "Hide the full driver table and sector map" : "Show the full driver table and sector map"} icon={open ? "chevU" : "chevD"} active={open} />
        </div>
      </div>
      {bench.length === 0 && levels.length === 0 ? (
        <Empty>Market data unavailable.</Empty>
      ) : (
        // The band owns the full page width now, so every benchmark and level
        // gets its own column instead of wrapping into a 4-wide block.
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 px-3.5 pb-2.5 pt-2 text-[12px] sm:grid-cols-3 md:grid-cols-5 xl:grid-cols-9">
          {bench.map((b) => (
            <div key={b.key} className="min-w-0">
              <div className="truncate text-[11px] text-ink-3">{b.label}</div>
              <Pct v={b.returns[win]} digits={1} className="text-[12.5px] font-medium" />
            </div>
          ))}
          {levels.map((l) => (
            <div key={l.label} className="min-w-0">
              <div className="truncate text-[11px] text-ink-3">{l.label}</div>
              <div className="font-mono text-[12.5px] font-medium text-ink">{l.v!.toLocaleString("en-US", { minimumFractionDigits: l.dp, maximumFractionDigits: l.dp })}</div>
            </div>
          ))}
        </div>
      )}
      <div className="border-t border-line-soft px-3.5 py-2 text-[12px] leading-[1.5] text-ink-2">
        <span className="text-ink-3">Drivers</span> {driversSentence(s, win)}
      </div>
      {/* Model returns and the main contributors/detractors are what the PM
          reads every morning — they are NOT behind the expander any more. Two
          up across the full width, each table with room to wrap. */}
      <div className="grid grid-cols-1 gap-3 border-t border-line-soft bg-ground p-3 xl:grid-cols-2">
        <ModelsCard s={s} />
        <MoversCard s={s} win={win} />
      </div>
      {open && (
        // The full tables stack one per row. Side by side inside this rail they
        // were the thing the PM could not read; a table that owns the whole
        // width wraps its text cells instead of scrolling sideways.
        <div className="animate-panel-in flex flex-col gap-3 border-t border-line-soft bg-ground p-3">
          <BenchmarkStrip s={s} />
          <DriversCard s={s} onRefresh={onRefresh} refreshing={refreshing} />
          <SectorMapCard s={s} />
        </div>
      )}
    </Card>
  );
}

/* ── Main contributors / detractors (always visible) ─────────────────── */

/** The top five up and down names by cap-weighted contribution, in the same
 *  columns the full Market drivers table uses. Window follows the Market
 *  panel's own 1d/1w switch; the index is picked here. */
export function MoversCard({ s, win }: { s: DailySummary; win: "1d" | "1w" }) {
  const d = s.drivers;
  const [idx, setIdx] = useState<"spx" | "tsx">("spx");
  const index = d?.indexes.find((i) => i.key === idx) ?? null;
  const top = index ? (win === "1d" ? index.top1d : index.top1w) : [];
  const bottom = index ? (win === "1d" ? index.bottom1d : index.bottom1w) : [];
  const contrib = (r: DriverRow) => (win === "1d" ? r.contrib1d : r.contrib1w);
  const ret = (r: DriverRow) => (win === "1d" ? r.ret1d : r.ret1w);
  const maxAbs = Math.max(0.01, ...[...top.slice(0, 5), ...bottom.slice(0, 5)].map((r) => Math.abs(contrib(r) ?? 0)));
  return (
    <Card className="animate-panel-in">
      <CardHeader
        mark="bg-hub-research"
        title="Main contributors"
        sub={index ? `${index.label} ${win === "1d" ? "today" : "this week"} · cap-weighted` : "loading"}
        right={<Toggle value={idx} options={[["spx", "S&P"], ["tsx", "TSX"]]} onChange={setIdx} />}
      />
      {!index || index.namesPriced === 0 ? (
        <Empty>{d?.error ?? "No driver data yet — the nightly job builds it, or use the refresh control."}</Empty>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th className="pl-3.5">Name</th>
              <th className="w-[36px] px-1.5" />
              <th className="n w-[72px]" title="Percentage points of the index return">Contrib pp</th>
              <th className="n w-[58px]">Return</th>
              <th className="n w-[58px] pr-3.5" title="Share of the priced universe">Weight</th>
            </tr>
          </thead>
          <tbody>
            <BandRow>Contributors</BandRow>
            <DriverRows rows={top} contrib={contrib} ret={ret} maxAbs={maxAbs} limit={5} />
            <BandRow>Detractors</BandRow>
            <DriverRows rows={bottom} contrib={contrib} ret={ret} maxAbs={maxAbs} limit={5} />
          </tbody>
        </table>
      )}
    </Card>
  );
}

/* ── Market drivers ──────────────────────────────────────────────────── */

export function DriversCard({ s, onRefresh, refreshing }: { s: DailySummary; onRefresh: () => void; refreshing: boolean }) {
  const d = s.drivers;
  const [idx, setIdx] = useState<"spx" | "tsx">("spx");
  const [win, setWin] = useState<"1d" | "1w">("1d");
  const index = d?.indexes.find((i) => i.key === idx) ?? null;
  const top = index ? (win === "1d" ? index.top1d : index.top1w) : [];
  const bottom = index ? (win === "1d" ? index.bottom1d : index.bottom1w) : [];
  const contrib = (r: DriverRow) => (win === "1d" ? r.contrib1d : r.contrib1w);
  const ret = (r: DriverRow) => (win === "1d" ? r.ret1d : r.ret1w);
  const maxAbs = Math.max(0.01, ...[...top, ...bottom].map((r) => Math.abs(contrib(r) ?? 0)));
  return (
    <Card className="animate-panel-in">
      <CardHeader
        mark="bg-hub-research"
        title="Market drivers"
        sub={d ? `cap-weighted contribution · ${timeAgo(d.builtAt)}${d.error ? " · stale" : ""}` : "loading"}
        right={
          <>
            <Toggle value={idx} options={[["spx", "S&P"], ["tsx", "TSX"]]} onChange={setIdx} />
            <Toggle value={win} options={[["1d", "1d"], ["1w", "1w"]]} onChange={setWin} />
            <IconButton onClick={onRefresh} disabled={refreshing} spin={refreshing} title="Rebuild from FactSet" icon="refresh" />
          </>
        }
      />
      {!index || index.namesPriced === 0 ? (
        <Empty>{d?.error ?? "No driver data yet — the nightly job builds it, or use the refresh control."}</Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3.5 pb-1.5 pt-2.5 text-[11.5px] text-ink-3">
            <span>
              {index.label} <Pct v={win === "1d" ? index.ret1d : index.ret1w} className="text-[13px] font-medium" />
            </span>
            <span>{index.namesPriced}/{index.namesTotal} names priced</span>
            <span className="inline-flex items-center gap-3">
              <span className="inline-flex items-center gap-1.5"><span className="dot bg-accent" /> held</span>
              <span className="inline-flex items-center gap-1.5"><span className="dot bg-violet" /> watch</span>
            </span>
          </div>
          {/* Contributors and detractors as one table so the columns line up and
              a long company name wraps in its cell instead of pushing the panel
              sideways. Numerics keep their own fixed columns. */}
          <table className="data-table">
            <thead>
              <tr>
                <th className="pl-3.5">Name</th>
                <th className="w-[40px] px-1.5" />
                <th className="n w-[72px]" title="Percentage points of the index return">Contrib pp</th>
                <th className="n w-[58px]">Return</th>
                <th className="n w-[58px] pr-3.5" title="Share of the priced universe">Weight</th>
              </tr>
            </thead>
            <tbody>
              <BandRow>Contributors</BandRow>
              <DriverRows rows={top} contrib={contrib} ret={ret} maxAbs={maxAbs} />
              <BandRow>Detractors</BandRow>
              <DriverRows rows={bottom} contrib={contrib} ret={ret} maxAbs={maxAbs} />
            </tbody>
          </table>
          <table className="data-table border-t border-line">
            <thead>
              <tr>
                <th className="pl-3.5">Sector · {win === "1d" ? "today" : "week"}</th>
                <th className="w-[40px] px-1.5" />
                <th className="n w-[72px]">Contrib pp</th>
                <th className="n w-[58px]">Return</th>
                <th className="n w-[58px] pr-3.5">Weight</th>
              </tr>
            </thead>
            <tbody>
              {index.sectors.map((sec) => {
                const v = win === "1d" ? sec.ret1d : sec.ret1w;
                const c = win === "1d" ? sec.contrib1d : sec.contrib1w;
                return (
                  <tr key={sec.sector}>
                    <td className="pl-3.5">
                      <span className="break-words text-ink">{sec.sector}</span>
                      {sec.leaders.length > 0 && (
                        <span className="ml-1.5 break-all font-mono text-[10.5px] text-ink-faint">{sec.leaders.slice(0, 3).map((l) => l.ticker).join(" ")}</span>
                      )}
                    </td>
                    <td className="px-1.5"><SectorBar v={v} /></td>
                    <td className="n text-ink-2">{c == null ? "—" : `${c > 0 ? "+" : ""}${c.toFixed(2)}`}</td>
                    <td className="n"><Pct v={v} digits={1} /></td>
                    <td className="n pr-3.5 text-ink-2">{(sec.weight * 100).toFixed(1)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}

function BandRow({ children }: { children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={5} className="!h-7 bg-surface-2 pl-3.5 text-[11px] text-ink-3">{children}</td>
    </tr>
  );
}

function DriverRows({ rows, contrib, ret, maxAbs, limit = 8 }: { rows: DriverRow[]; contrib: (r: DriverRow) => number | null; ret: (r: DriverRow) => number | null; maxAbs: number; limit?: number }) {
  if (rows.length === 0) {
    return (
      <tr>
        <td colSpan={5} className="pl-3.5 text-[12px] text-ink-3">No names priced.</td>
      </tr>
    );
  }
  return (
    <>
      {rows.slice(0, limit).map((r) => {
        const c = contrib(r);
        const w = c == null ? 0 : (Math.abs(c) / maxAbs) * 100;
        return (
          <tr key={r.ticker}>
            <td className="pl-3.5">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0">
                <span className={`dot ${r.held === "Portfolio" ? "bg-accent" : r.held === "Watchlist" ? "bg-violet" : "bg-transparent"}`} />
                <TickerLink ticker={r.ticker} />
                <span className="min-w-0 break-words text-[11px] text-ink-3">{r.name ?? r.sector ?? ""}</span>
              </span>
            </td>
            <td className="px-1.5">
              <span className="relative block h-1 w-full overflow-hidden rounded-full bg-line-soft">
                <span className={`absolute left-0 top-0 h-full rounded-full ${(c ?? 0) >= 0 ? "bg-pos" : "bg-neg"}`} style={{ width: `${w}%` }} />
              </span>
            </td>
            <td className="n text-ink-2">{c == null ? "—" : `${c > 0 ? "+" : ""}${c.toFixed(2)}`}</td>
            <td className="n"><Pct v={ret(r)} digits={1} /></td>
            <td className="n pr-3.5 text-ink-2">{r.weight == null ? "—" : `${(r.weight * 100).toFixed(1)}%`}</td>
          </tr>
        );
      })}
    </>
  );
}

function SectorBar({ v }: { v: number | null }) {
  const pct = v == null ? 0 : Math.max(-1, Math.min(1, v / 3)) * 50;
  return (
    <span className="relative block h-1 w-full overflow-hidden rounded-full bg-line-soft">
      <span className="absolute left-1/2 top-0 h-full w-px bg-line" />
      {v != null && <span className={`absolute top-0 h-full ${v >= 0 ? "bg-pos" : "bg-neg"}`} style={pct >= 0 ? { left: "50%", width: `${pct}%` } : { right: "50%", width: `${-pct}%` }} />}
    </span>
  );
}

function Toggle<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([v, label]) => (
        <button key={v} type="button" onClick={() => onChange(v)} className={value === v ? "on" : ""}>
          {label}
        </button>
      ))}
    </div>
  );
}

/* ── Sector map (regime × leadership × book) ─────────────────────────── */

export function SectorMapCard({ s }: { s: DailySummary }) {
  const rows = s.regime?.sectorMap ?? [];
  const sectors = rows.filter((r) => r.kind === "sector").sort((a, b) => (b.ret1m ?? -99) - (a.ret1m ?? -99));
  const industries = rows.filter((r) => r.kind === "industry").sort((a, b) => (b.ret1m ?? -99) - (a.ret1m ?? -99));
  const label = s.regime?.composite?.label;
  return (
    <Card className="animate-panel-in">
      <CardHeader mark="bg-hub-research" title="Sector map" sub={label ? `leadership under ${label} · book vs S&P weight` : "leadership"} />
      {rows.length === 0 ? (
        <Empty>Needs the market-drivers build.</Empty>
      ) : (
        // No horizontal scroller: the four return columns are fixed-width
        // numerics and the sector name is the only cell that wraps.
        <table className="data-table">
          <thead>
            <tr>
              <th className="pl-3.5">Sector</th>
              <th className="n w-[48px]">1d</th>
              <th className="n w-[48px]">1w</th>
              <th className="n w-[48px]">1m</th>
              <th className="n w-[48px]">3m</th>
              <th className="n w-[56px] pr-3.5" title="Book weight, and active vs the S&P weight beneath it">Book</th>
            </tr>
          </thead>
          <tbody>
            {sectors.map((r) => (
              <tr key={r.symbol}>
                <td className="pl-3.5">
                  <span className="font-mono text-[11px] text-ink-faint">{r.symbol}</span>{" "}
                  <span className="break-words">{r.label}</span>
                </td>
                <Cell v={r.ret1d} /><Cell v={r.ret1w} /><Cell v={r.ret1m} /><Cell v={r.ret3m} />
                <td className="n pr-3.5">
                  {r.bookWeightPct != null ? (
                    <>
                      <span className="block text-ink">{r.bookWeightPct.toFixed(1)}%</span>
                      {r.activePct != null && (
                        <span className={`block text-[11px] ${r.activePct > 0.5 ? "text-pos" : r.activePct < -0.5 ? "text-neg" : "text-ink-3"}`} title="Active vs the S&P weight">
                          {r.activePct > 0 ? "+" : ""}{r.activePct.toFixed(1)}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </td>
              </tr>
            ))}
            <tr><td colSpan={6} className="!h-7 bg-surface-2 pl-3.5 text-[11px] text-ink-3">Industries</td></tr>
            {industries.map((r) => (
              <tr key={r.symbol}>
                <td className="pl-3.5">
                  <span className="font-mono text-[11px] text-ink-faint">{r.symbol}</span>{" "}
                  <span className="break-words">{r.label}</span>
                </td>
                <Cell v={r.ret1d} /><Cell v={r.ret1w} /><Cell v={r.ret1m} /><Cell v={r.ret3m} />
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Cell({ v }: { v: number | null }) {
  const bg = v == null ? "" : v >= 3 ? "bg-pos-soft" : v <= -3 ? "bg-neg-soft" : "";
  return (
    <td className={`n ${bg}`}>
      <Pct v={v} digits={1} />
    </td>
  );
}

/* ── All models ──────────────────────────────────────────────────────── */

const PROFILE_LABEL: Record<string, string> = { conservative: "Cons.", balanced: "Balanced", growth: "Growth", allEquity: "All-Eq" };

export function ModelsCard({ s }: { s: DailySummary }) {
  const rows = s.performance?.models ?? [];
  const [all, setAll] = useState(false);
  const groups = [...new Set(rows.map((r) => r.groupId))];
  const shown = all ? groups : groups.slice(0, 1);
  return (
    <Card className="animate-panel-in">
      <CardHeader
        mark="bg-hub-portfolio"
        title="Model returns"
        sub={rows[0]?.asOf ? `as of ${rows[0].asOf}` : "pm:pim-performance"}
        href="/aa-performance"
        right={groups.length > 1 && (
          <button type="button" onClick={() => setAll((v) => !v)} className="text-[11.5px] text-ink-3 hover:text-ink">{all ? "PIM only" : `all ${groups.length} groups`}</button>
        )}
      />
      {rows.length === 0 ? (
        <Empty>No model series yet.</Empty>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th className="pl-3.5">Model</th>
              {["1d", "1w", "1m", "3m", "YTD"].map((h) => <th key={h} className="n w-[52px] last:pr-3.5">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {shown.map((g) => {
              const grp = rows.filter((r) => r.groupId === g);
              return grp.map((r, i) => (
                <tr key={`${g}-${r.profile}`}>
                  <td className="pl-3.5">
                    {i === 0 ? <span className="break-words font-medium text-ink">{r.groupName}</span> : <span className="break-words text-ink-faint">{r.groupName}</span>}
                    <span className="ml-1.5 text-ink-2">{PROFILE_LABEL[r.profile] ?? r.profile}</span>
                  </td>
                  {(["1d", "1w", "1m", "3m", "ytd"] as const).map((k) => (
                    <td key={k} className="n last:pr-3.5"><Pct v={r.returns[k]} /></td>
                  ))}
                </tr>
              ));
            })}
            {(s.performance?.benchmarks ?? []).map((b) => (
              <tr key={b.key} className="bg-surface-2">
                <td className="pl-3.5 break-words text-ink-2">{b.label}</td>
                {(["1d", "1w", "1m", "3m", "ytd"] as const).map((k) => (
                  <td key={k} className="n last:pr-3.5"><Pct v={b.returns[k]} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Link href="/aa-performance" className="flex h-8 items-center border-t border-line-soft px-3.5 text-[11.5px] text-accent hover:text-accent-ink">
        Full performance, every model
      </Link>
    </Card>
  );
}
