"use client";

import Link from "next/link";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { useStocks } from "@/app/lib/StockContext";

/** Version (profile) options for the shared header selector — the 4 named
 *  sleeves from the handoff. Values match PimProfileType. */
const VERSIONS: { value: string; label: string }[] = [
  { value: "conservative", label: "Conservative" },
  { value: "balanced", label: "Balanced" },
  { value: "growth", label: "Growth" },
  { value: "allEquity", label: "All-Equity" },
];

/**
 * Segmented switcher for the consolidated "Portfolio" hub. The redesign merges
 * the old Dashboard + Positioning + PIM Model tabs into one Portfolio tab; this
 * bar navigates between the segments. Routes are UNCHANGED (deep-linking
 * preserved) — each segment just links to the page that already renders that
 * content. Self-hides on any non-hub route so it only appears within the hub.
 */

// X-ray was removed as a distinct segment — Portfolio X-ray already lives on the
// Positioning page, so a separate segment was redundant. Positioning owns it.
const SEGMENTS: { label: string; href: string }[] = [
  { label: "Rankings", href: "/" },
  { label: "Positioning", href: "/portfolio" },
  { label: "Models", href: "/pim-model" },
  { label: "Allocation", href: "/aa-performance" },
];

export function PortfolioTabs() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { pimModels, stocks } = useStocks();

  const isHub =
    pathname === "/" ||
    pathname === "/scoring" ||
    pathname.startsWith("/stock/") ||
    pathname.startsWith("/portfolio") ||
    pathname === "/pim-model" ||
    pathname === "/aa-performance";
  if (!isHub) return null;

  // Which segment "owns" the current route (X-ray shares /portfolio with
  // Positioning; it's an in-page anchor, so Positioning is the active one there).
  const activeHref =
    pathname === "/pim-model" ? "/pim-model"
    : pathname === "/aa-performance" ? "/aa-performance"
    : pathname.startsWith("/portfolio") ? "/portfolio"
    : "/"; // "/", "/scoring", "/stock/*"

  // Shared Model (group) + Version (profile) live in the URL so they flow
  // across every segment and stay deep-linkable.
  const groups = pimModels?.groups ?? [];
  const model = searchParams.get("model") || groups[0]?.id || "pim";
  const version = searchParams.get("version") || "allEquity"; // matches Positioning's default
  const setParam = (key: string, val: string) => {
    const p = new URLSearchParams(Array.from(searchParams.entries()));
    p.set(key, val);
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };

  const holdingsCount = (stocks ?? []).filter((s) => s.bucket === "Portfolio").length;

  return (
    <div className="bg-surface border-b border-line print:hidden">
      <div className="mx-auto max-w-7xl px-4 md:px-8 pt-3">
        {/* Title row: obvious page title + shared Model/Version selectors */}
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-ink leading-none">Portfolio</h1>
            <p className="mt-1 text-xs text-ink-3">{holdingsCount} holdings</p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <label className="flex items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Model</span>
              <select
                value={model}
                onChange={(e) => setParam("model", e.target.value)}
                className="rounded-control border border-line bg-surface px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
              >
                {groups.length === 0 ? (
                  <option value="pim">PIM</option>
                ) : (
                  groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)
                )}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Version</span>
              <select
                value={version}
                onChange={(e) => setParam("version", e.target.value)}
                className="rounded-control border border-line bg-surface px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
              >
                {VERSIONS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
              </select>
            </label>
          </div>
        </div>

        {/* Segment row */}
        <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-2">
          <div className="flex items-center gap-0.5 rounded-control border border-line bg-surface-2 p-0.5 shrink-0">
            {SEGMENTS.map((seg) => {
              const isActive = seg.href === activeHref;
              return (
                <Link
                  key={seg.label}
                  href={seg.href}
                  className={`rounded-[6px] px-3 py-1 text-[13px] whitespace-nowrap transition-colors ${
                    isActive
                      ? "bg-surface text-ink font-semibold shadow-sm"
                      : "text-ink-2 hover:text-ink"
                  }`}
                >
                  {seg.label}
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
