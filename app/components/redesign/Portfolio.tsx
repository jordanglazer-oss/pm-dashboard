"use client";

/**
 * Redesign › Portfolio: Models vs Positioning. Today these are two rail
 * entries showing overlapping tables, and the team asked why.
 *
 *   MODEL = the target weights we enter in Client Link.
 *   LIVE  = where the portfolio actually sits after prices moved.
 *
 * Option A merges them: one table, Model beside Live, with the drift.
 * Option B keeps them apart but labels each plainly, as two tabs.
 *
 * READ-ONLY. Targets = pm:pim-models (weight in class × the profile's
 * asset-class mix). Live = the Positioning books' units × latest price
 * (US$ names × USD/CAD), the same arithmetic the Positioning tab uses.
 * A book with any unpriced holding shows no live weights rather than
 * wrong ones.
 */

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import type { PimHolding, PimPortfolioPositions, PimProfileType } from "@/app/lib/pim-types";
import { holdingBucket } from "@/app/lib/sleeve-targets";
import { tickerMatch } from "@/app/lib/rebalance";
import { useGet } from "./data";
import { AsOf, BTN, Card, Empty, fmtNum, fmtSigned, Loading, More, Page, Table, Tag, TD, TDN, tone, type OptionDef } from "./ui";

export const PORTFOLIO_OPTIONS: OptionDef[] = [
  { id: "a", label: "Merged", blurb: "One page instead of two: every holding with its Model weight (what goes into Client Link) beside its Live weight, and the gap between them." },
  { id: "b", label: "Two clear tabs", blurb: "Keep them separate, but say what each is: a Model tab (targets only, ready to enter in Client Link) and a Live portfolio tab (where we actually are)." },
  { id: "c", label: "One full table", level: "Medium", blurb: "Merged, with every holding showing: grouped by part of the portfolio, with price, model weight, live weight and a bar for the gap. No clicking to open groups." },
  { id: "d", label: "A card per bucket", level: "Medium", blurb: "Core, Managed Alpha, individual stocks and fixed income each get their own card with their holdings, model beside live, plus the largest gaps at the top." },
];

const PROFILES: { id: PimProfileType; label: string }[] = [
  { id: "balanced", label: "Balanced" },
  { id: "growth", label: "Growth" },
  { id: "allEquity", label: "All-Equity" },
  { id: "conservative", label: "Conservative" },
];

type GroupId = "core" | "thematic" | "alpha" | "fixedIncome" | "alternative";
const GROUPS: { id: GroupId; label: string }[] = [
  { id: "core", label: "Core (index ETFs)" },
  { id: "thematic", label: "Managed Alpha (funds)" },
  { id: "alpha", label: "Individual stocks" },
  { id: "fixedIncome", label: "Fixed income" },
  { id: "alternative", label: "Alternatives" },
];

type Row = { h: PimHolding; group: GroupId; model: number; live: number | null; drift: number | null; price: number | null };

const toPriceTicker = (s: string) => {
  if (/^[A-Z]{2,4}\d{2,5}(-T)?$/i.test(s)) return s.replace(/-T$/i, "");
  if (s.endsWith("-T")) return s.replace("-T", ".TO");
  if (s.endsWith(".U")) return s.replace(".U", "-U.TO");
  return s;
};

