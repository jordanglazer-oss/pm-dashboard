"use client";

import React from "react";
import type { HealthData } from "@/app/lib/types";
import type { TechnicalIndicators } from "@/app/lib/technicals";
import { useStocks } from "@/app/lib/StockContext";
import { AppIcon } from "@/app/components/AppIcon";

/**
 * Health monitor — the Yahoo/FactSet fundamentals read (moving averages,
 * revisions, valuation, ownership, catalyst dates). Informational only.
 *
 * Renders as a flush row-set inside the stock page's "Risk & factors" panel:
 * the condensed label/value rows are always visible; the full five-category
 * read-out sits one persisted click away. The persisted key is the same
 * `stock.healthMonitor` the old collapsible card used ("1" = collapsed, first
 * seen collapsed), so an existing preference carries over untouched.
 */

// ── Helpers ──

function fmt(val: number | undefined, decimals = 1, suffix = ""): string {
  if (val == null || !isFinite(val)) return "—";
  return `${val.toFixed(decimals)}${suffix}`;
}

/** Format a market cap given in MILLIONS as $X.XXT / $X.XXB / $XXXM. */
function fmtMktCap(millions: number | undefined): string {
  if (millions == null || !isFinite(millions)) return "—";
  if (millions >= 1_000_000) return `$${(millions / 1_000_000).toFixed(2)}T`;
  if (millions >= 1_000) return `$${(millions / 1_000).toFixed(1)}B`;
  return `$${millions.toFixed(0)}M`;
}

function pctDistance(price: number | undefined, avg: number | undefined): string {
  if (price == null || avg == null || avg === 0) return "—";
  const pct = ((price - avg) / avg) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function aboveBelow(price: number | undefined, avg: number | undefined): "above" | "below" | null {
  if (price == null || avg == null) return null;
  return price >= avg ? "above" : "below";
}

type Signal = "green" | "red" | "neutral";

function signalColor(signal: Signal): string {
  if (signal === "green") return "text-pos";
  if (signal === "red") return "text-neg";
  return "text-ink";
}

function Row({ label, value, signal = "neutral" }: { label: string; value: string; signal?: Signal }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12px]">
      <span className="text-ink-2">{label}</span>
      <span className={`text-right font-mono font-medium ${signalColor(signal)}`}>{value}</span>
    </div>
  );
}

