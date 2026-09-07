"use client";

import React from "react";
import type {
  MarketData,
  ForwardLookingBundle,
  TrendStatsBundle,
} from "@/app/lib/types";
import { SignalPill } from "./SignalPill";
import { Sparkline } from "./Sparkline";
import { ClampText } from "./ClampText";
import { AppIcon } from "./AppIcon";

// Render the multi-horizon delta line shown under each sentiment sparkline.
// Uses whichever deltas are available in the bundle so a fresh oscillator
// log (only 1w / 1m) doesn't print "3m null".
function trendCaption(t: TrendStatsBundle | undefined): string | null {
  if (!t) return null;
  const fmt = (d: number | null | undefined): string | null => {
    if (d == null) return null;
    return `${d >= 0 ? "+" : ""}${d}`;
  };
  const parts: string[] = [];
  const d1w = fmt(t.delta1w);
  const d1m = fmt(t.delta1m);
  const d3m = fmt(t.delta3m);
  if (d1w) parts.push(`1w ${d1w}`);
  if (d1m) parts.push(`1m ${d1m}`);
  if (d3m) parts.push(`3m ${d3m}`);
  if (parts.length === 0) return null;
  // Intentionally omits the trailing-range percentile that used to be
  // appended here. Our rolling window is only as long as the app has
  // been logging, which produces misleading percentiles when the true
  // multi-decade range is much wider. Trajectory + multi-horizon deltas
  // are kept because those are genuinely self-referential.
  return `${t.trajectory} · ${parts.join(" · ")}`;
}

/**
 * One gauge, laid out VERTICALLY as a cell: label row, big read, fluid
 * sparkline, caption. Nothing here has a fixed width, so all four stay
 * legible at any column width and read as one set. Rendered as a cell of a
 * hairline grid — the panel and the header belong to the tab that holds it.
 */
