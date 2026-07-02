import { NextRequest, NextResponse } from "next/server";
import { crossSectional, factsetConfigured, FACTSET_FORMULAS } from "@/app/lib/factset";
import { resolveFactsetId } from "@/app/lib/factset-symbols";
import { createLogger } from "@/app/lib/logger";

/**
 * POST { tickers: string[] } → live FactSet prices { prices: { TICKER: number|null }, source }.
 *
 * Resolves each dashboard ticker to a FactSet id (skipping the ones we keep on
 * the existing source), pulls P_PRICE in one batched cross-sectional call, and
 * maps back to the original tickers. Read-only, no Redis. Returns
 * { configured: false } (and empty prices) until the relay env is set, so the
 * caller can fall back to its existing price source.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 20;

const log = createLogger("FactSet-prices");

export async function POST(req: NextRequest) {
  let tickers: string[] = [];
  try {
    const body = await req.json().catch(() => ({}));
    tickers = Array.isArray(body?.tickers)
      ? [...new Set<string>((body.tickers as unknown[]).map((t) => String(t || "").toUpperCase().trim()).filter(Boolean))]
      : [];
  } catch {
    tickers = [];
  }
  if (tickers.length === 0) return NextResponse.json({ prices: {}, source: "factset" });

  if (!factsetConfigured()) {
    return NextResponse.json({ configured: false, prices: {}, source: "factset" });
  }

  // Resolve tickers → FactSet ids (dedupe; remember which ticker each id maps to).
  const idToTickers = new Map<string, string[]>();
  for (const t of tickers) {
    const r = resolveFactsetId(t);
    if (r.source !== "factset") continue;
    const list = idToTickers.get(r.id) ?? [];
    list.push(t);
    idToTickers.set(r.id, list);
  }
  const ids = [...idToTickers.keys()];
  const prices: Record<string, number | null> = {};
  for (const t of tickers) prices[t] = null;
  if (ids.length === 0) return NextResponse.json({ prices, source: "factset" });

  try {
    const data = await crossSectional(ids, [FACTSET_FORMULAS.price]);
    for (const id of ids) {
      const v = data[id]?.[FACTSET_FORMULAS.price];
      const price = typeof v === "number" ? v : null;
      for (const t of idToTickers.get(id) ?? []) prices[t] = price;
    }
    return NextResponse.json({ prices, source: "factset", fetchedAt: new Date().toISOString() });
  } catch (e) {
    log.error("crossSectional failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ prices, source: "factset", error: e instanceof Error ? e.message : "failed" });
  }
}
