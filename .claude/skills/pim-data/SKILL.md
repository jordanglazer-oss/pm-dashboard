---
name: pim-data
description: PIM model + book data and rebalance math. Load BEFORE touching pm:pim-models, pm:pim-models-versions / pm:pim-models-version:<id>, pm:model-drafts (Stage changes, staged/back-dated rebalance, MODEL_SUBSTITUTES), pm:weight-decisions (monthly review, pins, release), pm:pim-positions, pm:pim-portfolio-state, pm:pim-performance, pm:sleeve-performance, pm:pim-sales-ledger, sleeve books (Core / Thematic / Alpha / Stocks book, pim|stocks), sleeveTargets / enforceSleeveTargets, three-bucket model, Positioning (weights-only, units), Build <profile> from <sibling>, Brief Performance panel, series auto-start / update-daily-value, holding history; and whenever the user mentions PIM models, rebalance, position weights, weightInClass, refPerStock, stock weights, FID5982, GRNJ, FINN, QQQM, or any per-stock/per-fund allocation math.
---

# PIM data, rebalance invariants and model books

> Before writing any key below, run the Redis-safety checklist in CLAUDE.md (keys touched, read-modify-write, concurrent writers, rollback, admin-route `?confirm=YES` + stash + diff, recent Blob backup). Everything here was moved verbatim from CLAUDE.md; nothing was summarised away.

# PIM Rebalance Invariants

These rules govern how holdings in `pm:pim-models` are weighted. Every one of them has real portfolio-performance consequences — a 2-bps drift compounds across 9 groups and every daily valuation. Treat them as contracts, not suggestions.

## The three equity pools

`rebalanceStockWeights` in `app/lib/StockContext.tsx` splits equity holdings in each group into three categories:

1. **Stocks** — every individual stock is pinned at `refPerStock = 0.018182` (≈ 1.82% of the equity class). Adding/removing a stock does NOT reshuffle the others.
2. **Locked holdings** — symbols in `LOCKED_EQUITY_SYMBOLS` pass through untouched. Their `weightInClass` is only ever set by the per-group Balanced % field on the stock page.
3. **ETFs** — absorb residual weight: `etfTotal = max(0, 1.0 - stockTotal - lockedTotal)`, distributed proportionally from `seedEtfWeights` (which excludes locked symbols when computing ratios).

Adding a stock increases `stockTotal` by `refPerStock`; the ETF pool shrinks by the same amount. Locked holdings never move.

## Pinned stocks (Review commits)

A stock holding may carry `pinned: { weightInClass, month, at }`, written by
`POST /api/weight-decisions/commit`. `rebalanceStockWeights` treats a pinned
stock exactly like a locked fund: pass-through at `pinned.weightInClass`,
never re-pinned to `refPerStock`. Only a "release" decision (or a restore of an
older version) removes the pin. Every server-side write of `pm:pim-models`
snapshots the blob first (`app/lib/model-versions.ts`); the PUT route refuses a
stale `revision` (409).

## Locked symbols

```ts
const LOCKED_EQUITY_SYMBOLS = new Set(["FID5982", "FID5982-T", "GRNJ"]);
```

Both `FID5982` and `FID5982-T` variants are listed because the persisted Redis blob uses the bare form while `pim-seed.ts` uses `-T`. Do NOT consolidate — keep both.

To change a locked symbol's weight, use the admin endpoint:

```
POST /api/admin/restore-holding-weight
{ "symbol": "FID5982", "balancedWeightPct": 4.5 }
```

It computes `weightInClass = (balancedWeightPct / 100) / group.profiles.balanced.equity` and writes it directly without triggering a rebalance. Only touches the named symbol.

## Profile scaling

`weightInClass` is stored once; the displayed weight is computed at render time:

```
displayedWeight = weightInClass × profileEquityAllocation
```

| Profile     | Equity allocation |
|-------------|-------------------|
| Balanced    | 0.66              |
| Growth      | 0.83              |
| All-Equity  | 1.00              |

So a locked symbol at `weightInClass = 0.068182` shows as:
- Balanced: 4.50%
- Growth: 5.66%
- All-Equity: 6.82%

NEVER store pre-scaled weights. Always store the in-class value and scale on render.

## Ticker suffix handling

