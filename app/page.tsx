"use client";

import React, { useMemo, useState } from "react";

const marketData = {
  date: "March 15, 2026",
  compositeSignal: "Bearish",
  conviction: "High",
  riskRegime: "Risk-Off",
  hedgeScore: 78,
  hedgeTiming: "Favorable",
  breadth: 47.9,
  vix: 27.2,
  move: 91.2,
  fearGreed: 24,
  hyOas: 309,
  igOas: 96,
  aaiiBullBear: -18,
  putCall: 1.08,
  termStructure: "Contango",
};

const holdingsSeed = [
  {
    ticker: "META",
    name: "Meta Platforms",
    bucket: "Portfolio",
    sector: "Communication Services",
    beta: 1.18,
    weights: { portfolio: 7.2 },
    manual: { brand: 2, moat: 2, catalysts: 2, management: 1 },
    auto: {
      secular: 2,
      research: 4,
      external: 3,
      charting: 1,
      relativeStrength: 1,
      aiRating: 1,
      growth: 2,
      valuation: 2,
      balanceSheet: 1,
      turnaround: 0,
      ownership: 1,
      macro: 0,
      sensitivity: 0,
    },
    notes:
      "Ad resilience still good, but cyclical growth multiple risk is rising in a weak-breadth market.",
  },
  {
    ticker: "CRM",
    name: "Salesforce",
    bucket: "Portfolio",
    sector: "Technology",
    beta: 1.27,
    weights: { portfolio: 5.6 },
    manual: { brand: 2, moat: 2, catalysts: 1, management: 1 },
    auto: {
      secular: 2,
      research: 4,
      external: 3,
      charting: 1,
      relativeStrength: 0,
      aiRating: 1,
      growth: 2,
      valuation: 1,
      balanceSheet: 1,
      turnaround: 0,
      ownership: 1,
      macro: 0,
      sensitivity: 0,
    },
    notes:
      "Strong SaaS franchise, but regime fit is poor while spreads widen and growth leadership fades.",
  },
  {
    ticker: "BN",
    name: "Brookfield",
    bucket: "Portfolio",
    sector: "Financials",
    beta: 0.92,
    weights: { portfolio: 4.3 },
    manual: { brand: 2, moat: 2, catalysts: 2, management: 1 },
    auto: {
      secular: 1,
      research: 4,
      external: 3,
      charting: 2,
      relativeStrength: 2,
      aiRating: 2,
      growth: 2,
      valuation: 2,
      balanceSheet: 1,
      turnaround: 1,
      ownership: 1,
      macro: 1,
      sensitivity: 1,
    },
    notes:
      "More resilient than pure growth and better aligned with real-asset and capital rotation themes.",
  },
  {
    ticker: "XLE",
    name: "Energy Select Sector SPDR",
    bucket: "Watchlist",
    sector: "Energy",
    beta: 1.05,
    weights: { portfolio: 0 },
    manual: { brand: 1, moat: 1, catalysts: 3, management: 1 },
    auto: {
      secular: 1,
      research: 4,
      external: 3,
      charting: 3,
      relativeStrength: 2,
      aiRating: 2,
      growth: 2,
      valuation: 3,
      balanceSheet: 1,
      turnaround: 2,
      ownership: 1,
      macro: 1,
      sensitivity: 1,
    },
    notes:
      "Tactical fit is strong in inflation, geopolitics, and risk-off rotation.",
  },
  {
    ticker: "XLU",
    name: "Utilities Select Sector SPDR",
    bucket: "Watchlist",
    sector: "Utilities",
    beta: 0.48,
    weights: { portfolio: 0 },
    manual: { brand: 1, moat: 1, catalysts: 1, management: 1 },
    auto: {
      secular: 0,
      research: 4,
      external: 3,
      charting: 2,
      relativeStrength: 2,
      aiRating: 2,
      growth: 1,
      valuation: 2,
      balanceSheet: 1,
      turnaround: 0,
      ownership: 1,
      macro: 1,
      sensitivity: 1,
    },
    notes:
      "Useful defensive ballast when PMs need capital preservation over beta exposure.",
  },
];

