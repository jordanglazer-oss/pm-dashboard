import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { canonicalTicker } from "@/app/lib/ticker";
import { SUGGESTED_STOCKS_KEY, type SuggestedStock } from "@/app/lib/suggested-stocks";
import type { ScoreKey, Scores } from "@/app/lib/types";

/**
 * `pm:stocks-suggested` — the Suggested funnel's staging records.
 *
 * GET  — the whole store (empty array on miss / read error; never seeds).
 * POST — merge ONE record by ticker (scores, explanations, fields).
 *
 * DELIBERATELY NO WHOLE-ARRAY PUT. The store is written by three independent
 * paths (the sync in /api/suggested-watchlist, the email ingest matchers, and
 * the client's on-demand rescore), and a client that PUTs a full array it read
 * a minute ago would silently roll back whatever the other two did in between
 * — the exact closure-vs-Redis race that cost a day of PIM data. Every write
 * here is a read-modify-write of a single record.
 *
 * Rejects tickers with no existing record: staging records are created by the
 * sync, never by a save. That keeps a typo or a stale client from inventing a
 * name the research lists never nominated.
 */

const log = createLogger("Stocks-suggested");

export async function GET() {
  try {
    const raw = await (await getRedis()).get(SUGGESTED_STOCKS_KEY);
    if (!raw) return NextResponse.json({ stocks: [] });
    const parsed = JSON.parse(raw);
    return NextResponse.json({ stocks: Array.isArray(parsed) ? parsed : [] });
  } catch (e) {
    log.error("read failed:", e);
    return NextResponse.json({ stocks: [] });
  }
}

type MergeBody = {
  ticker?: unknown;
  /** Partial score map — merged over the record's scores. */
  scores?: unknown;
  explanations?: unknown;
  lastScored?: unknown;
  /** Any other Stock fields to merge (name, sector, price, currency, …). */
  fields?: unknown;
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as MergeBody;
    const ticker = typeof body.ticker === "string" ? body.ticker.trim() : "";
    if (!ticker) return NextResponse.json({ error: "ticker is required" }, { status: 400 });

    const redis = await getRedis();
    const raw = await redis.get(SUGGESTED_STOCKS_KEY);
    const store: SuggestedStock[] = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(store)) {
      log.error("store is not an array — refusing to write");
      return NextResponse.json({ error: "store corrupt" }, { status: 500 });
    }

    const key = canonicalTicker(ticker);
    const idx = store.findIndex((s) => canonicalTicker(s.ticker) === key);
    if (idx < 0) {
      return NextResponse.json({ error: `no suggested record for ${ticker}` }, { status: 404 });
    }

    const prev = store[idx];
    const next: SuggestedStock = { ...prev };

    if (body.fields && typeof body.fields === "object" && !Array.isArray(body.fields)) {
      // Never let a merge rewrite the record's identity or promote it out of
      // staging — bucket/ticker are owned by the sync and the promote path.
      const { ticker: _t, bucket: _b, ...rest } = body.fields as Record<string, unknown>;
      void _t; void _b;
      Object.assign(next, rest);
    }
    if (body.scores && typeof body.scores === "object" && !Array.isArray(body.scores)) {
      const merged: Scores = { ...prev.scores };
      for (const [k, v] of Object.entries(body.scores as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) merged[k as ScoreKey] = v;
      }
      next.scores = merged;
    }
    if (body.explanations && typeof body.explanations === "object" && !Array.isArray(body.explanations)) {
      next.explanations = { ...(prev.explanations ?? {}), ...(body.explanations as object) };
    }
    if (typeof body.lastScored === "string") next.lastScored = body.lastScored;

    const nextStore = [...store];
    nextStore[idx] = next;
    await redis.set(SUGGESTED_STOCKS_KEY, JSON.stringify(nextStore));
    return NextResponse.json({ ok: true, stock: next });
  } catch (e) {
    log.error("write failed:", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
