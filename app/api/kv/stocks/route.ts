import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

const KEY = "pm:stocks";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) {
      // No data yet — return empty array, never seed
      return NextResponse.json({ stocks: [] });
    }
    return NextResponse.json({ stocks: JSON.parse(raw) });
  } catch (e) {
    console.error("Redis read error (stocks):", e);
    // On error, return empty — never seed data that could overwrite real data
    return NextResponse.json({ stocks: [] });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const stocks = body?.stocks;
    // Shape guard: pm:stocks MUST be an array. This invariant is what got
    // violated in the 2026-05-25 incident — a buggy admin script wrote an
    // object literal, which downstream readers Object.spread'd into the
    // wrong shape and silently corrupted the portfolio. Reject any non-array
    // body up front so the same class of bug can't reach Redis again.
    if (!Array.isArray(stocks)) {
      console.error("[pm:stocks PUT] Rejected non-array body:", typeof stocks);
      return NextResponse.json(
        { error: `pm:stocks must be an array, got ${stocks === null ? "null" : typeof stocks}` },
        { status: 400 },
      );
    }
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(stocks));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (stocks):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
