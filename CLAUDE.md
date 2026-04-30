# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Critical: Always Push After Committing

The user does not review code locally — they only see issues after Vercel deploys a preview. **Every `git commit` must be immediately followed by a `git push`** so a preview build kicks off. Never leave a commit sitting in the local branch unpushed. If a series of small commits is being made, push at least once per logical unit (don't batch 5 commits and push at the end).

## Deployed URL

The user's deployed Vercel URL is **`https://pm-dashboard-7rr9.vercel.app`**. Whenever sending the user a link to hit (admin routes, debug endpoints, etc.), always embed this base URL so they can click directly without manual editing. Do not send placeholder URLs like `<your-preview-url>/...`.

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
- **`pm:score-history`** — **append-only** per-ticker log of composite score changes. Shape: `{ [ticker]: Entry[] }` where each `Entry` is `{ date, timestamp, total, raw, adjusted, scores }`. Written by the stock page's `handleRescore` flow (via `POST /api/kv/score-history`) once the fresh score has propagated into context. Same date-validation invariant as `pm:portfolio-snapshots`: POST rejects entries whose `date` is not today (server UTC). Read by the Score History tile on the stock page. Informational-only — not fed into alerts or composite math.
- **`pm:market-regime`** — cached output of `/api/market-regime` (Yahoo-derived regime snapshot: SPX 10M trend, RSP/SPY breadth, sector ratios XLY/XLP & XLK/XLU & MTUM/USMV, cross-asset VIX/DXY/^TNX/CL=F, global ^STOXX & ^N225, plus composite Risk-On/Neutral/Risk-Off label). Shape: a single JSON blob matching `MarketRegimeData` in `app/lib/market-regime.ts`. Pure cache (no user input) — recomputed on GET when older than 30 minutes or when `?refresh=1` is passed. On Yahoo failure the route falls back to the cached value (even if stale) rather than blanking. Safe to nuke (next GET rebuilds it).
- **`pm:attachments`** / **`pm:attachment:<id>`** — screenshot storage for the Brief (Equity Flows / Newton) and Research (Upticks / RBC). Split intentionally: `pm:attachments` holds only a lightweight manifest array (`id`, `label`, `section`, `addedAt` — no dataUrl), while each image's base64 dataUrl lives in its own `pm:attachment:<id>` key. This split is load-bearing: a single blob holding 11 JPM screenshots would exceed per-value write limits and silently drop on save, making attachments vanish across refreshes. Managed by `/api/kv/attachments` (manifest GET/PUT) and `/api/kv/attachments/[id]` (image GET/PUT/DELETE). The GET manifest route includes a one-shot lazy migration that splits any legacy inline-dataUrl entries. Safe to delete individual `pm:attachment:<id>` keys; the manifest will filter out missing ids on next hydration. When refactoring, NEVER reintroduce dataUrls into the manifest blob or into `pm:research.attachments` — research's `save` helper strips them before each PUT for the same reason.
- **`pm:edgar-ticker-map`** — cached SEC ticker→CIK mapping (the `company_tickers.json` file from sec.gov). Refreshed lazily every 7 days on first call after expiry. Pure cache (no user input). Safe to nuke (next call rebuilds it). Required by `app/lib/edgar.ts` for ticker-to-CIK resolution before fetching XBRL company facts.
- **`pm:edgar-submissions:{paddedCik}`** — cached SEC submissions metadata for a CIK (`data.sec.gov/submissions/CIK{paddedCik}.json`). Includes the `sic` code which drives industry classification (bank/insurance/REIT/SaaS/biotech/energy/etc.) for the EDGAR concept registry. Refreshed lazily every 7 days. Pure cache. Safe to nuke. Used by `app/lib/edgar-industry.ts`.
- **`pm:edgar-form4:{TICKER}`** — per-ticker cached SEC Form 4 insider-activity summary (officers / directors / 10%+ owners). Aggregates the last 90 days of OPEN-MARKET trades only (codes P=Purchase, S=Sale); deliberately excludes RSU grants/vests, option exercises, tax-withholding sales, and gifts. Refreshed lazily every 24 hours per ticker. Drives the `ownershipTrends` scoring category. Pure cache. Safe to nuke. Required by `app/lib/edgar-form4.ts`.
- **`pm:edgar-facts:{TICKER}`** — per-ticker cached XBRL company facts from `data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json`. Refreshed lazily every 24 hours on first call after expiry. Returns the full taxonomy of US-GAAP and DEI concepts for that issuer (every line item from every filing, ~5MB per ticker for large filers). Pure cache. Safe to nuke individual entries; next score will refetch. **Requires the `SEC_USER_AGENT` env var** to be set (the SEC rejects requests without a User-Agent identifying the caller via a contact email).
- **`pm:ratelimit:auth:*`** — per-IP login-attempt counters (auto-expire every 60s). Safe to ignore; not user data.
- **`pm:upticks-scrape-cache`** — hash-gated cache of the Anthropic vision parse of the Newton's Upticks screenshot (`{ hash, entries, analyzedAt }`). Mirrors the JPM-flows caching pattern in `app/api/morning-brief/route.ts`: the Refresh button in Research always POSTs the current upticks attachments to `/api/upticks-scrape`, but the route only spends Anthropic tokens when the image fingerprint changes. Safe to nuke (worst case: one re-scan on next Refresh).
- **`pm:research-scrape-cache:{source}`** — hash-gated cache of the Anthropic vision parse for the four non-Newton research sources, where `{source}` is one of `fundstrat-top` / `fundstrat-bottom` / `rbc-focus` / `seeking-alpha-picks`. Same `{ hash, entries, analyzedAt }` shape as the upticks cache and same semantics: `/api/research-scrape` only spends Anthropic tokens when the image fingerprint for that specific source changes (or `force: true` is passed). Each source caches independently so refreshing one doesn't invalidate the others. Safe to nuke individual keys (worst case: one re-scan on next Refresh for that source).
- **`pm:research-synthesis`** — PERSISTED cross-source synthesis blob shown at the top of the Research page (`{ result, generatedAt, generatedDate, briefRegime?, briefDate? }`). Strict stickiness model: once generated, the synthesis is anchored to the brief that existed at generation time and DOES NOT regenerate on page reload, even if the brief is regenerated mid-day. Reads use `GET /api/research-synthesis` (zero Anthropic spend). The first-ever generation auto-fires when no blob is persisted; subsequent reloads always read the cached blob. The "Force re-generate" button is the ONLY path that overwrites the persisted blob — it uses the current brief at the moment of the click. Portfolio holdings (from `pm:stocks` where `bucket === "Portfolio"`) are excluded from `topPicks` and `honorableMentions` both via prompt instruction and a server-side filter pass. Safe to nuke (next page load auto-generates a new one).
- **`pm:client-report-analysis-cache`** — hash-gated cache of the Anthropic-generated "Where you are now / Recommendations / Summary" bullets for the Client Report PDF (`{ hash, result }`). Same pattern as the upticks scrape: `/api/client-report-analysis` POSTs the full portfolio comparison payload (client holdings, model holdings, allocations, performance, per-ticker MERs, optional brief context). The hash is computed over a canonicalized projection so order-independent. `force: true` bypasses the cache when the user hits "Regenerate". Safe to nuke (worst case: the Generate button re-spends one Anthropic call on the next click).
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
