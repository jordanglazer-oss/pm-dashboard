"use client";

/**
 * Redesign › router + shell. One catch-all route (/redesign/[[...slug]])
 * renders every option page: /redesign/<section>/<option>/<rest>.
 *
 * Every page under /redesign is a PREVIEW beside the existing screens.
 * Nothing in the existing dashboard is removed, hidden or changed.
 */

import React from "react";
import Link from "next/link";
import MainScreen, { MAIN_OPTIONS } from "./Main";
import MarketFacts, { MARKET_OPTIONS } from "./Market";
import ManualInputs from "./ManualInputs";
import WatchList, { WATCH_OPTIONS } from "./Watch";
import StockView, { STOCK_OPTIONS } from "./StockView";
import Portfolio, { PORTFOLIO_OPTIONS } from "./Portfolio";
import ThesisView, { THESIS_OPTIONS } from "./Thesis";
import Inventory from "./Inventory";
import { PerfTable } from "./Perf";
import { BTN, Bullets, Card, OptionSwitch, Page, Table, Tag, TD, type OptionDef } from "./ui";

type Section = { id: string; label: string; options: OptionDef[]; what: string; writes?: string };

export const SECTIONS: Section[] = [
  { id: "main", label: "Main screen", options: MAIN_OPTIONS, what: "The one page with what matters: performance, buy-zone alerts, key market facts, this week." },
  { id: "market", label: "Market facts", options: MARKET_OPTIONS, what: "Replaces the risk-on / risk-off call with the facts behind it, each with a date and a source." },
  { id: "manual-inputs", label: "Manual inputs", options: [], what: "One two-minute screen for the numbers typed in by hand, with who updated each and when.", writes: "Saves the numbers you type" },
  { id: "watch", label: "Watch list", options: WATCH_OPTIONS, what: "Target buy prices typed straight into the table; yellow and green zones.", writes: "Saves the target price you type" },
  { id: "stock", label: "Stock page", options: STOCK_OPTIONS, what: "The essentials first; the other fifteen-odd tiles open on request." },
  { id: "portfolio", label: "Portfolio", options: PORTFOLIO_OPTIONS, what: "Models vs Positioning: merged into one table, or two clearly labelled tabs." },
  { id: "performance", label: "Performance", options: [], what: "Models and indices over any period, in one table." },
  { id: "thesis", label: "Thesis", options: THESIS_OPTIONS, what: "Rework to one plain-language sentence per stock, or cut the section." },
  { id: "inventory", label: "Inventory", options: [], what: "Every screen today, fact or opinion, and a starting suggestion. Includes the session schedule." },
];

function hrefOf(s: Section) {
  return s.options.length ? `/redesign/${s.id}/a` : `/redesign/${s.id}`;
}