`-T` / `.TO` suffix variants for Canadian listings are not normalized at the storage layer. Use `tickerMatch` (from `app/lib/types.ts`) for comparisons. Be especially careful when the Redis blob and seed data disagree on the suffix — both variants must be handled.

## Beta sources (related)

When refreshing holdings data, beta must come from the right source per instrument type:

- **Individual stocks** (`!instrumentType || instrumentType === "stock"`): Yahoo `summaryDetail.beta` → fallback `defaultKeyStatistics.beta3Year`, clamp `[-3, 5]`, round to 3 decimals.
- **ETFs / mutual funds**: Morningstar BetaM36 via `/api/fund-data`. Never overwrite a fund's beta with a Yahoo number.

The weighted Portfolio β chip in `PortfolioOverview.tsx` uses individual stocks only — ETFs/MFs are excluded from that calculation.

## Safe-edit checklist

Before modifying any rebalance / weight logic:

1. **Read the current `pm:pim-models` blob** via `/api/kv/pim-models` GET to know what's actually stored (not just what seeds suggest).
2. **Verify the math sums to 1.0** after your change: `sum(stockWeights) + sum(lockedWeights) + sum(etfWeights) === 1.0` within each group's equity pool.
3. **Confirm LOCKED symbols are untouched** by your code path.
4. **Never mutate weights in a migration/seed** — migrations must preserve whatever is currently persisted.
5. **If uncertain, ask the user** before writing. Weight changes propagate to automated performance numbers and cannot be silently reverted.

## Red flags — stop and confirm

- A change that calls `rebalanceStockWeights` on a path that previously didn't.
- A loop that touches every holding's weight (usually a sign of "reset" logic).
- Seed arrays being merged into Redis state without a locked-symbol guard.
- Any code that computes a weight without reading the current `weightInClass` first.


## Per-key detail (moved from CLAUDE.md)

