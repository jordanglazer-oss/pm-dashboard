"use client";

import React, { useEffect, useRef, useState } from "react";

/**
 * Brief command bar — the sticky header from the "sticky command bar" redesign.
 *
 * Consolidates what used to be three stacked rows (big title block, generated-at
 * + Regenerate, and the Brief/Daily Input toggle) into ONE sticky strip that
 * carries the day's verdict and the section rail. Everything that was in those
 * rows is still here; nothing was dropped.
 *
 * Layout follows the design: title + date · regime pill + composite counts +
 * distance-to-flip · section rail · Brief/Input toggle · Regenerate · time.
 * Sticky so the section rail and the regime read stay reachable while scrolling
 * a long brief.
 *
 * Responsive (the design is desktop-only): below lg the rail moves to its own
 * horizontally-scrollable row and the meta cluster wraps, so nothing overflows
 * on a phone.
 */

export type BriefSection = { id: string; label: string };

/** The five designed sections, in document order. */
export const BRIEF_SECTIONS: BriefSection[] = [
  { id: "s-decide", label: "Decide" },
  { id: "s-act", label: "Act" },
  { id: "s-board", label: "Board" },
  { id: "s-horizon", label: "Horizons" },
  { id: "s-narrative", label: "Narrative" },
];


function regimeTone(regime: string | undefined): string {
  if (regime === "Risk-Off") return "border-neg-border bg-neg-soft text-neg";
  if (regime === "Risk-On") return "border-pos-border bg-pos-soft text-pos";
  return "border-warn-border bg-warn-soft text-warn";
}