function useBook(profile: PimProfileType) {
  const { pimModels, stocks } = useStocks();
  const pos = useGet<{ portfolios: PimPortfolioPositions[] }>("/api/kv/pim-positions");
  const group = pimModels?.groups?.find((g) => g.id === "pim") ?? null;
  const book = pos.data?.portfolios?.find((p) => p.groupId === "pim" && p.profile === profile) ?? null;

  const symbols = useMemo(() => {
    const set = new Set<string>();
    for (const h of group?.holdings ?? []) set.add(h.symbol);
    for (const p of book?.positions ?? []) if (p.units > 0) set.add(p.symbol);
    return [...set];
  }, [group, book]);
  const key = symbols.join(",");
  const [px, setPx] = useState<{ prices: Record<string, number>; fx: number | null; at: string | null }>({ prices: {}, fx: null, at: null });
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const syms = key.split(",");
    fetch("/api/prices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tickers: [...syms.map(toPriceTicker), "USDCAD=X"] }) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d?.prices) return;
        const prices: Record<string, number> = {};
        for (const s of syms) {
          const v = d.prices[toPriceTicker(s)] ?? d.prices[s];
          if (typeof v === "number" && v > 0) prices[s] = v;
        }
        const fx = d.prices["USDCAD=X"];
        setPx({ prices, fx: typeof fx === "number" && fx > 0 ? fx : null, at: new Date().toISOString() });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [key]);

  return useMemo(() => {
    const mix = group?.profiles?.[profile];
    if (!group || !mix) return { rows: [] as Row[], ready: !pos.loading, liveOk: false, missing: [] as string[], cashModel: 0, cashLive: null as number | null, at: px.at, hasBook: Boolean(book) };
    const alloc = (c: PimHolding["assetClass"]) => (c === "equity" ? mix.equity : c === "fixedIncome" ? mix.fixedIncome : mix.alternatives);
    const units = (sym: string) => book?.positions.find((p) => tickerMatch(p.symbol, sym))?.units ?? 0;
    const valueOf = (h: { symbol: string; currency: "CAD" | "USD" }) => {
      const u = units(h.symbol);
      if (u <= 0) return 0;
      const p = px.prices[h.symbol];
      if (!p || (h.currency === "USD" && !px.fx)) return null;
      return u * p * (h.currency === "USD" ? (px.fx as number) : 1);
    };
    const missing: string[] = [];
    let total = book?.cashBalance ?? 0;
    const values = new Map<string, number>();
    for (const h of group.holdings) {
      const v = valueOf(h);
      if (v == null) missing.push(h.symbol);
      else {
        values.set(h.symbol, v);
        total += v;
      }
    }
    // Positions the model no longer carries still count toward the book's value.
    for (const p of book?.positions ?? []) {
      if (p.units <= 0 || group.holdings.some((h) => tickerMatch(h.symbol, p.symbol))) continue;
      const price = px.prices[p.symbol];
      if (!price) missing.push(p.symbol);
      else total += p.units * price;
    }
    const liveOk = Boolean(book) && missing.length === 0 && total > 0 && Boolean(px.at);
    const rows: Row[] = group.holdings
      .map((h) => {
        const model = h.weightInClass * alloc(h.assetClass) * 100;
        const live = liveOk ? ((values.get(h.symbol) ?? 0) / total) * 100 : null;
        const g: GroupId = h.assetClass === "equity" ? holdingBucket(h, stocks) : h.assetClass;
        return { h, group: g, model, live, drift: live == null ? null : live - model, price: px.prices[h.symbol] ?? null };
      })
      .filter((r) => r.model > 0.0001 || (r.live ?? 0) > 0.0001);
    return { rows, ready: !pos.loading, liveOk, missing, cashModel: mix.cash * 100, cashLive: liveOk ? ((book?.cashBalance ?? 0) / total) * 100 : null, at: px.at, hasBook: Boolean(book) };
  }, [group, profile, book, px, stocks, pos.loading]);
}

const pctText = (v: number | null) => (v == null ? "—" : `${fmtNum(v, 2)}%`);
const driftText = (v: number | null) => (v == null ? "—" : fmtSigned(v, 2, " pts"));
const sum = (rows: Row[], f: (r: Row) => number | null) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);