- **`pm:pim-models`** — per-group equity/fixed-income holdings with `weightInClass` values. Drives every weight shown in PIM Model / Positioning tabs and the automated performance numbers. Since 2026-09-24 the blob carries a server-stamped **`revision`**: `PUT /api/kv/pim-models` refuses (409, returning the current model) any body whose `revision` is older than the stored one OR MISSING once the stored model has one (a tab whose load failed sits on the built-in sample models and carries no revision), and the client persist (`persistPim` in StockContext) is sequential, carries the newest revision it has seen, and on 409 reloads the server copy instead of overwriting and DROPS any saves queued before the refusal (`pimEpochRef`; they were built on the same stale copy) — this closes the stale-tab data-loss pattern for this key. A holding may carry **`pinned: { weightInClass, month, at }`** (set by a Review commit): `rebalanceStockWeights` SKIPS pinned stocks (pass-through like a hand-set fund) so a committed weight survives later trades until a "release" decision. Every server-side writer (Review commit, restore) snapshots the blob first — see `pm:pim-models-versions`.
- **`pm:pim-models-versions`** (index) + **`pm:pim-models-version:<id>`** (full snapshots) — the undo history of the models (`app/lib/model-versions.ts`). Written ONLY by `snapshotModels()` right before a Review commit or a restore writes `pm:pim-models`; a restore snapshots first too, so it is itself undoable. Named so `stash-prune` (`pm:*.pre-*`) never touches them; **BACKED UP**. Retention 730 days, never fewer than 10. `GET /api/model-versions[?id=]` is read-only (diff vs live); `POST /api/weight-decisions/restore` needs `confirm: "RESTORE <id>"`.
- **`pm:model-drafts`** — staged model changes (`app/lib/model-staging.ts`): `{ active: ModelDraft | null, history: ModelDraft[] (≤12 applied) }`. A draft = rows parsed from a target-model screenshot (`POST /api/model-staging/parse`, Anthropic vision, read-only — the image is never stored) + an ABSOLUTE proposed holdings list for every model group (the source model from the screenshot; the others PROPAGATED: names the source dropped leave, non-Core names follow the source's weight change, new names join where `modelEligibility` allows and never US-situs into No US Situs, Core ETFs absorb the residual — mirroring the source's new Core mix when the model's Core is drawn from the same ETFs). Edited in the "Stage changes…" subwindow on PIM Model. `POST /api/kv/model-drafts` saves ONLY the active draft (409 if a different draft is active, unless `replace`). **Nothing here reaches `pm:pim-models`** except `POST /api/model-staging/apply` (`confirm: "APPLY"`, refuses unless the live `revision` equals the one the PM reviewed, validates every class sums to 100%, `snapshotModels` first, replaces only each staged group's `holdings`, pins stocks staged off `REF_PER_STOCK`, bumps revision). The applied draft keeps `exits[groupId]`; Positioning's Rebalance sells EXACTLY those symbols to zero (applied ≤45 days ago) — any other orphan position stays untraded as before. Apply never writes `pm:stocks`/`pm:pim-positions`; bucket follow-ups are offered as buttons. **Apply + record a back-dated rebalance** — `POST /api/model-staging/rebalance` (`app/lib/staged-rebalance.ts` plans, `app/lib/staged-apply.ts` is the shared apply): `mode: "plan"` is a read-only dry run; `mode: "commit"` (confirm `REBALANCE <asOf>`, asOf = one of the last 5 trading days, refused if any PIM transaction is dated after asOf; the trade list is REBUILT from the live models + positions at commit, so a model save between Build and commit is logged, not refused — the revision guard covers only a write DURING the request; FUNDSERV NAVs may be typed in to override the fetched one) refreshes performance so asOf is recorded on the OLD holdings, refuses unless every PIM book's series has an asOf entry, stashes `pm:pim-performance` / `pm:pim-positions` / `pm:pim-portfolio-state` at `<key>.pre-staged-rebalance-<ts>`, ANCHORS each series at asOf and drops later entries (cutover = asOf close; the daily job then recomputes every day after asOf on the new positions and the Appendix replaces those days by date), applies the models (snapshot), then writes every PIM book (units sized off the PRIOR close; stocks/ETFs at the PM's average fill = cost basis; FUNDSERV funds settle at asOf's NAV; Alpha book = everything outside Core (stocks + Thematic funds); positions the new model drops sold to zero) and the transactions + `lastRebalance` dated asOf 4 pm ET, and refreshes performance again. The client then tags roles, moves names leaving every model to the Watchlist, flushes `pm:stocks` and reloads the page. Yahoo class-share symbols (`QQC.F-T` → `QQC-F.TO`) go through `yahooClassShare` (`app/lib/yahoo-symbol.ts`) at every model/performance price fetch. Per-model substitutes (`MODEL_SUBSTITUTES` in model-staging.ts): Non-Res holds FINN (FINN.NE / FINN-T) in place of FID5982, and PC USA holds QQQM in place of BOTH of PIM's Nasdaq ETFs (QQQX.U + the CAD-hedged QQC.F, which has no home in PC USA's CAD-stocks-only CAD side) — QQQM = their combined weight, so the Nasdaq share of the TOTAL model matches PIM and its USD-model share follows from the currency split. Every source change to the original (weight, bucket, removal) is applied to the substitute there, and it sits in the original's bucket. An index ETF new to a model (and a substitute index ETF like QQQM) is held at the source's share of its CURRENCY model (QQQX.U = 10% of PIM's USD model → 10% of every model's USD model); the index ETFs the model already held absorb the rest. Backed up. Losing it costs an unapplied draft only.
- **`pm:weight-decisions`** — the monthly review's per-name target decisions (`app/lib/weight-decisions.ts`): `{ months: { "YYYY-MM": { status: draft|committed, decisions: { [symbol]: { action: keep|adopt|set|release, targetInClass?, note? } }, stashKey? } } }`. Drafts save per symbol by read-merge-write; a committed month is immutable. `POST /api/weight-decisions/commit` (needs `confirm: "COMMIT YYYY-MM"`) re-runs `reconcile()` server-side against the LIVE model (same-BUCKET netting — Alpha stocks net among Alpha, Thematic funds among Thematic, Core is never decided; 10%-of-portfolio stock cap), snapshots, writes PIM with `applyDecisions` + every other model with `inheritDecisions` (FINN follows FID5982 in Non-Res), runs `enforceSleeveTargets` so the commit lands on the bucket targets, refuses if any equity sleeve no longer sums to 1, marks the month committed and journals each change. A "release" returns a stock to `releaseWeight()` (the Alpha per-stock share after the month's pins; the old 1.82% only without bucket targets). **BACKED UP.** The Thesis / Tactical alpha-sleeve tags (`inThesis` / `inTactical` on pm:stocks, `pm:alpha-sleeves`, `pm:position-theses[TK].tacticalPlan`) were RETIRED in Oct 2026 — the fields may remain on stored records, nothing reads or writes them; do not reintroduce them. Thesis coverage (kill sweep, verdicts, alerts) = every HELD underwritten name. Since Phase 2 (Nov 2026) EVERY short-term condition kind (`SHORT_TERM_KINDS` in `kill-conditions.ts`: SIA, Equate, MarketEdge, score floor/decay, revisions, risk alert, 200-day, technical) reads `info` ("context only") when met and never counts as a trip, for every thesis — only `metric` guards and `custom` breakers can trip.
- **`pm:pim-portfolio-state` is merge-on-write (Nov 2026)** — the trade log only grows from the browser (a settle replaces a pending entry under the SAME id; nothing deletes one), so `PUT /api/kv/pim-portfolio-state` keeps any stored group missing from the body and any stored transaction (by `id`) missing from a group, and never nulls a stored `lastRebalance` / `trackingStart`. A tab whose load failed, or one opened before a staged rebalance, can no longer erase history. Removing a transaction therefore needs a server-side route, not the client PUT.
- **`pm:pim-performance` is BACKED UP (since 2026-11-15)** — it holds anchors, back-dated cut-overs and seeded series that cannot be recomputed. Only `pm:pim-performance.pre-*` stashes stay out of the nightly backup. A failed backup run emails ALERT_EMAIL_TO (`app/lib/backup-alert.ts`, via pm:mail-outbox), and the weekday daily-value cron separately emails when the newest backup is over 30h old.
- **`pm:sleeve-performance`** — **NO LONGER UPDATED (Nov 2026)**: the Sleeves vs Core panel now reads the Core / Thematic / Alpha books in `pm:pim-performance` (one engine, fed by the Positioning books' units); the daily-value cron no longer calls `updateSleevePerformance`. Kept as a historical record; do not clobber. Originally: weights-based sleeve series (Nov 2026, `app/lib/sleeve-performance.ts`): Core / Thematic / Stocks (Alpha) / Stocks + Thematic, each tracked FORWARD from the PIM model's equity weights (renormalised within the sleeve, drifting with prices, reset to targets when the model's sleeve changes — logged in `events`). NO units or positions — it exists because the units-based Alpha book never held the Thematic funds. `{ startedAt, lastDate, series: { id: { history[{date,value,dailyReturn}], weights, targetsKey } }, events, updatedAt }`. APPEND-ONLY, single writer `updateSleevePerformance` (weekday daily-value cron + `POST /api/sleeve-performance`); starts at 100 on the first run; a FUNDSERV NAV not yet posted holds the day back ≤ 3 days. Shown on /aa-performance ("Sleeves vs Core", any preset or custom date range). One-time BACKFILL (`backfillSleeveHistory`, `GET|POST /api/sleeve-performance/backfill`, confirm `BACKFILL`): history BEFORE `startedAt` is filled from pm:pim-performance (core ← core, thematic ← thematic, stocks ← alpha — the units Alpha book held only stocks; nonCore has no source), rescaled to meet at startedAt, marked `backfilledFrom` per series; stashes `pm:sleeve-performance.pre-backfill-<ts>` first and never touches entries on/after startedAt. The existing pm:pim-performance series are read-only here. **BACKED UP.** Losing it loses the history (it restarts at 100).
- **Thematic positions book + "Add missing names" (Nov 2026, `PimPortfolio.tsx`)** — Positioning has a **Thematic** tab for the PIM group (equity-only, the Thematic funds renormalised), so the existing `pim|thematic` series runs on units. Since Nov 2026 the Core and Thematic books are first-class in every trade path: `executeRebalanceForProfile` sizes them (equity-only, their bucket) so "Rebalance all profiles" reaches them at the same shared prices; buy-only sizes them to their sleeve target; and after any trade a "Sleeve books" step re-sizes a Core / Thematic book to its sleeve's model targets at the trade's prices ONLY when its membership changed (a stray non-member, a missing member, or idle cash > 1%) — books whose membership didn't change keep their drift; an unbuilt book stays unbuilt. A book with NO units uses the existing "Build <profile> from <sibling>" seed; a book with SOME units but model names missing (the Alpha book never held the Thematic funds) gets an "Add N at model weight" plan: each missing name sized at its model weight of the enlarged book (total = current value ÷ (1 − missing weight)), existing units/cost untouched, new cost = today's C$ price — written via the page's usual `PUT /api/kv/pim-positions` after a confirm. `bookTargets` in `staged-rebalance.ts` treats a `thematic` book as Thematic funds only.
- **`pm:pim-sales-ledger`** — APPEND-ONLY record of every write that REDUCED a position's units (`app/lib/sales-ledger.ts`): `{ events: [{ id, at, date, groupId, profile, source: client|staged-rebalance, sales: [{ symbol, unitsBefore, unitsAfter, costBasis }], bookBefore[] }] }`, capped at 1500. Exists because the trade log stores a sale's price and target weight but not the units sold or the average cost at that moment, so realized gains could not be tallied afterwards. A WRITE-ASIDE from `PUT /api/kv/pim-positions` and the staged-rebalance commit: it never changes what is saved to `pm:pim-positions` and never throws. An entry is a fact about units, not proof of a trade (Edit positions lowering a weight is recorded too) — pair it with a sell in the trade log before calling it a realized sale. Only covers writes from 2026-11-19 on. **BACKED UP.**
- **Stocks book (Nov 2026)** — `pim|stocks` in `pm:pim-positions` + `pm:pim-performance`: the individual stocks ALONE (no Core ETFs, no Thematic funds), so the stock picks have their own record now that the Alpha book also holds the Thematic funds. Created ONCE by `GET /api/admin/seed-stocks-book` (dry run default, `&confirm=YES`; refuses if a Stocks series/book exists or the backup's Alpha book held non-stocks; refuses if the live Alpha series and the backup ledger disagree >10 days before the cut date; stashes pm:pim-performance / pm:pim-positions / pm:appendix-daily-values `.pre-stocks-seed-<ts>`): pm:pim-performance was NOT in the nightly backups at the time (it is since 2026-11-15; only its `.pre-*` stashes are excluded), so the source of truth is the Alpha ledger in pm:appendix-daily-values of the pre-fill backup `backups/2026-11-11T22-56-27-248Z.json` (the Alpha book held only stocks until "Add N at model weight" on 2026-11-11). Series = live Alpha up to that ledger's last date (cut date) with ledger values winning, last entry anchored, plus a matching `stocks` Appendix ledger; book = the live Alpha book's stock positions, units/cost untouched (today's Positioning weights) + its cash; Alpha dates on/before the cut date recomputed after the fill are restored from the ledger (series + Appendix), the cut date anchored, later days keep their daily returns with values re-chained. PimPerformance's Appendix validation skips the `stocks` ledger like `alpha`. Daily value counts only non-Core, non-Thematic equity for it. Rebalance / buy-only treat it like the other sleeve books; after a trade that changes its membership it keeps its DRIFT (strays sold, a new stock enters at its model share of the stocks, held names scale together) rather than resetting to model weights. The Positioning tab appears only once the book exists. `PUT /api/kv/pim-positions` and `PUT /api/kv/pim-performance` now KEEP any book / series missing from the body (a tab loaded before a book was added can't drop it).
- **"Build <profile> from <sibling>" (Nov 2026)** defaults to the sibling's CURRENT weights inside each asset class (Positioning drift), scaled to the profile's own mix; names the sibling doesn't hold take their model share. "At the model target weights" remains as an option.
- **Brief → Performance panel (Nov 2026, `app/components/brief/PerformancePanel.tsx`)** — right under The bottom line, replacing the Alpha vs core cell: every PIM book (Core / Thematic / Alpha / Stocks, then Conservative → All-Equity) plus S&P 500 / TSX, by 1D · 1W · 1M · QTD · YTD (+ an optional custom From–To range column), every cell showing the return with its points vs Core beneath — no clicking. READ-ONLY and LIVE without regenerating the brief: history from `/api/kv/pim-performance` (re-read every 5 min), today's move from `useLiveTodayReturn` (re-priced every minute 9:30–17:00 ET) compounded onto the last close only when the series hasn't closed today; markets compound a live `/api/prices` move onto the summary's benchmark returns. No blended benchmark — Core is the yardstick.
- **Series auto-start (Nov 2026, `update-daily-value`)** — a `pim` positions book with units but NO performance series gets one (from its Appendix ledger if present, else at 100 on the last weekday close + the day before, anchored, with a matching Appendix ledger). Exists because the per-model loop only updates EXISTING series, so a book given units on Positioning (the Thematic book) was never tracked.
- **Holdings since first purchase** (Nov 2026, `app/lib/holding-history.ts`, `GET /api/holding-history`, panel on /aa-performance) — READ-ONLY view built from `pm:pim-portfolio-state` (PIM group trade log) + price history; stores nothing. A rebalance's per-profile trades collapse to one decision per symbol per day (All-Equity target when present), classed Bought / Raised target / Cut target / Rebalanced / Sold out by the target's move.

## Architecture notes (moved from CLAUDE.md)

### PIM rebalance invariants (in `StockContext.tsx`)
The `rebalanceStockWeights` function splits equity into three pools:
1. **Stocks** — locked at `refPerStock = 0.018182` (1.82% of class) each.
2. **Locked holdings** — symbols in `LOCKED_EQUITY_SYMBOLS` (`FID5982`, `FID5982-T`, `GRNJ`) — pass through unchanged. These are specialty funds whose weight is set by the per-group Balanced % input, not by residual math.
3. **ETFs** — absorb residual: `etfTotal = max(0, 1.0 - stockTotal - lockedTotal)`, distributed proportionally from seed ratios (excluding locked symbols).

Profile scaling: `displayedWeight = weightInClass × profileEquityAllocation`. Balanced 0.66, Growth 0.83, All-Equity 1.0 — applied at render time, not stored.

When adding/removing a holding to a group, **do not** re-run rebalance on locked symbols. When migrating data, preserve the locked-symbol weights verbatim.

### Three-bucket equity model (Oct 2026): Core / Thematic / Alpha
PIM equity is three buckets: **Core** (index ETFs, `designation: "core"`, absorb the residual), **Thematic** (`designation: "thematic"` — thematic/specialty funds, each held at a set weight), **Alpha** (individual stocks ONLY). Targets live on `pm:pim-models.sleeveTargets` `{ core, thematic, alpha, since }`, written ONLY by a Stage changes apply (`/api/model-staging/apply`, from a screenshot whose row colours give the buckets, or "Start from live models" + "Resize buckets"). While present, `enforceSleeveTargets` (`app/lib/sleeve-targets.ts`) runs on EVERY client write of the models (`withSleeves` in StockContext, incl. `updatePimModels`): each unpinned stock = (alpha − PIM's pinned stocks) / PIM's unpinned stock count, in EVERY model (PIM sets, others derive); Thematic + pinned pass through; Core absorbs keeping its own mix (the seed-ratio Core reshuffle in `rebalanceStockWeights` is skipped). No targets → identity. Every legacy `=== "core"` check treats `"thematic"` as non-Core (pass-through), which is intended. Each equity holding carries its bucket ON the model (`PimHolding.bucket`, written by a Stage changes apply / the re-tag tool); every reader resolves Core/Thematic through `bucketTests` / `modelBucketLookup` / `holdingBucket` (`sleeve-targets.ts`) — model bucket first, pm:stocks designation only as the fallback. Performance: the firm-wide **Alpha series, book and view = everything outside Core (stocks + Thematic funds)** since late Oct 2026 (PM's call); the `pim|thematic` series (seeded at 100 by the first bucket apply, accrued by `update-daily-value`) tracks the Thematic funds on their own as well. Append-only — past Alpha history is never recomputed by a split change.

### Positioning is weights-only (Oct 2026)
The Positioning tab shows and takes WEIGHTS only — Price · Gain % · Model · Live · Drift; no units / C$ value / ACB C$ / Gain C$ columns, tiles or trade previews. The engine is unchanged on purpose: `pm:pim-positions` still stores notional `units` + `costBasis` (C$ per unit) per book, because units ARE the price-drifted weights (daily return = Σ live weight × return, identical to units × price), and every performance / Appendix / Client Report reader keeps working. Edit positions takes each name's live % (a weight left as shown keeps its exact units; units = weight × book value ÷ live C$ price; the remainder is cash) plus the average cost (C$ / unit) that drives Gain %. A persisted **Show units** toggle (`positioning.showUnits` in pm:ui-prefs, off by default) reveals Units / Value C$ / ACB C$ / Gain C$ read-only. Never reintroduce unit ENTRY in the UI; never change the engine to "weights" without re-validating every positions reader.
