"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { QuickAddStock } from "./QuickAddStock";

const tabs = [
  { label: "Brief", href: "/brief" },
  { label: "Dashboard", href: "/" },
  { label: "Chat", href: "/chat" },
  { label: "PIM Model", href: "/pim-model" },
  { label: "Positioning", href: "/portfolio" },
  { label: "Screener", href: "/screener" },
  { label: "Research", href: "/research" },
  { label: "AA & Perf", href: "/aa-performance" },
  { label: "Hedging", href: "/hedging" },
  { label: "Appendix", href: "/appendix" },
  { label: "Inbox", href: "/inbox" },
];

export function Navigation() {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);

  // Cmd/Win + Left/Right arrow → move one tab at a time, wrapping at the ends.
  // The browser's default Cmd+Left/Right is history back/forward, which on this
  // app jumps the user multiple tabs at once because every tab click pushes a
  // history entry. preventDefault overrides that so the shortcut becomes a
  // single-tab step. `metaKey` covers both macOS Cmd and Windows Win key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack any shortcut inside text inputs / textareas / contenteditable.
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable) return;
      }

      // Shift+A → open Quick-Add Stock modal. Picked because it doesn't
      // collide with any browser default and is reachable one-handed.
      if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "A" || e.key === "a")) {
        e.preventDefault();
        setQuickAddOpen(true);
        return;
      }

      // Cmd/Win + Left/Right arrow → move one tab at a time, wrapping at the ends.
      // The browser's default Cmd+Left/Right is history back/forward, which on this
      // app jumps the user multiple tabs at once because every tab click pushes a
      // history entry. preventDefault overrides that so the shortcut becomes a
      // single-tab step. `metaKey` covers both macOS Cmd and Windows Win key.
      if (!e.metaKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      // Find current tab index — fall back to Dashboard for /stock/* etc.
      let idx = tabs.findIndex((tab) => tab.href === pathname);
      if (idx < 0) {
        idx = tabs.findIndex((tab) => tab.label === "Dashboard");
      }
      const delta = e.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(idx + delta + tabs.length) % tabs.length];
      e.preventDefault();
      router.push(next.href);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pathname, router]);

  // /stock/[ticker] detail pages and the legacy /scoring route both live under
  // the consolidated Dashboard tab since scoring was folded into Dashboard.
  const activeTab = pathname.startsWith("/stock/") || pathname === "/scoring"
    ? "Dashboard"
    : pathname === "/brief"
    ? "Brief"
    : pathname === "/pim-model"
    ? "PIM Model"
    : pathname === "/portfolio"
    ? "Positioning"
    : pathname === "/research"
    ? "Research"
    : pathname === "/screener"
    ? "Screener"
    : pathname === "/aa-performance"
    ? "AA & Perf"
    : pathname === "/hedging"
    ? "Hedging"
    : pathname === "/appendix"
    ? "Appendix"
    : pathname === "/chat"
    ? "Chat"
    : pathname === "/inbox"
    ? "Inbox"
    : "Dashboard";

  return (
    <header className="bg-slate-900 text-white">
      <div className="mx-auto flex items-center justify-between px-4 py-2 md:px-6">
        {/* Branding */}
        <div className="flex items-center gap-3 shrink-0">
          <h1 className="text-base font-bold tracking-tight whitespace-nowrap">PIM Dashboard</h1>
        </div>

        {/* Hamburger button — mobile only */}
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="md:hidden flex items-center justify-center w-9 h-9 rounded-lg hover:bg-slate-800 transition-colors"
          aria-label="Toggle menu"
        >
          {menuOpen ? (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" /></svg>
          )}
        </button>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-0.5 shrink-0 ml-4">
          {tabs.map((tab) => {
            const isActive = tab.label === activeTab;
            return (
              <Link
                key={tab.label}
                href={tab.href}
                className={`rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors whitespace-nowrap ${
                  isActive
                    ? "bg-blue-600 text-white"
                    : "text-slate-300 hover:text-white hover:bg-slate-800"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
          {/* Quick-Add Stock — visible from every page. */}
          <button
            onClick={() => setQuickAddOpen(true)}
            className="ml-2 flex items-center gap-1 rounded-md bg-emerald-600 hover:bg-emerald-700 px-2.5 py-1.5 text-[13px] font-semibold text-white transition-colors whitespace-nowrap"
            title="Add a stock (Shift+A)"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
            Add
          </button>
        </nav>
      </div>

      {/* Mobile dropdown menu */}
      {menuOpen && (
        <nav className="md:hidden border-t border-slate-700 px-4 pb-3 pt-1">
          {tabs.map((tab) => {
            const isActive = tab.label === activeTab;
            return (
              <Link
                key={tab.label}
                href={tab.href}
                onClick={() => setMenuOpen(false)}
                className={`block rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors ${
                  isActive
                    ? "bg-blue-600 text-white"
                    : "text-slate-300 hover:text-white hover:bg-slate-800"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
          <button
            onClick={() => { setMenuOpen(false); setQuickAddOpen(true); }}
            className="mt-1 w-full flex items-center justify-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
            Add Stock
          </button>
        </nav>
      )}
      {/* Keyboard shortcut hint — desktop only, subtle */}
      <div className="hidden md:flex items-center justify-center gap-4 bg-slate-800 px-4 py-0.5 text-[10px] text-slate-500">
        <span><kbd className="rounded bg-slate-700 px-1 py-px text-slate-400">⌘/Win</kbd> + <kbd className="rounded bg-slate-700 px-1 py-px text-slate-400">←→</kbd> switch tabs</span>
        <span><kbd className="rounded bg-slate-700 px-1 py-px text-slate-400">Shift</kbd> + <kbd className="rounded bg-slate-700 px-1 py-px text-slate-400">A</kbd> add stock</span>
        {pathname.startsWith("/stock/") && (
          <span><kbd className="rounded bg-slate-700 px-1 py-px text-slate-400">⌥/Alt</kbd> + <kbd className="rounded bg-slate-700 px-1 py-px text-slate-400">←→</kbd> switch stocks</span>
        )}
        <Link href="/admin/health" className="ml-auto text-slate-500 hover:text-slate-300 transition-colors">
          health
        </Link>
      </div>
      <QuickAddStock open={quickAddOpen} onClose={() => setQuickAddOpen(false)} />
    </header>
  );
}
