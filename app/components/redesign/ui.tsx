"use client";

/**
 * Redesign options (Nov 2026 team rebuild) — shared building blocks.
 *
 * Everything under /redesign is ADDITIVE: new pages beside the existing
 * screens, reading the same data through the same routes. Nothing here
 * removes, hides or changes an existing screen.
 *
 * House rules for these pages (from the team's plan):
 *  - facts, not opinions — no regime label, no AI call, no recommendation;
 *  - point form; every number carries its as-of date and its source;
 *  - readable on an iPad (15px+ text, roomy rows);
 *  - the most important things visible, the rest behind ONE persisted
 *    "More" section (pm:ui-prefs via usePersistedOpen).
 */

import React from "react";
import Link from "next/link";
import { usePersistedOpen } from "@/app/lib/useCollapsed";

export type OptionDef = { id: string; label: string; blurb: string };

export const fmtNum = (v: number | null | undefined, digits = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
export const fmtSigned = (v: number | null | undefined, digits = 1, unit = "%") => (v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}${unit}`);
export const tone = (v: number | null | undefined) => (v == null || !Number.isFinite(v) || v === 0 ? "text-ink-2" : v > 0 ? "text-pos" : "text-neg");

const ET = "America/New_York";
export const todayET = () => new Intl.DateTimeFormat("en-CA", { timeZone: ET }).format(new Date());

/** "Nov 24" / "Nov 24, 4:05 PM" from an ISO date or timestamp. */
export function fmtAsOf(iso: string | null | undefined): string {
  if (!iso) return "no date";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return t.toLocaleString("en-US", { timeZone: ET, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Whole days between an ISO date/timestamp and today (Eastern). Null when unreadable. */
export function daysOld(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : (() => {
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? null : new Intl.DateTimeFormat("en-CA", { timeZone: ET }).format(t);
  })();
  if (!day) return null;
  const a = Date.parse(`${day}T12:00:00Z`);
  const b = Date.parse(`${todayET()}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Page frame: a wide, calm column with larger type. */
export function Page({ title, lede, right, children }: { title: string; lede?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-ground pb-16 text-ink">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-5">
        <header className="flex flex-wrap items-end gap-x-4 gap-y-2 px-1 pt-2">
          <div className="min-w-0">
            <h1 className="text-[28px] font-bold leading-tight tracking-tight text-ink">{title}</h1>
            {lede && <p className="mt-1 text-[15px] text-ink-2">{lede}</p>}
          </div>
          {right && <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div>}
        </header>
        {children}
      </div>
    </main>
  );
}

/** The A / B / C switch at the top of a section. Links, so an option can be shared. */
export function OptionSwitch({ base, options, current, suffix = "" }: { base: string; options: OptionDef[]; current: string; suffix?: string }) {
  if (options.length < 2) return null;
  const cur = options.find((o) => o.id === current) ?? options[0];
  return (
    <div className="rounded-card border border-brass/40 bg-brass-soft px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold uppercase tracking-wide text-brass-ink">Design options</span>
        {options.map((o) => (
          <Link
            key={o.id}
            href={`${base}/${o.id}${suffix}`}
            className={`inline-flex h-9 items-center rounded-control border px-3.5 text-[14px] font-semibold ${o.id === cur.id ? "border-accent bg-accent !text-white" : "border-line bg-surface !text-ink-2 hover:bg-surface-hover"}`}
          >
            {o.id.toUpperCase()} · {o.label}
          </Link>
        ))}
      </div>
      <p className="mt-1.5 text-[14px] text-ink-2">{cur.blurb}</p>
    </div>
  );
}

/** A plain card. `title` row is optional; `right` sits at the end of it. */
export function Card({ title, sub, right, children, className = "", pad = true }: { title?: string; sub?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={`overflow-hidden rounded-card border border-line-soft bg-surface shadow-[var(--shadow-card)] ${className}`}>
      {(title || right) && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line-soft px-5 py-3">
          {title && <h2 className="text-[17px] font-bold tracking-tight text-ink">{title}</h2>}
          {sub && <span className="text-[13px] text-ink-3">{sub}</span>}
          {right && <div className="ml-auto flex items-center gap-2 text-[13px]">{right}</div>}
        </div>
      )}
      <div className={pad ? "px-5 py-4" : ""}>{children}</div>
    </section>
  );
}

