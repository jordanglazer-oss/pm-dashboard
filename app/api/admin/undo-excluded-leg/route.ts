import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type {
  PimModelGroup,
  PimPortfolioPositions,
  PimPortfolioState,
} from "@/app/lib/pim-types";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("Undo-excluded-leg");

const PIM_MODELS_KEY = "pm:pim-models";
const PIM_POSITIONS_KEY = "pm:pim-positions";
const PIM_STATE_KEY = "pm:pim-portfolio-state";

/**
 * GET /api/admin/undo-excluded-leg
 *   ?groups=non-res,cgf          model group ids OR names (case-insensitive)
 *   &sell=JBND-T                 the sold symbol (-T / .TO variants both match)
 *   &buy=RBF5280                 the bought symbol
 *   &fraction=0.10               fraction of the position that was sold
 *   &date=2026-08-26             optional; transaction rows on this date are
 *                                removed (defaults to today, server UTC)
 *   &confirm=YES                 REQUIRED to write; without it: dry-run diff
 *
 * Surgically unwinds ONE partial-switch's effects in models that were meant
 * to be excluded from the trade. Before the both-legs-skip fix, unticking a
 * model only blocked the BUY: the sell still trimmed the model target there
 * (freed weight redistributed to the sleeve's siblings) and still reduced the
 * position's units — leaving e.g. Non-Res fixed income at 15.4% / 12.6%
 * instead of 14% / 14%.
 *
 * Per named group, this endpoint:
 *   1. pm:pim-models — restores the sold holding's weightInClass to
 *      w / (1 - fraction) and scales its same-class siblings back down
 *      proportionally, so the sleeve still sums to exactly what it did.
 *      If the bought symbol is present in the group's holdings it is
 *      reported and the group is SKIPPED (state doesn't match the
 *      excluded-leg failure mode).
 *   2. pm:pim-positions — restores the sold position's units to
 *      units / (1 - fraction) and removes the bought position outright
 *      (the buy should never have landed in an excluded model's book).
 *      Cash is untouched — the switch path never touched it.
 *   3. pm:pim-portfolio-state — removes this trade's transaction rows
 *      (sell of `sell` paired with `buy`, buy of `buy` paired with `sell`)
 *      dated `date` in the named groups. Partial sells never update
 *      lastRebalance.prices, so there is nothing to undo there.
 *
 * Safety: dry-run by default; on confirm the prior value of every key it
 * writes is stashed first (`<key>.pre-undo-excluded-<ts>`), and the response
 * is a full before/after diff.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const groupsParam = (url.searchParams.get("groups") || "").trim();
    const sell = (url.searchParams.get("sell") || "").trim().toUpperCase();
    const buy = (url.searchParams.get("buy") || "").trim().toUpperCase();
    const fraction = Number(url.searchParams.get("fraction"));
    const date = (url.searchParams.get("date") || new Date().toISOString().slice(0, 10)).trim();
    const confirm = url.searchParams.get("confirm") === "YES";

    if (!groupsParam || !sell || !buy) {
      return NextResponse.json(
        { error: "groups, sell and buy query params required" },
        { status: 400 },
      );
    }
    if (!isFinite(fraction) || fraction <= 0 || fraction >= 1) {
      return NextResponse.json(
        { error: "fraction must be a number in (0, 1), e.g. 0.10 for a 10% partial sell" },
        { status: 400 },
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
    }

    const norm = (s: string) => (s || "").toUpperCase().replace(/-T$/, ".TO");
    const symEq = (a: string, b: string) => norm(a) === norm(b);

    const redis = await getRedis();
    const [pimRaw, posRaw, stateRaw] = await Promise.all([
      redis.get(PIM_MODELS_KEY),
      redis.get(PIM_POSITIONS_KEY),
      redis.get(PIM_STATE_KEY),
    ]);
    if (!pimRaw) {
      return NextResponse.json({ error: "pm:pim-models not found" }, { status: 404 });
    }

    const pim = JSON.parse(pimRaw) as { groups: PimModelGroup[]; lastUpdated?: string };
    const posBlob = posRaw
      ? (JSON.parse(posRaw) as { portfolios?: PimPortfolioPositions[] })
      : { portfolios: [] };
    const portfolios = Array.isArray(posBlob.portfolios) ? posBlob.portfolios : [];
    const state: PimPortfolioState | null = stateRaw ? JSON.parse(stateRaw) : null;

    // Resolve requested groups by id or name, case-insensitive.
    const wanted = groupsParam.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const targetGroups = pim.groups.filter(
      (g) => wanted.includes(g.id.toLowerCase()) || wanted.includes(g.name.toLowerCase()),
    );
    const unresolved = wanted.filter(
      (w) => !targetGroups.some((g) => g.id.toLowerCase() === w || g.name.toLowerCase() === w),
    );
    if (targetGroups.length === 0) {
      return NextResponse.json(
        { error: `no model groups matched: ${groupsParam}`, availableGroups: pim.groups.map((g) => ({ id: g.id, name: g.name })) },
        { status: 404 },
      );
    }
    const targetIds = new Set(targetGroups.map((g) => g.id));

    // ── 1. Models: restore sold weight, scale siblings back down. ─────────
    const modelDiffs: Array<{
      groupId: string; groupName: string;
      changes: Array<{ symbol: string; weightInClassBefore: number; weightInClassAfter: number }>;
      skippedReason?: string;
    }> = [];
    const updatedGroups = pim.groups.map((g) => {
      if (!targetIds.has(g.id)) return g;
      const sold = g.holdings.find((h) => symEq(h.symbol, sell));
      if (!sold) {
        modelDiffs.push({ groupId: g.id, groupName: g.name, changes: [], skippedReason: `${sell} not in this model` });
        return g;
      }
      if (g.holdings.some((h) => symEq(h.symbol, buy))) {
        modelDiffs.push({ groupId: g.id, groupName: g.name, changes: [], skippedReason: `${buy} IS present in this model — state does not match the excluded-leg failure mode; not touching it` });
        return g;
      }
      const restored = sold.weightInClass / (1 - fraction);
      const freed = restored - sold.weightInClass;
      const siblings = g.holdings.filter(
        (h) => h.assetClass === sold.assetClass && h !== sold && h.weightInClass > 0,
      );
      const sibTotal = siblings.reduce((s, h) => s + h.weightInClass, 0);
      if (siblings.length === 0 || sibTotal <= freed) {
        modelDiffs.push({ groupId: g.id, groupName: g.name, changes: [], skippedReason: `no ${sold.assetClass} siblings able to give back ${freed.toFixed(6)} of class weight — was the trade really redistributed here?` });
        return g;
      }
      // Reverse of the proportional absorption: each sibling gave nothing and
      // received freed × (its pre-trade share); scaling every sibling by
      // (sibTotal − freed) / sibTotal recovers the pre-trade weights exactly
      // and keeps the sleeve sum unchanged.
      const scale = (sibTotal - freed) / sibTotal;
      const changes: Array<{ symbol: string; weightInClassBefore: number; weightInClassAfter: number }> = [];
      const holdings = g.holdings.map((h) => {
        if (h === sold) {
          changes.push({ symbol: h.symbol, weightInClassBefore: h.weightInClass, weightInClassAfter: restored });
          return { ...h, weightInClass: restored };
        }
        if (siblings.includes(h)) {
          const after = h.weightInClass * scale;
          changes.push({ symbol: h.symbol, weightInClassBefore: h.weightInClass, weightInClassAfter: after });
          return { ...h, weightInClass: after };
        }
        return h;
      });
      modelDiffs.push({ groupId: g.id, groupName: g.name, changes });
      return { ...g, holdings };
    });

    // ── 2. Positions: restore sold units, remove bought position. ─────────
    const positionDiffs: Array<{
      groupId: string; profile: string;
      soldUnitsBefore?: number; soldUnitsAfter?: number;
      removedBuyUnits?: number;
    }> = [];
    const updatedPortfolios = portfolios.map((pp) => {
      if (!targetIds.has(pp.groupId)) return pp;
      const soldPos = pp.positions.find((p) => symEq(p.symbol, sell));
      const buyPos = pp.positions.find((p) => symEq(p.symbol, buy));
      if (!soldPos && !buyPos) return pp;
      const diff: (typeof positionDiffs)[number] = { groupId: pp.groupId, profile: pp.profile };
      let positions = pp.positions;
      if (soldPos && soldPos.units > 0) {
        const restoredUnits = soldPos.units / (1 - fraction);
        diff.soldUnitsBefore = soldPos.units;
        diff.soldUnitsAfter = restoredUnits;
        positions = positions.map((p) => (p === soldPos ? { ...p, units: restoredUnits } : p));
      }
      if (buyPos) {
        diff.removedBuyUnits = buyPos.units;
        positions = positions.filter((p) => p !== buyPos);
      }
      positionDiffs.push(diff);
      return { ...pp, positions, lastUpdated: new Date().toISOString() };
    });

    // ── 3. Transaction tape: drop this trade's rows in the target groups. ──
    const removedTxns: Array<{ groupId: string; symbol: string; direction: string; date: string }> = [];
    let updatedState: PimPortfolioState | null = state;
    if (state && Array.isArray(state.groupStates)) {
      updatedState = {
        ...state,
        groupStates: state.groupStates.map((gs) => {
          if (!targetIds.has(gs.groupId)) return gs;
          const keep = gs.transactions.filter((t) => {
            const matches =
              t.date.slice(0, 10) === date &&
              ((t.direction === "sell" && symEq(t.symbol, sell) && symEq(t.pairedWith || "", buy)) ||
               (t.direction === "buy" && symEq(t.symbol, buy) && symEq(t.pairedWith || "", sell)));
            if (matches) removedTxns.push({ groupId: gs.groupId, symbol: t.symbol, direction: t.direction, date: t.date });
            return !matches;
          });
          return keep.length === gs.transactions.length ? gs : { ...gs, transactions: keep };
        }),
      };
    }

    const summary = {
      dryRun: !confirm,
      groupsMatched: targetGroups.map((g) => ({ id: g.id, name: g.name })),
      groupsUnresolved: unresolved,
      sell, buy, fraction, date,
      models: modelDiffs,
      positions: positionDiffs,
      transactionsRemoved: removedTxns,
    };

    if (!confirm) {
      return NextResponse.json({
        ...summary,
        note: "DRY RUN — nothing written. Re-run with &confirm=YES to apply.",
      });
    }

    // ── Stash prior state, then write. ─────────────────────────────────────
    const ts = Date.now();
    const writes: string[] = [];
    await redis.set(`${PIM_MODELS_KEY}.pre-undo-excluded-${ts}`, pimRaw);
    await redis.set(
      PIM_MODELS_KEY,
      JSON.stringify({ ...pim, groups: updatedGroups, lastUpdated: new Date().toISOString() }),
    );
    writes.push(PIM_MODELS_KEY);
    if (posRaw) {
      await redis.set(`${PIM_POSITIONS_KEY}.pre-undo-excluded-${ts}`, posRaw);
      await redis.set(PIM_POSITIONS_KEY, JSON.stringify({ ...posBlob, portfolios: updatedPortfolios }));
      writes.push(PIM_POSITIONS_KEY);
    }
    if (stateRaw && updatedState && removedTxns.length > 0) {
      await redis.set(`${PIM_STATE_KEY}.pre-undo-excluded-${ts}`, stateRaw);
      await redis.set(PIM_STATE_KEY, JSON.stringify(updatedState));
      writes.push(PIM_STATE_KEY);
    }

    log.info(`applied for groups=${[...targetIds].join(",")} sell=${sell} buy=${buy} fraction=${fraction}`);
    return NextResponse.json({
      ...summary,
      applied: true,
      keysWritten: writes,
      stashSuffix: `.pre-undo-excluded-${ts}`,
      note: "Applied. Prior values stashed; hard-refresh the app so StockContext rehydrates.",
    });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