function Bar({ current }: { current: string }) {
  return (
    <div className="mx-auto mb-4 max-w-[1180px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-accent-border bg-accent-soft px-4 py-2.5">
        <Link href="/redesign" className="text-[14px] font-bold !text-accent">Redesign preview</Link>
        <span className="text-[13.5px] text-ink-2">Options for the team. The current screens are unchanged.</span>
      </div>
      <nav className="mt-2 flex gap-1.5 overflow-x-auto pb-1" aria-label="Redesign sections">
        {SECTIONS.map((s) => (
          <Link
            key={s.id}
            href={hrefOf(s)}
            className={`inline-flex h-9 shrink-0 items-center rounded-control border px-3 text-[14px] font-semibold ${s.id === current ? "border-ink bg-ink !text-white" : "border-line bg-surface !text-ink-2 hover:bg-surface-hover"}`}
          >
            {s.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

function Index() {
  return (
    <Page title="Redesign options" lede="A few ways each part of the dashboard could look. Open one, flip between the options, tell us which.">
      <Card title="How to use this">
        <Bullets
          items={[
            "Each section below has one to three options. Open it and use the A / B / C buttons at the top.",
            "Same data as today, shown more simply: the most important things visible, the rest behind a \"Show …\" line.",
            "Facts only on these pages: no risk-on / risk-off label, no AI calls. Every number shows its date and source.",
            "Nothing has been removed. Every current screen is still in the menu, exactly as it was.",
            <>Two pages save what you type (watch list target prices, manual inputs). <Tag kind="yellow">These save for real</Tag> Everything else is view-only.</>,
          ]}
        />
      </Card>
      <Card title="Sections" pad={false}>
        <Table head={[{ label: "Section" }, { label: "What it is" }, { label: "Options" }]} minWidth={720}>
          {SECTIONS.map((s) => (
            <tr key={s.id}>
              <td className={`${TD} whitespace-nowrap`}>
                <Link href={hrefOf(s)} className="text-[16px] font-bold !text-accent underline">{s.label}</Link>
                {s.writes && <div className="mt-1"><Tag kind="yellow">{s.writes}</Tag></div>}
              </td>
              <td className={`${TD} max-w-[420px] text-[14.5px] text-ink-2`}>{s.what}</td>
              <td className={TD}>
                <div className="flex flex-wrap gap-1.5">
                  {s.options.length ? (
                    s.options.map((o) => (
                      <Link key={o.id} href={`/redesign/${s.id}/${o.id}`} className={BTN}>
                        {o.id.toUpperCase()} · {o.label}
                      </Link>
                    ))
                  ) : (
                    <Link href={hrefOf(s)} className={BTN}>Open</Link>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Not redesigned yet" sub="still on the current screens">
        <Bullets
          items={[
            "Holdings table, Review, Risk, Journal, Themes, Funds, PM Monthly, Client report.",
            "Research (Ranked, Sources, Inbox) and the Ideas screens (Synthesis, Pipeline, Conviction).",
            "Monitor and the automatic emails — the inventory lists every one, for the notifications discussion.",
            "Currency impact and the Manager Evaluator: both exist today; the wider fund search in the plan is not built.",
          ]}
        />
      </Card>
    </Page>
  );
}

function Performance() {
  return (
    <Page title="Performance" lede="Models and indices, any period." right={<Link href="/aa-performance" className={BTN}>Current Performance page</Link>}>
      <Card title="Returns" sub="recorded daily values, close to close" pad={false}>
        <PerfTable prefKey="redesign.performance.more" />
      </Card>
      <Card title="Still on the current Performance page">
        <Bullets items={["Where returns came from (market, currency, selection) and by holding", "Currency impact: hedged vs unhedged", "Holdings since first purchase", "Realized gains and losses", "Asset allocation targets"]} />
      </Card>
    </Page>
  );
}

export default function RedesignShell({ slug }: { slug: string[] }) {
  const [sectionId, a, b] = slug;
  const section = SECTIONS.find((s) => s.id === sectionId);
  if (!section) {
    return (
      <>
        <Bar current="" />
        <Index />
      </>
    );
  }
  const opt = section.options.some((o) => o.id === a) ? a : (section.options[0]?.id ?? "");
  // /redesign/stock/<ticker> (no option letter) still finds the ticker.
  const rest = section.options.some((o) => o.id === a) ? b : a;
  const body =
    section.id === "main" ? <MainScreen opt={opt} />
    : section.id === "market" ? <MarketFacts opt={opt} />
    : section.id === "manual-inputs" ? <ManualInputs />
    : section.id === "watch" ? <WatchList opt={opt} />
    : section.id === "stock" ? <StockView opt={opt} ticker={rest} />
    : section.id === "portfolio" ? <Portfolio opt={opt} />
    : section.id === "performance" ? <Performance />
    : section.id === "thesis" ? <ThesisView opt={opt} />
    : <Inventory />;
  return (
    <>
      <Bar current={section.id} />
      {section.options.length > 1 && (
        <div className="mx-auto mb-4 max-w-[1180px]">
          <OptionSwitch base={`/redesign/${section.id}`} options={section.options} current={opt} suffix={section.id === "stock" && rest ? `/${rest}` : ""} />
        </div>
      )}
      {body}
    </>
  );
}
