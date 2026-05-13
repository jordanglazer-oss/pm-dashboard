import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type { PimPortfolioPositions, PimPosition, PimProfileType } from "@/app/lib/pim-types";
import type { Stock } from "@/app/lib/types";

const POSITIONS_KEY = "pm:pim-positions";
const STOCKS_KEY = "pm:stocks";

/**
 * POST /api/admin/seed-core-positions
 *
 * Body:
 *   fromProfile?: PimProfileType (default "allEquity")
 *   group?: string (default "pim")
 *   dryRun?: boolean (default TRUE — explicit opt-in required for write)
 *
 * Derives initial positions for the Core model by:
 *   1. Reading current pm:pim-positions for (group, fromProfile).
 *   2. Reading pm:stocks to determine which symbols are designation:"core".
 *   3. Filtering the source profile's positions to those core symbols.
 *   4. Writing them as a new (group, "core") entry in pm:pim-positions.
 *
 * Unit counts + cost bases are copied verbatim from the source profile.
 * No price-based normalization — the assumption is your Core ETFs in
 * AllEquity are already the units you actually hold (which they should
 * be, since AllEquity has 100% equity allocation and all your core ETFs
 * are in it).
 *
 * dryRun=true (default) returns the proposed new entry without writing.
 * dryRun=false writes — and only after the user explicitly confirms in
 * the chat layer per the standing stop-and-confirm rule.
 *
 * Safety: stashes the existing pm:pim-positions blob to
 * pm:pim-positions.pre-seed-core-<ts> before writing.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const fromProfile = (typeof body?.fromProfile === "string" ? body.fromProfile : "allEquity") as PimProfileType;
    const groupId = typeof body?.group === "string" ? body.group : "pim";
    const dryRun = body?.dryRun !== false;

    const redis = await getRedis();
    const [positionsRaw, stocksRaw] = await Promise.all([
      redis.get(POSITIONS_KEY),
      redis.get(STOCKS_KEY),
    ]);

    if (!positionsRaw) {
      return NextResponse.json({ error: "pm:pim-positions not found" }, { status: 404 });
    }
    if (!stocksRaw) {
      return NextResponse.json({ error: "pm:stocks not found" }, { status: 404 });
    }

    const positionsBlob = JSON.parse(positionsRaw) as { portfolios: PimPortfolioPositions[] };
    const stocks = JSON.parse(stocksRaw) as Stock[];

    const source = positionsBlob.portfolios.find(
      (p) => p.groupId === groupId && p.profile === fromProfile,
    );
    if (!source) {
      return NextResponse.json(
        { error: `no positions for (${groupId}, ${fromProfile}) — cannot derive Core from missing source` },
        { status: 404 },
      );
    }

    // Build the set of core-designated tickers from pm:stocks. Same
    // logic the rest of the dashboard uses for the core/alpha split.
    const coreTickers = new Set<string>();
    for (const s of stocks) {
      if (s.designation === "core") coreTickers.add(s.ticker.toUpperCase());
    }
    // Normalize source-position symbols the same way PimModel does
    // (PimPortfolio symbol "XSP-T" → ticker "XSP.TO"), so the lookup
    // against coreTickers (which are .TO format) works.
    const isCoreSymbol = (sym: string): boolean => {
      const tk = sym.endsWith("-T") ? sym.replace(/-T$/, ".TO") : sym;
      return coreTickers.has(tk.toUpperCase());
    };

    const corePositions: PimPosition[] = source.positions
      .filter((p) => isCoreSymbol(p.symbol) && p.units > 0)
      .map((p) => ({
        symbol: p.symbol,
        units: p.units,
        costBasis: p.costBasis,
      }));

    if (corePositions.length === 0) {
      return NextResponse.json(
        { error: `no core-designated positions found in (${groupId}, ${fromProfile}) — verify your Core ETFs are tagged designation:"core" in pm:stocks` },
        { status: 400 },
      );
    }

    // Check if (groupId, "core") already exists.
    const existingCoreIdx = positionsBlob.portfolios.findIndex(
      (p) => p.groupId === groupId && p.profile === "core",
    );
    const existingCore = existingCoreIdx >= 0 ? positionsBlob.portfolios[existingCoreIdx] : null;

    const totalUnits = corePositions.reduce((s, p) => s + p.units, 0);

    const proposed: PimPortfolioPositions = {
      groupId,
      profile: "core",
      positions: corePositions,
      cashBalance: 0,
      lastUpdated: new Date().toISOString(),
    };

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        wrote: false,
        fromProfile,
        groupId,
        proposed,
        existing: existingCore,
        summary: {
          coreSymbolCount: coreTickers.size,
          matchedPositionCount: corePositions.length,
          totalUnits: parseFloat(totalUnits.toFixed(4)),
          willOverwriteExisting: !!existingCore,
        },
        note: "dryRun=true — no data written. Inspect `proposed` and re-run with dryRun:false to apply.",
      });
    }

    // ─── WRITE PATH ───
    const ts = Date.now();
    await redis.set(`${POSITIONS_KEY}.pre-seed-core-${ts}`, positionsRaw);

    if (existingCoreIdx >= 0) {
      positionsBlob.portfolios[existingCoreIdx] = proposed;
    } else {
      positionsBlob.portfolios.push(proposed);
    }
    await redis.set(POSITIONS_KEY, JSON.stringify(positionsBlob));

    return NextResponse.json({
      ok: true,
      dryRun: false,
      wrote: true,
      fromProfile,
      groupId,
      proposed,
      stashKey: `${POSITIONS_KEY}.pre-seed-core-${ts}`,
      summary: {
        coreSymbolCount: coreTickers.size,
        matchedPositionCount: corePositions.length,
        totalUnits: parseFloat(totalUnits.toFixed(4)),
        replacedExisting: !!existingCore,
      },
    });
  } catch (e) {
    console.error("seed-core-positions error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
