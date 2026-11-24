"use client";

/**
 * Redesign › Individual stock page. Same data as the current stock page;
 * the essentials first, everything else one click away.
 *
 * Visible: what it is, the price, where it sits in the book, the key facts
 * (each with its date and source), our thesis in plain language, the chart.
 * Behind expandable sections (persisted): the Street, analyst history, risk
 * and technicals, the score and its write-up, the contrarian read, score
 * history — the EXISTING tiles, unchanged, rendered inside the section.
 *
 * READ-ONLY (the existing tiles keep their own behaviour; editing a thesis
 * or re-scoring stays on the current stock page, linked at the top).
 * Option A = one-column fact sheet. Option B = chart and facts side by side.
 */

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { MAX_SCORE, type ScoredStock } from "@/app/lib/types";
import { displayTicker } from "@/app/lib/ticker";
import StockChart from "@/app/components/StockChart";
import StreetTakeawaysTile from "@/app/components/StreetTakeawaysTile";
import AnalystTrendTile from "@/app/components/AnalystTrendTile";
import AnalystReportHistoryTile from "@/app/components/AnalystReportHistoryTile";
import ContrarianTile from "@/app/components/ContrarianTile";
import RiskAlertPanel from "@/app/components/RiskAlertPanel";
import StockHealthMonitor from "@/app/components/StockHealthMonitor";
import ScoreHistory from "@/app/components/ScoreHistory";
import { useGet } from "./data";
import { zoneOf, ZoneTag } from "./Watch";
import { AsOf, BTN, Bullets, Card, Empty, fmtAsOf, fmtNum, fmtSigned, More, Page, Tag, tone, type OptionDef } from "./ui";

export const STOCK_OPTIONS: OptionDef[] = [
  { id: "a", label: "Fact sheet", blurb: "One column: key facts, our thesis, the chart, then everything else in sections you open when you need them." },
  { id: "b", label: "Chart beside facts", blurb: "The chart on the left, the key facts and the Street on the right, thesis underneath. More on screen at once; better on a wide display." },
];

type Pillar = { title?: string; claim?: string; status?: "intact" | "watch" | "broken"; statusNote?: string; statusBy?: string };
type Thesis = { why?: string; updatedAt?: string; underwrittenAt?: string; aiDrafted?: boolean; pillars?: Pillar[] };

type KeyFact = { label: string; value: string; note?: string; at?: string | null; source: string; cls?: string };

function useKeyFacts(stock: ScoredStock): KeyFact[] {
  const { getAnalystSnapshot } = useStocks();
  const snap = getAnalystSnapshot(stock.ticker);
  return useMemo(() => {
    const h = stock.healthData ?? {};
    const price = stock.price ?? h.currentPrice ?? null;
    const out: KeyFact[] = [];
    const fs = snap?.factset;
    if (fs?.averageTarget != null && price) {
      const up = (fs.averageTarget / price - 1) * 100;
      out.push({ label: "Street average target", value: fmtNum(fs.averageTarget), note: `${fmtSigned(up)} vs price${fs.analystCount != null ? ` · ${fs.analystCount} analysts` : ""}`, at: fs.asOf ?? fs.lastUpdated, source: "FactSet", cls: tone(up) });
    }
    if (fs?.revUp != null || fs?.revDown != null) {
      out.push({ label: "Estimate revisions, 30 days", value: `${fs?.revUp ?? 0} up · ${fs?.revDown ?? 0} down`, at: fs?.asOf ?? fs?.lastUpdated, source: "FactSet" });
    }
    for (const [k, name] of [["rbc", "RBC"], ["jpm", "JPMorgan"]] as const) {
      const e = snap?.[k];
      if (e?.rating) out.push({ label: `${name} rating`, value: String(e.rating), note: e.target != null ? `target ${fmtNum(e.target)}` : undefined, at: e.asOf ?? e.lastUpdated, source: `${name} report` });
    }
    const ms = snap?.morningstar;
    if (ms?.stars != null) out.push({ label: "Morningstar", value: `${ms.stars} of 5 stars`, note: [ms.fairValue != null ? `fair value ${fmtNum(ms.fairValue)}` : "", ms.moat ? `${ms.moat} moat` : ""].filter(Boolean).join(" · ") || undefined, at: ms.asOf ?? ms.lastUpdated, source: "Morningstar report" });
    if (h.earningsDate) out.push({ label: "Next earnings", value: fmtAsOf(h.earningsDate.slice(0, 10)), source: "Yahoo Finance" });
    if (h.forwardPE != null) out.push({ label: "Forward P/E", value: `${fmtNum(h.forwardPE, 1)}×`, note: h.trailingPE != null ? `trailing ${fmtNum(h.trailingPE, 1)}×` : undefined, source: "Yahoo / FactSet" });
    if (h.revenueGrowth != null) out.push({ label: "Revenue growth", value: fmtSigned(h.revenueGrowth), source: "Yahoo / FactSet" });
    if (price && h.twoHundredDayAvg) {
      const d = (price / h.twoHundredDayAvg - 1) * 100;
      out.push({ label: "Price vs 200-day average", value: fmtSigned(d), note: `average ${fmtNum(h.twoHundredDayAvg)}`, source: "Yahoo Finance", cls: tone(d) });
    }
    if (h.dividendYield != null && h.dividendYield > 0) out.push({ label: "Dividend yield", value: `${fmtNum(h.dividendYield, 2)}%`, source: "Yahoo / FactSet" });
    if (h.marketCap != null) out.push({ label: "Market value", value: h.marketCap >= 1000 ? `$${fmtNum(h.marketCap / 1000, 1)}B` : `$${fmtNum(h.marketCap, 0)}M`, source: "Yahoo / FactSet" });
    return out;
  }, [stock, snap]);
}

