# Claude Code — paste-ready prompts

Work from the root of your `pm-dashboard` repo. Paste the blocks **in order**, one at a time. After each finishes, review the diff, commit, then paste the next. That's it.

If you only ever paste **Prompt 0 → 1 → 2 → 3**, you'll have shipped everything safe. Prompt 4 (the two bolder rethinks) is optional and can wait.

---

## Prompt 0 — Setup (paste this first, once)

```
Read design_handoff_polish_motion/README.md in full — it's a polish & motion pass on this dashboard, fifteen refinements each mapped to a specific file with exact tokens, timings and easings. Open design_handoff_polish_motion/Polish & Motion Handoff.dc.html in a browser to see the Before/After for each.

Before writing any code, confirm back to me:
- the four ship passes and which files each touches, and
- that you'll follow these hard rules on every change:
  1. Use the existing Precision Light tokens in app/globals.css (bg-accent, text-pos, border-line, rounded-card, font-mono, etc.) — never hardcode the prototype's hex values.
  2. Gate every animation/transition behind prefers-reduced-motion by extending the existing reduced-motion blocks in globals.css. Add a shared useReducedMotion() hook if the guard repeats.
  3. Do not change routes, information architecture, the color palette, or the fonts.
  4. Reuse existing pieces where named: FlashValue, SignalPill, .hover-lift, .animate-row-in, .spark-draw.
  5. Always prefix currency values with $.

Don't change any code yet — just confirm the plan.
```

---

## Prompt 1 — Foundations (safe, pure CSS/token)

```
Implement Pass 1 from design_handoff_polish_motion/README.md. Show me the diff per file and stop when done — don't start Pass 2.

- #06 Numeric hierarchy: numeric <td> → font-mono text-right tabular-nums; ticker col font-mono font-semibold; sign carries color as TEXT only (text-pos / text-neg), no fills; demote %, x, /100 glyphs to text-ink-faint one size smaller. Enforce a $ prefix on every price/value formatter.
- #09 Elevation: add --shadow-sm and --shadow-card tokens to globals.css; static cards use sm, sectioned containers use card; retire heavy flat 0 10px 24px shadows; only .hover-lift tiles animate to the raised two-layer shadow + translateY(-2px).
- #10 Status color: default SignalPill to its soft variant; numeric deltas are colored text, not filled pills; reserve a solid fill for one alert-grade state per view.

Follow the hard rules from setup. Use the token table and file list in the README.
```

---

## Prompt 2 — Motion (all reduced-motion-gated)

```
Implement Pass 2 from design_handoff_polish_motion/README.md. Diff per file, then stop.

- #02 Rows respond: rankings <tbody> rows animate rowIn .34s ease-out both with animation-delay: calc(var(--i) * 28ms) (cap index ~12); hover adds box-shadow 0 4px 14px -6px rgb(16 21 28 / .18), translateY(-1px), and a 2px --color-accent left rail via opacity.
- #01 CountUp: rAF-tween prev→next over 640ms easeOutCubic; keep FlashValue's tint; add a delta pill (▲ +N.N / ▼ N.N) in pos/neg soft with animation chipIn .3s; tabular-nums.
- #07 Shimmer skeleton: in Skeleton.tsx keep base bg-line, add relative/overflow-hidden + an absolute gradient sweep at shimmer 1.5s infinite; drop animate-pulse.
- #03 Sparklines: in Sparkline.tsx switch fill to a vertical linearGradient (--color-accent .20→0), stroke 1.8 on --color-accent (drop #3b82f6), keep .spark-draw, add a dotPulse end-dot after the draw.

Add the needed @keyframes to globals.css and gate them all under prefers-reduced-motion. Follow the hard rules.
```

---

## Prompt 3 — Structure

```
Implement Pass 3 from design_handoff_polish_motion/README.md. Diff per file, then stop.

- #04 Conviction ring: SVG ring r=34, stroke-dasharray=2πr, stroke-dashoffset=C·(1−score/100), rotate -90; animate offset C→target with ringFill 1s cubic-bezier(.22,1,.36,1); track --color-line-soft, arc = tier color; score centered font-mono.
- #05 Exposure bars: in PortfolioOverview.tsx Sector Exposure — 6px --color-line-soft track, fill width=pct%, grow with barGrow .7s cubic-bezier(.22,1,.36,1) (scaleX, transform-origin left), ~70ms stagger; largest sector --color-accent, rest --color-ink-faint, >25% flips to --color-warn.
- #08 EmptyState: new reusable EmptyState.tsx (glyph, title, body, action) — accent-soft icon chip, semibold title, ink-2 body, primary+ghost buttons, fadeUp .45s on mount; use it on empty Watchlist, Screener no-results, Inbox zero.

Follow the hard rules; gate motion under prefers-reduced-motion.
```

---

## Prompt 4 — Delight + rethinks (optional; do last)

```
Implement Pass 4 from design_handoff_polish_motion/README.md. Do the three delight items first, show diffs, and treat #11 and #12 as separate reviewable changes at the end.

- #13 FLIP re-sort: rankings rows keep stable keys (by ticker); drive position from rank via transform translateY(rank*rowH) with transition transform .5s cubic-bezier(.22,1,.36,1) (or react-flip-toolkit on the tbody). Reduced-motion → reorder instantly.
- #14 Chart scrubbing: in StockChart.tsx add a transparent onPointerMove capture, map (clientX−rect.left)/rect.width → nearest index, render a % crosshair + anchored dot + tooltip (value + date); overlays pointer-events:none; touch snaps on drag.
- #15 Tactile controls: segmented control (PortfolioTabs/ResearchTabs) gets an absolute white pill translateX(active*100%) .28s cubic-bezier(.22,1,.36,1); toggle knob uses overshoot cubic-bezier(.34,1.56,.64,1); every button/link gets :active { transform: scale(.95) } .1s.
- #11 Cockpit band (STRUCTURAL): merge ModelReturnsStrip + RegimeStrip into one CockpitBand as the first child of the dashboard (value + CountUp day-move, 3-segment regime gauge, portfolio sparkline, scaleIn .5s). Keep per-model detail on the Models sub-tab. Show me this as its own diff for approval.
- #12 Command palette: group CommandPalette.tsx results (Holdings/Pages/Actions) with mono labels, ticker avatar + live change on holdings, per-row <kbd> hints, accent-soft active row moved by ↑/↓, scaleIn .28s + backdrop blur on open.

Follow the hard rules; gate all motion under prefers-reduced-motion.
```
