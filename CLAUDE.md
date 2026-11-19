# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Critical: Always Push After Committing

The user does not review code locally — they only see issues after Vercel deploys a preview. **Every `git commit` must be immediately followed by a `git push`** so a preview build kicks off. Never leave a commit sitting in the local branch unpushed. If a series of small commits is being made, push at least once per logical unit (don't batch 5 commits and push at the end).

## Deployed URL

The user's deployed Vercel URL is **`https://pm-dashboard-7rr9.vercel.app`**. Whenever sending the user a link to hit (admin routes, debug endpoints, etc.), always embed this base URL so they can click directly without manual editing. Do not send placeholder URLs like `<your-preview-url>/...`.

## Auth

The login cookie `auth` is a SIGNED token (`app/lib/auth-token.ts`, HS256 via `jose`, key derived from `SITE_PASSWORD`, or `AUTH_SECRET` when set), verified in `middleware.ts` and renewed for 30 days on every `/api/auth/check`. Never compare the cookie to a fixed string again — the old value `"authenticated"` could be typed in by hand. Changing `SITE_PASSWORD` signs everyone out. For local checks without touching live data: run `node scripts/redis-stub.mjs` (in-memory Redis stand-in on port 6391) and start the `pm-dashboard-stub` launch config (port 3001, throwaway `SITE_PASSWORD=local-test-password`), then log in through `/login`; setting the cookie by hand no longer works.

## Critical: Preserve Existing Functionality

When making a change, it is vital that functionality is unaffected, unless the explicit goal of the prompt is to change a certain piece of functionality. The website must continue to function correctly regardless of any minor or major tweaks made. Before any non-trivial edit:

- Identify what the change is *supposed* to affect, and confirm everything else stays untouched.
- Prefer the smallest possible diff that accomplishes the goal.
- After editing, run `npx tsc --noEmit` and `npm run lint`, and reason through what user-visible flows could be impacted (data fetching, persistence, rebalance math, render conditions).
- If a change has potential blast radius beyond the stated goal, surface it and confirm with the user before proceeding.

## Critical: Verify Redis Safety Before Every Commit

**Read this every time you are about to commit or push a change.** This rule was added after a multi-trade Buy/Sell bug + an automated "repair" endpoint together corrupted live PIM model + positions data with no backup available for recovery. The fix took hours and reconstruction was only possible because of a screenshot the user happened to share earlier.

Before committing ANY change — including:
- New code paths
- Refactors (no matter how small)
- New admin / repair / migration endpoints
- "Quick fix" snippets suggested via DevTools console
- Editing in-place state in StockContext, PimPortfolio, PimModel, or any route under `/api/kv/*` or `/api/admin/*`

…you MUST work through this checklist explicitly in the response you give the user. Not silently — actually write out the answers so the user can verify:

1. **What Redis keys does this touch?** List every `pm:*` key the change reads or writes. Include indirect writes through context methods (e.g. `addStock` → `pm:stocks`, `updatePimModels` → `pm:pim-models`).
2. **For each write, does it preserve unrelated fields?** A `redis.set(key, JSON.stringify(...))` that drops a top-level field present in the existing blob will silently delete data. Always read-modify-write rather than overwrite. When in doubt, spread the previous object: `JSON.stringify({ ...prev, changedField: ... })`.
3. **Are there other code paths writing the same key concurrently?** Client-side React closures can lag behind Redis. If a back-end endpoint and a front-end persist hook can race against each other on the same key, that's a known data-loss pattern (see commit `a0edb9c` for the multi-trade closure fix). Either gate one path or use functional setState + refs.
4. **What's the rollback story if this goes wrong?** For any mutation of persisted data, the change should be reversible. Prefer one of: (a) the existing `*.pre-import-{ts}` stash pattern, (b) a fresh write-aside before the mutation, (c) explicit user confirmation that the change is irreversible.
5. **If this is an admin/repair endpoint:** does it require a `?confirm=YES` query param? Does it stash the prior state before mutating? Does it return a diff summary so the user can verify the result?
6. **Are nightly backups actually running?** Backups now live in **Vercel Blob** (`backups/<stamp>.json`), not Redis. Don't trust their existence on faith — the cron in `vercel.json` can be misconfigured or rejected by the `CRON_SECRET` check. Verify a recent one via `/api/admin/list-backups` (or the nav Backup-health chip) before relying on it as a safety net.

**For DevTools-console snippets you suggest to the user**: the same rules apply. A `fetch("/api/kv/...", { method: "PUT", body: ... })` from the console is as destructive as any server-side write. Walk through the checklist above before recommending such a snippet, and prefer GET-only diagnostic snippets when at all possible.

**When you are unsure whether a change is safe**, the answer is to STOP and ask the user before committing. The cost of pausing to confirm is always lower than the cost of recovering from corrupted production data.

## Critical: Large binaries + backups live in Vercel Blob, not Redis

The 250 MB Redis Essentials tier repeatedly OOM'd because multi-MB binaries accumulated in it (analyst PDFs, screenshots) and nightly backups were stored *inside* Redis. As of the June 2026 reliability work, those are **moved to Vercel Blob** (private store, `BLOB_READ_WRITE_TOKEN` env var; helpers in `app/lib/blob-store.ts`). **Redis holds only small structured live data.** Do NOT reintroduce binaries or backups into Redis — that restarts the OOM cycle.

- **Analyst-report PDFs** → Blob `analyst-reports/<ticker>-<source>` (stable path, overwrites). The manifest `pm:analyst-reports` stores a `pdfUrl` pointer. Written by the email-ingest `storeReport` and `PUT /api/kv/analyst-reports/[id]`. Nothing in the UI reads the PDF back today — it's an archive. (The extracted data lives in `pm:analyst-snapshots`.)
- **Brief/Research attachments** (screenshots + PDFs) → Blob `attachments/<id>`. The manifest `pm:attachments` (Redis, tiny) still tracks `id/label/section/addedAt`. Read back server-side via `getDataUrl()` (authenticated private `get()`) in `morning-brief` + `GET /api/kv/attachments/[id]`, with a legacy Redis fallback during transition.
- **Nightly backups** → Blob `backups/<sanitized-iso>.json` (`app/lib/backup-store.ts`: write/list/read/prune/findByDate). 30-day retention by Blob `uploadedAt`. The cron, `backup-now`, `backup-health` (nav chip), `list-backups`, `restore-from-backup`, and the legacy repair endpoints (`check-backup*`, `patch-stale-swap`, `restore-pim-performance`) all read from Blob. Durable even if Redis is lost.
- One-off migrations exist for both binary types: `/api/admin/migrate-analyst-pdfs-to-blob` and `/api/admin/migrate-attachments-to-blob` (dry-run default, `&confirm=YES`, copy-then-delete).
- The nightly cron also auto-purges dead rollback stashes older than 14 days (`app/lib/stash-prune.ts`) so Redis self-maintains.

## Critical: Persisted User Data

This app stores user-controlled **live** data in Redis (Upstash KV). **Never make changes that wipe, reseed, or migrate persisted data without explicit user confirmation.** In particular:

**Load the relevant skill before touching any `pm:*` key.** The per-key detail (shape, sole writers, guards, backup status, whether it is safe to nuke) lives in the project skills under `.claude/skills/`, not here. Before reading the code for, writing, migrating or suggesting a console snippet against a key, invoke its skill (Skill tool) and follow it. If a key is not listed below, search the skills (`grep -rn "pm:<key>" .claude/skills`) before assuming it has no rules — and if it truly has none, add it to the right skill in the same change.

| Key family | Skill |
|---|---|
| `pm:pim-models` (revision guard, pins), `pm:pim-models-versions` / `pm:pim-models-version:<id>`, `pm:model-drafts` (Stage changes, staged rebalance), `pm:weight-decisions`, `pm:pim-positions`, `pm:pim-portfolio-state` (merge-on-write), `pm:pim-performance` (backed up), `pm:sleeve-performance` (no longer updated), `pm:pim-sales-ledger`, sleeve / Stocks books, rebalance math, three-bucket model, Positioning | `pim-data` |
| `pm:stocks-suggested`, `pm:street-takeaways`, `pm:earnings-previews`, `pm:position-theses` (+ `-archive`), `pm:themes`, `pm:theme-evidence`, `pm:research-synthesis`, `pm:attachments` + Blob `attachments/<id>` | `research-data` |
| `pm:agent-settings`, `pm:agent-spend:*`, `pm:agent-calls`, `pm:agent-flag:<id>`, `pm:agent-run:*`, `pm:agent-state:*`, `pm:agent-memo:<date>`, `pm:decision-journal`, the `ANTHROPIC_AGENTS_API_KEY` gateway | `agents-data` |
| Rubric v3 + revision 7 growth, `pm:score-history`, `pm:sia-history`, `pm:growth-bands` (+ `-detail`), `pm:edgar-*` caches | `scoring` |
| `pm:regime-history`, `pm:action-state`, `pm:deployments`, `pm:hedges`, `pm:fundstrat-levels`, `pm:portfolio-snapshots` | `brief-market-data` |
| `pm:fund-one-pagers`, `pm:pm-monthly-drafts` (+ PM Monthly facts), `pm:client-report-analysis-cache`, `pm:client-report-bullets-cache` | `reporting-data` |
| Pure caches + retired keys: `pm:market-regime`, `pm:market-drivers`, `pm:earnings-dates`, `pm:brief-prevday`, `pm:fundstrat-view-cache`, `pm:vol-anchor`, `pm:risk-analytics`, `pm:fund-data-negative:*`, `pm:ratelimit:auth:*`, `pm:upticks-scrape-cache`, `pm:research-scrape-cache:*`, `pm:factor-*` | `caches` |

Rules that apply to every session regardless of skill:

- **`pm:stocks`** — the user's portfolio + watchlist. **This blob is THE BOOK** — only `bucket: "Portfolio" | "Watchlist"` entries belong in it. Losing this means the user re-enters every position by hand. `Stock.bucket` also has a third value, `"Suggested"`, but those records live in their OWN key (below); use `bookStocks()` / `isBookStock()` from `app/lib/types.ts` and never write `bucket === "Portfolio" ? a : b` over a list that could contain one.
- **`pm:stocks-suggested`** is a SEPARATE key for Suggested-funnel staging records — never a third bucket inside `pm:stocks`, and there is deliberately no whole-array PUT (see `research-data`).
- **Stale-tab rules for whole-blob keys (Nov 2026)** — a tab left open must never write its old copy back over what the server wrote since:
  - **`pm:analyst-snapshots` / `pm:analyst-reports`**: the browser saves ONE ticker's changed sources with `PATCH /api/kv/analyst-snapshots|analyst-reports` (`{ ticker, set, remove }`, read-merge-write; `patchTickerSources` in StockContext). The whole-map `PUT` still exists for old tabs only — do not call it from new code.
  - **`pm:research`**: `GET` returns a `hash`; the Sources page sends it back as `baseHash` on every save (`PUT`, or `POST` for the tab-close `sendBeacon`). A mismatch → 409 with the current copy, and the page folds its own changed top-level lists into that copy and retries (`sendResearchSave`). A body with no `baseHash` is accepted as before. Never store a non-object.
  - **`pm:pim-positions`**: Positioning re-reads positions when the PM returns to the tab after ≥ 60s away (skipped while an edit / rebalance / settlement is open; discarded if the tab wrote meanwhile). This is a refresh, not a server-side refusal — the save sites still write whole books.
- **`pm:pim-positions`**, **`pm:pim-portfolio-state`**, **`pm:hedging-history`**, **`pm:client-portfolio`**, **`pm:client-report-notes`**, **`pm:appendix-daily-values`**, **`pm:aa-performance`**, **`pm:pim-performance`**, **`pm:brief`**, **`pm:research`**, **`pm:scanner`**, **`pm:fund-data-cache`**, **`pm:chart-analysis`**, **`pm:attachments`**, **`pm:ui-prefs`**, **`pm:market`**, **`pm:hedging-custom-strikes`** — all user-edited or expensive-to-rebuild state.
- Append-only stores (`pm:portfolio-snapshots`, `pm:score-history`, `pm:sia-history`, `pm:regime-history`, `pm:pim-sales-ledger`) never get past entries rewritten (each skill has the exact write rule); `pm:deployments` and `pm:hedges` only add, replace or void one entry at a time — nothing deletes one; flags (`pm:agent-flag:<id>`) are never deleted; committed `pm:weight-decisions` months are immutable.
- **Blob `backups/<sanitized-iso>.json`** (was `pm:backup:YYYY-MM-DD` in Redis) — nightly full-database backups written by the `/api/cron/backup-redis` cron (06:00 UTC daily, configured in `vercel.json`). Each file is a JSON blob `{ backedUpAt, keyCount, totalBytes, data: { key → value } }` capturing every `pm:*` key EXCEPT the regenerable caches + bulky binaries (see `EXCLUDE_PATTERNS` in `backup-now`). Stored in **Vercel Blob** now (durable even if Redis is lost; can't OOM the live tier), via `app/lib/backup-store.ts`. Retention: 30 days (pruned by Blob `uploadedAt`). To restore, use `restore-from-backup` (takes a Blob `pathname` from `list-backups`) or read a snapshot and replay each `data[key]` via `redis.set`. The cron still requires `CRON_SECRET`; `/api/cron/*` is exempted from the auth-cookie middleware so Vercel's cron runner (header auth) can reach it.

Concrete rules:
- KV GET routes must return empty (`[]` / `{}`) on missing-key or read-error — never seed defaults that could later overwrite real data via PUT.
- Do not introduce code paths that call `redis.del`, `redis.set` with empty/seed values, or batch-overwrite a key from client default state during boot.
- Schema changes to a stored blob require a read-merge-write migration that preserves unknown fields, not a clobber.
- Refactors to `StockContext.tsx` must keep the bootstrap order: load from `/api/kv/*` first, only persist back after the initial load resolves.
- **For any new historical / timeseries data, use the append-only pattern**: compose field keys by date (e.g. `YYYY-MM-DD:<dim1>:<dim2>`), validate on write that the leading date equals today's server date, and reject past-dated entries with 400. `pm:portfolio-snapshots` is the reference implementation — copy its `POST` handler's date-check invariant when adding similar stores.

## Site rule: every collapse/expand persists

Any section a user can collapse, expand, or "show all" MUST survive a refresh,
and the state belongs in **`pm:ui-prefs`** (Redis-backed, so it also follows the
PM across devices) — never a bare `useState`, never `localStorage`.

- `useCollapsed(key)` → `[collapsed, toggle]` for sections that default OPEN.
- `usePersistedOpen(key, defaultOpen)` → `[open, toggle]` for everything else
  (a tile that starts open, a "show every row" expander that starts closed).
- `CollapsibleSection` / the Brief's `Fold` already persist via `prefKey`.

Reading an unset key never writes, so a default stays presentational until the
user actually toggles. **Exempt** (deliberately transient): dropdown menus,
modals, inline forms, one-at-a-time accordions, and row-selection state.

Two traps that have already bitten:
- If a component reads BOTH a pref and a legacy store, every writer must write
  the pref. The Thesis Desk's "Collapse all" wrote only its localStorage blob
  while `isOpen()` gave the pref priority, so collapsing appeared to work and
  then reverted on refresh.
- Don't gate already-collapsible prose behind a second "Show more". `ClampText`
  used to; it now always renders the full text.

## Common Commands

```bash
npm run dev          # next dev (localhost:3000)
npm run build        # next build (run before pushing if touching server routes)
npm run lint         # eslint
npx tsc --noEmit     # typecheck only — run after edits, no test suite exists
```

There are no automated tests. Verification = `tsc --noEmit` + `lint` + manual smoke in dev.

## Architecture

**Next.js 16 App Router**, React 19, TypeScript, Tailwind v4, `redis` client against Upstash (`REDIS_URL` or `KV_URL` env). Anthropic SDK for AI features (Morning Brief, chart analysis, scoring narratives).

### Route layout
- `app/(dashboard)/` — route group for the authenticated UI. `layout.tsx` here wraps every page in `Navigation` + `StockProvider`.
- `app/login/` — auth gate (cookie-based, see `app/api/auth`).
- `app/api/kv/*` — thin Redis JSON-blob CRUD endpoints (one key per route, GET/PUT pattern).
- `app/api/{score,refresh-data,prices,fund-data,chart-data,morning-brief,...}` — data-fetching server routes that call Yahoo Finance, Anthropic, and other upstreams. These are read-only with respect to Redis (except where they write derived caches like `pm:fund-data-cache`).
- `app/api/admin/*` — surgical mutations the user can hit by hand (e.g. `restore-holding-weight` patches a single symbol's weight in `pm:pim-models` without rebalancing).

### State
`app/lib/StockContext.tsx` is the single client-side source of truth. It hydrates from `/api/kv/stocks`, `/api/kv/pim-models`, etc. on mount, exposes mutation helpers via `useStocks()`, and persists each change back through PUT. Components never talk to Redis directly.

### PIM, Positioning and scoring (detail in skills)
- **PIM rebalance invariants** (`rebalanceStockWeights` in `StockContext.tsx`: stocks at `refPerStock`, `LOCKED_EQUITY_SYMBOLS` pass through, ETFs absorb the residual; `displayedWeight = weightInClass × profileEquityAllocation`, never stored pre-scaled), the **three-bucket model** (Core / Thematic / Alpha, `sleeveTargets`, `enforceSleeveTargets`) and **Positioning is weights-only** (never reintroduce unit ENTRY; never change the engine to "weights") → `pim-data` skill.
- **Scoring rubric v3** (33-pt conviction; technicals are the separate setup grade, never summed; cutoffs only in `app/lib/rating-bands.ts`) and **rubric revision 7** (growth is COMPUTED in `app/lib/growth-score.ts`; never reintroduce hand-set growth thresholds into the prompt) → `scoring` skill.

### Tickers
`-T` / `.TO` suffix variants for Canadian listings are not normalized at the storage layer. Use `tickerMatch` from `app/lib/types.ts` (or equivalent) for comparisons. The `pm:pim-models` blob has been observed to use the bare `FID5982` while `pim-seed.ts` lists `FID5982-T` — the LOCKED set holds both forms.

### Beta sources
- Individual stocks: Yahoo `summaryDetail.beta` (3y) → fallback `defaultKeyStatistics.beta3Year`, clamped to `[-3, 5]`. Persisted via `updateStockFields` only when `instrumentType === "stock"` (or unset).
- ETFs / mutual funds: Morningstar BetaM36 via `/api/fund-data`. Never overwrite a fund's beta with a Yahoo number.

### Tailwind v4 cascade gotcha
`app/globals.css` has an unlayered `a { color: inherit; text-decoration: none; }`. In Tailwind v4 this overrides `.text-white` on `<Link>` elements. For navy/colored link-buttons use `!text-white` (and `inline-flex items-center` to match `<button>` box rendering).

**Any UNLAYERED rule in `globals.css` beats EVERY Tailwind utility**, regardless of specificity — layered CSS always loses to unlayered CSS. The `a { color: inherit }` rule above is one instance; the control reset was another and is now fixed: `button, input, select { font: inherit; }` silently reset font-weight app-wide (`font: …` is a shorthand), so `font-medium` / `font-semibold` on any `<button>` or `<input>` rendered at 400 for months. It is now written as longhands (`font-family` / `font-size` / `line-height` / `letter-spacing`) so weight is left to the utility. When adding a bare-element rule to `globals.css`, never use a shorthand, and prefer the narrowest property you actually need. Note the same trap applies to the workspace helper classes (`.panel-h`, `.data-table td`, `.seg > *`): they are unlayered, so a Tailwind colour/size utility on those elements loses — put the utility on an inner `<span>` instead.

### Seed files
`pim-seed.ts`, `pim-daily-value-seed.ts`, `defaults.ts`, the root `pim-model-data.json`, and the `*.xlsx` files at the repo root are reference data only — they are NOT loaded into Redis automatically. Do not wire them into any boot path.

### Logging convention
API routes use a shared helper at `app/lib/logger.ts` that prefixes every log line with a route-specific tag:
```ts
import { createLogger } from "@/app/lib/logger";
const log = createLogger("Score");  // or "Brief", "Score-gaps", etc.

log.info("started for", ticker);    // → "[Score] started for AAPL"
log.warn("non-200 from Yahoo");     // → "[Score] non-200 from Yahoo"
log.error("Anthropic failed:", e);  // → "[Score] Anthropic failed: ..."
```
New routes should use this rather than bare `console.log` so Vercel runtime log search ("[Score]", "[Finviz breadth]", "[Backfill-summaries]") finds the right output during incidents.
