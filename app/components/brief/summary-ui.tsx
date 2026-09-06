"use client";

import React from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";

/**
 * Shared primitives for the Brief summary zones. Card language mirrors the
 * rest of the Precision Light UI (rounded-card / border-line / shadow-sm,
 * Plex Mono for numbers) so the summary reads as one system with the
 * narrative folds beneath it.
 */

export function Card({ className = "", children, tone }: { className?: string; children: React.ReactNode; tone?: "pos" | "neg" | "warn" | "accent" }) {
  const edge =
    tone === "pos" ? "border-l-[3px] border-l-pos" : tone === "neg" ? "border-l-[3px] border-l-neg" : tone === "warn" ? "border-l-[3px] border-l-warn" : tone === "accent" ? "border-l-[3px] border-l-accent" : "";
  return <section className={`min-w-0 overflow-hidden rounded-card border border-line bg-white shadow-sm ${edge} ${className}`}>{children}</section>;
}

export function CardHeader({ title, sub, right, href }: { title: string; sub?: React.ReactNode; right?: React.ReactNode; href?: string }) {
  return (
    <header className="flex items-baseline gap-2 border-b border-line-soft px-4 pt-3 pb-2">
      {href ? (
        <Link href={href} className="text-sm font-bold tracking-tight text-ink hover:text-accent">
          {title}
        </Link>
      ) : (
        <h3 className="text-sm font-bold tracking-tight text-ink">{title}</h3>
      )}
      {sub && <span className="min-w-0 truncate text-xs text-ink-3">· {sub}</span>}
      {right && <span className="ml-auto shrink-0">{right}</span>}
    </header>
  );
}

