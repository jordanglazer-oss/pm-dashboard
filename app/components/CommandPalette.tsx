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
import { AppIcon } from "./AppIcon";

type Entry = {
  id: string;            // stable identifier for recency ordering
  category: "page" | "stock" | "action";
  label: string;
  subtitle?: string;
  href?: string;
  action?: () => void;
  // Last known price for holding rows (shown on the right). (#12)
  price?: number;
  /** Adjusted composite for holding rows (v2 rich results). */
  score?: number;
  // Lowercased search target — match anything containing this string.
  searchTarget: string;
};

const CATEGORY_LABEL: Record<Entry["category"], string> = {
  page: "Pages",
  stock: "Holdings",
  action: "Actions",
};

const PAGE_ENTRIES: Omit<Entry, "id" | "searchTarget">[] = [
  { category: "page", label: "Brief",        subtitle: "Regime, verdict, the day's calls",  href: "/brief" },
  { category: "page", label: "Holdings",     subtitle: "Portfolio rankings & filters",      href: "/" },
  { category: "page", label: "Positioning",  subtitle: "Live book vs model · rebalance",    href: "/portfolio" },
  { category: "page", label: "Models",       subtitle: "Model holdings · scenarios · eligibility", href: "/pim-model" },
  { category: "page", label: "Performance",  subtitle: "Returns · allocation · attribution", href: "/aa-performance" },
  { category: "page", label: "Risk",         subtitle: "Contributions · clusters · stress", href: "/risk" },
  { category: "page", label: "Thesis",       subtitle: "Kill conditions & underwrites",     href: "/thesis" },
  { category: "page", label: "Journal",      subtitle: "Decision log & hit rates",          href: "/journal" },
  { category: "page", label: "Synthesis",    subtitle: "AI base/bull/bear per name",        href: "/synthesis" },
  { category: "page", label: "Pipeline",     subtitle: "Conviction board",                  href: "/conviction" },
  { category: "page", label: "Screener",     subtitle: "Technical scans",                   href: "/screener" },
  { category: "page", label: "Radar",        subtitle: "Regime-tilted factor screen",       href: "/radar" },
  { category: "page", label: "Setups",       subtitle: "Technical setup scan",              href: "/setups" },
  { category: "page", label: "Factor Lab",   subtitle: "Shadow quant read-outs",            href: "/factor-lab" },
  { category: "page", label: "Research",     subtitle: "Upticks, Fundstrat, RBC, Alpha",    href: "/research" },
  { category: "page", label: "Inbox",        subtitle: "Coverage table & email ingest",     href: "/inbox" },
  { category: "page", label: "Hedging",      subtitle: "SPY put hedging window",            href: "/hedging" },
  { category: "page", label: "Chat",         subtitle: "Ask Claude anything",               href: "/chat" },
  { category: "page", label: "Appendix",     subtitle: "Daily ledger / historical",         href: "/appendix" },
  { category: "page", label: "Client Report", subtitle: "Client-facing PDF builder",        href: "/client-report" },
  { category: "page", label: "Methodology",  subtitle: "How the process works",             href: "/methodology" },
  { category: "page", label: "Health",       subtitle: "Upstream data source status",       href: "/admin/health" },
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
  const { stocks, scoredStocks, refreshAllPrices } = useStocks();
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

    const scoreByTicker = new Map(scoredStocks.map((x) => [x.ticker, x.adjusted]));
    const stockEntries: Entry[] = stocks.map((s) => ({
      id: `stock:${s.ticker}`,
      category: "stock",
      label: s.ticker,
      subtitle: `${s.name}${s.bucket ? ` · ${s.bucket}` : ""}${s.sector ? ` · ${s.sector}` : ""}`,
      price: typeof s.price === "number" ? s.price : undefined,
      score: scoreByTicker.get(s.ticker),
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
        id: "action:refresh-prices",
        category: "action",
        label: "Refresh prices",
        subtitle: "Batched Yahoo refresh across the whole book",
        action: () => { void refreshAllPrices(); },
        searchTarget: "refresh prices update quotes yahoo",
      },
      {
        id: "action:log-hedge",
        category: "action",
        label: "Log a hedge",
        subtitle: "Open the hedging ledger",
        href: "/hedging",
        searchTarget: "log hedge spy put ledger protection",
      },
      {
        id: "action:regenerate-brief",
        category: "action",
        label: "Regenerate brief…",
        subtitle: "Opens the Brief — confirm the regeneration there",
        href: "/brief",
        searchTarget: "regenerate brief morning rerun",
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

    // Per-ticker actions (v2): every scoreable holding gets a Rescore and a
    // Synthesis jump, findable by typing the ticker + verb.
    const tickerActions: Entry[] = [];
    for (const st of stocks) {
      if (st.instrumentType && st.instrumentType !== "stock") continue;
      tickerActions.push({
        id: `action:rescore:${st.ticker}`,
        category: "action",
        label: `Rescore ${st.ticker}`,
        subtitle: "Web-verified full rescore · ~$0.04",
        href: `/stock/${encodeURIComponent(st.ticker)}?action=rescore`,
        searchTarget: `rescore score ${st.ticker} ${st.name}`.toLowerCase(),
      });
      tickerActions.push({
        id: `action:synthesis:${st.ticker}`,
        category: "action",
        label: `Synthesis for ${st.ticker}`,
        subtitle: "Jump to the name's base/bull/bear record",
        href: `/synthesis?ticker=${encodeURIComponent(st.ticker)}`,
        searchTarget: `synthesis generate ${st.ticker} ${st.name}`.toLowerCase(),
      });
    }

    return [...pages, ...stockEntries, ...actions, ...tickerActions];
  }, [stocks, scoredStocks, onTriggerQuickAdd, refreshAllPrices]);

  // Apply the query (substring on lowercased target) + recency boost.
  const filtered = useMemo<Entry[]>(() => {
    const q = query.trim().toLowerCase();
    const recent = readRecent();
    const matches = q
      ? allEntries.filter((e) => e.searchTarget.includes(q))
      : [...allEntries];

    // Grouped display (#12): sort by category first (Pages → Holdings →
    // Actions) so each section is contiguous; then WITHIN a category by recency
    // boost, then query-prefix match (so "AA" surfaces AAPL first), then alpha.
    const order = { page: 0, stock: 1, action: 2 } as const;
    matches.sort((a, b) => {
      if (a.category !== b.category) return order[a.category] - order[b.category];

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
      className="fixed inset-0 z-[110] flex items-start justify-center bg-ink/40 px-4 pt-10 backdrop-blur-[2px] sm:pt-20"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="animate-scale-in w-full max-w-[560px] overflow-hidden rounded-card border border-line bg-surface shadow-[var(--shadow-pop)]"
      >
        <div className="flex h-9 items-center gap-2.5 border-b border-line-soft px-3.5">
          <AppIcon name="search" size={14} className="text-ink-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages, holdings, or actions"
            className="h-full flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-3"
          />
          <kbd className="rounded border border-line bg-surface-2 px-1 py-px font-mono text-[10px] text-ink-3">Esc</kbd>
        </div>

        <ul ref={listRef} className="max-h-96 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <li className="px-3.5 py-6 text-center text-[12.5px] text-ink-3">No matches</li>
          ) : (
            filtered.map((e, idx) => {
              const active = idx === highlight;
              // Section header when the category changes (grouped display, #12).
              const showHeader = idx === 0 || filtered[idx - 1].category !== e.category;
              return (
                <React.Fragment key={e.id}>
                  {showHeader && (
                    <li className={`px-3.5 pb-1 text-[11px] text-ink-3 ${idx === 0 ? "pt-1.5" : "pt-2.5"}`}>
                      {CATEGORY_LABEL[e.category]}
                    </li>
                  )}
                  <li
                    data-idx={idx}
                    onMouseEnter={() => setHighlight(idx)}
                    onClick={() => activate(e)}
                    className={`flex h-8 cursor-pointer items-center gap-2.5 px-3.5 text-[12.5px] ${
                      active ? "bg-accent-soft" : ""
                    }`}
                  >
                    <CategoryGlyph category={e.category} />
                    <div className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span className={`shrink-0 truncate ${e.category === "stock" ? "font-mono font-medium" : "font-medium"} text-ink`}>
                        {e.label}
                      </span>
                      {e.subtitle && (
                        <span className="min-w-0 truncate text-[11.5px] text-ink-3">{e.subtitle}</span>
                      )}
                    </div>
                    {e.price != null && (
                      <span className="shrink-0 font-mono text-[12px] tabular-nums text-ink-2">{e.price.toFixed(2)}</span>
                    )}
                    {e.score != null && (
                      <span className="shrink-0 font-mono text-[12px] tabular-nums text-ink">{e.score.toFixed(1)}<span className="text-ink-faint">/41</span></span>
                    )}
                    {active && (
                      <kbd className="shrink-0 rounded border border-line bg-surface px-1 py-px font-mono text-[10px] text-ink-3">Enter</kbd>
                    )}
                  </li>
                </React.Fragment>
              );
            })
          )}
        </ul>

        <div className="flex h-8 items-center gap-3 border-t border-line-soft px-3.5 text-[11px] text-ink-3">
          <span><kbd className="rounded border border-line px-1 py-px font-mono text-[10px]">↑</kbd> <kbd className="rounded border border-line px-1 py-px font-mono text-[10px]">↓</kbd> navigate</span>
          <span><kbd className="rounded border border-line px-1 py-px font-mono text-[10px]">Enter</kbd> open</span>
          <span className="ml-auto"><kbd className="rounded border border-line px-1 py-px font-mono text-[10px]">⌘K</kbd> toggle</span>
        </div>
      </div>
    </div>
  );
}

/** Row glyph — one 14px stroke icon in ink-3, no tinted chip. */
function CategoryGlyph({ category }: { category: Entry["category"] }) {
  const name = category === "stock" ? "trend" : category === "action" ? "spark" : "list";
  return <AppIcon name={name} size={14} className="shrink-0 text-ink-3" />;
}
