"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { QuickAddStock } from "./QuickAddStock";
import { CommandPalette } from "./CommandPalette";
import { NotificationTray } from "./NotificationTray";
import { useStocks } from "@/app/lib/StockContext";
import { useNotifications } from "@/app/lib/NotificationsContext";

/**
 * Consolidated navigation (redesign/streamline):
 *  - FOUR top tabs — Brief / Portfolio / Ideas / Research — plus an "Ask"
 *    action (Chat) and a "More" overflow (Appendix, Client Report,
 *    Methodology, Health). Every route survives; only grouping changed.
 *  - Mobile: the 11-item hamburger is replaced by a fixed bottom tab bar
 *    (Brief / Portfolio / Ideas / Research / More) with 44px+ targets.
 *  - The permanent keyboard-hint footer strip is gone; shortcuts live in a
 *    "?" overlay, and the three health chips collapse into one status dot
 *    that only turns amber/red when something is actually wrong.
 */

type HealthStatus = "ok" | "warning" | "critical" | "unknown";

type BackupHealth = {
  ok: boolean;
  status?: HealthStatus;
  ageHours?: number | null;
  lastBackupAt?: string | null;
};
type EstimatesHealth = {
  ok: boolean;
  status?: HealthStatus;
  ageHours?: number | null;
  lastRunAt?: string | null;
  resolvedCount?: number;
  updatedCount?: number;
};
type AnthropicStatus = { state: "ok" | "credit_exhausted"; at: string; detail?: string } | null;

function ageLabel(ageHours: number | null | undefined): string {
  if (ageHours == null) return "none";
  if (ageHours < 1) return "<1h";
  if (ageHours < 48) return `${Math.round(ageHours)}h`;
  return `${Math.round(ageHours / 24)}d`;
}

/**
 * One status dot for the whole system (backup cron, FactSet estimates
 * refresh, Anthropic credits). Green dot = everything checked out; amber /
 * pulsing red = the worst signal. Click for a detail popover. Replaces the
 * three always-on chips in the old footer strip — same polling, same
 * thresholds, a fraction of the chrome.
 */
