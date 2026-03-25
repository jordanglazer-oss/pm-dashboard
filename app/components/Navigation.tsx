"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { label: "Brief", href: "/brief" },
  { label: "Dashboard", href: "/" },
  { label: "Scoring", href: "/scoring" },
  { label: "Research", href: "/research" },
  { label: "AA & Performance", href: "/aa-performance" },
];

export function Navigation() {
  const pathname = usePathname();

  const activeTab = pathname.startsWith("/stock/") || pathname === "/scoring"
    ? "Scoring"
    : pathname === "/brief"
    ? "Brief"
    : pathname === "/research"
    ? "Research"
    : pathname === "/aa-performance"
    ? "AA & Performance"
    : "Dashboard";

  return (
    <header className="bg-slate-900 text-white">
      <div className="mx-auto flex items-center justify-between px-4 py-3 md:px-8">
        {/* Branding */}
        <div className="flex items-center gap-3 shrink-0">
          <h1 className="text-lg font-bold tracking-tight whitespace-nowrap">PIM Scoring System</h1>
          <span className="hidden lg:inline text-sm text-slate-400 whitespace-nowrap">
            Equity Evaluation &middot; Shared Team Data &middot; Max 40
          </span>
        </div>

        {/* Tabs + avatar */}
        <nav className="flex items-center gap-1 shrink-0 ml-4">
          {tabs.map((tab) => {
            const isActive = tab.label === activeTab;
            return (
              <Link
                key={tab.label}
                href={tab.href}
                className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors whitespace-nowrap ${
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
    </header>
  );
}