function FactGrid({ facts, cols }: { facts: KeyFact[]; cols: string }) {
  if (!facts.length) return <Empty>No facts on file yet. Refresh data on the current stock page.</Empty>;
  return (
    <div className={`grid gap-x-6 gap-y-4 ${cols}`}>
      {facts.map((f) => (
        <div key={f.label} className="min-w-0">
          <div className="text-[13px] font-medium text-ink-3">{f.label}</div>
          <div className={`figure text-[21px] leading-tight ${f.cls ?? ""}`}>{f.value}</div>
          {f.note && <div className="text-[13.5px] text-ink-2">{f.note}</div>}
          <div className="text-[12.5px] text-ink-3">{f.at ? `${fmtAsOf(f.at)} · ` : ""}{f.source}</div>
        </div>
      ))}
    </div>
  );
}

const PILLAR_TAG: Record<string, { kind: "green" | "yellow" | "red"; label: string }> = {
  intact: { kind: "green", label: "Intact" },
  watch: { kind: "yellow", label: "Watch" },
  broken: { kind: "red", label: "Broken" },
};

function ThesisBlock({ stock }: { stock: ScoredStock }) {
  const { data, loading } = useGet<Record<string, Thesis>>("/api/kv/position-theses", (raw) => (raw as { theses?: Record<string, Thesis> })?.theses ?? null);
  const t = data?.[stock.ticker.toUpperCase()];
  const watchWhy = stock.watch?.thesis;
  if (loading) return <Empty>Loading thesis…</Empty>;
  if (!t?.why && !watchWhy) return <Empty>No thesis written for this name.</Empty>;
  const pillars = (t?.pillars ?? []).filter((p) => p.title || p.claim);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {t?.aiDrafted ? <Tag kind="yellow" title="This thesis started from an AI draft">Started as an AI draft</Tag> : t?.why ? <Tag kind="green">Written by the team</Tag> : <Tag>Watch list note</Tag>}
        {t?.updatedAt && <AsOf at={t.updatedAt} source="thesis on file" />}
      </div>
      <p className="max-w-[80ch] whitespace-pre-line text-[15.5px] leading-relaxed">{t?.why || watchWhy}</p>
      {pillars.length > 0 && (
        <Bullets
          items={pillars.map((p, i) => (
            <span key={i}>
              <span className="font-semibold">{p.title || p.claim}</span>
              {p.status && PILLAR_TAG[p.status] ? <span className="ml-2 align-middle"><Tag kind={PILLAR_TAG[p.status].kind}>{PILLAR_TAG[p.status].label}</Tag></span> : null}
              {p.statusNote ? <span className="text-ink-2"> — {p.statusNote}</span> : null}
            </span>
          ))}
        />
      )}
      {stock.watch?.breakers && <p className="text-[14.5px] text-ink-2"><span className="font-semibold text-ink">Drop it if:</span> {stock.watch.breakers}</p>}
    </div>
  );
}