/** Small grey "as of · source" line that every number carries. */
export function AsOf({ at, source, className = "" }: { at?: string | null; source?: string | null; className?: string }) {
  return (
    <span className={`text-[12.5px] text-ink-3 ${className}`}>
      {fmtAsOf(at)}
      {source ? ` · ${source}` : ""}
    </span>
  );
}

/** A pill. Tones are for STATUS of the data or a price zone — never a market call. */
export function Tag({ children, kind = "neutral", title }: { children: React.ReactNode; kind?: "neutral" | "green" | "yellow" | "red" | "blue"; title?: string }) {
  const cls =
    kind === "green" ? "border-pos-border bg-pos-soft text-pos"
    : kind === "yellow" ? "border-warn-border bg-warn-soft text-warn"
    : kind === "red" ? "border-neg-border bg-neg-soft text-neg"
    : kind === "blue" ? "border-accent-border bg-accent-soft text-accent"
    : "border-line bg-surface-2 text-ink-2";
  return (
    <span title={title} className={`inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[12.5px] font-semibold ${cls}`}>
      {children}
    </span>
  );
}

/** The ONE persisted "more" section per card: everything that is not essential. */
export function More({ prefKey, label, count, children, defaultOpen = false }: { prefKey: string; label: string; count?: number; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, toggle] = usePersistedOpen(prefKey, defaultOpen);
  return (
    <div className="border-t border-line-soft">
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full items-center gap-2 px-5 py-3 text-left text-[14px] font-semibold text-accent hover:bg-surface-hover">
        <span className="inline-block w-3 text-center">{open ? "−" : "+"}</span>
        <span>{open ? `Hide ${label}` : `Show ${label}`}</span>
        {count != null && <span className="font-normal text-ink-3">({count})</span>}
      </button>
      {open && <div className="px-5 pb-4">{children}</div>}
    </div>
  );
}

/** Headline figure with a label above and one short line below. */
export function Figure({ label, value, sub, valueClass = "" }: { label: string; value: React.ReactNode; sub?: React.ReactNode; valueClass?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[13px] font-medium text-ink-3">{label}</div>
      <div className={`figure text-[26px] leading-tight ${valueClass}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[12.5px] text-ink-3">{sub}</div>}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-3 text-[14.5px] text-ink-3">{children}</p>;
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return <p className="animate-pulse py-3 text-[14.5px] text-ink-3">{what}…</p>;
}

/** Point-form list. */
export function Bullets({ items, className = "" }: { items: React.ReactNode[]; className?: string }) {
  if (!items.length) return null;
  return (
    <ul className={`flex flex-col gap-1.5 text-[15px] leading-snug text-ink ${className}`}>
      {items.map((it, i) => (
        <li key={i} className="flex gap-2.5">
          <span className="mt-[9px] inline-block h-[5px] w-[5px] shrink-0 rounded-full bg-ink-3" />
          <span className="min-w-0">{it}</span>
        </li>
      ))}
    </ul>
  );
}

/** Roomy table for these pages (iPad-sized rows). Wrap in a Card with pad={false}. */
export function Table({ head, children, minWidth = 640 }: { head: { label: string; right?: boolean; title?: string }[]; children: React.ReactNode; minWidth?: number }) {
  return (
    <div className="overflow-x-auto overscroll-x-contain">
      <table className="w-full border-collapse text-[15px]" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-line-soft bg-surface-2">
            {head.map((h, i) => (
              <th key={i} title={h.title} className={`whitespace-nowrap px-3 py-2.5 text-[12.5px] font-semibold uppercase tracking-wide text-ink-3 first:pl-5 last:pr-5 ${h.right ? "text-right" : "text-left"}`}>
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export const TD = "px-3 py-3 align-middle first:pl-5 last:pr-5 border-b border-line-soft";
export const TDN = `${TD} text-right tabular-nums whitespace-nowrap`;

export const BTN = "inline-flex h-9 items-center gap-1.5 rounded-control border border-line bg-surface px-3.5 text-[14px] font-medium text-ink-2 hover:bg-surface-hover disabled:opacity-50";
export const BTN_PRIMARY = "inline-flex h-9 items-center gap-1.5 rounded-control border border-accent bg-accent px-3.5 text-[14px] font-semibold !text-white hover:opacity-90 disabled:opacity-50";
export const INPUT = "h-10 w-full rounded-control border border-line bg-surface px-3 text-[15px] text-ink tabular-nums";
