"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

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
];

export function Navigation() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

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
        </nav>
      )}
    </header>
  );
}
