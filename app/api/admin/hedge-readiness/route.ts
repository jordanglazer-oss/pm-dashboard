/**
 * GET /api/admin/hedge-readiness
 *
 * READ-ONLY. Validates, end to end, whether the logged hedge ledger can
 * actually be marked to market and attributed to a model — BEFORE any of it is
 * wired into performance.
 *
 * Reports per hedge:
 *   - whether the fields marking requires are present (expiry, strikePrice,
 *     contracts, premiumUsd)
 *   - whether CBOE currently lists that exact (expiry, strike) put, and its mid
 *   - unrealized P&L at that mark
 *
 * And per (group, profile): the US-equity notional, and how many SPY puts that
 * notional implies at each logged strike, using the house convention
 *
 *     contracts = US equity notional / (strike x 100)
 *
 * US equity = equity-class holdings whose SYMBOL_COUNTRY is "United States"
 * (which already covers ITOT / XUU.U / XUS.U / XSP-T / XUH-T / XSU-T / VTWO).
 * Holdings classified "Global" are reported SEPARATELY rather than folded in,
 * since whether they count is a portfolio judgement, not a lookup.
 *
 * Writes nothing. No performance data is read or altered.
 */

import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { loadHedges, isActiveHedge } from "@/app/lib/hedges";
import { fetchPutQuotes } from "@/app/lib/hedging";
import { usEquityNotional } from "@/app/lib/us-equity-exposure";
import type { Stock } from "@/app/lib/types";

type Holding = { symbol: string; currency?: "CAD" | "USD"; assetClass?: string; weightInClass: number };
type Group = { id: string; name: string; holdings: Holding[]; profiles?: Record<string, { equity?: number } | undefined> };
type Position = { symbol: string; units: number; costBasis: number };
type Portfolio = { groupId: string; profile: string; positions?: Position[]; cashBalance?: number };

const norm = (s: string) => (s || "").toUpperCase().replace(/-T$/, ".TO");
const r2 = (n: number) => Math.round(n * 100) / 100;