function regimeMultiplier(sector: string) {
  const offensive = [
    "Technology",
    "Communication Services",
    "Consumer Discretionary",
  ];
  const defensive = [
    "Energy",
    "Utilities",
    "Consumer Staples",
    "Financials",
    "Materials",
    "Industrials",
  ];

  if (defensive.includes(sector)) return 1.1;
  if (offensive.includes(sector)) return 0.82;
  return 1;
}

function computeScores(stock: any) {
  const raw =
    stock.manual.brand +
    stock.auto.secular +
    stock.auto.research +
    stock.auto.external +
    stock.auto.charting +
    stock.auto.relativeStrength +
    stock.auto.aiRating +
    stock.auto.growth +
    stock.auto.valuation +
    stock.auto.balanceSheet +
    stock.manual.moat +
    stock.auto.turnaround +
    stock.manual.catalysts +
    stock.manual.management +
    stock.auto.ownership +
    stock.auto.macro +
    stock.auto.sensitivity;

  const adjusted = Math.round(raw * regimeMultiplier(stock.sector) * 10) / 10;

  let rating = "Hold";
  if (adjusted >= 28) rating = "Buy";
  else if (adjusted <= 17) rating = "Sell";

  let risk = "Medium";
  if (marketData.riskRegime === "Risk-Off" && stock.beta >= 1.15) risk = "High";
  if (["Utilities", "Consumer Staples"].includes(stock.sector)) risk = "Low";

  return { raw, adjusted, rating, risk };
}

function pillClasses(
  tone: "red" | "amber" | "green" | "blue" | "gray"
) {
  if (tone === "red") return "border border-red-200 bg-red-50 text-red-600";
  if (tone === "amber")
    return "border border-amber-200 bg-amber-50 text-amber-600";
  if (tone === "green")
    return "border border-emerald-200 bg-emerald-50 text-emerald-600";
  if (tone === "blue")
    return "border border-blue-200 bg-blue-50 text-blue-600";
  return "border border-slate-200 bg-slate-100 text-slate-700";
}

function ratingTone(rating: string) {
  if (rating === "Buy") return "green" as const;
  if (rating === "Sell") return "red" as const;
  return "amber" as const;
}