function GaugeCard({
  label,
  href,
  badge,
  value,
  unit,
  read,
  readTone,
  spark,
  caption,
  detail,
  children,
}: {
  label: string;
  href: string;
  badge?: "live" | "logged" | null;
  value: string;
  unit?: string;
  read: string;
  readTone: string;
  spark?: React.ReactNode;
  caption?: string | null;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col px-3.5 py-3">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-ink-3">
        <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1 truncate hover:text-accent" title={`${label} source`}>
          <span className="truncate">{label}</span>
          <AppIcon name="external" size={11} />
        </a>
        {badge && (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
            <span className={`dot ${badge === "live" ? "bg-pos" : "bg-accent"}`} />
            {badge === "live" ? "Live" : "Logged"}
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[20px] font-semibold leading-none text-ink">{value}</span>
        {unit && <span className="text-[11px] text-ink-3">{unit}</span>}
        <span className={`ml-auto truncate text-[12.5px] font-medium ${readTone}`}>{read}</span>
      </div>
      {children}
      {spark && <div className="mt-1.5">{spark}</div>}
      {caption && <div className="mt-0.5 font-mono text-[10.5px] leading-tight text-ink-3">{caption}</div>}
      {/* Bounded to two lines — the full sentence is on hover, and the
          Contrarian take below carries the joined-up read. */}
      <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-snug text-ink-3" title={detail}>
        {detail}
      </p>
    </div>
  );
}

type Props = {
  marketData: MarketData;
  aaiiBull?: number;
  aaiiNeutral?: number;
  aaiiBear?: number;
  contrarianAnalysis?: string;
  // Optional auto-fetched series. When present these override the manual
  // marketData values for F&G / AAII / oscillator and unlock the sparklines.
  forwardData?: ForwardLookingBundle | null;
};

// CNN Fear & Greed official category bands (so the label matches cnn.com):
//   0-24 Extreme Fear · 25-44 Fear · 45-55 Neutral · 56-75 Greed · 76-100 Extreme Greed
function fearGreedLabel(value: number): string {
  if (value <= 24) return "Extreme Fear";
  if (value <= 44) return "Fear";
  if (value <= 55) return "Neutral";
  if (value <= 75) return "Greed";
  return "Extreme Greed";
}

function fearGreedContrarian(value: number): {
  signal: string;
  tone: "red" | "amber" | "green";
  detail: string;
} {
  if (value <= 15)
    return {
      signal: "Contrarian Bullish",
      tone: "green",
      detail:
        "Extreme fear readings historically precede strong forward returns. Panic selling creates opportunity for disciplined PMs willing to add risk when others capitulate.",
    };
  if (value <= 30)
    return {
      signal: "Leaning Bullish",
      tone: "green",
      detail:
        "Fear is elevated but not extreme. The crowd is cautious, which reduces the probability of a further severe drawdown from current levels.",
    };
  if (value <= 55)
    return {
      signal: "Neutral",
      tone: "amber",
      detail:
        "Sentiment is balanced. No strong contrarian signal in either direction.",
    };
  if (value <= 75)
    return {
      signal: "Leaning Bearish",
      tone: "amber",
      detail:
        "Complacency is building. Consider tightening stops and reducing marginal risk.",
    };
  return {
    signal: "Contrarian Bearish",
    tone: "red",
    detail:
      "Extreme greed is a reliable warning sign. This is where PMs should be raising cash and adding hedges.",
  };
}

function aaiiBullBearContrarian(spread: number): {
  signal: string;
  tone: "red" | "amber" | "green";
  detail: string;
} {
  if (spread <= -20)
    return {
      signal: "Contrarian Bullish",
      tone: "green",
      detail:
        "Retail investors are deeply bearish. Historically, AAII spreads below -20 have preceded above-average 6-12 month returns.",
    };
  if (spread <= -5)
    return {
      signal: "Leaning Bullish",
      tone: "green",
      detail:
        "Bears outnumber bulls by a meaningful margin. Incrementally supportive for forward returns.",
    };
  if (spread <= 15)
    return {
      signal: "Neutral",
      tone: "amber",
      detail:
        "No actionable contrarian signal from the AAII survey at current levels.",
    };
  if (spread <= 30)
    return {
      signal: "Leaning Bearish",
      tone: "amber",
      detail:
        "Bulls are gaining confidence. Elevated bullish sentiment tends to precede below-average returns.",
    };
  return {
    signal: "Contrarian Bearish",
    tone: "red",
    detail:
      "Retail euphoria is extreme. AAII spreads above +30 are rare and have historically marked intermediate tops.",
  };
}

// Contrarian rating based on all 4 indicators (range -8 to +8)
export function overallContrarianRating(fg: number, spread: number, spOsc: number = 0, putCall: number = 0.85): { label: string; tone: "red" | "amber" | "green" } {
  const fgSignal = fg <= 15 ? 2 : fg <= 30 ? 1 : fg <= 55 ? 0 : fg <= 75 ? -1 : -2;
  const aaiiSignal = spread <= -20 ? 2 : spread <= -5 ? 1 : spread <= 15 ? 0 : spread <= 30 ? -1 : -2;
  const oscSignal = spOsc <= -4 ? 2 : spOsc <= -2 ? 1 : spOsc <= 2 ? 0 : spOsc <= 4 ? -1 : -2;
  const pcSignal = putCall >= 1.2 ? 2 : putCall >= 1.0 ? 1 : putCall >= 0.7 ? 0 : putCall >= 0.5 ? -1 : -2;
  const combined = fgSignal + aaiiSignal + oscSignal + pcSignal;

  if (combined >= 5) return { label: "Strong Buy", tone: "green" };
  if (combined >= 2) return { label: "Leaning Bullish", tone: "green" };
  if (combined >= -2) return { label: "Neutral", tone: "amber" };
  if (combined >= -5) return { label: "Leaning Bearish", tone: "amber" };
  return { label: "Strong Sell Signal", tone: "red" };
}

export function SentimentGauges({ marketData, aaiiBull = 30, aaiiNeutral = 17, aaiiBear = 52, contrarianAnalysis, forwardData }: Props) {
  // Auto-fetched values win over manual entries when available. The fallback
  // chain is: live forward data → marketData → hardcoded default. Each tile
  // also surfaces a small "auto" badge so the PM can tell at a glance which
  // values came from the live fetch vs. the manual snapshot.
  const fgValue =
    forwardData?.fearGreed?.value ?? marketData.fearGreed;
  const fgIsAuto =
    forwardData?.fearGreed?.value != null &&
    forwardData.fearGreed.status === "live";
  const fgHistory = forwardData?.fearGreed?.history ?? [];

  const aaiiBullBearValue =
    forwardData?.aaiiBullBear?.value ?? marketData.aaiiBullBear;
  const aaiiIsAuto =
    forwardData?.aaiiBullBear?.value != null &&
    forwardData.aaiiBullBear.status === "live";
  const aaiiBullBearHistory = forwardData?.aaiiBullBear?.history ?? [];
  const effAaiiBull = forwardData?.aaiiBull?.value ?? aaiiBull;
  const effAaiiNeutral = forwardData?.aaiiNeutral?.value ?? aaiiNeutral;
  const effAaiiBear = forwardData?.aaiiBear?.value ?? aaiiBear;

  const oscValue =
    forwardData?.spOscillator?.value ?? marketData.spOscillator;
  const oscHistory = forwardData?.spOscillator?.history ?? [];

  const pcValue =
    forwardData?.putCallRatio?.value ?? marketData.putCall;
  const pcHistory = forwardData?.putCallRatio?.history ?? [];

  const fgData = fearGreedContrarian(fgValue);
  const aaiiData = aaiiBullBearContrarian(aaiiBullBearValue);
  const overall = overallContrarianRating(fgValue, aaiiBullBearValue, oscValue, marketData.putCall);
  const fgLabel = fearGreedLabel(fgValue);

  // Colour by job: fear reads neg, the middle warn, greed pos — the same
  // token drives the read and the sparkline stroke.
  const fgToken = fgValue <= 25 ? "neg" : fgValue <= 50 ? "warn" : "pos";
  const fgColor = `var(--color-${fgToken})`;
  const fgReadTone = fgToken === "neg" ? "text-neg" : fgToken === "warn" ? "text-warn" : "text-pos";

  // SVG donut for F&G
  const oscRead =
    oscValue <= -4
      ? { label: "Deeply Oversold", tone: "text-pos", detail: "Extreme oversold conditions have historically preceded sharp mean-reversion rallies. High-conviction contrarian buy signal." }
      : oscValue <= -2
      ? { label: "Oversold", tone: "text-pos", detail: "Market is stretched to the downside. Incrementally bullish on a contrarian basis." }
      : oscValue >= 4
      ? { label: "Deeply Overbought", tone: "text-neg", detail: "Extreme overbought conditions. Risk of a pullback is elevated — consider trimming or hedging." }
      : oscValue >= 2
      ? { label: "Overbought", tone: "text-neg", detail: "Market is getting stretched. Reduce marginal risk and tighten stops." }
      : { label: "Neutral", tone: "text-ink-2", detail: "No strong directional signal from the oscillator at current levels." };
  const pcRead =
    pcValue >= 1.2
      ? { label: "Extreme Fear", tone: "text-pos", detail: "Heavy put buying signals panic. Historically a strong contrarian buy signal — protection is expensive and the crowd is hedged." }
      : pcValue >= 1.0
      ? { label: "Elevated Fear", tone: "text-pos", detail: "Put buying is elevated, suggesting caution in the market. Incrementally bullish on a contrarian basis." }
      : pcValue <= 0.5
      ? { label: "Extreme Complacency", tone: "text-neg", detail: "Extreme complacency — virtually no hedging activity. This is a strong contrarian warning sign." }
      : pcValue <= 0.7
      ? { label: "Complacent", tone: "text-neg", detail: "Low put demand suggests complacency. Protection is cheap, which is when disciplined PMs should be hedging." }
      : { label: "Neutral", tone: "text-ink-2", detail: "Put/Call ratio is in a neutral range. No strong contrarian signal." };


  return (
    <div>
      {/* The overall read, and the reminder that these are read inversely. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3.5 py-2 text-[11.5px] text-ink-3">
        <SignalPill tone={overall.tone}>{overall.label}</SignalPill>
        <span>counter-signal · read extremes inversely</span>
      </div>
      <p className="sr-only">
        Sentiment extremes read <strong className="text-ink-2">inversely</strong> — crowd fear = opportunity, crowd greed = warning. A counterweight to the regime read above, not another summary of it.
      </p>

      {/* Two across, never four: inside the Brief's sentiment column four
          columns left ~96px per card. Two keeps every card readable. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 sm:[&>*:nth-child(odd)]:border-r [&>*:not(:last-child)]:border-b sm:[&>*:nth-last-child(-n+2)]:border-b-0 [&>*]:border-line-soft">
        <GaugeCard
          label="CNN Fear & Greed"
          href="https://www.cnn.com/markets/fear-and-greed"
          badge={fgIsAuto ? "live" : null}
          value={String(Math.round(fgValue))}
          unit="/100"
          read={fgLabel}
          readTone={fgReadTone}
          spark={fgHistory.length >= 2 ? (
            <Sparkline points={fgHistory} width={420} height={26} stroke={fgColor} yMin={0} yMax={100} referenceY={50} />
          ) : null}
          caption={[fgHistory.length >= 2 ? "trailing 1Y" : null, trendCaption(forwardData?.fearGreed?.trend)].filter(Boolean).join(" · ") || null}
          detail={fgData.detail}
        />

        <GaugeCard
          label="AAII Sentiment Survey"
          href="https://www.aaii.com/sentimentsurvey"
          badge={aaiiIsAuto ? "live" : null}
          value={`${aaiiBullBearValue > 0 ? "+" : ""}${aaiiBullBearValue.toFixed(1)}%`}
          unit="bull−bear"
          read={aaiiData.signal}
          readTone={aaiiData.tone === "green" ? "text-pos" : aaiiData.tone === "red" ? "text-neg" : "text-warn"}
          spark={aaiiBullBearHistory.length >= 2 ? (
            <Sparkline points={aaiiBullBearHistory} width={420} height={26} referenceY={0} />
          ) : null}
          caption={[aaiiBullBearHistory.length >= 2 ? "spread, trailing 52wk" : null, trendCaption(forwardData?.aaiiBullBear?.trend)].filter(Boolean).join(" · ") || null}
          detail={aaiiData.detail}
        >
          <div className="mt-1.5 space-y-[3px]">
            {([
              ["Bull", effAaiiBull, "bg-pos"],
              ["Neut", effAaiiNeutral, "bg-warn"],
              ["Bear", effAaiiBear, "bg-neg"],
            ] as const).map(([name, pctVal, bar]) => (
              <div key={name} className="flex items-center gap-1.5">
                <span className="w-7 shrink-0 text-[11px] text-ink-3">{name}</span>
                <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-[2px] bg-line-soft">
                  <span className={`block h-full ${bar}`} style={{ width: `${pctVal}%` }} />
                </span>
                <span className="w-9 shrink-0 text-right font-mono text-[11px] text-ink-2">{pctVal.toFixed(1)}</span>
              </div>
            ))}
          </div>
        </GaugeCard>

        <GaugeCard
          label="S&P Oscillator"
          href="https://app.marketedge.com/#!/markets"
          badge={oscHistory.length > 0 ? "logged" : null}
          value={`${oscValue > 0 ? "+" : ""}${oscValue}`}
          read={oscRead.label}
          readTone={oscRead.tone}
          spark={oscHistory.length >= 2 ? (
            <Sparkline points={oscHistory} width={420} height={26} referenceY={0} />
          ) : null}
          caption={[oscHistory.length >= 2 ? "logged entries, 6mo" : null, trendCaption(forwardData?.spOscillator?.trend)].filter(Boolean).join(" · ") || null}
          detail={oscRead.detail}
        />

        <GaugeCard
          label="Total Put/Call Ratio"
          href="https://www.cboe.com/us/options/market_statistics/daily/"
          badge={pcHistory.length > 0 ? "logged" : null}
          value={pcValue.toFixed(2)}
          read={pcRead.label}
          readTone={pcRead.tone}
          spark={pcHistory.length >= 2 ? (
            <Sparkline points={pcHistory} width={420} height={26} referenceY={0.85} />
          ) : null}
          caption={[pcHistory.length >= 2 ? "logged entries, 6mo" : null, trendCaption(forwardData?.putCallRatio?.trend)].filter(Boolean).join(" · ") || null}
          detail={pcRead.detail}
        />
      </div>

      {/* Claude's contrarian analysis */}
      {contrarianAnalysis && (
        <div className="border-t border-line-soft px-3.5 py-3">
          <div className="mb-1 text-[11px] text-ink-3">Contrarian take</div>
          <ClampText text={contrarianAnalysis} textClassName="text-[12.5px] leading-[1.5] text-ink-2" />
        </div>
      )}
    </div>
  );
}
