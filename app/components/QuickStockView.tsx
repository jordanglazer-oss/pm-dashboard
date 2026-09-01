"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import StockChart from "@/app/components/StockChart";
import { displayTicker } from "@/app/lib/ticker";

type Quote = {
  price: number | null;
  previousClose: number | null;
  name: string | null;
  currency: string | null;
};

/**
 * Lightweight quote view for tickers OUTSIDE the Portfolio/Watchlist.
 * Rendered by the stock page when the ticker isn't in pm:stocks: company
 * name + live price from /api/prices (Yahoo) and the standard interactive
 * chart. Nothing here is persisted — it's a read-only window so any ticker
 * clicked anywhere in the app opens SOMETHING useful instead of "not found".
 */
export default function QuickStockView({
  ticker,
  backHref,
  backLabel,
  goBack,
}: {
  ticker: string;
  backHref: string;
  backLabel: string;
  goBack: (e: React.MouseEvent) => void;
}) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "unknown">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/prices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tickers: [ticker] }),
        });
        if (!res.ok) throw new Error(`prices ${res.status}`);
        const data = await res.json();
        const q: Quote = {
          price: data.prices?.[ticker] ?? null,
          previousClose: data.previousCloses?.[ticker] ?? null,
          name: data.names?.[ticker] ?? null,
          currency: data.currencies?.[ticker] ?? null,
        };
        if (cancelled) return;
        if (q.price == null && q.name == null) {
          setState("unknown");
        } else {
          setQuote(q);
          setState("ok");
        }
      } catch {
        if (!cancelled) setState("unknown");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  const backLink = (
    <Link
      href={backHref}
      onClick={goBack}
      className="inline-flex items-center gap-1.5 rounded-pill border border-line bg-white px-3 py-1.5 text-[12px] font-semibold text-ink-2 shadow-sm hover:bg-surface-hover hover:text-ink transition-colors"
      title={`Return to ${backLabel} (restores your place)`}
    >
      ← {backLabel}
    </Link>
  );

  if (state === "unknown") {
    return (
      <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-ink md:px-8 md:py-8">
        <div className="mx-auto max-w-5xl">
          <div className="mb-4">{backLink}</div>
          <div className="rounded-card border border-line bg-white p-8 text-center shadow-sm">
            <h1 className="text-2xl font-semibold text-ink">{displayTicker(ticker)} not found</h1>
            <p className="mt-2 text-ink-3">
              Not in your book, and no quote data came back for this symbol.
            </p>
          </div>
        </div>
      </main>
    );
  }

  const price = quote?.price ?? null;
  const prev = quote?.previousClose ?? null;
  const change = price != null && prev != null && prev !== 0 ? price - prev : null;
  const changePct = change != null && prev != null ? (change / prev) * 100 : null;
  const changeColor = change == null ? "text-ink-3" : change >= 0 ? "text-pos" : "text-neg";

  return (
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-ink md:px-8 md:py-8">
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="flex items-center justify-between gap-3">
          {backLink}
          <span
            className="rounded-pill bg-surface-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3"
            title="This ticker is not in your Portfolio or Watchlist — showing a live quote and chart only. Nothing is saved."
          >
            Quick view · not in book
          </span>
        </div>

        <div className="rounded-card border border-line bg-white p-5 shadow-sm md:p-6">
          {state === "loading" ? (
            <div className="animate-pulse space-y-3">
              <div className="h-7 w-40 rounded bg-surface-2" />
              <div className="h-4 w-64 rounded bg-surface-2" />
            </div>
          ) : (
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <h1 className="font-mono text-2xl font-bold text-ink">{displayTicker(ticker)}</h1>
              {quote?.name && <span className="text-base text-ink-2">{quote.name}</span>}
              {price != null && (
                <span className="ml-auto flex items-baseline gap-2">
                  <span className="font-mono text-2xl font-bold tabular-nums text-ink">
                    {price.toFixed(2)}
                    {quote?.currency && quote.currency !== "USD" && (
                      <span className="ml-1 text-sm font-semibold text-ink-3">{quote.currency}</span>
                    )}
                  </span>
                  {change != null && changePct != null && (
                    <span className={`font-mono text-sm font-semibold tabular-nums ${changeColor}`}>
                      {change >= 0 ? "+" : ""}
                      {change.toFixed(2)} ({change >= 0 ? "+" : ""}
                      {changePct.toFixed(2)}%)
                    </span>
                  )}
                </span>
              )}
            </div>
          )}
        </div>

        <StockChart ticker={ticker} />
      </div>
    </main>
  );
}