export function BriefCommandBar({
  date,
  generatedAt,
  regime,
  regimeScore,
  regimeSignals,
  boundaryGap,
  briefMode,
  onModeChange,
  onRegenerate,
  generating,
}: {
  date: string;
  generatedAt?: string;
  regime?: string;
  regimeScore?: number;
  regimeSignals?: string[];
  boundaryGap?: number;
  briefMode: "brief" | "input";
  onModeChange: (m: "brief" | "input") => void;
  onRegenerate: () => void;
  generating: boolean;
}) {
  // The nav's height is MEASURED, not assumed. It was hardcoded at 46px, but
  // the real header is taller (py-2.5 + button height + border), so the bar
  // tucked underneath it and the rail disappeared. A ResizeObserver keeps both
  // the bar's offset and the sections' scroll-margin correct even if the nav
  // wraps (narrow screens) or gains a row.
  const barRef = useRef<HTMLDivElement | null>(null);
  const [navH, setNavH] = useState(53);
  useEffect(() => {
    const nav = document.querySelector("header.sticky") as HTMLElement | null;
    if (!nav) return;
    const sync = () => {
      const h = Math.round(nav.getBoundingClientRect().height);
      setNavH(h);
      // Sections scroll-margin = both sticky bars, so a rail jump never lands
      // a heading underneath them.
      const barH = barRef.current ? Math.round(barRef.current.getBoundingClientRect().height) : 44;
      document.documentElement.style.setProperty("--brief-scroll-mt", `${h + barH + 12}px`);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(nav);
    if (barRef.current) ro.observe(barRef.current);
    return () => ro.disconnect();
  }, []);

  // Highlight the section currently in view. Uses IntersectionObserver so the
  // rail reflects scroll position without a scroll listener on every frame.
  const [active, setActive] = useState<string>(BRIEF_SECTIONS[0].id);
  useEffect(() => {
    if (briefMode !== "brief") return;
    const els = BRIEF_SECTIONS.map((s) => document.getElementById(s.id)).filter(
      (e): e is HTMLElement => e !== null,
    );
    if (!els.length) return;
    const obs = new IntersectionObserver(
      (entries) => {
        // The topmost intersecting section wins, so the rail doesn't flicker
        // between two sections that are both partly visible.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) setActive(visible[0].target.id);
      },
      { rootMargin: "-140px 0px -55% 0px", threshold: 0 },
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [briefMode]);

  const time = generatedAt
    ? new Date(generatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : null;

  // Composite counts from the signal list the brief already returns.
  const up = regimeSignals?.filter((s) => /risk-on/i.test(s)).length;
  const down = regimeSignals?.filter((s) => /risk-off/i.test(s)).length;
  const total = regimeSignals?.length;

  return (
    // Freeze-pane layering: the primary nav is sticky at top-0 (z-40); this bar
    // pins directly beneath it at the MEASURED nav height with a lower z so the
    // nav always wins. NOTE: this only works because the Brief's <main> uses
    // overflow-x-clip rather than -hidden; `hidden` would make it a scroll
    // container and kill sticky on every descendant.
    <div
      ref={barRef}
      style={{ top: navH }}
      className="sticky z-30 -mx-4 mb-4 border-b border-line bg-surface/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-surface/80"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2">
        {/* Title + date */}
        <div className="flex shrink-0 items-baseline gap-2.5">
          <h1 className="text-[17px] font-semibold tracking-[-0.02em] text-ink">Morning Brief</h1>
          <span className="font-mono text-[11px] text-ink-3">{date}</span>
        </div>

        <span className="hidden h-5 w-px shrink-0 bg-line sm:block" />

        {/* Regime verdict — the day's headline, always visible while scrolling */}
        {regime && (
          <div className="flex shrink-0 items-center gap-1.5">
            <span className={`inline-flex items-center rounded-pill border px-2.5 py-[3px] text-[11px] font-bold uppercase tracking-[0.04em] ${regimeTone(regime)}`}>
              {regime}
            </span>
            {total != null && total > 0 && (
              <span className="font-mono text-[11px] text-ink-3">
                {up}↑ {down}↓ / {total}
                {typeof regimeScore === "number" && ` · net ${regimeScore >= 0 ? "+" : ""}${regimeScore}`}
              </span>
            )}
            {typeof boundaryGap === "number" && boundaryGap > 0 && boundaryGap <= 3 && (
              <span className="inline-flex items-center rounded-pill bg-neg-soft px-2 py-[3px] text-[10px] font-semibold text-neg">
                {boundaryGap} from a flip
              </span>
            )}
          </div>
        )}

        {/* Section rail — desktop inline, mobile on its own scrollable row */}
        <nav className="ml-auto hidden items-center gap-0.5 lg:flex" aria-label="Brief sections">
          {BRIEF_SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className={`rounded-[6px] px-2.5 py-1 text-xs transition-colors ${
                active === s.id
                  ? "bg-accent-soft font-semibold text-accent"
                  : "text-ink-2 hover:bg-surface-hover hover:text-ink"
              }`}
            >
              {s.label}
            </a>
          ))}
        </nav>

        {/* Brief / Daily Input toggle */}
        <div className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-control border border-line bg-surface-2 p-0.5 lg:ml-0">
          {(["brief", "input"] as const).map((m) => (
            <button
              key={m}
              onClick={() => onModeChange(m)}
              className={`rounded-[6px] px-3 py-1 text-[13px] font-semibold transition-colors ${
                briefMode === m ? "bg-ink text-white shadow-sm" : "text-ink-2 hover:text-ink"
              }`}
            >
              {m === "brief" ? "Brief" : "Daily Input"}
            </button>
          ))}
        </div>

        <button
          onClick={onRegenerate}
          disabled={generating}
          title="Regenerate the brief from the current inputs"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-control bg-ink px-3 py-1.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <svg className={`h-3.5 w-3.5 ${generating ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {generating ? "Generating…" : "Regenerate"}
        </button>

        {time && <span className="shrink-0 text-[11px] text-ink-faint">{time}</span>}
      </div>

      {/* Mobile section rail — horizontally scrollable so five labels fit any width */}
      {briefMode === "brief" && (
        <nav className="-mx-4 flex items-center gap-1 overflow-x-auto px-4 pb-2 lg:hidden" aria-label="Brief sections">
          {BRIEF_SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className={`shrink-0 rounded-pill border px-2.5 py-1 text-[11px] transition-colors ${
                active === s.id
                  ? "border-accent-border bg-accent-soft font-semibold text-accent"
                  : "border-line text-ink-2"
              }`}
            >
              {s.label}
            </a>
          ))}
        </nav>
      )}
    </div>
  );
}
