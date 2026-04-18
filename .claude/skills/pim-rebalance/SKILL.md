---
name: pim-rebalance
description: Rules, invariants, and safe-edit procedures for PIM model weights, rebalancing, and position sizing. Load whenever the user mentions PIM models, rebalance, position weights, weightInClass, stock weights, FID5982, GRNJ, or any per-stock/per-fund allocation math.
---

# PIM Rebalance Invariants

These rules govern how holdings in `pm:pim-models` are weighted. Every one of them has real portfolio-performance consequences — a 2-bps drift compounds across 9 groups and every daily valuation. Treat them as contracts, not suggestions.

## The three equity pools

`rebalanceStockWeights` in `app/lib/StockContext.tsx` splits equity holdings in each group into three categories:

1. **Stocks** — every individual stock is pinned at `refPerStock = 0.018182` (≈ 1.82% of the equity class). Adding/removing a stock does NOT reshuffle the others.
2. **Locked holdings** — symbols in `LOCKED_EQUITY_SYMBOLS` pass through untouched. Their `weightInClass` is only ever set by the per-group Balanced % field on the stock page.
3. **ETFs** — absorb residual weight: `etfTotal = max(0, 1.0 - stockTotal - lockedTotal)`, distributed proportionally from `seedEtfWeights` (which excludes locked symbols when computing ratios).

Adding a stock increases `stockTotal` by `refPerStock`; the ETF pool shrinks by the same amount. Locked holdings never move.

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