function Group({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[12px] font-medium text-ink">{title}</span>
        <span className="text-[11px] text-ink-3">{subtitle}</span>
      </div>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

// ── Main component ──

export default function StockHealthMonitor({
  healthData,
  technicals,
  className = "",
}: {
  healthData: HealthData;
  technicals?: TechnicalIndicators;
  className?: string;
}) {
  const { uiPrefs, setUiPref } = useStocks();
  // Same key + semantics as the old CollapsibleSection (defaultCollapsed):
  // "1" = collapsed; unset = collapsed. Reading never writes.
  const collapsed = "stock.healthMonitor" in uiPrefs ? uiPrefs["stock.healthMonitor"] === "1" : true;
  const toggle = () => setUiPref("stock.healthMonitor", collapsed ? "0" : "1");
  const open = !collapsed;

  const price = healthData.currentPrice;
  const athInfo = technicals?.distanceFromATH;

  // Price & Technical signals
  const fiftyDmaSignal = aboveBelow(price, healthData.fiftyDayAvg);
  const twoHundredDmaSignal = aboveBelow(price, healthData.twoHundredDayAvg);

  // Earnings revision signal — only flag green/red if revision is >= 2% (meaningful change)
  const round2 = (n: number) => parseFloat(n.toFixed(2));
  const revPct = (cur: number, prev: number) => prev !== 0 ? Math.abs((cur - prev) / prev) * 100 : 0;
  const REV_THRESHOLD = 2; // minimum % change to trigger signal
  let earningsRevSignal: Signal = "neutral";
  if (healthData.earningsCurrentEst != null && healthData.earnings30dAgo != null) {
    const cur = round2(healthData.earningsCurrentEst);
    const prev = round2(healthData.earnings30dAgo);
    if (revPct(cur, prev) >= REV_THRESHOLD) {
      earningsRevSignal = cur > prev ? "green" : cur < prev ? "red" : "neutral";
    }
  }

  // PEG signal
  let pegSignal: Signal = "neutral";
  if (healthData.pegRatio != null) {
    pegSignal = healthData.pegRatio < 1.5 ? "green" : healthData.pegRatio > 2.5 ? "red" : "neutral";
  }

  // Short interest is informational-only (high short interest isn't
  // always bearish — can fuel squeezes). Always neutral signal.
  const shortSignal: Signal = "neutral";

  // FCF margin signal
  let fcfSignal: Signal = "neutral";
  if (healthData.fcfMargin != null) {
    fcfSignal = healthData.fcfMargin > 15 ? "green" : healthData.fcfMargin < 5 ? "red" : "neutral";
  }

  // Earnings revision direction text — compare rounded values so arrow matches display
  let revisionText = "—";
  if (healthData.earningsCurrentEst != null && healthData.earnings30dAgo != null) {
    const cur = round2(healthData.earningsCurrentEst);
    const prev30 = round2(healthData.earnings30dAgo);
    const arrow = cur > prev30 ? "↑" : cur < prev30 ? "↓" : "→";
    revisionText = `$${cur.toFixed(2)} ${arrow} (30d ago: $${prev30.toFixed(2)})`;
  }

  let revision90Text: string | null = null;
  if (healthData.earningsCurrentEst != null && healthData.earnings90dAgo != null) {
    const cur = round2(healthData.earningsCurrentEst);
    const prev90 = round2(healthData.earnings90dAgo);
    const arrow90 = cur > prev90 ? "↑" : cur < prev90 ? "↓" : "→";
    revision90Text = `$${cur.toFixed(2)} ${arrow90} (90d ago: $${prev90.toFixed(2)})`;
  }

  const fiftyText = healthData.fiftyDayAvg != null
    ? `${fiftyDmaSignal === "above" ? "Above" : "Below"} ${fmt(healthData.fiftyDayAvg, 2)} · ${pctDistance(price, healthData.fiftyDayAvg)}`
    : "—";
  const twoHundredText = healthData.twoHundredDayAvg != null
    ? `${twoHundredDmaSignal === "above" ? "Above" : "Below"} ${fmt(healthData.twoHundredDayAvg, 2)} · ${pctDistance(price, healthData.twoHundredDayAvg)}`
    : "—";
  const fiftySig: Signal = fiftyDmaSignal === "above" ? "green" : fiftyDmaSignal === "below" ? "red" : "neutral";
  const twoHundredSig: Signal = twoHundredDmaSignal === "above" ? "green" : twoHundredDmaSignal === "below" ? "red" : "neutral";
  const roicSig: Signal = healthData.roic != null ? (healthData.roic > 15 ? "green" : healthData.roic < 5 ? "red" : "neutral") : "neutral";
  const revGrowthSig: Signal = healthData.revenueGrowth != null ? (healthData.revenueGrowth > 0 ? "green" : "red") : "neutral";

  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] font-medium text-ink">Health monitor</span>
        <span className="text-[11.5px] text-ink-3">informational only</span>
        <button
          onClick={toggle}
          className="ml-auto grid h-7 w-7 place-items-center rounded-control text-ink-3 hover:bg-surface-hover hover:text-ink"
          aria-expanded={open}
          aria-label={open ? "Hide full health monitor" : "Show full health monitor"}
          title={open ? "Hide full health monitor" : "Show full health monitor"}
        >
          <AppIcon name={open ? "chevU" : "chevD"} size={14} />
        </button>
      </div>

      <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1.5">
        <Row label="50-day MA" value={fiftyText} signal={fiftySig} />
        <Row label="200-day MA" value={twoHundredText} signal={twoHundredSig} />
        <Row label="Forward P/E" value={fmt(healthData.forwardPE, 1, "x")} />
        <Row label="PEG" value={fmt(healthData.pegRatio, 2)} signal={pegSignal} />
        <Row label="Revenue growth" value={fmt(healthData.revenueGrowth, 1, "%")} signal={revGrowthSig} />
        <Row label="FCF margin" value={fmt(healthData.fcfMargin, 1, "%")} signal={fcfSignal} />
        <Row label="ROIC" value={fmt(healthData.roic, 1, "%")} signal={roicSig} />
        <Row label="Next earnings" value={healthData.earningsDate ?? "—"} />
      </div>

      {open && (
        <div className="mt-3 grid gap-x-6 gap-y-4 border-t border-line-soft pt-3 sm:grid-cols-2">
          {/* Price & Technical */}
          <Group title="Price & technical" subtitle="moving averages & relative strength">
            <Row label="50-day MA" value={fiftyText} signal={fiftySig} />
            <Row label="200-day MA" value={twoHundredText} signal={twoHundredSig} />
            <Row label="Revenue growth" value={fmt(healthData.revenueGrowth, 1, "%")} signal={revGrowthSig} />
            {athInfo && (
              <Row
                label="% from all-time high"
                value={
                  athInfo.pct >= -0.1
                    ? `At ATH ($${athInfo.athPrice.toFixed(2)})`
                    : `${athInfo.pct.toFixed(1)}% ($${athInfo.athPrice.toFixed(2)}, ${athInfo.daysAgo}d ago)`
                }
                signal={athInfo.pct >= -5 ? "green" : athInfo.pct <= -20 ? "red" : "neutral"}
              />
            )}
          </Group>

          {/* Fundamental Quality */}
          <Group title="Fundamental quality" subtitle="earnings revisions, FCF & returns">
            <Row label="Earnings revision (30d)" value={revisionText} signal={earningsRevSignal} />
            {revision90Text && (
              <Row
                label="Earnings revision (90d)"
                value={revision90Text}
                signal={healthData.earningsCurrentEst != null && healthData.earnings90dAgo != null && revPct(round2(healthData.earningsCurrentEst), round2(healthData.earnings90dAgo)) >= REV_THRESHOLD
                  ? (round2(healthData.earningsCurrentEst) > round2(healthData.earnings90dAgo) ? "green" : "red")
                  : "neutral"}
              />
            )}
            <Row label="FCF margin" value={fmt(healthData.fcfMargin, 1, "%")} signal={fcfSignal} />
            <Row label="ROIC" value={fmt(healthData.roic, 1, "%")} signal={roicSig} />
          </Group>

          {/* Valuation vs History */}
          <Group title="Valuation vs history" subtitle="P/E, PEG & EV/EBITDA">
            <Row label="Forward P/E" value={fmt(healthData.forwardPE, 1, "x")} />
            <Row label="Trailing P/E" value={fmt(healthData.trailingPE, 1, "x")} />
            <Row label="PEG ratio" value={fmt(healthData.pegRatio, 2)} signal={pegSignal} />
            <Row label="EV/EBITDA" value={fmt(healthData.enterpriseToEbitda, 1, "x")} />
            <Row label="Market cap" value={fmtMktCap(healthData.marketCap)} />
            <Row label="Dividend yield" value={fmt(healthData.dividendYield, 2, "%")} />
          </Group>

          {/* Ownership & Positioning */}
          <Group title="Ownership & positioning" subtitle="institutional, insider & short interest">
            <Row label="Institutional ownership" value={fmt(healthData.heldPercentInstitutions, 1, "%")} />
            <Row label="Insider ownership" value={fmt(healthData.heldPercentInsiders, 1, "%")} />
            <Row label="Short interest (% float)" value={fmt(healthData.shortPercentOfFloat, 1, "%")} signal={shortSignal} />
          </Group>

          {/* Catalyst Calendar */}
          <Group title="Catalyst calendar" subtitle="upcoming events & dates">
            <Row label="Next earnings date" value={healthData.earningsDate ?? "—"} />
            <Row label="Ex-dividend date" value={healthData.exDividendDate ?? "—"} />
          </Group>
        </div>
      )}
    </div>
  );
}
