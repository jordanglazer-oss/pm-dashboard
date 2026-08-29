# Handoff: Precision Light — Polish & Motion Pass

## Overview
Fifteen targeted refinements to the **PIM Dashboard** ("Precision Light" redesign). These are polish, motion, data-viz and interaction upgrades — they do **not** change the information architecture, routes, or the token palette. Everything below maps to values that already exist in `app/globals.css` (`@theme` tokens) and to specific components in `app/components/`.

## About the design files
`Polish & Motion Handoff.dc.html` in this folder is a **design reference** — an interactive prototype showing intended look and motion. It is **not** production code to paste in. Recreate each effect in the real Next.js + Tailwind v4 codebase using the existing Precision Light tokens and component structure. The prototype uses hardcoded hex values so it opens standalone; **in the app always use the token utilities** (`bg-accent`, `text-pos`, `border-line`, `rounded-card`, `font-mono`, etc.), never the literal hex.

## Fidelity
**High-fidelity.** Colors, timings, easings and layout are final and map 1:1 to existing tokens. Recreate precisely.

## Non-negotiable global rules
1. **Use tokens, not hex.** Every color below is given as its `globals.css` token. Map hex → token when implementing (table at the bottom).
2. **Respect `prefers-reduced-motion`.** `globals.css` already has reduced-motion blocks — extend them so every new animation/transition no-ops under reduced motion. Interactive demos (13–15) should still *function*, just without the transition.
3. **`tabular-nums` everywhere numeric.** Already set on `table` and `.font-mono`; keep it.
4. **No new palette, no new fonts.** IBM Plex Sans / IBM Plex Mono only.

---

## The fifteen changes

Grouped into four ship passes (see Sequencing). Each item: **target file(s) · what to change · exact values**.

### Pass 1 — Foundations (pure CSS, zero risk)

**06 · Numeric hierarchy & alignment**
- Target: any table with numeric columns — `PortfolioOverview.tsx`, `page.tsx` (Regime Multiplier table), `StockScoring.tsx`, `PimPortfolio.tsx`.
- Numeric `<td>`: `font-mono text-right tabular-nums`. Ticker column `font-mono font-semibold`.
- Sign carries color: gains `text-pos`, losses `text-neg` — **text only**, no fill.
- Demote unit glyphs (`%`, `x`, `/100`) to `text-ink-faint` and one step smaller than the number.
- **Always prefix currency with `$`** (prices, values). This was inconsistent in the redesign — enforce it in every price/value formatter.

**09 · Elevation ladder**
- Target: `globals.css` + all cards.
- Add two shadow tokens: `--shadow-sm: 0 1px 2px rgb(16 21 28 / .05)` and `--shadow-card: 0 1px 2px rgb(16 21 28 / .05), 0 4px 12px -4px rgb(16 21 28 / .08)`.
- Static cards → `--shadow-sm`; sectioned containers → `--shadow-card`. Retire any heavy flat `0 10px 24px` shadows.
- Only genuinely-clickable tiles animate: extend `.hover-lift` to the raised two-layer shadow + `translateY(-2px)`, `transition: box-shadow .16s, transform .16s`.

**10 · Status color restraint**
- Target: `SignalPill.tsx` (already has soft + solid variants), all rating/change cells.
- Default `SignalPill` to the **soft** variant (tint bg + colored text + hairline border) — the `toneClasses` you already have. Reserve a **solid fill** for a single alert-grade state per view (e.g. Risk-Off, credits exhausted).
- Numeric deltas render as colored *text* (`text-pos`/`text-neg`), never a filled pill.

### Pass 2 — Motion (all behind reduced-motion)

**01 · Numbers that change with intent**
- Target: `FlashValue.tsx` (keep it) + new `CountUp` wrapper; live figures in `ModelReturnsStrip.tsx`, `PortfolioOverview.tsx`, stock price headers.
- `CountUp`: rAF-tween previous→next value over **640ms, easeOutCubic** (`1 - (1-t)³`). Keep `FlashValue`'s tint on top (green/red for direction).
- Add a delta pill next to the figure: `▲ +N.N` / `▼ N.N`, colored `--color-pos`/`--color-neg` soft, `animation: chipIn .3s ease-out`. `tabular-nums` so width doesn't jitter.

