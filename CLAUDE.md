# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Critical: Preserve Existing Functionality

When making a change, it is vital that functionality is unaffected, unless the explicit goal of the prompt is to change a certain piece of functionality. The website must continue to function correctly regardless of any minor or major tweaks made. Before any non-trivial edit:

- Identify what the change is *supposed* to affect, and confirm everything else stays untouched.
- Prefer the smallest possible diff that accomplishes the goal.
- After editing, run `npx tsc --noEmit` and `npm run lint`, and reason through what user-visible flows could be impacted (data fetching, persistence, rebalance math, render conditions).
- If a change has potential blast radius beyond the stated goal, surface it and confirm with the user before proceeding.

## Critical: Persisted User Data

This app stores user-controlled data in Redis (Upstash KV). **Never make changes that wipe, reseed, or migrate persisted data without explicit user confirmation.** In particular:

- **`pm:stocks`** — the user's portfolio + watchlist. Both buckets live in this single JSON blob (`bucket: "Portfolio" | "Watchlist"` on each entry). Losing this means the user re-enters every position by hand.
- **`pm:pim-models`** — per-group equity/fixed-income holdings with `weightInClass` values. Drives every weight shown in PIM Model / Positioning tabs and the automated performance numbers.
- **`pm:pim-positions`**, **`pm:pim-portfolio-state`**, **`pm:hedging-history`**, **`pm:client-portfolio`**, **`pm:client-report-notes`**, **`pm:appendix-daily-values`**, **`pm:aa-performance`**, **`pm:pim-performance`**, **`pm:brief`**, **`pm:research`**, **`pm:scanner`**, **`pm:fund-data-cache`**, **`pm:chart-analysis`**, **`pm:attachments`**, **`pm:ui-prefs`**, **`pm:market`**, **`pm:hedging-custom-strikes`** — all user-edited or expensive-to-rebuild state.
- **`pm:portfolio-snapshots`** — **append-only** daily history of sector breakdowns and top holdings per (date, group, profile). Past-dated writes are rejected by the route. Used for trend analysis; losing it means losing all historical drift data.
- **`pm:ratelimit:auth:*`** — per-IP login-attempt counters (auto-expire every 60s). Safe to ignore; not user data.
- **`pm:upticks-scrape-cache`** — hash-gated cache of the Anthropic vision parse of the Newton's Upticks screenshot (`{ hash, entries, analyzedAt }`). Mirrors the JPM-flows caching pattern in `app/api/morning-brief/route.ts`: the Refresh button in Research always POSTs the current upticks attachments to `/api/upticks-scrape`, but the route only spends Anthropic tokens when the image fingerprint changes. Safe to nuke (worst case: one re-scan on next Refresh).
- **`pm:backup:YYYY-MM-DD`** — nightly full-database backups written by the `/api/cron/backup-redis` cron (06:00 UTC daily, configured in `vercel.json`). Each value is a JSON blob `{ backedUpAt, keyCount, totalBytes, data: { key → value } }` capturing every `pm:*` key EXCEPT: `pm:backup:*` itself (avoid recursion), `pm:ratelimit:*` (ephemeral), and `pm:fund-data-cache` (large + deterministically re-fetchable). Retention: 14 days (older backups are auto-pruned on each run). To restore, read the target backup and replay each `data[key]` via `redis.set(key, value)`. Requires `CRON_SECRET` env var — the route rejects any request without a matching bearer token. The `/api/cron/*` namespace is exempted from the auth-cookie middleware because Vercel's cron runner authenticates via that header instead.

Concrete rules:
- KV GET routes must return empty (`[]` / `{}`) on missing-key or read-error — never seed defaults that could later overwrite real data via PUT.
- Do not introduce code paths that call `redis.del`, `redis.set` with empty/seed values, or batch-overwrite a key from client default state during boot.
- Schema changes to a stored blob require a read-merge-write migration that preserves unknown fields, not a clobber.
- Refactors to `StockContext.tsx` must keep the bootstrap order: load from `/api/kv/*` first, only persist back after the initial load resolves.
- **For any new historical / timeseries data, use the append-only pattern**: compose field keys by date (e.g. `YYYY-MM-DD:<dim1>:<dim2>`), validate on write that the leading date equals today's server date, and reject past-dated entries with 400. `pm:portfolio-snapshots` is the reference implementation — copy its `POST` handler's date-check invariant when adding similar stores.

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

### PIM rebalance invariants (in `StockContext.tsx`)
The `rebalanceStockWeights` function splits equity into three pools:
1. **Stocks** — locked at `refPerStock = 0.018182` (1.82% of class) each.
2. **Locked holdings** — symbols in `LOCKED_EQUITY_SYMBOLS` (`FID5982`, `FID5982-T`, `GRNJ`) — pass through unchanged. These are specialty funds whose weight is set by the per-group Balanced % input, not by residual math.
3. **ETFs** — absorb residual: `etfTotal = max(0, 1.0 - stockTotal - lockedTotal)`, distributed proportionally from seed ratios (excluding locked symbols).

Profile scaling: `displayedWeight = weightInClass × profileEquityAllocation`. Balanced 0.66, Growth 0.83, All-Equity 1.0 — applied at render time, not stored.

When adding/removing a holding to a group, **do not** re-run rebalance on locked symbols. When migrating data, preserve the locked-symbol weights verbatim.

### Tickers
`-T` / `.TO` suffix variants for Canadian listings are not normalized at the storage layer. Use `tickerMatch` from `app/lib/types.ts` (or equivalent) for comparisons. The `pm:pim-models` blob has been observed to use the bare `FID5982` while `pim-seed.ts` lists `FID5982-T` — the LOCKED set holds both forms.

### Beta sources
- Individual stocks: Yahoo `summaryDetail.beta` (3y) → fallback `defaultKeyStatistics.beta3Year`, clamped to `[-3, 5]`. Persisted via `updateStockFields` only when `instrumentType === "stock"` (or unset).
- ETFs / mutual funds: Morningstar BetaM36 via `/api/fund-data`. Never overwrite a fund's beta with a Yahoo number.

### Tailwind v4 cascade gotcha
`app/globals.css` has an unlayered `a { color: inherit; text-decoration: none; }`. In Tailwind v4 this overrides `.text-white` on `<Link>` elements. For navy/colored link-buttons use `!text-white` (and `inline-flex items-center` to match `<button>` box rendering).

### Seed files
`pim-seed.ts`, `pim-daily-value-seed.ts`, `defaults.ts`, the root `pim-model-data.json`, and the `*.xlsx` files at the repo root are reference data only — they are NOT loaded into Redis automatically. Do not wire them into any boot path.