function Sections({ stock }: { stock: ScoredStock }) {
  const scoreable = !stock.instrumentType || stock.instrumentType === "stock";
  const k = "redesign.stock";
  return (
    <Card pad={false} title="More on this name" sub="open what you need">
      {scoreable && (
        <More prefKey={`${k}.street`} label="what the Street is saying (FactSet alerts, results, news)">
          <StreetTakeawaysTile ticker={stock.ticker} />
        </More>
      )}
      {scoreable && (
        <More prefKey={`${k}.analysts`} label="analyst targets and bank reports over time">
          <div className="flex flex-col gap-3.5">
            <AnalystTrendTile ticker={stock.ticker} />
            <AnalystReportHistoryTile ticker={stock.ticker} />
          </div>
        </More>
      )}
      {(stock.riskAlert || stock.healthData) && (
        <More prefKey={`${k}.risk`} label="technicals, valuation and financial detail">
          <div className="flex flex-col gap-3">
            {stock.riskAlert && stock.technicals && <RiskAlertPanel riskAlert={stock.riskAlert} technicals={stock.technicals} />}
            {stock.healthData && <StockHealthMonitor healthData={stock.healthData} technicals={stock.technicals} />}
          </div>
        </More>
      )}
      {scoreable && (
        <More prefKey={`${k}.score`} label="our score and the write-up behind it">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="figure text-[26px]">{Number(stock.adjusted.toFixed(1))}<span className="text-ink-3"> / {MAX_SCORE}</span></span>
              <span className="text-[15px] text-ink-2">{stock.ratingLabel || stock.rating}</span>
              <AsOf at={stock.lastScored} source="scored with AI help — an opinion, not a fact" />
            </div>
            {stock.companySummary && <p className="max-w-[80ch] text-[15px] leading-relaxed"><span className="font-semibold">What it does: </span>{stock.companySummary}</p>}
            {stock.bearCase && <p className="max-w-[80ch] text-[15px] leading-relaxed"><span className="font-semibold">Risks to watch: </span>{stock.bearCase}</p>}
            <ScoreHistory ticker={stock.ticker} currentTotal={stock.adjusted} currentRaw={stock.raw} />
          </div>
        </More>
      )}
      {scoreable && (
        <More prefKey={`${k}.contrarian`} label="contrarian checks (cheap, estimates, insiders, out of favour)">
          <ContrarianTile ticker={stock.ticker} />
        </More>
      )}
    </Card>
  );
}

