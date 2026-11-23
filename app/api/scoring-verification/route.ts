import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { GROWTH_BANDS_KEY } from "@/app/lib/growth-score";
import { QUALITY_BANDS_KEY } from "@/app/lib/quality-score";
import { appendVerification, parseVerificationInput, verificationStatus, SCORING_VERIFICATION_KEY, type VerificationEntry } from "@/app/lib/scoring-verification";

/**
 * pm:scoring-verification — the record of each human spot check of the
 * computed scores against a FactSet terminal (app/lib/scoring-verification.ts).
 *
 * GET  → the log + the current status of growth and quality. Read-only;
 *        `{ entries: [] }` on a missing key or a read error (never seeds).
 * POST → APPEND one entry `{ score, who, result, tickers, notes }`. The date
 *        and the calibration it refers to are stamped server-side. Nothing is
 *        ever edited or removed; an unreadable log is left alone (409).
 *
 * Redis: reads pm:growth-bands / pm:quality-bands (calibratedAt only);
 * writes pm:scoring-verification by read-append-write. Changes no score.
 */

export const dynamic = "force-dynamic";
const log = createLogger("Scoring-verification");

async function calibratedAt(redis: Awaited<ReturnType<typeof getRedis>>, key: string): Promise<string | null> {
  try {
    const raw = await redis.get(key);
    const at = raw ? (JSON.parse(raw) as { calibratedAt?: string }).calibratedAt : null;
    return typeof at === "string" ? at : null;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(SCORING_VERIFICATION_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : { entries: [] };
    const [g, q] = await Promise.all([calibratedAt(redis, GROWTH_BANDS_KEY), calibratedAt(redis, QUALITY_BANDS_KEY)]);
    return NextResponse.json({
      entries: parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries) ? (parsed as { entries: VerificationEntry[] }).entries : [],
      growth: { bandsCalibratedAt: g, ...verificationStatus(parsed, "growth", g) },
      quality: { bandsCalibratedAt: q, ...verificationStatus(parsed, "quality", q) },
    });
  } catch {
    return NextResponse.json({ entries: [], growth: verificationStatus(null, "growth", null), quality: verificationStatus(null, "quality", null) });
  }
}

export async function POST(req: NextRequest) {
  try {
    const input = parseVerificationInput(await req.json().catch(() => null));
    if ("error" in input) return NextResponse.json({ error: input.error }, { status: 400 });
    const redis = await getRedis();
    const bandsAt = await calibratedAt(redis, input.score === "growth" ? GROWTH_BANDS_KEY : QUALITY_BANDS_KEY);
    if (!bandsAt) return NextResponse.json({ error: `there are no ${input.score} bands on file to verify against` }, { status: 409 });
    const now = new Date();
    const entry: VerificationEntry = { id: randomUUID(), date: now.toISOString().slice(0, 10), at: now.toISOString(), ...input, bandsCalibratedAt: bandsAt };
    const raw = await redis.get(SCORING_VERIFICATION_KEY);
    let prev: unknown = null;
    if (raw) {
      try { prev = JSON.parse(raw); } catch { return NextResponse.json({ error: "the verification log on file could not be read — left alone" }, { status: 409 }); }
    }
    const res = appendVerification(prev, entry);
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: 409 });
    await redis.set(SCORING_VERIFICATION_KEY, JSON.stringify(res.next));
    log.info(`${input.score} spot check recorded: ${input.result}, ${input.tickers.length} names, by ${input.who}`);
    return NextResponse.json({ ok: true, entry, status: verificationStatus(res.next, input.score, bandsAt) });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
