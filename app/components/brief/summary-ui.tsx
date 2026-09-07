"use client";

import React from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { AppIcon } from "../AppIcon";

/**
 * Shared primitives for the Brief summary zones, in the workspace vocabulary:
 * `.panel` / `.panel-h` cards, dot + word status, mono numerics.
 */

export function Card({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return <section className={`panel min-w-0 ${className}`}>{children}</section>;
}

export function CardHeader({ title, sub, right, href }: { title: string; sub?: React.ReactNode; right?: React.ReactNode; href?: string }) {
  return (
    <div className="panel-h">
      {href ? (
        <Link href={href} className="t hover:text-accent">
          {title}
        </Link>
      ) : (
        <span className="t">{title}</span>
      )}
      {sub && <span className="m min-w-0 truncate">{sub}</span>}
      {right && <div className="ml-auto flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  );
}

export function fmtPct(v: number | null | undefined, digits = 2, signed = true): string {
  if (v == null || !isFinite(v)) return "—";
  const s = v.toFixed(digits);
  return `${signed && v > 0 ? "+" : ""}${s}%`;
}

export function fmtPp(v: number | null | undefined, digits = 2): string {
  if (v == null || !isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}pp`;
}

export function toneFor(v: number | null | undefined, deadband = 0): string {
  if (v == null || !isFinite(v)) return "text-ink-3";
  if (v > deadband) return "text-pos";
  if (v < -deadband) return "text-neg";
  return "text-ink-2";
}

/** Signed, colored, monospace percentage. */
export function Pct({ v, digits = 2, className = "", deadband = 0, pp = false }: { v: number | null | undefined; digits?: number; className?: string; deadband?: number; pp?: boolean }) {
  return <span className={`font-mono tabular-nums ${toneFor(v, deadband)} ${className}`}>{pp ? fmtPp(v, digits) : fmtPct(v, digits)}</span>;
}

/** The one pill left in the vocabulary: 18px, 11px medium, tinted by job. */
export function Pill({ children, tone = "neutral", className = "", title }: { children: React.ReactNode; tone?: "pos" | "neg" | "warn" | "accent" | "neutral" | "violet"; className?: string; title?: string }) {
  const map = {
    pos: "bg-pos-soft text-pos",
    neg: "bg-neg-soft text-neg",
    warn: "bg-warn-soft text-warn",
    accent: "bg-accent-soft text-accent-ink",
    violet: "bg-violet-soft text-violet",
    neutral: "bg-surface-2 text-ink-2",
  } as const;
  return <span title={title} className={`inline-flex h-[18px] items-center whitespace-nowrap rounded px-1.5 text-[11px] font-medium ${map[tone]} ${className}`}>{children}</span>;
}

export function regimeTone(label: string | null | undefined): "pos" | "neg" | "warn" {
  if (label === "Risk-On") return "pos";
  if (label === "Risk-Off") return "neg";
  return "warn";
}

export function toneText(tone: "pos" | "neg" | "warn" | "accent" | "neutral"): string {
  return tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : tone === "warn" ? "text-warn" : tone === "accent" ? "text-accent" : "text-ink-2";
}

export function toneDot(tone: "pos" | "neg" | "warn" | "accent" | "neutral"): string {
  return tone === "pos" ? "bg-pos" : tone === "neg" ? "bg-neg" : tone === "warn" ? "bg-warn" : tone === "accent" ? "bg-accent" : "bg-ink-faint";
}

/** Status = dot + the word beside it, in one span. */
export function Status({ tone, children, className = "" }: { tone: "pos" | "neg" | "warn" | "accent" | "neutral"; children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${className}`}>
      <span className={`dot ${toneDot(tone)}`} />
      {children}
    </span>
  );
}

/** Tiny inline line chart. */
export function Spark({ points, width = 140, height = 36, baseline, className = "" }: { points: number[]; width?: number; height?: number; baseline?: number; className?: string }) {
  const valid = points.filter((p) => isFinite(p));
  if (valid.length < 2) return <svg width={width} height={height} className={className} />;
  const min = Math.min(...valid, baseline ?? Infinity);
  const max = Math.max(...valid, baseline ?? -Infinity);
  const span = max - min || 1;
  const x = (i: number) => (i / (points.length - 1)) * (width - 2) + 1;
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const first = points[0];
  const up = last >= (baseline ?? first);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      {baseline != null && <line x1={1} x2={width - 1} y1={y(baseline)} y2={y(baseline)} stroke="currentColor" className="text-line" strokeDasharray="2 3" />}
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" className={up ? "text-pos" : "text-neg"} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(points.length - 1)} cy={y(last)} r="2" className={up ? "fill-pos" : "fill-neg"} />
    </svg>
  );
}