export async function GET() {
  try {
    const redis = await getRedis();
    const [pimRaw, posRaw, marketRaw, stocksRaw, hedges] = await Promise.all([
      redis.get("pm:pim-models"),
      redis.get("pm:pim-positions"),
      redis.get("pm:market"),
      redis.get("pm:stocks"),
      loadHedges(),
    ]);

    const stocksArr: Stock[] = stocksRaw
      ? (() => { const p = JSON.parse(stocksRaw); return Array.isArray(p) ? p : (p?.stocks ?? []); })()
      : [];
    const stockByTicker = new Map<string, Stock>();
    for (const st of stocksArr) if (st?.ticker) stockByTicker.set(norm(st.ticker), st);

    const pim = pimRaw ? (JSON.parse(pimRaw) as { groups?: Group[] }) : {};
    const pos = posRaw ? (JSON.parse(posRaw) as { portfolios?: Portfolio[] }) : {};
    const market = marketRaw ? (JSON.parse(marketRaw) as { usdCadRate?: number }) : {};
    const usdCad = market.usdCadRate ?? null;

    const active = hedges.filter((h) => isActiveHedge(h));

    // ── Can each hedge be marked? ────────────────────────────────────────
    const wanted = active
      .filter((h) => h.expiry && h.strikePrice != null)
      .map((h) => ({ expiry: h.expiry!, strike: h.strikePrice! }));

    let quotes: Awaited<ReturnType<typeof fetchPutQuotes>> | null = null;
    let quoteError: string | null = null;
    try {
      quotes = await fetchPutQuotes(wanted);
    } catch (e) {
      quoteError = e instanceof Error ? e.message : "CBOE fetch failed";
    }

    const hedgeRows = active.map((h) => {
      const missing: string[] = [];
      if (!h.expiry) missing.push("expiry");
      if (h.strikePrice == null) missing.push("strikePrice");
      if (h.contracts == null) missing.push("contracts");
      if (h.premiumUsd == null) missing.push("premiumUsd");

      const q = h.expiry && h.strikePrice != null
        ? quotes?.get(`${h.expiry}|${h.strikePrice}`) ?? null
        : null;

      const contracts = h.contracts ?? null;
      const costUsd = h.premiumUsd != null && contracts != null ? h.premiumUsd * 100 * contracts : null;
      const markUsd = q?.mid != null && contracts != null ? q.mid * 100 * contracts : null;

      return {
        id: h.id,
        implementedAt: h.implementedAt,
        expiry: h.expiry ?? null,
        strikePrice: h.strikePrice ?? null,
        contracts,
        premiumUsd: h.premiumUsd ?? null,
        markable: missing.length === 0 && q?.mid != null,
        missingFields: missing,
        cboeListed: q ? q.mid != null : null,
        currentMidUsd: q?.mid ?? null,
        costUsd: costUsd != null ? r2(costUsd) : null,
        markUsd: markUsd != null ? r2(markUsd) : null,
        unrealizedUsd: costUsd != null && markUsd != null ? r2(markUsd - costUsd) : null,
        unrealizedCad: costUsd != null && markUsd != null && usdCad != null
          ? r2((markUsd - costUsd) * usdCad) : null,
        note: missing.length > 0
          ? `Cannot be marked — missing ${missing.join(", ")}.`
          : q?.mid == null
            ? "CBOE does not currently list this exact (expiry, strike). Cannot be marked."
            : null,
      };
    });

    // ── US-equity notional per (group, profile) ──────────────────────────
    const notionalRows = (pos.portfolios ?? []).map((pp) => {
      const g = (pim.groups ?? []).find((x) => x.id === pp.groupId);
      const currencyOf = new Map<string, string | undefined>();
      const classOf = new Map<string, string | undefined>();
      for (const h of g?.holdings ?? []) {
        currencyOf.set(norm(h.symbol), h.currency);
        classOf.set(norm(h.symbol), h.assetClass);
      }

      // Valued at COST here on purpose: this route must not depend on a live
      // price fetch to answer "can this be built". Live marks come later.
      const valued = (pp.positions ?? [])
        .filter((p) => p.units > 0)
        .map((p) => ({
          symbol: p.symbol,
          valueUsd: usdCad ? (p.units * p.costBasis) / usdCad : 0,
          isEquity: classOf.get(norm(p.symbol)) === "equity",
          stock: stockByTicker.get(norm(p.symbol)) ?? null,
        }));

      const { notionalUsd, unresolved, contributions } = usEquityNotional(valued);

      const impliedContracts = active
        .filter((h) => h.strikePrice != null)
        .map((h) => ({
          hedgeId: h.id,
          strike: h.strikePrice!,
          impliedContracts: notionalUsd > 0 ? r2(notionalUsd / (h.strikePrice! * 100)) : null,
          loggedContracts: h.contracts ?? null,
        }));

      return {
        groupId: pp.groupId,
        profile: pp.profile,
        usEquityNotionalAtCostUsd: r2(notionalUsd),
        /** Holdings whose US share is unknown. Sizing must NOT proceed while
         *  this is non-empty — treating them as 0% under-hedges silently. */
        unresolvedSymbols: [...new Set(unresolved)],
        contributions: contributions.map((c) => ({ ...c, valueUsd: r2(c.valueUsd), contributionUsd: r2(c.contributionUsd) })),
        impliedContracts,
      };
    });

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      usdCadRate: usdCad,
      quoteError,
      activeHedgeCount: active.length,
      totalHedgeCount: hedges.length,
      hedges: hedgeRows,
      notionalByProfile: notionalRows,
      caveats: [
        "Notional is valued at COST here, not live prices — this route deliberately avoids a price fetch. The real implementation will mark at live prices.",
        "unresolvedSymbols must be empty before any hedge is sized. A holding with an unknown US share is never counted as 0% — that would under-hedge silently. Set its US equity % on the stock page.",
        "CBOE quotes are 15-minute delayed, which is fine for a daily mark.",
        "There are no historical option prices available, so a hedge can only be marked from the day tracking starts — its earlier contribution cannot be reconstructed.",
      ],
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "hedge-readiness failed" }, { status: 500 });
  }
}