function HoldingsTable({ rows, show }: { rows: Row[]; show: "both" | "model" | "live" }) {
  const head = [
    { label: "Holding" },
    ...(show !== "live" ? [{ label: "Model", right: true, title: "Target weight — what goes into Client Link" }] : []),
    ...(show !== "model" ? [{ label: "Live", right: true, title: "Weight today, after prices moved" }] : []),
    ...(show !== "model" ? [{ label: show === "live" ? "vs model" : "Drift", right: true, title: "Live minus Model, in percentage points" }] : []),
    ...(show === "model" ? [{ label: "Currency" }] : []),
  ];
  return (
    <Table head={head} minWidth={show === "both" ? 560 : 440}>
      {rows.map((r) => (
        <tr key={r.h.symbol}>
          <td className={TD}>
            <span className="font-semibold">{r.h.symbol}</span>
            <span className="ml-2 text-[13.5px] text-ink-3">{r.h.name}</span>
          </td>
          {show !== "live" && <td className={TDN}>{pctText(r.model)}</td>}
          {show !== "model" && <td className={`${TDN} font-semibold`}>{pctText(r.live)}</td>}
          {show !== "model" && <td className={`${TDN} ${tone(r.drift)}`}>{driftText(r.drift)}</td>}
          {show === "model" && <td className={`${TD} text-ink-2`}>{r.h.currency}</td>}
        </tr>
      ))}
    </Table>
  );
}

function Summary({ rows, cashModel, cashLive, show }: { rows: Row[]; cashModel: number; cashLive: number | null; show: "both" | "model" | "live" }) {
  const liveOk = rows.some((r) => r.live != null);
  const lines = [
    ...GROUPS.map((g) => {
      const rs = rows.filter((r) => r.group === g.id);
      return { label: g.label, n: rs.length, model: sum(rs, (r) => r.model), live: liveOk ? sum(rs, (r) => r.live) : null };
    }).filter((l) => l.n > 0),
    { label: "Cash", n: 0, model: cashModel, live: cashLive },
  ];
  const head = [
    { label: "Part of the portfolio" },
    ...(show !== "live" ? [{ label: "Model", right: true }] : []),
    ...(show !== "model" ? [{ label: "Live", right: true }, { label: "Drift", right: true }] : []),
  ];
  return (
    <Table head={head} minWidth={420}>
      {lines.map((l) => {
        const d = l.live == null ? null : l.live - l.model;
        return (
          <tr key={l.label}>
            <td className={`${TD} font-semibold`}>
              {l.label}
              {l.n > 0 && <span className="ml-2 text-[13px] font-normal text-ink-3">{l.n} {l.n === 1 ? "holding" : "holdings"}</span>}
            </td>
            {show !== "live" && <td className={`${TDN} text-[17px]`}>{pctText(l.model)}</td>}
            {show !== "model" && <td className={`${TDN} text-[17px] font-semibold`}>{pctText(l.live)}</td>}
            {show !== "model" && <td className={`${TDN} ${tone(d)}`}>{driftText(d)}</td>}
          </tr>
        );
      })}
    </Table>
  );
}

function ByGroup({ rows, show, prefix }: { rows: Row[]; show: "both" | "model" | "live"; prefix: string }) {
  return (
    <>
      {GROUPS.map((g) => {
        const rs = rows.filter((r) => r.group === g.id).sort((a, b) => b.model - a.model);
        if (!rs.length) return null;
        return (
          <More key={g.id} prefKey={`${prefix}.${g.id}`} label={g.label.toLowerCase()} count={rs.length}>
            <div className="-mx-5"><HoldingsTable rows={rs} show={show} /></div>
          </More>
        );
      })}
    </>
  );
}

// ── Medium options ──

function DriftBar({ v, max }: { v: number | null; max: number }) {
  if (v == null) return <span className="text-ink-3">—</span>;
  const w = Math.min(50, (Math.abs(v) / Math.max(max, 0.01)) * 50);
  return (
    <span className="relative inline-block h-[10px] w-[120px] rounded-full bg-line-soft align-middle" aria-hidden="true">
      <span className="absolute left-1/2 top-[-2px] h-[14px] w-px bg-ink-3" />
      <span className={`absolute top-0 h-[10px] rounded-full ${v >= 0 ? "bg-pos" : "bg-neg"}`} style={v >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }} />
    </span>
  );
}

const FULL_HEAD = [
  { label: "Holding" },
  { label: "Price", right: true, title: "Latest price, in the holding's own currency" },
  { label: "Model", right: true, title: "Target weight — what goes into Client Link" },
  { label: "Live", right: true, title: "Weight today, after prices moved" },
  { label: "Drift", right: true, title: "Live minus Model, in percentage points" },
  { label: "Under / over model" },
];

