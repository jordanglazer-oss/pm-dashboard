"use client";

/**
 * Command Palette — Cmd+K (Ctrl+K on Win/Linux) from anywhere opens a
 * spotlight-style search box for navigating the app.
 *
 * Surfaces three kinds of entries:
 *   1. Pages — every nav tab plus admin pages (Health) plus the Stock
 *      page (resolved via ticker search)
 *   2. Stocks — Portfolio + Watchlist names, with bucket and sector
 *      shown as subtle metadata. Selecting jumps to /stock/[ticker].
 *   3. Actions — global commands like "Add stock", "Open Health".
 *
 * The implementation is intentionally dependency-free (no cmdk, no
 * fuse.js) because the matchable surface is small (~50-200 items) and
 * simple substring matching is plenty for this scale. Performance is
 * O(n) per keystroke against an in-memory list — no measurable cost.
 *
 * Keyboard:
 *   - Cmd+K / Ctrl+K     open
 *   - Esc                close
 *   - ↑ / ↓              move highlight
 *   - Enter              activate highlighted entry
 *
 * Each result entry exposes either `href` (navigate) or `action`
 * (run a function). Recent selections are persisted to localStorage
 * so the most-used items float to the top.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useStocks } from "@/app/lib/StockContext";

type Entry = {
  id: string;            // stable identifier for recency ordering
  category: "page" | "stock" | "action";
  label: string;
  subtitle?: string;
  href?: string;
  action?: () => void;
  // Lowercased search target — match anything containing this string.
  searchTarget: string;
};

const PAGE_ENTRIES: Omit<Entry, "id" | "searchTarget">[] = [
  { category: "page", label: "Brief",        subtitle: "Morning briefing & regime",       href: "/brief" },
  { category: "page", label: "Dashboard",    subtitle: "Portfolio rankings & sector mix", href: "/" },
  { category: "page", label: "Chat",         subtitle: "Ask Claude anything",             href: "/chat" },
  { category: "page", label: "PIM Model",    subtitle: "Model holdings & sleeve drift",   href: "/pim-model" },
  { category: "page", label: "Positioning",  subtitle: "Live positions & today's return", href: "/portfolio" },
  { category: "page", label: "Screener",     subtitle: "Run scans / technicals scanner",  href: "/screener" },
  { category: "page", label: "Research",     subtitle: "Upticks, Fundstrat, RBC, Alpha",  href: "/research" },
  { category: "page", label: "AA & Perf",    subtitle: "Asset allocation & performance",  href: "/aa-performance" },
  { category: "page", label: "Hedging",      subtitle: "SPY put hedging window",          href: "/hedging" },
  { category: "page", label: "Appendix",     subtitle: "Daily ledger / historical",       href: "/appendix" },
  { category: "page", label: "Inbox",        subtitle: "Brokerage emails ingest",         href: "/inbox" },
  { category: "page", label: "Health",       subtitle: "Upstream data source status",    href: "/admin/health" },
];

const RECENT_KEY = "pm:cmd-palette:recent";
const MAX_RECENT = 8;

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string").slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function writeRecent(id: string) {
  try {
    const current = readRecent();
    const next = [id, ...current.filter((x) => x !== id)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
}

type Props = {
  open: boolean;
  onClose: () => void;
  onTriggerQuickAdd: () => void;
};

export function CommandPalette({ open, onClose, onTriggerQuickAdd }: Props) {
  const router = useRouter();
  const { stocks } = useStocks();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // Reset state on open and focus the input.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlight(0);
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  // Build the full entry list — pages + stocks + actions. Stable IDs
  // so recency-ordering survives across opens.
  const allEntries = useMemo<Entry[]>(() => {
    const pages: Entry[] = PAGE_ENTRIES.map((p) => ({
      ...p,
      id: `page:${p.href}`,
      searchTarget: `${p.label} ${p.subtitle ?? ""}`.toLowerCase(),
    }));

    const stockEntries: Entry[] = stocks.map((s) => ({
      id: `stock:${s.ticker}`,
      category: "stock",
      label: s.ticker,
      subtitle: `${s.name}${s.bucket ? ` · ${s.bucket}` : ""}${s.sector ? ` · ${s.sector}` : ""}`,
      href: `/stock/${encodeURIComponent(s.ticker)}`,
      searchTarget: `${s.ticker} ${s.name} ${s.sector ?? ""} ${s.bucket ?? ""}`.toLowerCase(),
    }));

    const actions: Entry[] = [
      {
        id: "action:add-stock",
        category: "action",
        label: "Add stock",
        subtitle: "Open Quick-Add modal (Shift+A)",
        action: () => onTriggerQuickAdd(),
        searchTarget: "add stock new ticker",
      },
      {
        id: "action:health",
        category: "action",
        label: "Open Health dashboard",
        subtitle: "Status of every upstream data source",
        href: "/admin/health",
        searchTarget: "health status diagnostics admin",
      },
    ];

    return [...pages, ...stockEntries, ...actions];
  }, [stocks, onTriggerQuickAdd]);

  // Apply the query (substring on lowercased target) + recency boost.
  const filtered = useMemo<Entry[]>(() => {
    const q = query.trim().toLowerCase();
    const recent = readRecent();
    const matches = q
      ? allEntries.filter((e) => e.searchTarget.includes(q))
      : [...allEntries];

    // Score: recent index gives early-position boost; ticker prefix
    // match outranks substring match for stocks (so "AA" surfaces AAPL
    // ahead of "Brand A" type entries).
    matches.sort((a, b) => {
      const ai = recent.indexOf(a.id);
      const bi = recent.indexOf(b.id);
      const aRecent = ai === -1 ? Infinity : ai;
      const bRecent = bi === -1 ? Infinity : bi;
      if (aRecent !== bRecent) return aRecent - bRecent;

      if (q) {
        const aPrefix = a.label.toLowerCase().startsWith(q) ? 0 : 1;
        const bPrefix = b.label.toLowerCase().startsWith(q) ? 0 : 1;
        if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      }
      // Category sort order: page, action, stock — so navigation outranks
      // stock detail unless the user typed a clear ticker match.
      const order = { page: 0, action: 1, stock: 2 } as const;
      if (a.category !== b.category) return order[a.category] - order[b.category];
      return a.label.localeCompare(b.label);
    });
    return matches.slice(0, 30);
  }, [allEntries, query]);

  // Reset highlight on query change so the top result is always live.
  useEffect(() => { setHighlight(0); }, [query]);

  const activate = useCallback((entry: Entry) => {
    writeRecent(entry.id);
    onClose();
    // Slight defer for the modal to close before navigating, so the
    // page transition feels snappy rather than mid-modal.
    setTimeout(() => {
      if (entry.action) entry.action();
      else if (entry.href) router.push(entry.href);
    }, 30);
  }, [onClose, router]);

  // Modal-level key handling for navigation and submit.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => Math.min(filtered.length - 1, h + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => Math.max(0, h - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const entry = filtered[highlight];
        if (entry) activate(entry);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, filtered, highlight, activate, onClose]);

  // Auto-scroll the highlighted row into view as the user arrows down a
  // long result list.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLLIElement>(`[data-idx="${highlight}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-start justify-center bg-ink/60 backdrop-blur-sm pt-10 sm:pt-20 px-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl rounded-card bg-white shadow-2xl border border-line overflow-hidden"
      >
        <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
          <svg className="w-4 h-4 text-ink-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.343-4.343m0 0A8 8 0 1 0 5.343 5.343a8 8 0 0 0 11.314 11.314Z" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages, stocks, or actions..."
            className="flex-1 bg-transparent text-ink text-sm outline-none placeholder:text-ink-3"
          />
          <kbd className="text-[10px] text-ink-3 border border-line rounded px-1.5 py-0.5">Esc</kbd>
        </div>

        <ul ref={listRef} className="max-h-96 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-ink-3">No matches</li>
          ) : (
            filtered.map((e, idx) => {
              const active = idx === highlight;
              return (
                <li
                  key={e.id}
                  data-idx={idx}
                  onMouseEnter={() => setHighlight(idx)}
                  onClick={() => activate(e)}
                  className={`flex items-center gap-3 px-4 py-2 cursor-pointer ${
                    active ? "bg-accent-soft" : ""
                  }`}
                >
                  <CategoryGlyph category={e.category} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-ink truncate">
                      {e.label}
                    </div>
                    {e.subtitle && (
                      <div className="text-[11px] text-ink-3 truncate">{e.subtitle}</div>
                    )}
                  </div>
                  <span className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold shrink-0">
                    {e.category}
                  </span>
                </li>
              );
            })
          )}
        </ul>

        <div className="border-t border-line-soft px-4 py-2 flex items-center gap-3 text-[10px] text-ink-3">
          <span><kbd className="border border-line rounded px-1 py-px">↑</kbd> <kbd className="border border-line rounded px-1 py-px">↓</kbd> navigate</span>
          <span><kbd className="border border-line rounded px-1 py-px">↵</kbd> open</span>
          <span className="ml-auto"><kbd className="border border-line rounded px-1 py-px">⌘K</kbd> toggle</span>
        </div>
      </div>
    </div>
  );
}

function CategoryGlyph({ category }: { category: Entry["category"] }) {
  if (category === "stock") {
    return (
      <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-pos-soft text-pos shrink-0">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18 9 11.25l4.306 4.307a11.95 11.95 0 0 1 5.814-5.518l2.74-1.22m0 0-5.94-2.281m5.94 2.281-2.28 5.941" /></svg>
      </span>
    );
  }
  if (category === "action") {
    return (
      <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-warn-soft text-warn shrink-0">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5 10.5 21l-.75-7.5h6L13.5 3l.75 7.5h-6Z" /></svg>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-surface-2 text-ink-2 shrink-0">
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6h16.5M3.75 12h16.5m-16.5 5.25h16.5" /></svg>
    </span>
  );
}