**02 · Rows that respond**
- Target: rankings `<tbody>` in `PortfolioOverview.tsx`; reuse existing `.animate-row-in` + `.hover-lift`.
- On load: `animation: rowIn .34s ease-out both; animation-delay: calc(var(--i) * 28ms)` — **cap the index** (~12) so late rows don't lag.
- On hover: `box-shadow: 0 4px 14px -6px rgb(16 21 28 / .18)`, `translateY(-1px)`, and reveal a **2px `--color-accent` left rail** via opacity 0→1.

**07 · Shimmer skeleton**
- Target: `Skeleton.tsx`.
- Keep bar base `bg-line`; add `position:relative; overflow:hidden` + an absolute sweep child: `background: linear-gradient(90deg, transparent, rgb(255 255 255 / .85), transparent); transform: translateX(-100%); animation: shimmer 1.5s ease-in-out infinite`. Drop `animate-pulse`.
- Add `@keyframes shimmer { 100% { transform: translateX(220%) } }` to `globals.css`, gated by the reduced-motion block.

**03 · Sparklines with body**
- Target: `Sparkline.tsx`.
- Switch `fill` to a vertical `<linearGradient>`: `--color-accent` at `.20` → `0`. Bump stroke to `1.8`. Recolor the default `stroke` off the hardcoded `#3b82f6` onto `--color-accent`.
- Keep the existing `.spark-draw`; add a pulsing end-dot: `@keyframes dotPulse` (scale .4→1.25→1, opacity 0→1), delayed to start *after* the draw completes.

### Pass 3 — Structure

**04 · Conviction ring**
- Target: stock-page score display (see score donut area referenced by `ScoreDelta.tsx`).
- SVG ring, `r=34`, `stroke-dasharray = 2πr ≈ 213.6`, `stroke-dashoffset = C · (1 − score/100)`, rotate `-90`. Animate offset from `C`→target with `cubic-bezier(.22,1,.36,1) 1s` (add `@keyframes ringFill { from { stroke-dashoffset: var(--c) } }`).
- Track = `--color-line-soft`; arc = tier color (`--color-pos` / `--color-warn` / `--color-neg`). Score stays centered, `font-mono`.

**05 · Sector exposure bars**
- Target: Sector Exposure block inside `PortfolioOverview.tsx`.
- 6px track (`--color-line-soft`), fill width = pct%. Grow with `transform-origin:left; animation: barGrow .7s cubic-bezier(.22,1,.36,1)` (scaleX 0→1 — GPU-cheap), staggered ~70ms.
- Largest sector `--color-accent`, rest `--color-ink-faint`; any weight **>25%** flips to `--color-warn` (concentration flag).

**08 · Empty states**
- Target: new `EmptyState.tsx`; use on empty Watchlist, Screener no-results, Inbox zero.
- Props: `glyph, title, body, action`. Layout: tinted `--color-accent-soft` icon chip (44px, `rounded-[11px]`), semibold title, one-line body `text-ink-2`, primary + ghost buttons. `animation: fadeUp .45s ease-out` on mount.

### Pass 4 — Delight (pointer-driven, reduced-motion-safe)

