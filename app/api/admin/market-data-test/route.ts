import { NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";

/**
 * GET /api/admin/market-data-test — READ-ONLY trial of the Market Data API
 * (marketdata.app, key in MARKET_DATA_API) as a replacement for the blocked
 * CBOE SPY option chain. Touches no Redis key and never returns the key.
 *
 * Spends about 6 of the plan's daily credits: one for the expiry list, one
 * for the SPY price, then the at-the-money / 5% / 10% out-of-the-money puts
 * for ONE monthly expiry (the Hedging page needs 3 puts × 9 months = 27).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const log = createLogger("Market-data-test");
const BASE = "https://api.marketdata.app/v1";

type Call = { what: string; status: number; credits: { consumed: string | null; remaining: string | null; limit: string | null }; body: unknown };

async function call(what: string, path: string, key: string): Promise<Call> {
  const res = await fetch(BASE + path, { headers: { Authorization: "Bearer " + key, Accept: "application/json" }, cache: "no-store" });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = "(not JSON)";
  }
  return {
    what,
    status: res.status,
    credits: { consumed: res.headers.get("x-api-ratelimit-consumed"), remaining: res.headers.get("x-api-ratelimit-remaining"), limit: res.headers.get("x-api-ratelimit-limit") },
    body,
  };
}

const round5 = (v: number) => Math.round(v / 5) * 5;

function thirdFriday(y: number, m: number): string {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const d = ((5 - first + 7) % 7) + 15;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export async function GET() {
  const key = process.env.MARKET_DATA_API;
  if (!key) return NextResponse.json({ ok: false, problem: "MARKET_DATA_API is not set for this deployment. In Vercel, tick the Preview environment for the variable, then redeploy." });
  try {
    const calls: Call[] = [];
    const exp = await call("expiry list", "/options/expirations/SPY/", key);
    calls.push(exp);
    const price = await call("SPY price", "/stocks/quotes/SPY/", key);
    calls.push(price);
    const expirations = ((exp.body as { expirations?: string[] })?.expirations ?? []).slice().sort();
    const pb = price.body as { last?: number[]; mid?: number[]; updated?: number[] };
    const spot = pb?.last?.[0] ?? pb?.mid?.[0] ?? null;

    // The monthly expiry two months out (a typical hedge tenor).
    const now = new Date();
    const probe = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));
    const target = thirdFriday(probe.getUTCFullYear(), probe.getUTCMonth() + 1);
    const pick = expirations.includes(target) ? target : (expirations.find((e) => e >= target) ?? null);

    const puts: { strike: number; label: string; bid: number | null; ask: number | null; mid: number | null; last: number | null; iv: number | null; delta: number | null; quoteTime: string | null }[] = [];
    if (spot && pick) {
      const wanted = [
        { label: "at the money", strike: round5(spot) },
        { label: "5% out of the money", strike: round5(spot * 0.95) },
        { label: "10% out of the money", strike: round5(spot * 0.9) },
      ];
      for (const w of wanted) {
        const c = await call(`put ${w.strike} (${w.label})`, `/options/chain/SPY/?expiration=${pick}&side=put&strike=${w.strike}`, key);
        const b = c.body as Record<string, (number | null)[] | undefined>;
        puts.push({
          strike: w.strike,
          label: w.label,
          bid: b?.bid?.[0] ?? null,
          ask: b?.ask?.[0] ?? null,
          mid: b?.mid?.[0] ?? null,
          last: b?.last?.[0] ?? null,
          iv: b?.iv?.[0] ?? null,
          delta: b?.delta?.[0] ?? null,
          quoteTime: b?.updated?.[0] ? new Date((b.updated[0] as number) * 1000).toISOString() : null,
        });
        // Keep the raw body out of the answer once summarised; statuses and credits stay.
        calls.push({ ...c, body: c.status === 200 || c.status === 203 ? "(summarised in puts)" : c.body });
      }
    }

    const priceTime = pb?.updated?.[0] ? new Date(pb.updated[0] * 1000).toISOString() : null;
    const works = puts.length === 3 && puts.every((p) => p.bid != null && p.ask != null && p.bid > 0 && p.ask > 0);
    const newest = puts.map((p) => p.quoteTime).filter(Boolean).sort().pop() ?? null;
    return NextResponse.json({
      ok: works,
      at: new Date().toISOString(),
      spot,
      spotAsOf: priceTime,
      expiriesListed: expirations.length,
      expiryTested: pick,
      puts,
      quotesAgeHours: newest ? +((Date.now() - Date.parse(newest)) / 3_600_000).toFixed(1) : null,
      creditsRemainingToday: calls[calls.length - 1]?.credits.remaining ?? null,
      calls: calls.map((c) => ({ what: c.what, status: c.status, credits: c.credits, ...(typeof c.body === "string" || c.status >= 400 ? { body: c.body } : {}) })),
    });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ ok: false, problem: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