function SystemHealthDot() {
  const [backup, setBackup] = useState<BackupHealth | null>(null);
  const [estimates, setEstimates] = useState<EstimatesHealth | null>(null);
  const [anthropic, setAnthropic] = useState<AnthropicStatus>(null);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch("/api/admin/backup-health")
        .then((r) => r.json())
        .then((d: BackupHealth) => { if (alive) setBackup(d); })
        .catch(() => {});
      fetch("/api/admin/estimates-health")
        .then((r) => r.json())
        .then((d: EstimatesHealth) => { if (alive) setEstimates(d); })
        .catch(() => {});
      fetch("/api/anthropic-status")
        .then((r) => r.json())
        .then((d: { status: AnthropicStatus }) => { if (alive) setAnthropic(d.status); })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 10 * 60 * 1000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const backupStatus: HealthStatus = !backup || backup.ok === false ? "unknown" : backup.status ?? "ok";
  const estimatesStatus: HealthStatus = !estimates || estimates.ok === false ? "unknown" : estimates.status ?? "ok";
  const anthropicBad = anthropic?.state === "credit_exhausted";

  const worst: HealthStatus | "credit" =
    anthropicBad ? "credit"
    : backupStatus === "critical" || estimatesStatus === "critical" ? "critical"
    : backupStatus === "warning" || estimatesStatus === "warning" ? "warning"
    : "ok";

  const dotCls =
    worst === "ok" ? "bg-pos"
    : worst === "warning" ? "bg-warn"
    : "bg-neg animate-pulse";

  const rows: { label: string; value: string; status: HealthStatus | "credit-bad" | "credit-ok" }[] = [
    { label: "Nightly backup", value: backupStatus === "unknown" ? "unknown" : `last ${ageLabel(backup?.ageHours)} ago`, status: backupStatus },
    { label: "FactSet estimates", value: estimatesStatus === "unknown" ? "unknown" : `last ${ageLabel(estimates?.ageHours)} ago`, status: estimatesStatus },
    { label: "Anthropic credits", value: anthropicBad ? "EXHAUSTED — AI features blocked" : "ok", status: anthropicBad ? "credit-bad" : "credit-ok" },
  ];

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-label="System health"
        title="System health — backups, estimate refresh, Anthropic credits"
        className="flex items-center justify-center w-8 h-8 rounded-control border border-line bg-surface hover:bg-surface-hover transition-colors"
      >
        <span className={`inline-block w-2 h-2 rounded-full ${dotCls}`} />
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-50 w-72 rounded-card border border-line bg-surface p-3 shadow-card">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-bold text-ink">System health</span>
            <Link href="/admin/health" onClick={() => setOpen(false)} className="text-[11px] font-medium text-accent hover:underline">
              Full health page →
            </Link>
          </div>
          {rows.map((r) => {
            const bad = r.status === "critical" || r.status === "credit-bad";
            const warn = r.status === "warning";
            return (
              <div key={r.label} className="flex items-center justify-between gap-2 border-t border-line-soft py-1.5 text-xs">
                <span className="text-ink-2">{r.label}</span>
                <span className={`font-mono ${bad ? "font-bold text-neg" : warn ? "font-semibold text-warn" : "text-ink-3"}`}>{r.value}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** "?" keyboard-shortcut overlay — replaces the permanent footer strip. */
function ShortcutsOverlay({ open, onClose, onStockPage }: { open: boolean; onClose: () => void; onStockPage: boolean }) {
  if (!open) return null;
  const rows: [string, string][] = [
    ["⌘/Win + ← →", "Switch top tabs"],
    ["Shift + ← →", "Switch segments within a tab"],
    ["⌘/Ctrl + K", "Search / command palette"],
    ["Shift + A", "Add a stock"],
    ["?", "This overlay"],
  ];
  if (onStockPage) rows.push(["⌥/Alt + ← →", "Previous / next stock"]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/30 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-card border border-line bg-surface p-5 shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-ink">Keyboard shortcuts</h2>
          <button onClick={onClose} aria-label="Close" className="text-ink-3 hover:text-ink">✕</button>
        </div>
        {rows.map(([keys, desc]) => (
          <div key={keys} className="flex items-center justify-between border-t border-line-soft py-2 text-sm">
            <kbd className="rounded bg-surface-2 border border-line px-1.5 py-0.5 text-[11px] text-ink-2">{keys}</kbd>
            <span className="text-ink-2">{desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// The four top-level tabs. Everything else lives one segment click inside
// them, or under the More overflow. Routes are unchanged.
const tabs = [
  { label: "Brief", href: "/brief" },
  { label: "Portfolio", href: "/" },
  { label: "Ideas", href: "/synthesis" },
  { label: "Research", href: "/research" },
];

const MORE_LINKS = [
  { label: "Ask (Chat)", href: "/chat" },
  { label: "Appendix", href: "/appendix" },
  { label: "Client Report", href: "/client-report" },
  { label: "Methodology", href: "/methodology" },
  { label: "Health", href: "/admin/health" },
];

/** Routes that belong under a tab but aren't that tab's own href. */
const TAB_ALIASES: Record<string, string> = {
  // Portfolio segments
  "/scoring": "Portfolio",
  "/portfolio": "Portfolio",
  "/pim-model": "Portfolio",
  "/aa-performance": "Portfolio",
  "/attribution": "Portfolio",
  "/risk": "Portfolio",
  "/thesis": "Portfolio",
  "/journal": "Portfolio",
  // Ideas segments
  "/conviction": "Ideas",
  "/screener": "Ideas",
  "/radar": "Ideas",
  "/setups": "Ideas",
  "/factor-lab": "Ideas",
  // Research segments
  "/inbox": "Research",
  // Brief segments
  "/hedging": "Brief",
};

/** Bottom-bar icons (stroke SVGs, one style). */
function TabIcon({ tab, className }: { tab: string; className?: string }) {
  const common = { className, fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, viewBox: "0 0 24 24" };
  switch (tab) {
    case "Brief":
      return <svg {...common}><path d="M4 5h16v14H4z" /><path d="M8 9h8M8 13h5" /></svg>;
    case "Portfolio":
      return <svg {...common}><path d="M4 19V9M10 19V5M16 19v-7M22 19H2" /></svg>;
    case "Ideas":
      return <svg {...common}><path d="M12 3v3M12 18v3M3 12h3M18 12h3M6.2 6.2l2.1 2.1M15.7 15.7l2.1 2.1M17.8 6.2l-2.1 2.1M8.3 15.7l-2.1 2.1" /><circle cx="12" cy="12" r="3" /></svg>;
    case "Research":
      return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>;
    default:
      return <svg {...common}><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg>;
  }
}

export function Navigation() {
  const pathname = usePathname();
  const router = useRouter();
  const [moreOpen, setMoreOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Transient inline confirmation on the Refresh button — replaces the
  // success toast (which still lands in the tray as a quiet event).
  const [refreshDone, setRefreshDone] = useState<string | null>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const { refreshAllPrices, loading: stocksLoading } = useStocks();
  const { notify } = useNotifications();

  // Fast global price refresh — single batched /api/prices call across
  // every ticker in pm:stocks AND every ticker referenced in the
  // Research blob. The heavier deep-refresh stays on the Dashboard.
  const handleGlobalRefresh = async () => {
    if (refreshing) return;
    if (stocksLoading) {
      notify({
        level: "info",
        title: "Still loading…",
        message: "Holdings are still hydrating from Redis. Try again in a second.",
        source: "Global refresh",
      });
      return;
    }
    setRefreshing(true);
    try {
      const { updated, total, missing } = await refreshAllPrices();
      const MAX_LISTED = 10;
      const missingLabel = missing.length === 0
        ? ""
        : missing.length <= MAX_LISTED
          ? `Didn't refresh: ${missing.join(", ")}`
          : `Didn't refresh: ${missing.slice(0, MAX_LISTED).join(", ")} (+${missing.length - MAX_LISTED} more)`;

      if (total === 0) {
        notify({ level: "info", title: "Nothing to refresh", message: "No stocks, ETFs, or Research tickers found.", source: "Global refresh" });
      } else if (updated === 0 && missing.length === total) {
        notify({ level: "error", title: "Refresh failed", message: missingLabel || "All tickers came back empty from Yahoo.", source: "Global refresh" });
      } else if (missing.length === 0) {
        notify({ level: "success", title: "Prices refreshed", message: `${updated} of ${total} updated · nothing missing`, source: "Global refresh", quiet: true });
        setRefreshDone(`✓ ${updated}/${total}`);
        setTimeout(() => setRefreshDone(null), 4000);
      } else {
        notify({ level: "warn", title: "Prices refreshed (with gaps)", message: `${updated} of ${total} updated · ${missingLabel}`, source: "Global refresh" });
      }
    } catch (err) {
      notify({ level: "error", title: "Refresh failed", message: err instanceof Error ? err.message : String(err), source: "Global refresh" });
    } finally {
      setRefreshing(false);
    }
  };

  // Close the More dropdown on outside click.
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [moreOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Cmd/Ctrl+K → Command Palette, allowed even inside text fields.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }

      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable) return;
      }

      // ? → shortcuts overlay.
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }

      // Shift+A → Quick-Add Stock modal.
      if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "A" || e.key === "a")) {
        e.preventDefault();
        setQuickAddOpen(true);
        return;
      }

      // Cmd/Win + Left/Right → move one tab at a time, wrapping.
      if (!e.metaKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      let idx = tabs.findIndex((tab) => tab.href === pathname);
      if (idx < 0) {
        const alias = pathname.startsWith("/stock/") ? "Portfolio" : TAB_ALIASES[pathname];
        idx = tabs.findIndex((tab) => tab.label === (alias ?? "Portfolio"));
      }
      const delta = e.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(idx + delta + tabs.length) % tabs.length];
      e.preventDefault();
      router.push(next.href);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pathname, router]);

  const isMoreRoute = MORE_LINKS.some((l) => l.href === pathname);
  const activeTab = isMoreRoute
    ? "More"
    : pathname.startsWith("/stock/")
      ? "Portfolio"
      : TAB_ALIASES[pathname] ??
        tabs.find((t) => t.href === pathname)?.label ??
        "Portfolio";

  return (
    <>
    <header className="sticky top-0 z-40 bg-surface text-ink border-b border-line print:hidden">
      <div className="mx-auto flex items-center justify-between px-4 py-2.5 md:px-6">
        {/* Branding */}
        <div className="flex items-center gap-2.5 shrink-0">
          <span className="grid h-6 w-6 place-items-center rounded-[7px] bg-accent text-[12px] font-bold text-white">P</span>
          <h1 className="text-[15px] font-semibold tracking-tight text-ink whitespace-nowrap">PIM Dashboard</h1>
        </div>

        {/* Mobile action cluster — nav itself lives in the bottom tab bar. */}
        <div className="md:hidden flex items-center gap-1">
          <NotificationTray />
          <button
            onClick={handleGlobalRefresh}
            disabled={refreshing}
            aria-label="Refresh prices"
            title="Refresh prices"
            className="flex items-center justify-center w-9 h-9 rounded-control border border-line bg-surface text-ink-2 hover:bg-surface-hover hover:text-ink transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <svg className={`w-5 h-5 ${refreshing ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" /></svg>
          </button>
          <button
            onClick={() => setQuickAddOpen(true)}
            aria-label="Add stock"
            title="Add stock"
            className="flex items-center justify-center w-9 h-9 rounded-control bg-accent hover:bg-accent-ink transition-colors text-white"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
          </button>
        </div>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-0.5 shrink-0 ml-4">
          {tabs.map((tab) => {
            const isActive = tab.label === activeTab;
            return (
              <Link
                key={tab.label}
                href={tab.href}
                className={`px-3 py-1.5 text-[13px] transition-colors whitespace-nowrap border-b-2 -mb-px ${
                  isActive
                    ? "text-ink font-semibold border-accent"
                    : "text-ink-2 hover:text-ink border-transparent"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}

          {/* More overflow */}
          <div ref={moreRef} className="relative">
            <button
              onClick={() => setMoreOpen(!moreOpen)}
              aria-expanded={moreOpen}
              className={`px-3 py-1.5 text-[13px] transition-colors whitespace-nowrap border-b-2 -mb-px ${
                activeTab === "More"
                  ? "text-ink font-semibold border-accent"
                  : "text-ink-2 hover:text-ink border-transparent"
              }`}
            >
              More ⋯
            </button>
            {moreOpen && (
              <div className="absolute left-0 top-9 z-50 w-48 rounded-card border border-line bg-surface py-1 shadow-card">
                {MORE_LINKS.map((l) => (
                  <Link
                    key={l.href}
                    href={l.href}
                    onClick={() => setMoreOpen(false)}
                    className={`block px-3.5 py-2 text-[13px] transition-colors ${
                      pathname === l.href ? "bg-accent-soft text-accent-ink font-semibold" : "text-ink-2 hover:bg-surface-hover hover:text-ink"
                    }`}
                  >
                    {l.label}
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Search + Ask + Notifications + Refresh + Quick-Add + Health */}
          <div className="ml-2 flex items-center gap-1.5">
            <button
              onClick={() => setPaletteOpen(true)}
              aria-label="Search"
              title="Search (⌘K)"
              className="flex items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 py-1.5 text-[12px] text-ink-3 hover:bg-surface-hover hover:text-ink transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.34-4.34M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z" /></svg>
              <kbd className="rounded bg-surface-2 border border-line px-1 py-px text-[10px] text-ink-3">⌘K</kbd>
            </button>
            <Link
              href="/chat"
              title="Ask — chat with the book in context"
              className="flex items-center gap-1 rounded-control border border-accent-border bg-accent-soft px-2.5 py-1.5 text-[13px] font-semibold !text-accent-ink hover:bg-accent hover:!text-white transition-colors whitespace-nowrap"
            >
              Ask
            </Link>
            <NotificationTray />
            <button
              onClick={handleGlobalRefresh}
              disabled={refreshing}
              className="flex items-center gap-1 rounded-control border border-line bg-surface text-ink-2 hover:bg-surface-hover hover:text-ink disabled:opacity-60 disabled:cursor-not-allowed px-2.5 py-1.5 text-[13px] font-medium transition-colors whitespace-nowrap"
              title="Refresh prices for every stock, ETF, and fund"
            >
              <svg className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" /></svg>
              {refreshing ? "Refreshing..." : refreshDone ? <span className="text-pos">{refreshDone}</span> : "Refresh"}
            </button>
            <button
              onClick={() => setQuickAddOpen(true)}
              className="flex items-center gap-1 rounded-control bg-accent hover:bg-accent-ink px-2.5 py-1.5 text-[13px] font-semibold text-white transition-colors whitespace-nowrap"
              title="Add a stock (Shift+A)"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
              Add
            </button>
            <SystemHealthDot />
            <button
              onClick={() => setShortcutsOpen(true)}
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (?)"
              className="flex items-center justify-center w-8 h-8 rounded-control border border-line bg-surface text-[12px] text-ink-3 hover:bg-surface-hover hover:text-ink transition-colors"
            >
              ?
            </button>
          </div>
        </nav>
      </div>

      <QuickAddStock open={quickAddOpen} onClose={() => setQuickAddOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onTriggerQuickAdd={() => setQuickAddOpen(true)}
      />
      <ShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} onStockPage={pathname.startsWith("/stock/")} />
    </header>

    {/* Mobile bottom tab bar. Fixed; content clearance comes from a body
        padding rule in globals.css (mobile only). */}
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 grid grid-cols-5 border-t border-line bg-surface print:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      {tabs.map((tab) => {
        const isActive = tab.label === activeTab;
        return (
          <Link
            key={tab.label}
            href={tab.href}
            className={`flex h-[60px] flex-col items-center justify-center gap-0.5 ${isActive ? "!text-accent" : "!text-ink-3"}`}
          >
            <TabIcon tab={tab.label} className="w-5 h-5" />
            <span className={`text-[10px] ${isActive ? "font-semibold" : ""}`}>{tab.label}</span>
          </Link>
        );
      })}
      <button
        onClick={() => setMobileMoreOpen(!mobileMoreOpen)}
        className={`flex h-[60px] flex-col items-center justify-center gap-0.5 ${activeTab === "More" ? "text-accent" : "text-ink-3"}`}
        aria-label="More"
      >
        <TabIcon tab="More" className="w-5 h-5" />
        <span className={`text-[10px] ${activeTab === "More" ? "font-semibold" : ""}`}>More</span>
      </button>
    </nav>

    {/* Mobile More sheet */}
    {mobileMoreOpen && (
      <div className="md:hidden fixed inset-0 z-50 bg-ink/30" onClick={() => setMobileMoreOpen(false)}>
        <div
          className="absolute bottom-0 inset-x-0 rounded-t-2xl border-t border-line bg-surface p-4 pb-8"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 24px)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line" />
          {MORE_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setMobileMoreOpen(false)}
              className={`block rounded-control px-4 py-3 text-sm font-semibold transition-colors ${
                pathname === l.href ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:text-ink hover:bg-surface-hover"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </div>
      </div>
    )}
    </>
  );
}