**11 · Cockpit summary band** *(bolder — structural)*
- Target: merge `ModelReturnsStrip.tsx` + `RegimeStrip.tsx` into one `CockpitBand.tsx`, rendered as the first child of `app/(dashboard)/page.tsx`.
- One band: portfolio value + `CountUp` day-move (from #01), a 3-segment regime gauge (segments fill by risk state, `gaugeSlide` stagger), a portfolio sparkline (#03). `animation: scaleIn .5s cubic-bezier(.22,1,.36,1)` on mount.
- Keep per-model detail available on the Models sub-tab — don't delete it.

**12 · Spotlight command palette** *(bolder — flow)*
- Target: `CommandPalette.tsx` (already exists, ⌘K wired).
- Group results under mono section labels (Holdings / Pages / Actions). Holding rows: ticker avatar chip + live change. Every row: a trailing `<kbd>` hint. Active row: `--color-accent-soft` background, moved by ↑/↓, run by ↵.
- Open with `scaleIn .28s cubic-bezier(.22,1,.36,1)` + backdrop blur.

**13 · Self-reordering rankings (FLIP)**
- Target: rankings `<tbody>` in `PortfolioOverview.tsx`.
- Keep row keys **stable** (by ticker) and drive vertical position from rank, not DOM order: `transform: translateY(rank * rowHeight); transition: transform .5s cubic-bezier(.22,1,.36,1)`. Simplest robust path: `react-flip-toolkit` on the tbody. Reduced-motion → reorder instantly, no transition.

**14 · Chart scrubbing**
- Target: `StockChart.tsx`.
- Transparent `onPointerMove` capture over the plot; map `(clientX − rect.left) / rect.width` → nearest data index. Render a % crosshair line + anchored dot + tooltip (value + date). All overlays `pointer-events:none` so the capture keeps firing. Touch: snap to nearest on drag.

**15 · Tactile controls**
- Target: `PortfolioTabs.tsx` / `ResearchTabs.tsx` (segmented), any toggle, all buttons.
- Segmented control: absolute white pill, `transform: translateX(activeIndex * 100%)`, `.28s cubic-bezier(.22,1,.36,1)`.
- Toggle knob: overshoot spring `cubic-bezier(.34,1.56,.64,1)`, `.24s`.
- Every button/link: `:active { transform: scale(.95) }`, `transition: transform .1s`.

---

## Design tokens (already in `app/globals.css @theme`)

Map every hex in the prototype to these. Do not introduce new values.

| Role | Token | Value |
|---|---|---|
| Page bg | `--color-ground` | `#f6f7f9` |
| Card / panel | `--color-surface` | `#ffffff` |
| Inset / zebra | `--color-surface-2` | `#fafbfc` |
| Row/control hover | `--color-surface-hover` | `#f4f6fb` |
| Card divider | `--color-line` | `#e6e8ec` |
| Row divider | `--color-line-soft` | `#f0f1f4` |
| Ink primary | `--color-ink` | `#10151c` |
| Ink secondary | `--color-ink-2` | `#5b6472` |
| Ink tertiary | `--color-ink-3` | `#9aa3b0` |
| Ink faint (units) | `--color-ink-faint` | `#c3c8d0` |
| Accent | `--color-accent` | `#2d5bd0` |
| Accent text on tint | `--color-accent-ink` | `#2c43be` |
| Accent tint bg | `--color-accent-soft` | `#eef4ff` |
| Accent border | `--color-accent-border` | `#cfe0ff` |
| Positive | `--color-pos` / `-soft` / `-border` | `#12805c` / `#f0f9f4` / `#bfe3d4` |
| Negative | `--color-neg` / `-soft` / `-border` | `#d1435b` / `#fdf2f3` / `#f2c9cf` |
| Warn | `--color-warn` / `-soft` / `-border` | `#b8791f` / `#fbf6ea` / `#f2e2bf` |
| Violet | `--color-violet` / `-soft` / `-border` | `#7c5cd0` / `#f3f0fb` / `#ddd3f2` |
| Radius | `--radius-card` / `-control` / `-pill` | `8px` / `8px` / `20px` |

## Motion reference (add to `globals.css`, gate under reduced-motion)
```
@keyframes chipIn    { from { opacity:0; transform:translateY(3px) scale(.9) } to { opacity:1; transform:none } }
@keyframes rowIn     { from { opacity:0; transform:translateY(7px) }           to { opacity:1; transform:none } }   /* you have this */
@keyframes shimmer   { 100% { transform:translateX(220%) } }
@keyframes dotPulse  { 0% { transform:scale(.4); opacity:0 } 55% { transform:scale(1.25); opacity:1 } 100% { transform:scale(1); opacity:1 } }
@keyframes ringFill  { from { stroke-dashoffset:var(--c) } }
@keyframes barGrow   { from { transform:scaleX(0) } to { transform:scaleX(1) } }
@keyframes gaugeSlide{ from { opacity:0; transform:translateX(-8px) } to { opacity:1; transform:none } }
@keyframes scaleIn   { from { opacity:0; transform:translateY(8px) scale(.975) } to { opacity:1; transform:none } }
```
Standard easings: **enter/settle** `cubic-bezier(.22,1,.36,1)`, **spring/overshoot** `cubic-bezier(.34,1.56,.64,1)`, **count-up** easeOutCubic.

## Sequencing
1. **Foundations** — #06, #09, #10. Pure CSS/token, no behavior change, safe to merge first.
2. **Motion** — #02, #01, #07, #03. All reduced-motion-gated.
3. **Structure** — #04, #05, #08.
4. **Delight** — #13, #14, #15, then the two headline rethinks #11 and #12.

## Files in this bundle
- `Polish & Motion Handoff.dc.html` — the interactive reference. Open it, replay each demo, and read the dark "handoff" note under each for the same spec in shorthand. Toggle the notes / reduce-motion via the on-page controls.