function FullRows({ rows, max }: { rows: Row[]; max: number }) {
  return (
    <>
      {rows.map((r) => (
        <tr key={r.h.symbol}>
          <td className={TD}>
            <span className="font-semibold">{r.h.symbol}</span>
            <span className="ml-2 text-[13.5px] text-ink-3">{r.h.name}</span>
          </td>
          <td className={`${TDN} text-ink-2`}>{r.price == null ? "—" : `${fmtNum(r.price)} ${r.h.currency === "USD" ? "US$" : "C$"}`}</td>
          <td className={TDN}>{pctText(r.model)}</td>
          <td className={`${TDN} font-semibold`}>{pctText(r.live)}</td>
          <td className={`${TDN} ${tone(r.drift)}`}>{driftText(r.drift)}</td>
          <td className={TD}><DriftBar v={r.drift} max={max} /></td>
        </tr>
      ))}
    </>
  );
}

function FullTable({ rows, cashModel, cashLive }: { rows: Row[]; cashModel: number; cashLive: number | null }) {
  const max = Math.max(0.5, ...rows.map((r) => Math.abs(r.drift ?? 0)));
  const liveOk = rows.some((r) => r.live != null);
  return (
    <Table head={FULL_HEAD} minWidth={820}>
      {GROUPS.map((g) => {
        const rs = rows.filter((r) => r.group === g.id).sort((a, b) => b.model - a.model);
        if (!rs.length) return null;
        const m = sum(rs, (r) => r.model);
        const l = liveOk ? sum(rs, (r) => r.live) : null;
        return (
          <React.Fragment key={g.id}>
            <tr className="bg-accent-soft">
              <td className={`${TD} text-[13px] font-bold uppercase tracking-wide text-accent`} colSpan={2}>{g.label}</td>
              <td className={`${TDN} font-bold`}>{pctText(m)}</td>
              <td className={`${TDN} font-bold`}>{pctText(l)}</td>
              <td className={`${TDN} font-bold ${tone(l == null ? null : l - m)}`}>{driftText(l == null ? null : l - m)}</td>
              <td className={TD} />
            </tr>
            <FullRows rows={rs} max={max} />
          </React.Fragment>
        );
      })}
      <tr className="bg-accent-soft">
        <td className={`${TD} text-[13px] font-bold uppercase tracking-wide text-accent`} colSpan={2}>Cash</td>
        <td className={`${TDN} font-bold`}>{pctText(cashModel)}</td>
        <td className={`${TDN} font-bold`}>{pctText(cashLive)}</td>
        <td className={`${TDN} font-bold ${tone(cashLive == null ? null : cashLive - cashModel)}`}>{driftText(cashLive == null ? null : cashLive - cashModel)}</td>
        <td className={TD} />
      </tr>
    </Table>
  );
}

function BucketCards({ rows }: { rows: Row[] }) {
  const max = Math.max(0.5, ...rows.map((r) => Math.abs(r.drift ?? 0)));
  const liveOk = rows.some((r) => r.live != null);
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      {GROUPS.map((g) => {
        const rs = rows.filter((r) => r.group === g.id).sort((a, b) => b.model - a.model);
        if (!rs.length) return null;
        const m = sum(rs, (r) => r.model);
        const l = liveOk ? sum(rs, (r) => r.live) : null;
        return (
          <Card key={g.id} title={g.label} sub={`model ${pctText(m)} · live ${pctText(l)}`} right={<span className={`font-semibold ${tone(l == null ? null : l - m)}`}>{driftText(l == null ? null : l - m)}</span>} pad={false} className={g.id === "alpha" ? "lg:col-span-2" : ""}>
            <Table head={FULL_HEAD} minWidth={g.id === "alpha" ? 820 : 620}>
              <FullRows rows={rs} max={max} />
            </Table>
          </Card>
        );
      })}
    </div>
  );
}