export function SectionHeading({ id, title, sub }: { id: string; title: string; sub: string }) {
  return (
    <div style={{ scrollMarginTop: "var(--brief-scroll-mt, 132px)" }} id={id} className="mb-2 mt-2 flex items-baseline gap-2.5">
      <h2 className="text-xs font-bold uppercase tracking-[0.22em] text-ink-3">{title}</h2>
      <span className="text-[11px] text-ink-faint">{sub}</span>
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

export function Pill({ children, tone = "neutral", className = "" }: { children: React.ReactNode; tone?: "pos" | "neg" | "warn" | "accent" | "neutral" | "violet"; className?: string }) {
  const map = {
    pos: "border-pos-border bg-pos-soft text-pos",
    neg: "border-neg-border bg-neg-soft text-neg",
    warn: "border-warn-border bg-warn-soft text-warn",
    accent: "border-accent-border bg-accent-soft text-accent-ink",
    violet: "border-violet-border bg-violet-soft text-violet",
    neutral: "border-line bg-surface-2 text-ink-2",
  } as const;
  return <span className={`inline-flex items-center whitespace-nowrap rounded-pill border px-2 py-[2px] text-[10.5px] font-semibold uppercase tracking-[0.04em] ${map[tone]} ${className}`}>{children}</span>;
}

export function regimeTone(label: string | null | undefined): "pos" | "neg" | "warn" {
  if (label === "Risk-On") return "pos";
  if (label === "Risk-Off") return "neg";
  return "warn";
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
    <div className={`relative h-1.5 w-full overflow-hidden rounded-full bg-line-soft ${className}`}>
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
 * Semicircle 0..100 gauge. The value is marked with a tick at the RIM rather
 * than a needle from the pivot — a needle crosses the number at these sizes
 * and makes it unreadable.
 */
export function Dial({ value, label, size = 148 }: { value: number | null; label: string | null; size?: number }) {
  const r = size / 2 - 8;
  const cx = size / 2;
  const cy = size / 2;
  const at = (f: number, radius: number) => {
    const a = Math.PI - (Math.max(0, Math.min(100, f)) / 100) * Math.PI;
    return { x: cx + radius * Math.cos(a), y: cy - radius * Math.sin(a) };
  };
  const arc = (from: number, to: number) => {
    const a = at(from, r);
    const b = at(to, r);
    return `M${a.x.toFixed(2)},${a.y.toFixed(2)} A${r},${r} 0 0 1 ${b.x.toFixed(2)},${b.y.toFixed(2)}`;
  };
  const v = value == null ? null : Math.max(0, Math.min(100, value));
  const tone = label === "Risk-On" ? "text-pos" : label === "Risk-Off" ? "text-neg" : "text-warn";
  const inner = v == null ? null : at(v, r - 7);
  const outer = v == null ? null : at(v, r + 6);
  return (
    <svg width={size} height={size / 2 + 16} viewBox={`0 0 ${size} ${size / 2 + 16}`} aria-hidden>
      <path d={arc(0, 33)} fill="none" strokeWidth="7" strokeLinecap="butt" className="stroke-neg-border" />
      <path d={arc(33, 67)} fill="none" strokeWidth="7" className="stroke-warn-border" />
      <path d={arc(67, 100)} fill="none" strokeWidth="7" className="stroke-pos-border" />
      {inner && outer && (
        <line x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} strokeWidth="3" strokeLinecap="round" className={`stroke-current ${tone}`} />
      )}
      <text x={cx} y={cy - 4} textAnchor="middle" className={`fill-current font-mono ${tone}`} style={{ fontSize: Math.round(size * 0.2), fontWeight: 600 }}>
        {v == null ? "—" : Math.round(v)}
      </text>
      <text x={2} y={cy + 13} className="fill-current text-ink-3" style={{ fontSize: 9 }}>OFF</text>
      <text x={size - 2} y={cy + 13} textAnchor="end" className="fill-current text-ink-3" style={{ fontSize: 9 }}>ON</text>
    </svg>
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
    <Link href={`/stock/${encodeURIComponent(ticker)}`} className={`font-mono text-[12px] font-semibold text-ink hover:text-accent ${className}`}>
      {ticker}
    </Link>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-5 text-center text-[12px] text-ink-3">{children}</p>;
}

export function weekday(dateStr: string): string {
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  if (isNaN(ms)) return dateStr;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(ms);
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

/**
 * A collapsible rail. Open/closed persists per person in `pm:ui-prefs` (the
 * same store the brief's narrative folds use, "1" = collapsed), so the page
 * comes back the way it was left.
 *
 * `preview` is the point of the pattern: a CLOSED rail still carries a live
 * one-line read, so the PM can tell whether it is worth opening without
 * opening it. Keep it to one line of the most decision-relevant numbers.
 */
export function Fold({
  prefKey,
  id,
  title,
  preview,
  meta,
  right,
  defaultOpen = false,
  tone,
  children,
}: {
  prefKey: string;
  id?: string;
  title: string;
  preview?: React.ReactNode;
  meta?: React.ReactNode;
  right?: React.ReactNode;
  defaultOpen?: boolean;
  tone?: "pos" | "neg" | "warn" | "accent";
  children: React.ReactNode;
}) {
  const { uiPrefs, setUiPref } = useStocks();
  const open = (uiPrefs[prefKey] ?? (defaultOpen ? "0" : "1")) !== "1";
  return (
    <Card tone={tone} className="min-w-0">
      <button
        type="button"
        onClick={() => setUiPref(prefKey, open ? "1" : "0")}
        aria-expanded={open}
        id={id}
        style={{ scrollMarginTop: "var(--brief-scroll-mt, 132px)" }}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-surface-hover"
      >
        <svg
          className={`h-3 w-3 shrink-0 text-ink-3 transition-transform ${open ? "" : "-rotate-90"}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
        <span className="shrink-0 text-[13px] font-bold tracking-tight text-ink">{title}</span>
        {meta && <span className="shrink-0 text-[11px] text-ink-3">· {meta}</span>}
        {preview && !open && <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-2">{preview}</span>}
        <span className="ml-auto shrink-0 pl-2">{right}</span>
      </button>
      {open && <div className="border-t border-line-soft">{children}</div>}
    </Card>
  );
}

/** Compact label/value pair for the decision band. */
export function Metric({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "pos" | "neg" | "warn" }) {
  const cls = tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : tone === "warn" ? "text-warn" : "text-ink";
  return (
    <div className="min-w-0 rounded-control border border-line-soft bg-surface-2 px-2 py-1.5">
      <div className="truncate text-[10px] font-semibold uppercase tracking-wide text-ink-3">{label}</div>
      <div className={`font-mono text-[13px] font-semibold tabular-nums ${cls}`}>{value}</div>
      {sub && <div className="truncate text-[10px] text-ink-faint">{sub}</div>}
    </div>
  );
}
