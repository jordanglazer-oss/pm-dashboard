"use client";

import { TAB_ALIASES } from "@/app/lib/hubs";
import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { QuickAddStock } from "./QuickAddStock";
import { CommandPalette } from "./CommandPalette";
import { NotificationTray } from "./NotificationTray";
import { AppIcon } from "./AppIcon";
import { NAV_GROUPS, NAV_UTILITIES, SYSTEM_LINKS, activeNavKey, navCrumb } from "@/app/lib/nav-model";
import { useStocks } from "@/app/lib/StockContext";
import { useNotifications } from "@/app/lib/NotificationsContext";

/**
 * Workspace shell (redesign/workspace):
 *  - A 200px LEFT RAIL lists every destination under Today / Portfolio /
 *    Ideas / Research, with Ask + Client report + System in its footer.
 *    No "More" menu and no per-hub segment rows: every page is one click
 *    from every other. Routes are unchanged from the streamline nav.
 *  - A 48px TOP BAR carries the crumb + page title, the ⌘K search, the
 *    canonical regime read, price refresh, notifications and Add.
 *  - Mobile keeps the bottom tab bar (Brief / Portfolio / Ideas / Research /
 *    More) and gains a drawer copy of the rail behind the top-bar menu button.
 *  - Shortcuts stay in the "?" overlay; the three health signals stay one
 *    status dot, now on the rail's System row.
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
        title="System — backups, estimate refresh, Anthropic credits, methodology, appendix"
        className={`flex h-7 w-full items-center gap-2.5 rounded-[5px] px-2.5 text-[13px] transition-colors hover:bg-surface-hover ${open ? "bg-surface-hover text-ink" : "text-ink-2"}`}
      >
        <AppIcon name="gear" size={15} className="text-ink-3" />
        <span>System</span>
        <span className={`ml-auto inline-block h-[7px] w-[7px] rounded-full ${dotCls}`} />
      </button>
      {open && (
        <div className="absolute bottom-9 left-0 z-50 w-64 rounded-card border border-line bg-surface p-3 shadow-card">
          <div className="mb-1 text-[12px] font-semibold text-ink">System health</div>
          {rows.map((r) => {
            const bad = r.status === "critical" || r.status === "credit-bad";
            const warn = r.status === "warning";
            return (
              <div key={r.label} className="flex items-center justify-between gap-2 border-t border-line-soft py-1.5 text-[12px]">
                <span className="text-ink-2">{r.label}</span>
                <span className={`font-mono text-[11.5px] ${bad ? "font-semibold text-neg" : warn ? "font-medium text-warn" : "text-ink-3"}`}>{r.value}</span>
              </div>
            );
          })}
          <div className="mt-2 flex flex-col border-t border-line-soft pt-2">
            {SYSTEM_LINKS.map((l) => (
              <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className="rounded-[5px] px-2 py-1.5 text-[12.5px] text-ink-2 transition-colors hover:bg-surface-hover hover:text-ink">
                {l.label}
              </Link>
            ))}
          </div>
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
// Hub membership lives in app/lib/hubs.ts (shared with the back crumb).

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
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // The canonical regime label (pm:market-regime composite) for the top bar —
  // shown once here, with its dial on the Brief. Read-only, cached GET.
  const [regime, setRegime] = useState<{ label: string; score: number | null } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/market-regime", { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => {
          if (!alive) return;
          const label = j?.composite?.label;
          if (label === "Risk-On" || label === "Neutral" || label === "Risk-Off") {
            const sc = j?.composite?.score100;
            setRegime({ label, score: typeof sc === "number" ? Math.round(sc) : null });
          }
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 30 * 60 * 1000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  // Transient inline confirmation on the Refresh button — replaces the
  // success toast (which still lands in the tray as a quiet event).
  const [refreshDone, setRefreshDone] = useState<string | null>(null);
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

  useEffect(() => { setDrawerOpen(false); }, [pathname]);

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

  const crumb = navCrumb(pathname);
  const activeKey = activeNavKey(pathname);

  const rail = (onNavigate?: () => void) => (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line-soft px-4">
        <span className="grid h-[22px] w-[22px] place-items-center rounded-[5px] bg-ink text-[11px] font-bold text-white">P</span>
        <span className="text-[13px] font-semibold tracking-tight text-ink">PIM Workspace</span>
      </div>
      <div className="flex grow flex-col gap-0.5 overflow-y-auto px-1.5 pb-2 pt-0.5">
        {NAV_GROUPS.map((g) => (
          <div key={g.label} className="flex flex-col gap-px">
            <div className="px-2.5 pb-1 pt-3.5 text-[10.5px] font-semibold tracking-[0.04em] text-ink-3">{g.label}</div>
            {g.items.map((it) => {
              const on = it.key === activeKey;
              return (
                <Link
                  key={it.key}
                  href={it.href}
                  onClick={onNavigate}
                  aria-current={on ? "page" : undefined}
                  className={`flex h-7 items-center gap-2.5 rounded-[5px] px-2.5 text-[13px] transition-colors ${on ? "bg-accent-soft font-medium !text-accent-ink" : "!text-ink-2 hover:bg-surface-hover hover:!text-ink"}`}
                >
                  <AppIcon name={it.icon} size={15} className={on ? "" : "text-ink-3"} />
                  <span>{it.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-px border-t border-line-soft px-1.5 pb-2.5 pt-2">
        {NAV_UTILITIES.map((it) => {
          const on = it.key === activeKey;
          return (
            <Link
              key={it.key}
              href={it.href}
              onClick={onNavigate}
              className={`flex h-7 items-center gap-2.5 rounded-[5px] px-2.5 text-[13px] transition-colors ${on ? "bg-accent-soft font-medium !text-accent-ink" : "!text-ink-2 hover:bg-surface-hover hover:!text-ink"}`}
            >
              <AppIcon name={it.icon} size={15} className={on ? "" : "text-ink-3"} />
              <span>{it.label}</span>
            </Link>
          );
        })}
        <SystemHealthDot />
      </div>
    </>
  );

  return (
    <>
    {/* Desktop rail */}
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[200px] flex-col border-r border-line bg-surface md:flex print:hidden">
      {rail()}
    </aside>

    {/* Mobile drawer copy of the rail */}
    {drawerOpen && (
      <div className="md:hidden fixed inset-0 z-50 bg-ink/30 print:hidden" onClick={() => setDrawerOpen(false)}>
        <aside className="absolute inset-y-0 left-0 flex w-[240px] flex-col bg-surface shadow-card" onClick={(e) => e.stopPropagation()}>
          {rail(() => setDrawerOpen(false))}
        </aside>
      </div>
    )}

    {/* Top bar */}
    <header className="sticky top-0 z-30 border-b border-line bg-surface text-ink md:ml-[200px] print:hidden">
      <div className="flex h-12 items-center gap-3 px-3 md:gap-4 md:px-5">
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="Menu"
          className="md:hidden grid h-8 w-8 place-items-center rounded-control text-ink-2 hover:bg-surface-hover"
        >
          <AppIcon name="menu" size={18} />
        </button>

        <div className="flex shrink-0 items-baseline gap-2 md:min-w-[220px] md:shrink">
          <span className="hidden text-[12px] text-ink-3 md:inline">{crumb.group}</span>
          <span className="hidden text-[12px] text-ink-faint md:inline">/</span>
          <span className="truncate text-[14px] font-semibold tracking-tight text-ink">{crumb.title}</span>
        </div>

        <button
          onClick={() => setPaletteOpen(true)}
          aria-label="Search"
          title="Search (⌘K)"
          className="mx-auto flex h-[30px] w-full min-w-0 max-w-[360px] items-center gap-2 rounded-control border border-line bg-surface-2 px-2.5 text-[12.5px] text-ink-3 transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <AppIcon name="search" size={14} strokeWidth={2} />
          <span className="hidden grow truncate text-left sm:inline">Jump to a name, page or action</span>
          <kbd className="hidden rounded border border-line bg-surface px-1 py-px font-mono text-[10px] text-ink-3 sm:inline">⌘K</kbd>
        </button>

        <div className="flex shrink-0 items-center gap-2 md:min-w-[220px] md:justify-end md:gap-3.5">
          {regime && (
            <Link
              href="/brief"
              title="Canonical market regime — click for the dial"
              className="hidden items-center gap-1.5 text-[12px] !text-ink-2 hover:!text-ink lg:flex"
            >
              <span className={`inline-block h-[7px] w-[7px] rounded-full ${regime.label === "Risk-On" ? "bg-pos" : regime.label === "Risk-Off" ? "bg-neg" : "bg-warn"}`} />
              {regime.label}
              {regime.score != null && <span className="font-mono text-ink-3">{regime.score}</span>}
            </Link>
          )}
          <button
            onClick={handleGlobalRefresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-control px-1.5 py-1 text-[12px] text-ink-3 transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
            title="Refresh prices for every stock, ETF, and fund"
          >
            <AppIcon name="refresh" size={14} strokeWidth={2} className={refreshing ? "animate-spin" : ""} />
            <span className="hidden font-mono md:inline">{refreshing ? "Refreshing" : refreshDone ? <span className="text-pos">{refreshDone}</span> : "Refresh"}</span>
          </button>
          <NotificationTray />
          <button
            onClick={() => setQuickAddOpen(true)}
            className="flex h-7 items-center gap-1.5 rounded-control bg-ink px-2.5 pl-2 text-[12.5px] font-medium text-white transition-colors hover:bg-ink-2"
            title="Add a stock (Shift+A)"
          >
            <AppIcon name="plus" size={13} strokeWidth={2.25} />
            Add
          </button>
          <button
            onClick={() => setShortcutsOpen(true)}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            className="hidden h-7 w-7 place-items-center rounded-control text-ink-3 transition-colors hover:bg-surface-hover hover:text-ink md:grid"
          >
            <AppIcon name="help" size={15} />
          </button>
        </div>
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