/** Centered diverging bar for a value in [-max, max]. */
export function DivergingBar({ v, max = 1, className = "" }: { v: number | null; max?: number; className?: string }) {
  const pct = v == null ? 0 : Math.max(-1, Math.min(1, v / max)) * 50;
  return (
    <div className={`relative h-1 w-full overflow-hidden rounded-full bg-line-soft ${className}`}>
      <span className="absolute left-1/2 top-0 h-full w-px bg-line" />
      {v != null && (
        <span
          className={`absolute top-0 h-full rounded-full ${v >= 0 ? "bg-pos" : "bg-neg"}`}
          style={pct >= 0 ? { left: "50%", width: `${pct}%` } : { right: "50%", width: `${-pct}%` }}
        />
      )}
    </div>
  );
}

/**
 * The regime dial as the canvas draws it: a thin track that fades from the
 * risk-off tint on the left to the risk-on tint on the right, with a 2px ink
 * marker at the value.
 */
export function RegimeTrack({ value, className = "" }: { value: number | null; className?: string }) {
  const v = value == null ? null : Math.max(0, Math.min(100, value));
  return (
    <div
      className={`relative h-1.5 rounded-[3px] ${className}`}
      style={{ background: "linear-gradient(90deg, var(--color-neg-soft), var(--color-line-soft) 50%, var(--color-pos-soft))" }}
      aria-hidden
    >
      {v != null && <span className="absolute -top-[3px] h-3 w-[2px] -ml-px bg-ink" style={{ left: `${v}%` }} />}
    </div>
  );
}

