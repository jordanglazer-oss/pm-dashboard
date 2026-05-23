"use client";

/**
 * Quick-Add Stock modal — accessible from the top navigation on every
 * page. The PM types a ticker, picks a bucket (Portfolio / Watchlist),
 * optionally picks a designation (Core / Alpha) for Portfolio names, and
 * the stock is added with metadata auto-resolved via /api/company-name.
 *
 * Mirrors the construction pattern used everywhere else (PimPortfolio
 * switch-buy, TechnicalScreener "Add to Watchlist") so behaviour is
 * identical — same default ZERO_SCORES, same auto-routing into PIM
 * models for Portfolio names (StockContext.addStock handles that).
 *
 * Keyboard:
 *   - `Esc`           closes the modal
 *   - `Enter`         submits when the ticker field is non-empty
 *   - The ticker input takes focus on open
 *
 * Safe by design: the modal calls into the same addStock context method
 * the rest of the app uses, so persistence, PIM auto-add, and rebalance
 * math all flow through the existing tested code paths.
 */

import React, { useEffect, useRef, useState } from "react";
import type { Stock, InstrumentType, ScoreKey } from "@/app/lib/types";
import { useStocks } from "@/app/lib/StockContext";

const ZERO_SCORES: Record<ScoreKey, number> = {
  brand: 0, secular: 0, researchCoverage: 0, externalSources: 0,
  analystConsensus: 0, researchMentions: 0,
  charting: 0, relativeStrength: 0, aiRating: 0, growth: 0,
  relativeValuation: 0, historicalValuation: 0, leverageCoverage: 0,
  cashFlowQuality: 0, competitiveMoat: 0, turnaround: 0, catalysts: 0,
  trackRecord: 0, ownershipTrends: 0,
};

type Props = {
  open: boolean;
  onClose: () => void;
};

export function QuickAddStock({ open, onClose }: Props) {
  const { addStock, stocks } = useStocks();
  const [ticker, setTicker] = useState("");
  const [bucket, setBucket] = useState<"Portfolio" | "Watchlist">("Watchlist");
  const [designation, setDesignation] = useState<"alpha" | "core">("alpha");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus the ticker input when the modal opens, reset state when closed.
  useEffect(() => {
    if (open) {
      setError(null);
      setTicker("");
      setBucket("Watchlist");
      setDesignation("alpha");
      // setTimeout so the input exists in the DOM before .focus() runs.
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Esc closes the modal — added at the window level so it works even
  // if focus isn't currently inside the modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function handleSubmit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    const cleaned = ticker.trim().toUpperCase();
    if (!cleaned) {
      setError("Ticker is required");
      return;
    }
    // Duplicate check — case-insensitive on the bare ticker. Skip if the
    // ticker is already in stocks under either bucket; we don't want
    // the modal to silently overwrite an existing entry.
    const exists = stocks.find((s) => s.ticker.toUpperCase() === cleaned);
    if (exists) {
      setError(`${cleaned} already exists in ${exists.bucket}.`);
      return;
    }

    setSubmitting(true);
    setError(null);

    // Resolve company metadata so the new entry has a real name + sector
    // instead of just the ticker. /api/company-name returns names,
    // sectors, and types (stock/etf/mutual-fund) keyed by ticker. If the
    // fetch fails we fall back to safe defaults — the user can edit
    // these on the stock page later.
    let name = cleaned;
    let sector = "";
    let instrumentType: InstrumentType = "stock";
    try {
      const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(cleaned)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.names?.[cleaned]) name = data.names[cleaned];
        if (data.sectors?.[cleaned]) sector = data.sectors[cleaned];
        if (data.types?.[cleaned]) instrumentType = data.types[cleaned] as InstrumentType;
      }
    } catch {
      // Non-fatal — defaults below.
    }

    const stock: Stock = {
      ticker: cleaned,
      name,
      instrumentType,
      bucket,
      // Funds/ETFs don't carry a single sector — leave blank to match the
      // pattern used in PimPortfolio switch-buy and TechnicalScreener.
      sector: instrumentType === "etf" || instrumentType === "mutual-fund" ? "" : sector,
      beta: 1.0,
      // Portfolio bucket gets weight 2 (matches moveBucket() default);
      // Watchlist names default to 0.
      weights: { portfolio: bucket === "Portfolio" ? 2 : 0 },
      scores: { ...ZERO_SCORES },
      notes: "Added via Quick-Add",
      // Designation only applies to Portfolio bucket — alpha vs core
      // gates whether the stock enters the Alpha sleeve or the Core
      // sleeve for Sleeve Drift / Dynamic Wt math.
      ...(bucket === "Portfolio" ? { designation } : {}),
    };

    try {
      addStock(stock);
      setSubmitting(false);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add stock");
      setSubmitting(false);
    }
  }

  return (
    <div
      // Backdrop — click anywhere outside the panel to dismiss.
      className="fixed inset-0 z-[100] flex items-start justify-center bg-slate-900/60 backdrop-blur-sm pt-10 sm:pt-24 px-4"
      onClick={onClose}
    >
      <div
        // Stop propagation so clicks inside the panel don't bubble to the
        // backdrop and close the modal mid-typing.
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-slate-200 p-5"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-bold text-slate-800">Quick-Add Stock</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-slate-400 hover:text-slate-600"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
              Ticker
            </label>
            <input
              ref={inputRef}
              type="text"
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              placeholder="AAPL, MSFT.TO, etc."
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono uppercase placeholder:font-sans placeholder:normal-case focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="text-[11px] text-slate-400 mt-1">
              Use the Yahoo-style ticker (e.g. <code>.TO</code> for TSX listings).
              Name and sector auto-fill.
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
              Bucket
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setBucket("Watchlist")}
                className={`rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                  bucket === "Watchlist"
                    ? "border-slate-800 bg-slate-800 text-white"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                Watchlist
              </button>
              <button
                type="button"
                onClick={() => setBucket("Portfolio")}
                className={`rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                  bucket === "Portfolio"
                    ? "border-blue-600 bg-blue-600 text-white"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                Portfolio
              </button>
            </div>
          </div>

          {/* Designation — only relevant for Portfolio bucket. Hidden on
              Watchlist since watchlist names don't feed Sleeve Drift. */}
          {bucket === "Portfolio" && (
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
                Designation
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setDesignation("alpha")}
                  className={`rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                    designation === "alpha"
                      ? "border-purple-600 bg-purple-600 text-white"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  Alpha
                </button>
                <button
                  type="button"
                  onClick={() => setDesignation("core")}
                  className={`rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                    designation === "core"
                      ? "border-emerald-600 bg-emerald-600 text-white"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  Core
                </button>
              </div>
              <p className="text-[11px] text-slate-400 mt-1">
                Alpha = active pick, Core = indexed/passive ETF. Drives Sleeve Drift bucketing.
              </p>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !ticker.trim()}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
            >
              {submitting && (
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" /></svg>
              )}
              {submitting ? "Adding..." : "Add Stock"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
