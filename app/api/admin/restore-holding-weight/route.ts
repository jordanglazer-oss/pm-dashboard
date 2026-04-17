import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type { PimHolding, PimModelGroup, PimProfileWeights } from "@/app/lib/pim-types";

const PIM_KEY = "pm:pim-models";

/**
 * POST /api/admin/restore-holding-weight
 *
 * Body: { symbol: string, balancedWeightPct: number }
 *
 * Restores a single equity holding's `weightInClass` across every PIM
 * model group so that it renders at `balancedWeightPct` in the Balanced
 * profile — then scales naturally to the Growth and All-Equity profiles
 * via the existing `weightInClass × profileEquityAllocation` math.
 *
 * Does NOT trigger `rebalanceStockWeights` — other holdings are not
 * touched. This is a surgical repair for drift caused by prior rebalance
 * passes (e.g. specialty funds that absorbed residual weight they should
 * not have). Safety rails:
 *   - only updates the one symbol named in the body
 *   - only updates equity holdings (fixed income / alternative untouched)
 *   - skips groups where the symbol is not already present
 *   - leaves all other holdings exactly as they were
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const symbol = typeof body?.symbol === "string" ? body.symbol.trim() : "";
    const balancedWeightPct = Number(body?.balancedWeightPct);

    if (!symbol) {
      return NextResponse.json({ error: "symbol required" }, { status: 400 });
    }
    if (!isFinite(balancedWeightPct) || balancedWeightPct <= 0 || balancedWeightPct > 100) {
      return NextResponse.json(
        { error: "balancedWeightPct must be a number between 0 and 100 (e.g. 4.5)" },
        { status: 400 }
      );
    }

    const redis = await getRedis();
    const raw = await redis.get(PIM_KEY);
    if (!raw) {
      return NextResponse.json({ error: "pm:pim-models not found" }, { status: 404 });
    }

    const data = JSON.parse(raw) as { groups: PimModelGroup[]; lastUpdated?: string };
    if (!Array.isArray(data?.groups)) {
      return NextResponse.json({ error: "pm:pim-models malformed" }, { status: 500 });
    }

    const fraction = balancedWeightPct / 100;
    const updates: Array<{
      groupId: string;
      previousWeightInClass: number;
      newWeightInClass: number;
      balancedEquityAlloc: number;
    }> = [];

    for (const group of data.groups) {
      const balanced: PimProfileWeights | undefined = group.profiles?.balanced;
      const balancedEquity = balanced?.equity ?? 0;
      if (balancedEquity <= 0) continue;

      const holding = group.holdings.find(
        (h: PimHolding) => h.symbol === symbol && h.assetClass === "equity"
      );
      if (!holding) continue;

      const newWeightInClass = parseFloat((fraction / balancedEquity).toFixed(6));
      const previousWeightInClass = holding.weightInClass;
      if (previousWeightInClass === newWeightInClass) continue;

      holding.weightInClass = newWeightInClass;
      updates.push({
        groupId: group.id,
        previousWeightInClass,
        newWeightInClass,
        balancedEquityAlloc: balancedEquity,
      });
    }

    if (updates.length === 0) {
      return NextResponse.json({
        ok: true,
        message: `No changes — ${symbol} already at target or not present in any group.`,
        updates,
      });
    }

    data.lastUpdated = new Date().toISOString();
    await redis.set(PIM_KEY, JSON.stringify(data));

    return NextResponse.json({
      ok: true,
      symbol,
      balancedWeightPct,
      groupsUpdated: updates.length,
      updates,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
