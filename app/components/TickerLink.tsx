"use client";

import Link from "next/link";
import React from "react";

/**
 * Universal ticker click-through. Links any ticker mention to /stock/[ticker]:
 * book names (Portfolio/Watchlist) get the full detailed stock page, anything
 * else falls through to the lightweight quote view (QuickStockView). Click is
 * stopPropagation'd so links inside clickable rows don't double-fire the row
 * handler; navigation goes through history so the back control on the stock
 * page restores the origin page and scroll position.
 */
export default function TickerLink({
  ticker,
  className = "hover:underline hover:text-accent transition-colors",
  children,
  title,
}: {
  ticker: string;
  className?: string;
  children?: React.ReactNode;
  title?: string;
}) {
  const clean = ticker.trim().replace(/^\$+/, "");
  if (!clean) return <>{children}</>;
  return (
    <Link
      href={`/stock/${encodeURIComponent(clean.toLowerCase())}`}
      onClick={(e) => e.stopPropagation()}
      className={className}
      title={title ?? `Open ${clean.toUpperCase()}`}
    >
      {children ?? clean.toUpperCase()}
    </Link>
  );
}
