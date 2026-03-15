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
  fearGreed: 24,
  hyOas: 309,
  igOas: 96,
  aaiiBullBear: -18
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
      sensitivity: 0
    },
    notes: "Ad resilience still good."
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
      sensitivity: 0
    },
    notes: "Strong SaaS franchise."
  }
];

function regimeMultiplier(sector: string) {
  const offensive = [
    "Technology",
    "Communication Services",
    "Consumer Discretionary"
  ];

  const defensive = [
    "Energy",
    "Utilities",
    "Consumer Staples",
    "Financials",
    "Materials",
    "Industrials"
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

  return { raw, adjusted, rating };
}

export default function PortfolioManagerDashboard() {
  const [stocks, setStocks] = useState(holdingsSeed);
  const [query, setQuery] = useState("");

  const scoredStocks = useMemo(
    () => stocks.map((s) => ({ ...s, ...computeScores(s) })),
    [stocks]
  );

  const filteredStocks = scoredStocks.filter((s) =>
    `${s.ticker} ${s.name} ${s.sector}`
      .toLowerCase()
      .includes(query.toLowerCase())
  );

  function addTicker() {
    const ticker = prompt("Ticker");
    if (!ticker) return;

    setStocks([
      {
        ticker,
        name: "New Company",
        bucket: "Watchlist",
        sector: "Technology",
        beta: 1,
        weights: { portfolio: 0 },
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
          sensitivity: 0
        },
        notes: ""
      },
      ...stocks
    ]);
  }

  return (
    <div style={{ padding: 40, fontFamily: "Arial" }}>
      <h1>Portfolio Manager Dashboard</h1>

      <h2>Morning Brief — {marketData.date}</h2>

      <p>
        Market regime: <b>{marketData.riskRegime}</b>
      </p>

      <p>
        Composite signal: <b>{marketData.compositeSignal}</b>
      </p>

      <p>
        Hedge score: <b>{marketData.hedgeScore}/100</b>
      </p>

      <h2>Market Conditions</h2>

      <ul>
        <li>VIX: {marketData.vix}</li>
        <li>Fear & Greed: {marketData.fearGreed}</li>
        <li>HY Credit Spread: {marketData.hyOas} bps</li>
        <li>IG Credit Spread: {marketData.igOas} bps</li>
        <li>AAII Bull/Bear: {marketData.aaiiBullBear}</li>
        <li>Breadth: {marketData.breadth}%</li>
      </ul>

      <h2>Stock Scoring</h2>

      <input
        placeholder="Search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <button onClick={addTicker}>Add ticker</button>

      <table border={1} cellPadding={10} style={{ marginTop: 20 }}>
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Sector</th>
            <th>Raw Score</th>
            <th>Adjusted Score</th>
            <th>Rating</th>
            <th>Notes</th>
          </tr>
        </thead>

        <tbody>
          {filteredStocks.map((s) => (
            <tr key={s.ticker}>
              <td>{s.ticker}</td>
              <td>{s.sector}</td>
              <td>{s.raw}</td>
              <td>{s.adjusted}</td>
              <td>{s.rating}</td>
              <td>{s.notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