export default function Portfolio({ opt }: { opt: string }) {
  const [profile, setProfile] = useState<PimProfileType>("balanced");
  const [tab, setTab] = useState<"model" | "live">("model");
  const b = useBook(profile);
  const drifts = b.rows.filter((r) => r.drift != null).sort((x, y) => Math.abs(y.drift as number) - Math.abs(x.drift as number)).slice(0, 6);
  const show: "both" | "model" | "live" = opt === "b" ? tab : "both";
  const seg = (on: boolean) => `h-9 rounded-control border px-3.5 text-[14px] font-semibold ${on ? "border-accent bg-accent text-white" : "border-line bg-surface text-ink-2 hover:bg-surface-hover"}`;

  return (
    <Page
      title="Portfolio"
      lede="Model = what we enter in Client Link. Live = where the portfolio sits today."
      right={
        <>
          <Link href="/pim-model" className={BTN}>Current Models page</Link>
          <Link href="/portfolio" className={BTN}>Current Positioning page</Link>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {PROFILES.map((p) => (
          <button key={p.id} type="button" onClick={() => setProfile(p.id)} className={seg(profile === p.id)}>{p.label}</button>
        ))}
        {opt === "b" && (
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={() => setTab("model")} className={seg(tab === "model")}>Model (Client Link targets)</button>
            <button type="button" onClick={() => setTab("live")} className={seg(tab === "live")}>Live portfolio</button>
          </div>
        )}
      </div>

      {!b.ready ? (
        <Card><Loading what="Loading the portfolio" /></Card>
      ) : !b.rows.length ? (
        <Card><Empty>No model on file for this profile.</Empty></Card>
      ) : (
        <>
          {show !== "model" && !b.liveOk && (
            <div className="rounded-card border border-warn-border bg-warn-soft px-4 py-2.5 text-[14.5px] text-warn">
              <span className="font-semibold">Live weights are not shown.</span>{" "}
              <span className="text-ink-2">
                {!b.hasBook ? "No positions are on file for this profile." : b.missing.length ? `No price for ${b.missing.slice(0, 5).join(", ")}${b.missing.length > 5 ? ` and ${b.missing.length - 5} more` : ""}, so the weights would be wrong.` : "Prices are still loading."}
              </span>
            </div>
          )}
          {opt === "c" && (
            <Card title="Model and live, every holding" sub={<AsOf at={b.at} source="Positioning units × Yahoo Finance prices" />} pad={false}>
              <FullTable rows={b.rows} cashModel={b.cashModel} cashLive={b.cashLive} />
            </Card>
          )}
          {opt === "d" && (
            <>
              {drifts.length > 0 && (
                <Card title="Furthest from model" sub={<AsOf at={b.at} source="Positioning units × Yahoo Finance prices" />} pad={false}>
                  <HoldingsTable rows={drifts} show="both" />
                </Card>
              )}
              <Card title="By part of the portfolio" pad={false}>
                <Summary rows={b.rows} cashModel={b.cashModel} cashLive={b.cashLive} show="both" />
              </Card>
              <BucketCards rows={b.rows} />
            </>
          )}
          {opt !== "c" && opt !== "d" && (
          <Card
            title={show === "model" ? "Model targets" : show === "live" ? "Live portfolio" : "Model and live"}
            sub={show === "model" ? "enter these in Client Link" : <AsOf at={b.at} source="Positioning units × Yahoo Finance prices" />}
            pad={false}
          >
            <Summary rows={b.rows} cashModel={b.cashModel} cashLive={b.cashLive} show={show} />
            <ByGroup rows={b.rows} show={show} prefix={`redesign.portfolio.${opt}.${show}`} />
          </Card>
          )}
          {opt !== "c" && opt !== "d" && show !== "model" && drifts.length > 0 && (
            <Card title="Furthest from model" sub="largest gaps, either way" pad={false}>
              <HoldingsTable rows={drifts} show="both" />
            </Card>
          )}
        </>
      )}
      <p className="px-1 text-[13px] text-ink-3">
        Drift = Live minus Model, in percentage points of the whole portfolio. <Tag>View only</Tag> Trades, rebalances and model changes stay on the current pages.
      </p>
    </Page>
  );
}
