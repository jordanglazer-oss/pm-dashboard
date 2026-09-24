# UI improvement audit

This audit focuses on making the portfolio workspace faster to scan, easier to
operate, and safer during high-attention tasks. The existing visual system is a
strong base: it already uses semantic design tokens, a consistent panel/table
language, responsive navigation, keyboard shortcuts, visible focus treatment,
and reduced-motion fallbacks.

## Recommended priorities

### 1. Turn the dashboard into a clearer decision hierarchy

The home screen currently moves from a conditional attention panel into the
full holdings table, inspector, a collapsed cockpit, reference links, and
optional analytical panels. Add a compact, persistent **Today** strip above the
holdings table with only three groups: items requiring action, portfolio/risk
change since the prior close, and data freshness. Make each value a link or
filter rather than a decorative KPI.

This would preserve the current information density while answering the first
question a PM has: “What changed, and what do I need to do?” Keep calm states
quiet, and avoid duplicating metrics that already appear in the Brief.

### 2. Reduce table overload with progressive disclosure

The rankings and fund tables expose many actions, columns, status badges, and
secondary signals at once. Define three column tiers:

1. **Pinned:** ticker/name, score, change, weight, and action/status.
2. **Contextual:** the columns most relevant to the active bucket.
3. **Detail:** everything available in the row inspector or a user-controlled
   “Columns” menu.

Keep the first column sticky when horizontally scrolling, add a subtle edge
fade when more columns exist, and show active sort/filter state in a compact
summary above the table. On mobile, replace the squeezed table with compact
holding cards or a purpose-built five-column list instead of relying primarily
on horizontal scrolling.

### 3. Separate primary actions from maintenance actions

“Add” is visually primary in the global header, while scoring, refresh,
backfill, gap filling, clearing chart data, and exports compete inside table
headers and overflow menus. Establish an action hierarchy:

- one primary action per surface;
- routine secondary actions beside it;
- destructive, diagnostic, export, and maintenance actions in a clearly
  labelled overflow section;
- confirmation language that states scope (for example, “Rescore 18 portfolio
  names”) and cost/time where relevant.

Long-running actions should use a shared progress pattern with item count,
elapsed state, safe cancellation behavior, and a link to failures. This is more
useful than changing a button label alone.

### 4. Improve navigation orientation without adding chrome

The desktop rail exposes every destination, which is efficient but visually
dense. Allow groups to collapse, remember that preference, and keep the active
group expanded. Add unread/action counts only where the count changes behavior
(Inbox, Thesis Watch, alerts), not to every destination.

On mobile, consolidate the drawer and “More” sheet into one secondary-navigation
pattern. The current two overlays create two different ways to reach the same
long tail of destinations. The bottom tabs should remain reserved for the four
or five highest-frequency workflows.

### 5. Make freshness and provenance a first-class visual system

Scores, prices, research, regime, and model outputs age at different rates.
Create one reusable freshness treatment with:

- absolute timestamp in the tooltip or details;
- concise relative age in the surface;
- stale and failed states that do not rely on color alone;
- source/provenance beside generated or imported values;
- a direct recovery action where possible.

Use this consistently in panel headers and inspectors rather than scattering
slightly different “last updated” labels throughout the workspace.

### 6. Strengthen accessibility semantics for dense interactions

The global focus and reduced-motion foundations are already present. The next
pass should focus on component semantics: give sortable headers `aria-sort`,
announce background-operation progress with `aria-live`, trap focus and support
Escape in the mobile drawer and sheet, expose their open state with
`aria-expanded`, and ensure icon-only controls have names that include their
scope. Increase desktop rail targets from 28px toward a 36px minimum and keep
mobile targets at least 44px.

Validate status colors with contrast checks and always pair red/amber/green
with text or an icon. Test the core flows with keyboard-only navigation and at
200% zoom, not just with automated linting.

### 7. Add resilient loading, empty, and error states

The authentication gate currently renders only “Loading,” and several data
loads fail silently. Introduce skeletons shaped like the eventual content, a
clear delayed-loading message, and an actionable retry state. Empty states
should explain whether there is genuinely no data, a filter removed all rows,
or a provider has not refreshed.

For the main dashboard, preserve the last usable snapshot during refresh and
mark it stale rather than blanking the workspace. This prevents a network issue
from looking like an empty portfolio.

### 8. Add an optional density preference

The 13px base type and 34px table rows are appropriate for an expert desktop
tool, but not ideal for every display or accessibility need. Offer Compact and
Comfortable density modes using shared CSS variables for body type, control
height, table-row height, and panel spacing. Comfortable should be the mobile
default. Avoid per-component sizing toggles that cause the system to drift.

## Suggested delivery sequence

1. **Measure:** identify the most-used routes and actions; run a keyboard,
   200%-zoom, narrow-desktop, and mobile audit.
2. **Quick wins:** sortable-table semantics, live progress announcements,
   larger rail targets, consistent freshness badges, and explicit error states.
3. **Dashboard pass:** Today strip, pinned/contextual/detail column tiers, sticky
   identifier column, and clearer action hierarchy.
4. **Responsive pass:** replace dense mobile tables and unify secondary mobile
   navigation.
5. **System pass:** shared loading/empty/error components and density tokens.

Success should be measured by time to identify the highest-priority holding,
time to complete a rescore/refresh workflow, accidental-action rate, horizontal
scroll frequency, and keyboard completion rate for the same core tasks.
