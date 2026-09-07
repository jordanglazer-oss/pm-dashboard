"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import StockChart from "@/app/components/StockChart";
import { displayTicker } from "@/app/lib/ticker";
import { AppIcon } from "@/app/components/AppIcon";
import { EmptyState } from "@/app/components/EmptyState";

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
      className="inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover transition-colors"
      title={`Return to ${backLabel} (restores your place)`}
    >
      <AppIcon name="arrowL" size={13} /> {backLabel}
    </Link>
  );

  if (state === "unknown") {
    return (
      <main className="flex flex-col gap-3.5 text-ink">
        <div className="flex h-7 items-center">{backLink}</div>
        <section className="panel">
          <EmptyState
            glyph={<AppIcon name="search" size={18} />}
            title={`${displayTicker(ticker)} not found`}
            body="Not in your book, and no quote data came back for this symbol."
          />
        </section>
      </main>
    );
  }

  const price = quote?.price ?? null;
  const prev = quote?.previousClose ?? null;
  const change = price != null && prev != null && prev !== 0 ? price - prev : null;
  const changePct = change != null && prev != null ? (change / prev) * 100 : null;
  const changeColor = change == null ? "text-ink-3" : change >= 0 ? "text-pos" : "text-neg";

  return (
    <main className="flex flex-col gap-3.5 text-ink">
      {/* Quiet rail: the back control, then the quick-view note. */}
      <div className="flex h-7 items-center gap-3">
        {backLink}
        <span
          className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-3"
          title="This ticker is not in your Portfolio or Watchlist — showing a live quote and chart only. Nothing is saved."
        >
          <span className="dot bg-ink-faint" /> Quick view · not in book
        </span>
      </div>

      {/* Identity row */}
      {state === "loading" ? (
        <div className="flex animate-pulse items-center gap-3.5">
          <div className="h-6 w-28 rounded bg-surface-2" />
          <div className="h-4 w-56 rounded bg-surface-2" />
        </div>
      ) : (
        <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
          <span className="font-mono text-[20px] font-semibold tracking-tight text-ink">{displayTicker(ticker)}</span>
          {quote?.name && <span className="text-[14px] text-ink-2">{quote.name}</span>}
          {price != null && (
            <span className="ml-1 inline-flex items-baseline gap-2">
              <span className="font-mono text-[18px] font-semibold tabular-nums text-ink">{price.toFixed(2)}</span>
              {change != null && changePct != null && (
                <span className={`font-mono text-[13px] tabular-nums ${changeColor}`}>
                  {change >= 0 ? "+" : ""}{change.toFixed(2)} ({change >= 0 ? "+" : ""}{changePct.toFixed(2)}%)
                </span>
              )}
            </span>
          )}
          {quote?.currency && <span className="text-[12px] text-ink-3">{quote.currency} · not in book</span>}
        </div>
      )}

      <StockChart ticker={ticker} />
    </main>
  );
}