function Picker({ opt, current }: { opt: string; current?: string }) {
  const { portfolioStocks, watchlistStocks } = useStocks();
  const [q, setQ] = useState("");
  const all = useMemo(
    () => [...portfolioStocks.map((s) => ({ s, held: true })), ...watchlistStocks.map((s) => ({ s, held: false }))].sort((a, b) => a.s.ticker.localeCompare(b.s.ticker)),
    [portfolioStocks, watchlistStocks],
  );
  const hits = all.filter(({ s }) => !q || s.ticker.toLowerCase().includes(q.toLowerCase()) || (s.name ?? "").toLowerCase().includes(q.toLowerCase()));
  return (
    <Card title="Pick a name" right={<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ticker or name" className="h-9 w-[220px] rounded-control border border-line bg-surface px-3 text-[14px]" />}>
      <div className="flex flex-wrap gap-2">
        {hits.map(({ s, held }) => (
          <Link
            key={s.ticker}
            href={`/redesign/stock/${opt}/${encodeURIComponent(s.ticker.toLowerCase())}`}
            className={`inline-flex h-9 items-center rounded-control border px-3 text-[14px] font-semibold ${current && s.ticker.toLowerCase() === current.toLowerCase() ? "border-accent bg-accent !text-white" : held ? "border-line bg-surface !text-ink hover:bg-surface-hover" : "border-line-soft bg-surface-2 !text-ink-2 hover:bg-surface-hover"}`}
            title={`${s.name}${held ? "" : " · watch list"}`}
          >
            {displayTicker(s.ticker)}
          </Link>
        ))}
        {!hits.length && <Empty>No names match.</Empty>}
      </div>
    </Card>
  );
}

function Header({ stock, dayChange }: { stock: ScoredStock; dayChange: number | null }) {
  const price = stock.price ?? stock.healthData?.currentPrice ?? null;
  const target = stock.watch?.targetBuyPrice;
  const above = price != null && target ? (price / target - 1) * 100 : null;
  const z = stock.bucket === "Watchlist" ? zoneOf({ ticker: stock.ticker, name: stock.name, plan: stock.watch ?? {}, price, sinceAddPct: null, aboveTargetPct: above, atTarget: above != null && above <= 0 }) : null;
  return (
    <Card>
      <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="text-[30px] font-bold leading-none tracking-tight">{displayTicker(stock.ticker)}</span>
            <Tag kind={stock.bucket === "Portfolio" ? "blue" : "neutral"}>{stock.bucket === "Portfolio" ? "We own it" : "Watch list"}</Tag>
            {z && z !== "unset" && <ZoneTag z={z} />}
          </div>
          <div className="mt-1 text-[16px] text-ink-2">{stock.name}{stock.sector ? ` · ${stock.sector}` : ""}</div>
        </div>
        <div>
          <div className="figure text-[30px] leading-none">{fmtNum(price)}</div>
          <div className="mt-1 text-[14px]">
            {dayChange != null ? <span className={`font-semibold ${tone(dayChange)}`}>{fmtSigned(dayChange, 2)} today</span> : <span className="text-ink-3">last price · Yahoo Finance</span>}
          </div>
        </div>
        {stock.bucket === "Portfolio" && stock.weights.portfolio > 0 && (
          <div>
            <div className="figure text-[24px] leading-none">{stock.weights.portfolio}%</div>
            <div className="mt-1 text-[13px] text-ink-3">of the portfolio</div>
          </div>
        )}
        {target != null && (
          <div>
            <div className="figure text-[24px] leading-none">{fmtNum(target)}</div>
            <div className="mt-1 text-[13px] text-ink-3">our target buy price{above != null ? ` · ${fmtSigned(above)} away` : ""}</div>
          </div>
        )}
        <Link href={`/stock/${encodeURIComponent(stock.ticker.toLowerCase())}`} className={`${BTN} ml-auto`}>Current full page (edit, re-score)</Link>
      </div>
    </Card>
  );
}

export default function StockView({ opt, ticker }: { opt: string; ticker?: string }) {
  const { getStock, loading } = useStocks();
  const stock = ticker ? getStock(decodeURIComponent(ticker).toUpperCase()) : undefined;
  const [dayChange, setDayChange] = useState<number | null>(null);

  return (
    <Page title="Stock page" lede="The essentials first. Everything else is one click away.">
      {!ticker ? (
        <Picker opt={opt} />
      ) : loading && !stock ? (
        <Card><Empty>Loading…</Empty></Card>
      ) : !stock ? (
        <>
          <Card><Empty>{decodeURIComponent(ticker).toUpperCase()} is not in the portfolio or on the watch list.</Empty></Card>
          <Picker opt={opt} />
        </>
      ) : (
        <Body key={stock.ticker} stock={stock} opt={opt} dayChange={dayChange} setDayChange={setDayChange} />
      )}
    </Page>
  );
}

function Body({ stock, opt, dayChange, setDayChange }: { stock: ScoredStock; opt: string; dayChange: number | null; setDayChange: (v: number | null) => void }) {
  const facts = useKeyFacts(stock);
  const showChart = stock.instrumentType !== "mutual-fund";
  const chart = showChart ? (
    <div className="min-w-0 overflow-hidden rounded-card border border-line-soft bg-surface shadow-[var(--shadow-card)]">
      <StockChart ticker={stock.ticker} technicals={stock.technicals} onDayChange={setDayChange} />
    </div>
  ) : null;
  return (
    <>
      <Header stock={stock} dayChange={dayChange} />
      {opt === "b" ? (
        <>
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            {chart}
            <Card title="Key facts"><FactGrid facts={facts} cols="grid-cols-2" /></Card>
          </div>
          <Card title="Why we own it"><ThesisBlock stock={stock} /></Card>
        </>
      ) : (
        <>
          <Card title="Key facts"><FactGrid facts={facts} cols="grid-cols-2 md:grid-cols-4" /></Card>
          <Card title="Why we own it"><ThesisBlock stock={stock} /></Card>
          {chart}
        </>
      )}
      <Sections stock={stock} />
      <Picker opt={opt} current={stock.ticker} />
    </>
  );
}
