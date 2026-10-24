import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";

const KEY = "pm:stocks";

/** Fingerprint of the stored blob. The stale-tab guard: a PUT must name the
 *  fingerprint of the copy it was built on (`baseHash`). Any writer — another
 *  tab, an email ingest, a rescore, a restore — changes the stored blob and so
 *  the fingerprint, with no writer having to remember to bump anything. */
const fingerprint = (raw: string | null) => (raw ? createHash("sha1").update(raw).digest("hex") : "empty");

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) {
      // No data yet — return empty array, never seed
      return NextResponse.json({ stocks: [], hash: fingerprint(null) });
    }
    return NextResponse.json({ stocks: JSON.parse(raw), hash: fingerprint(raw) });
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

    // ── Stale-tab guard ──
    // Refuse a save built on an older copy than the one stored, and hand the
    // current copy back: the client re-applies only its own edits onto it
    // (app/lib/stocks-merge.ts) and retries. A body without a baseHash comes
    // from a tab still running pre-guard code — refused too, so an old tab can
    // no longer overwrite newer data (it stops saving until it is reloaded).
    const currentRaw = await redis.get(KEY);
    const currentHash = fingerprint(currentRaw);
    if (body?.baseHash !== currentHash) {
      return NextResponse.json(
        { error: "stale", stocks: currentRaw ? JSON.parse(currentRaw) : [], hash: currentHash },
        { status: 409 },
      );
    }

    // ── Write tracer (diagnostic for the AVGO/ORCL bucket drift) ──
    // Persist a rolling tail of the last 10 writes to pm:stocks so we can
    // see WHO is writing it: request timestamp, requester IP/UA, plus a
    // tiny shape summary (bucket counts + AVGO/ORCL bucket) of the
    // incoming payload. Read it back via /api/admin/peek-stock-writes.
    // Best-effort — failures don't block the save.
    try {
      const bucketCounts: Record<string, number> = {};
      for (const s of stocks as Array<{ ticker: string; bucket: string }>) {
        bucketCounts[s.bucket] = (bucketCounts[s.bucket] || 0) + 1;
      }
      const avgo = (stocks as Array<{ ticker: string; bucket: string }>).find((s) => s.ticker === "AVGO");
      const orcl = (stocks as Array<{ ticker: string; bucket: string }>).find((s) => s.ticker === "ORCL");
      const entry = {
        at: new Date().toISOString(),
        userAgent: req.headers.get("user-agent") ?? null,
        forwardedFor: req.headers.get("x-forwarded-for") ?? null,
        referer: req.headers.get("referer") ?? null,
        bucketCounts,
        avgoBucket: avgo?.bucket ?? null,
        orclBucket: orcl?.bucket ?? null,
        stocksCount: stocks.length,
      };
      const existingRaw = await redis.get("pm:stocks-write-trace");
      const existing: unknown[] = existingRaw ? JSON.parse(existingRaw) : [];
      const trimmed = [...existing.slice(-9), entry];
      await redis.set("pm:stocks-write-trace", JSON.stringify(trimmed));
    } catch (traceErr) {
      console.error("[pm:stocks PUT] write-trace failed (non-blocking):", traceErr);
    }

    const nextRaw = JSON.stringify(stocks);
    await redis.set(KEY, nextRaw);
    return NextResponse.json({ ok: true, hash: fingerprint(nextRaw) });
  } catch (e) {
    console.error("Redis write error (stocks):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
