import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { resolveFactsetId } from "@/app/lib/factset-symbols";
import { crossSectional, factsetConfigured, type FactsetValue } from "@/app/lib/factset";
import { namesMatch } from "@/app/lib/factset-fundamentals";

/**
 * GET /api/admin/factset-ticker-audit
 *
 * Admin-only (cookie middleware). READ-ONLY: reads pm:stocks, resolves every
 * portfolio + watchlist ticker to a FactSet id, and confirms — in ONE batched
 * FactSet call — that each id returns a price AND a company name that matches
 * the stored name. Flags tickers that:
 *   - "no-data"        → resolved id returns no price (wrong/uncovered id)
 *   - "name-mismatch"  → resolves to a DIFFERENT company than stored
 *   - "skipped-existing" → deliberately kept on the existing source (overrides)
 *
 * No writes, no mutations — this only tells us which tickers need an override
 * before scoring fully relies on FactSet.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type StoredStock = { ticker?: string; name?: string; bucket?: string };

export async function GET() {
  if (!factsetConfigured()) {
    return NextResponse.json({
      ok: false,
      configured: false,
      hint: "Set FACTSET_RELAY_URL and FACTSET_RELAY_SECRET in Vercel env first.",
    });
  }

  let stocks: StoredStock[] = [];
  try {
    const redis = await getRedis();
    const raw = await redis.get("pm:stocks");
    if (raw) {
      const parsed = JSON.parse(raw);
      stocks = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.stocks) ? parsed.stocks : [];
    }
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }

  const rows = stocks
    .filter((s) => typeof s?.ticker === "string" && s.ticker.trim())
    .map((s) => ({
      ticker: (s.ticker as string).trim().toUpperCase(),
      storedName: s.name || "",
      bucket: s.bucket || "",
    }));

  const resolved = rows.map((r) => ({ ...r, res: resolveFactsetId(r.ticker) }));
  const factsetIds = [
    ...new Set(
      resolved
        .filter((r) => r.res.source === "factset")
        .map((r) => (r.res as { id: string }).id)
    ),
  ];

  let data: Record<string, Record<string, FactsetValue>> = {};
  if (factsetIds.length) {
    try {
      data = await crossSectional(factsetIds, ["P_PRICE", "FG_COMPANY_NAME"]);
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: `FactSet batch lookup failed: ${e instanceof Error ? e.message : String(e)}` },
        { status: 502 }
      );
    }
  }

  const results = resolved.map((r) => {
    if (r.res.source === "existing") {
      return { ticker: r.ticker, bucket: r.bucket, status: "skipped-existing", reason: r.res.reason };
    }
    const id = (r.res as { id: string }).id;
    const row = data[id] || {};
    const price = typeof row["P_PRICE"] === "number" ? (row["P_PRICE"] as number) : null;
    const factsetName = typeof row["FG_COMPANY_NAME"] === "string" ? (row["FG_COMPANY_NAME"] as string) : null;
    let status: string;
    if (price == null) status = "no-data";
    else if (r.storedName && factsetName && !namesMatch(r.storedName, factsetName)) status = "name-mismatch";
    else status = "ok";
    return { ticker: r.ticker, bucket: r.bucket, factsetId: id, price, storedName: r.storedName, factsetName, status };
  });

  const problems = results.filter((r) => r.status === "no-data" || r.status === "name-mismatch");
  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === "ok").length,
    noData: results.filter((r) => r.status === "no-data").length,
    nameMismatch: results.filter((r) => r.status === "name-mismatch").length,
    skippedExisting: results.filter((r) => r.status === "skipped-existing").length,
  };

  return NextResponse.json({ ok: true, summary, problems, results });
}