/** Ordinal suffix — 1st, 2nd, 3rd, 4th … 21st, 31st. */
export function ordinal(n: number): string {
  const i = Math.round(n);
  const mod100 = i % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${i}th`;
  switch (i % 10) {
    case 1: return `${i}st`;
    case 2: return `${i}nd`;
    case 3: return `${i}rd`;
    default: return `${i}th`;
  }
}

export function TickerLink({ ticker, className = "" }: { ticker: string; className?: string }) {
  return (
    <Link href={`/stock/${encodeURIComponent(ticker)}`} className={`font-mono text-[12.5px] font-medium text-ink hover:text-accent ${className}`}>
      {ticker}
    </Link>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-3.5 py-5 text-center text-[12px] text-ink-3">{children}</p>;
}

export function weekday(dateStr: string): string {
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  if (isNaN(ms)) return dateStr;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(ms);
}

/** "Wed" — the three-letter day for the calendar rows. */
export function weekdayShort(dateStr: string): string {
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  if (isNaN(ms)) return dateStr.slice(5);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(ms);
}

export function relDays(n: number): string {
  if (!isFinite(n)) return "";
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n < 0) return `${-n}d ago`;
  return `in ${n}d`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!isFinite(ms)) return "";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** 28×28 icon-only control (the chevron that opens a panel's full content). */
export function IconButton({ onClick, title, icon, active, className = "", disabled, spin }: { onClick: () => void; title: string; icon: string; active?: boolean; className?: string; disabled?: boolean; spin?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-expanded={active}
      disabled={disabled}
      className={`grid h-7 w-7 place-items-center rounded-control border border-line bg-surface text-ink-2 transition-colors hover:bg-surface-hover disabled:opacity-50 ${className}`}
    >
      <AppIcon name={icon} size={14} className={spin ? "animate-spin" : ""} />
    </button>
  );
}

/** 24px secondary button for row actions (Done / Snooze / Open). */
export function RowButton({ onClick, href, disabled, title, children }: { onClick?: () => void; href?: string; disabled?: boolean; title?: string; children: React.ReactNode }) {
  const cls = "inline-flex h-6 items-center rounded-control border border-line bg-surface px-2 text-[12px] text-ink-2 transition-colors hover:bg-surface-hover disabled:opacity-50";
  if (href) {
    return (
      <Link href={href} className={cls} title={title}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className={cls}>
      {children}
    </button>
  );
}

/**
 * A collapsible panel. Open/closed persists per person in `pm:ui-prefs`
 * ("1" = collapsed), so the page comes back the way it was left. `preview` is
 * the one-line read a CLOSED panel still carries.
 */
export function Fold({
  prefKey,
  id,
  title,
  preview,
  meta,
  right,
  defaultOpen = false,
  children,
}: {
  prefKey: string;
  id?: string;
  title: string;
  preview?: React.ReactNode;
  meta?: React.ReactNode;
  right?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const { uiPrefs, setUiPref } = useStocks();
  const open = (uiPrefs[prefKey] ?? (defaultOpen ? "0" : "1")) !== "1";
  return (
    <Card>
      <div className="panel-h" id={id} style={{ scrollMarginTop: 64 }}>
        <button type="button" onClick={() => setUiPref(prefKey, open ? "1" : "0")} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <AppIcon name={open ? "chevD" : "chevR"} size={14} className="text-ink-3" />
          <span className="t shrink-0">{title}</span>
          {meta && <span className="m shrink-0">{meta}</span>}
          {preview && !open && <span className="m min-w-0 flex-1 truncate !text-ink-2">{preview}</span>}
        </button>
        {right && <div className="ml-auto flex shrink-0 items-center gap-2">{right}</div>}
      </div>
      {open && <div>{children}</div>}
    </Card>
  );
}

/** Compact label/value pair. */
export function Metric({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "pos" | "neg" | "warn" }) {
  const cls = tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : tone === "warn" ? "text-warn" : "text-ink";
  return (
    <div className="min-w-0">
      <div className="truncate text-[11px] text-ink-3">{label}</div>
      <div className={`font-mono text-[13px] font-medium tabular-nums ${cls}`}>{value}</div>
      {sub && <div className="truncate text-[11px] text-ink-faint">{sub}</div>}
    </div>
  );
}

/** The bottom-panel tab that holds the narrative rows; `useRevealFold` switches to it. */
export const BRIEF_TABS_PREF = "brief.tabs";

/**
 * Open a narrative fold and scroll to it.
 *
 * The narrative rows are `CollapsibleSection`s keyed by prefKey (each renders
 * `id={prefKey}`) inside the Narrative tab of the bottom panel — so revealing
 * one also selects that tab, then expands the row ("0" = open) and scrolls
 * once React has painted it.
 */
export function useRevealFold(): (prefKey: string) => void {
  const { setUiPref } = useStocks();
  return React.useCallback(
    (prefKey: string) => {
      if (prefKey.startsWith("briefNarrative")) setUiPref(BRIEF_TABS_PREF, "narrative");
      setUiPref(prefKey, "0");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = document.getElementById(prefKey);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      });
    },
    [setUiPref]
  );
}

/** The consistent "go deeper" text link inside a cell. */
export function TileLink({ onClick, href, children, className = "" }: { onClick?: () => void; href?: string; children: React.ReactNode; className?: string }) {
  const cls = `text-[11.5px] text-accent transition-colors hover:text-accent-ink ${className}`;
  if (href) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {children}
    </button>
  );
}
