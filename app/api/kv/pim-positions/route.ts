import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { missingFromBody } from "@/app/lib/kv-merge";
import { appendSales, diffSales, type LedgerBook, type SaleEvent } from "@/app/lib/sales-ledger";

const KEY = "pm:pim-positions";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ portfolios: [] });
    return NextResponse.json(JSON.parse(raw));
  } catch (e) {
    console.error("Redis read error (pim-positions):", e);
    return NextResponse.json({ portfolios: [] });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const data = await req.json();
    // Shape guard: must be an object with a 'portfolios' array.
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      console.error("[pm:pim-positions PUT] Rejected non-object body:", typeof data);
      return NextResponse.json(
        { error: "pm:pim-positions body must be an object with a 'portfolios' array" },
        { status: 400 },
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!Array.isArray((data as any).portfolios)) {
      console.error("[pm:pim-positions PUT] Rejected body missing 'portfolios' array");
      return NextResponse.json(
        { error: "pm:pim-positions body must include a 'portfolios' array" },
        { status: 400 },
      );
    }
    const redis = await getRedis();
    // A book the incoming body doesn't carry is KEPT, never dropped: a tab
    // loaded before a book was added (e.g. the Stocks book, Nov 2026) would
    // otherwise delete it on its next trade. No client flow removes a book.
    const existingRaw = await redis.get(KEY);
    let saleEvents: SaleEvent[] = [];
    if (existingRaw) {
      try {
        const existing = JSON.parse(existingRaw) as { portfolios?: { groupId: string; profile: string }[] };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const incoming = (data as any).portfolios as { groupId: string; profile: string }[];
        const kept = missingFromBody(existing.portfolios ?? [], incoming);
        if (kept.length) {
          console.warn("[pm:pim-positions PUT] kept books missing from the body:", kept.map((b) => `${b.groupId}|${b.profile}`).join(", "));
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (data as any).portfolios = [...incoming, ...kept];
        }
        // Write-aside only (see sales-ledger.ts): note any units that went DOWN.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        saleEvents = diffSales((existing.portfolios ?? []) as LedgerBook[], (data as any).portfolios as LedgerBook[], "client");
      } catch { /* unreadable existing blob — write as before */ }
    }
    await redis.set(KEY, JSON.stringify(data));
    await appendSales(redis, saleEvents); // never throws; never changes what was saved above
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (pim-positions):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
