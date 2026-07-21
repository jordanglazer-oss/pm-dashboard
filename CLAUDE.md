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

- **`pm:stocks`** — the user's portfolio + watchlist. Both buckets live in this single JSON blob (`bucket: "Portfolio" | "Watchlist"` on each entry). Losing this means the user re-enters every position by hand.
- **`pm:pim-models`** — per-group equity/fixed-income holdings with `weightInClass` values. Drives every weight shown in PIM Model / Positioning tabs and the automated performance numbers.
- **`pm:pim-positions`**, **`pm:pim-portfolio-state`**, **`pm:hedging-history`**, **`pm:client-portfolio`**, **`pm:client-report-notes`**, **`pm:appendix-daily-values`**, **`pm:aa-performance`**, **`pm:pim-performance`**, **`pm:brief`**, **`pm:research`**, **`pm:scanner`**, **`pm:fund-data-cache`**, **`pm:chart-analysis`**, **`pm:attachments`**, **`pm:ui-prefs`**, **`pm:market`**, **`pm:hedging-custom-strikes`** — all user-edited or expensive-to-rebuild state.
- **`pm:portfolio-snapshots`** — **append-only** daily history of sector breakdowns and top holdings per (date, group, profile). Past-dated writes are rejected by the route. Used for trend analysis; losing it means losing all historical drift data.
- **`pm:score-history`** — **append-only** per-ticker log of composite score changes. Shape: `{ [ticker]: Entry[] }` where each `Entry` is `{ date, timestamp, total, raw, adjusted, scores }`. Written by the stock page's `handleRescore` flow (via `POST /api/kv/score-history`) once the fresh score has propagated into context. Same date-validation invariant as `pm:portfolio-snapshots`: POST rejects entries whose `date` is not today (server UTC). Read by the Score History tile on the stock page. Informational-only — not fed into alerts or composite math.
- **`pm:market-regime`** — cached output of `/api/market-regime` (Yahoo-derived regime snapshot: SPX 10M trend, RSP/SPY breadth, sector ratios XLY/XLP & XLK/XLU & MTUM/USMV, cross-asset VIX/DXY/^TNX/CL=F, global ^STOXX & ^N225, plus composite Risk-On/Neutral/Risk-Off label). Shape: a single JSON blob matching `MarketRegimeData` in `app/lib/market-regime.ts`. Pure cache (no user input) — recomputed on GET when older than 30 minutes or when `?refresh=1` is passed. On Yahoo failure the route falls back to the cached value (even if stale) rather than blanking. Safe to nuke (next GET rebuilds it).
- **`pm:attachments`** (manifest, Redis) + **Blob `attachments/<id>`** (files) — screenshot AND PDF storage for the Brief (Equity Flows / Newton) and Research (Upticks / Fundstrat / RBC / Alpha Picks). Split intentionally: `pm:attachments` holds only a lightweight manifest array (`id`, `label`, `section`, `addedAt` — no dataUrl); each file's dataUrl now lives in **Vercel Blob** at `attachments/<id>` (it used to be a `pm:attachment:<id>` Redis key — that was an OOM source; a legacy Redis fallback remains for un-migrated reads). The dataUrl can be `data:image/...;base64,...` (image, max 10MB raw — re-compressed to JPEG client-side) OR `data:application/pdf;base64,...` (PDF, max 15MB raw, pass-through with no re-encoding). Backend block builders in upticks-scrape, research-scrape, and morning-brief detect the MIME prefix and emit either an Anthropic `image` block or a `document` block (PDF). The hash-gated cache pattern works identically for both — same dataUrl → same hash → cache hit. Split storage is load-bearing: a single blob holding 11 JPM screenshots would exceed per-value write limits and silently drop on save, making attachments vanish across refreshes. Managed by `/api/kv/attachments` (manifest GET/PUT) and `/api/kv/attachments/[id]` (file GET/PUT/DELETE). The GET manifest route includes a one-shot lazy migration that splits any legacy inline-dataUrl entries. Safe to delete individual `pm:attachment:<id>` keys; the manifest will filter out missing ids on next hydration. When refactoring, NEVER reintroduce dataUrls into the manifest blob or into `pm:research.attachments` — research's `save` helper strips them before each PUT for the same reason.
- **`pm:brief-prevday`** — compact digest (regime, verdict, bottom line, hedging + cash calls, dates) of the most recent brief from a PREVIOUS Eastern day. Written by `/api/morning-brief` whenever it finds a prior-day brief in `pm:brief` at generation time; read when the brief is REGENERATED same-day so the "since last brief" comparison stays anchored to the previous trading day instead of the earlier same-day run. Regenerable cache — safe to nuke (worst case: one same-day regeneration compares against the earlier same-day brief, clearly labeled).
- **`pm:edgar-ticker-map`** — cached SEC ticker→CIK mapping (the `company_tickers.json` file from sec.gov). Refreshed lazily every 7 days on first call after expiry. Pure cache (no user input). Safe to nuke (next call rebuilds it). Required by `app/lib/edgar.ts` for ticker-to-CIK resolution before fetching XBRL company facts.
- **`pm:edgar-submissions:{paddedCik}`** — cached SEC submissions metadata for a CIK (`data.sec.gov/submissions/CIK{paddedCik}.json`). Includes the `sic` code which drives industry classification (bank/insurance/REIT/SaaS/biotech/energy/etc.) for the EDGAR concept registry. Refreshed lazily every 7 days. Pure cache. Safe to nuke. Used by `app/lib/edgar-industry.ts`.
- **`pm:edgar-form4:{TICKER}`** — per-ticker cached SEC Form 4 insider-activity summary (officers / directors / 10%+ owners). Aggregates the last 90 days of OPEN-MARKET trades only (codes P=Purchase, S=Sale); deliberately excludes RSU grants/vests, option exercises, tax-withholding sales, and gifts. Refreshed lazily every 24 hours per ticker. Drives the `ownershipTrends` scoring category. Pure cache. Safe to nuke. Required by `app/lib/edgar-form4.ts`.
- **`pm:edgar-facts:{TICKER}`** — per-ticker cached XBRL company facts from `data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json`. Refreshed lazily every 24 hours on first call after expiry. Returns the full taxonomy of US-GAAP and DEI concepts for that issuer (every line item from every filing, ~5MB per ticker for large filers). Pure cache. Safe to nuke individual entries; next score will refetch. **Requires the `SEC_USER_AGENT` env var** to be set (the SEC rejects requests without a User-Agent identifying the caller via a contact email).
- **`pm:fund-data-negative:{TICKER}`** — negative cache for tickers `/api/fund-data` confirmed don't have data (Morningstar IDs Yahoo can't resolve, delisted symbols, insurance variable annuity funds, etc.). Auto-expires after 7 days; subsequent calls return a fast `404 { cached: true }` instead of paying another multi-second Yahoo timeout. Force a re-attempt with `?force=1`. Without this, every Client Report load and PIM model refresh would re-pay the slow lookup for every untranslatable ticker on every page open. Safe to nuke individual entries.
- **`pm:ratelimit:auth:*`** — per-IP login-attempt counters (auto-expire every 60s). Safe to ignore; not user data.
- **`pm:upticks-scrape-cache`** — hash-gated cache of the Anthropic vision parse of the Newton's Upticks screenshot (`{ hash, entries, analyzedAt }`). Mirrors the JPM-flows caching pattern in `app/api/morning-brief/route.ts`: the Refresh button in Research always POSTs the current upticks attachments to `/api/upticks-scrape`, but the route only spends Anthropic tokens when the image fingerprint changes. Safe to nuke (worst case: one re-scan on next Refresh).
- **`pm:research-scrape-cache:{source}`** — hash-gated cache of the Anthropic vision parse for the four non-Newton research sources, where `{source}` is one of `fundstrat-top` / `fundstrat-bottom` / `fundstrat-smid-top` / `fundstrat-smid-bottom` / `rbc-focus` / `rbc-us-focus` / `seeking-alpha-picks`. Same `{ hash, entries, analyzedAt }` shape as the upticks cache and same semantics: `/api/research-scrape` only spends Anthropic tokens when the image fingerprint for that specific source changes (or `force: true` is passed). Each source caches independently so refreshing one doesn't invalidate the others. Safe to nuke individual keys (worst case: one re-scan on next Refresh for that source).
- **`pm:research-synthesis`** — PERSISTED cross-source synthesis blob shown at the top of the Research page (`{ result, generatedAt, generatedDate, briefRegime?, briefDate? }`). Strict stickiness model: once generated, the synthesis is anchored to the brief that existed at generation time and DOES NOT regenerate on page reload, even if the brief is regenerated mid-day. Reads use `GET /api/research-synthesis` (zero Anthropic spend). The first-ever generation auto-fires when no blob is persisted; subsequent reloads always read the cached blob. The "Force re-generate" button is the ONLY path that overwrites the persisted blob — it uses the current brief at the moment of the click. Portfolio holdings (from `pm:stocks` where `bucket === "Portfolio"`) are excluded from `topPicks` and `honorableMentions` both via prompt instruction and a server-side filter pass. Safe to nuke (next page load auto-generates a new one).
- **`pm:client-report-analysis-cache`** — hash-gated cache of the Anthropic-generated "Where you are now / Recommendations / Summary" bullets for the Client Report PDF (`{ hash, result }`). Same pattern as the upticks scrape: `/api/client-report-analysis` POSTs the full portfolio comparison payload (client holdings, model holdings, allocations, performance, per-ticker MERs, optional brief context). The hash is computed over a canonicalized projection so order-independent. `force: true` bypasses the cache when the user hits "Regenerate". Safe to nuke (worst case: the Generate button re-spends one Anthropic call on the next click).
- **Blob `backups/<sanitized-iso>.json`** (was `pm:backup:YYYY-MM-DD` in Redis) — nightly full-database backups written by the `/api/cron/backup-redis` cron (06:00 UTC daily, configured in `vercel.json`). Each file is a JSON blob `{ backedUpAt, keyCount, totalBytes, data: { key → value } }` capturing every `pm:*` key EXCEPT the regenerable caches + bulky binaries (see `EXCLUDE_PATTERNS` in `backup-now`). Stored in **Vercel Blob** now (durable even if Redis is lost; can't OOM the live tier), via `app/lib/backup-store.ts`. Retention: 30 days (pruned by Blob `uploadedAt`). To restore, use `restore-from-backup` (takes a Blob `pathname` from `list-backups`) or read a snapshot and replay each `data[key]` via `redis.set`. The cron still requires `CRON_SECRET`; `/api/cron/*` is exempted from the auth-cookie middleware so Vercel's cron runner (header auth) can reach it.

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