function SignalPill({
  children,
  tone = "gray",
}: {
  children: React.ReactNode;
  tone?: "red" | "amber" | "green" | "blue" | "gray";
}) {
  return (
    <span
      className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${pillClasses(
        tone
      )}`}
    >
      {children}
    </span>
  );
}

function StatCard({
  title,
  value,
  sub,
}: {
  title: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-sm text-slate-500">{title}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
        {value}
      </div>
      <div className="mt-2 text-sm text-slate-500">{sub}</div>
    </div>
  );
}

export default function PortfolioManagerDashboard() {
  const [stocks, setStocks] = useState(holdingsSeed);
  const [query, setQuery] = useState("");
  const [newTicker, setNewTicker] = useState("");
  const [newBucket, setNewBucket] = useState("Watchlist");

  const scoredStocks = useMemo(
    () => stocks.map((s) => ({ ...s, ...computeScores(s) })),
    [stocks]
  );

  const filteredStocks = scoredStocks.filter((s) =>
    `${s.ticker} ${s.name} ${s.sector} ${s.bucket}`
      .toLowerCase()
      .includes(query.toLowerCase())
  );

  const offensiveExposure = scoredStocks
    .filter(
      (s) =>
        s.bucket === "Portfolio" &&
        ["Technology", "Communication Services", "Consumer Discretionary"].includes(
          s.sector
        )
    )
    .reduce((sum, s) => sum + s.weights.portfolio, 0);

  function addTicker() {
    if (!newTicker.trim()) return;

    setStocks([
      {
        ticker: newTicker.trim().toUpperCase(),
        name: "New Security",
        bucket: newBucket,
        sector: "Technology",
        beta: 1,
        weights: { portfolio: newBucket === "Portfolio" ? 2 : 0 },
        manual: { brand: 1, moat: 1, catalysts: 1, management: 1 },
        auto: {
          secular: 1,
          research: 2,
          external: 2,
          charting: 1,
          relativeStrength: 1,
          aiRating: 1,
          growth: 1,
          valuation: 1,
          balanceSheet: 1,
          turnaround: 0,
          ownership: 0,
          macro: 0,
          sensitivity: 0,
        },
        notes:
          "Placeholder entry. In the next version this should be auto-populated from market and company data feeds.",
      },
      ...stocks,
    ]);

    setNewTicker("");
  }

  return (
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-slate-900 md:px-8 md:py-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-4xl font-semibold tracking-tight">Morning Brief</h1>
            <p className="mt-2 text-xl text-slate-400">{marketData.date}</p>
          </div>
          <div className="flex items-center gap-3">
            <button className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-600">
              Refresh
            </button>
            <button className="rounded-2xl bg-slate-900 px-4 py-3 text-sm font-medium text-white">
              PM Login
            </button>
          </div>
        </header>

        <section className="rounded-[32px] bg-gradient-to-r from-slate-900 to-slate-700 p-8 text-white shadow-lg">
          <div className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-300">
            Bottom line
          </div>
          <p className="mt-5 max-w-6xl text-2xl leading-10 text-slate-50 md:text-[32px] md:leading-[1.45]">
            This looks like a <span className="font-semibold">risk-off regime shift</span>,
            not a routine dip. Credit is deteriorating, breadth is weak, volatility is
            elevated, and positioning still does not look washed out enough to call a
            durable low. PM risk is not just security selection anymore. It is owning
            quality businesses in poor tactical sectors and forcing them through the wrong
            market environment.
          </p>
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatCard
            title="Composite Signal"
            value={marketData.compositeSignal}
            sub={`Conviction: ${marketData.conviction}`}
          />
          <StatCard
            title="Hedge Timing Score"
            value={`${marketData.hedgeScore}/100`}
            sub={marketData.hedgeTiming}
          />
          <StatCard
            title="Breadth (% above 200 DMA)"
            value={`${marketData.breadth}%`}
            sub="Late-cycle / deteriorating breadth"
          />
          <StatCard
            title="Portfolio regime mismatch"
            value={`${offensiveExposure.toFixed(1)}%`}
            sub="Offensive exposure in current portfolio"
          />
        </section>

        <section className="rounded-[30px] border border-red-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-2xl font-semibold">Composite Signal</h2>
            <SignalPill tone="red">{marketData.compositeSignal}</SignalPill>
            <span className="text-slate-500">Conviction: {marketData.conviction}</span>
          </div>
          <p className="mt-4 text-lg leading-8 text-slate-700">
            HY spreads are widening, breadth is below 50%, VIX is elevated, and sentiment
            is fearful without true capitulation. For PMs, that means the main risk is
            portfolio construction mismatch: growth-heavy and long-duration exposures can
            still lose a lot even if the businesses remain fundamentally solid.
          </p>
        </section>

        <section className="grid gap-5 lg:grid-cols-2">
          <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-2xl font-semibold">Credit Spreads</h3>
              <SignalPill tone="red">Risk-Off</SignalPill>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-4">
              <div className="rounded-2xl bg-slate-50 p-4">
                <div className="text-sm text-slate-400">HY OAS</div>
                <div className="mt-2 text-4xl font-semibold">{marketData.hyOas} bps</div>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4">
                <div className="text-sm text-slate-400">IG OAS</div>
                <div className="mt-2 text-4xl font-semibold">~{marketData.igOas} bps</div>
              </div>
            </div>
            <p className="mt-5 text-lg leading-8 text-slate-600">
              Widening spreads raise the discount-rate pressure on equities and usually hit
              high-multiple growth first. This is often a grinding-risk backdrop rather than
              a one-day crash event.
            </p>
          </div>

          <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-2xl font-semibold">Volatility Regime</h3>
              <SignalPill tone="amber">Elevated</SignalPill>
            </div>
            <div className="mt-5 grid grid-cols-3 gap-4">
              <div className="rounded-2xl bg-slate-50 p-4">
                <div className="text-sm text-slate-400">VIX</div>
                <div className="mt-2 text-3xl font-semibold">{marketData.vix}</div>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4">
                <div className="text-sm text-slate-400">Term</div>
                <div className="mt-2 text-3xl font-semibold">{marketData.termStructure}</div>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4">
                <div className="text-sm text-slate-400">MOVE</div>
                <div className="mt-2 text-3xl font-semibold">{marketData.move}</div>
              </div>
            </div>
            <p className="mt-5 text-lg leading-8 text-slate-600">
              Volatility is high enough to justify disciplined hedging, but not yet at full
              panic levels. That usually argues for adding protection before the market
              reaches obvious capitulation.
            </p>
          </div>
        </section>

        <section className="grid gap-5 lg:grid-cols-2">
          <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-2xl font-semibold">Breadth & Internals</h3>
              <SignalPill tone="red">Deteriorating</SignalPill>
            </div>
            <div className="mt-5 space-y-4 text-lg leading-8 text-slate-700">
              <div className="grid grid-cols-[1fr_auto] gap-4 border-b border-slate-100 pb-3">
                <span className="text-slate-400">A/D Line</span>
                <span className="font-medium">Negative divergence persists</span>
              </div>
              <div className="grid grid-cols-[1fr_auto] gap-4 border-b border-slate-100 pb-3">
                <span className="text-slate-400">% Above 200 DMA</span>
                <span className="font-medium">{marketData.breadth}%</span>
              </div>
              <div className="grid grid-cols-[1fr_auto] gap-4 pb-3">
                <span className="text-slate-400">New Highs/Lows</span>
                <span className="font-medium">Highs narrowing, lows broadening</span>
              </div>
              <p>
                Index stability can be misleading when the median stock is deteriorating
                underneath. That is exactly when PMs need tighter exposure control and
                stronger sector discipline.
              </p>
            </div>
          </div>

          <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-2xl font-semibold">Fund Flows & Positioning</h3>
              <SignalPill tone="red">Risk-Off</SignalPill>
            </div>
            <div className="mt-5 space-y-4 text-lg leading-8 text-slate-700">
              <p>
                <span className="text-slate-400">Fear & Greed:</span>{" "}
                <span className="font-medium">{marketData.fearGreed}/100</span>
              </p>
              <p>
                <span className="text-slate-400">AAII bull-bear spread:</span>{" "}
                <span className="font-medium">{marketData.aaiiBullBear}</span>
              </p>
              <p>
                <span className="text-slate-400">Put/Call:</span>{" "}
                <span className="font-medium">{marketData.putCall}</span>
              </p>
              <p>
                Positioning is cautious, but not washed out. That matters because a fearful
                market can still become much more fearful before the real reset is complete.
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-2xl font-semibold">Hedging Indicator</h3>
              <p className="mt-2 text-slate-500">
                Current framework: add hedges when score &gt; 65
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <SignalPill tone="red">
                Current score: {marketData.hedgeScore}/100
              </SignalPill>
              <SignalPill tone="amber">Timing: {marketData.hedgeTiming}</SignalPill>
            </div>
          </div>
          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="text-sm text-slate-400">VIX</div>
              <div className="mt-2 text-2xl font-semibold">72/100</div>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="text-sm text-slate-400">Credit spreads</div>
              <div className="mt-2 text-2xl font-semibold">81/100</div>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="text-sm text-slate-400">Breadth</div>
              <div className="mt-2 text-2xl font-semibold">86/100</div>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="text-sm text-slate-400">Sentiment</div>
              <div className="mt-2 text-2xl font-semibold">75/100</div>
            </div>
          </div>
        </section>

        <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <h3 className="text-2xl font-semibold">Stock scoring</h3>
            <div className="flex flex-col gap-3 md:flex-row">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search ticker, name, sector, or bucket"
                className="w-full min-w-[260px] rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none placeholder:text-slate-400 md:w-auto"
              />
              <div className="flex gap-3">
                <input
                  value={newTicker}
                  onChange={(e) => setNewTicker(e.target.value)}
                  placeholder="Add ticker"
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none placeholder:text-slate-400"
                />
                <select
                  value={newBucket}
                  onChange={(e) => setNewBucket(e.target.value)}
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-3"
                >
                  <option>Portfolio</option>
                  <option>Watchlist</option>
                </select>
                <button
                  onClick={addTicker}
                  className="rounded-2xl bg-slate-900 px-4 py-3 text-white"
                >
                  Add
                </button>
              </div>
            </div>
          </div>

          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[1100px] text-left">
              <thead>
                <tr className="border-b border-slate-200 text-sm text-slate-500">
                  <th className="pb-3">Ticker</th>
                  <th className="pb-3">Bucket</th>
                  <th className="pb-3">Sector</th>
                  <th className="pb-3">Raw</th>
                  <th className="pb-3">Regime adj.</th>
                  <th className="pb-3">Rating</th>
                  <th className="pb-3">Risk</th>
                  <th className="pb-3">Regime effect</th>
                  <th className="pb-3">Notes</th>
                </tr>
              </thead>
              <tbody>
                {filteredStocks.map((s) => {
                  const effect = (s.adjusted - s.raw).toFixed(1);
                  return (
                    <tr
                      key={`${s.ticker}-${s.bucket}`}
                      className="border-b border-slate-100 align-top"
                    >
                      <td className="py-4">
                        <div className="font-semibold text-slate-900">{s.ticker}</div>
                        <div className="text-sm text-slate-500">{s.name}</div>
                      </td>
                      <td className="py-4">
                        <SignalPill tone={s.bucket === "Portfolio" ? "blue" : "gray"}>
                          {s.bucket}
                        </SignalPill>
                      </td>
                      <td className="py-4 text-slate-700">{s.sector}</td>
                      <td className="py-4 text-slate-700">{s.raw}/37</td>
                      <td className="py-4 font-medium text-slate-900">
                        {s.adjusted}/37
                      </td>
                      <td className="py-4">
                        <SignalPill tone={ratingTone(s.rating)}>{s.rating}</SignalPill>
                      </td>
                      <td className="py-4">
                        <SignalPill
                          tone={
                            s.risk === "High"
                              ? "red"
                              : s.risk === "Low"
                              ? "green"
                              : "amber"
                          }
                        >
                          {s.risk}
                        </SignalPill>
                      </td>
                      <td
                        className={`py-4 font-medium ${
                          Number(effect) >= 0 ? "text-emerald-600" : "text-red-600"
                        }`}
                      >
                        {Number(effect) >= 0 ? "+" : ""}
                        {effect}
                      </td>
                      <td className="max-w-[360px] py-4 text-slate-600">{s.notes}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-2xl font-semibold">Forward actions</h3>
          <div className="mt-5 space-y-4">
            <div className="rounded-3xl border border-red-200 bg-red-50/40 p-5">
              <div className="mb-2 flex items-center gap-3">
                <SignalPill tone="red">High</SignalPill>
                <h4 className="text-xl font-semibold">
                  Increase hedge ratio on growth-heavy sleeves
                </h4>
              </div>
              <p className="text-lg leading-8 text-slate-700">
                With the hedge score at 78, breadth below 50%, and spreads widening, this
                is the zone where PMs should add protection before any true panic signal
                arrives.
              </p>
            </div>
            <div className="rounded-3xl border border-red-200 bg-red-50/40 p-5">
              <div className="mb-2 flex items-center gap-3">
                <SignalPill tone="red">High</SignalPill>
                <h4 className="text-xl font-semibold">
                  Trim offensive growth where regime-adjusted score weakens
                </h4>
              </div>
              <p className="text-lg leading-8 text-slate-700">
                Do not rewrite the fundamental score. Keep it. But use the regime multiplier
                to reduce position sizes where tactical fit is poor.
              </p>
            </div>
            <div className="rounded-3xl border border-amber-200 bg-amber-50/40 p-5">
              <div className="mb-2 flex items-center gap-3">
                <SignalPill tone="amber">Medium</SignalPill>
                <h4 className="text-xl font-semibold">
                  Rotate incremental capital toward Energy, Utilities, Staples, and real
                  assets
                </h4>
              </div>
              <p className="text-lg leading-8 text-slate-700">
                Defensive and inflation-linked sectors currently receive the positive regime
                multiplier. This improves tactical alignment without replacing the
                underlying stock work.
              </p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
