import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { DEPLOYMENTS_KEY, timingScorecard, type Deployment, type DailyClose } from "@/app/lib/deployments";
import { easternToday } from "@/app/lib/date-eastern";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("Deployments");

/**
 * Deployment log (pm:deployments).
 *
 * GET              → { deployments, scorecard } — scorecard is computed on the
 *                    fly from SPY daily closes; nothing about it is stored.
 * POST { add }     → append ONE entry (read-merge-write).
 * POST { voidId }  → mark ONE entry voided (never hard-deleted).
 *
 * There is deliberately NO whole-array write: a stale tab cannot roll the log
 * back. A missing key reads as an empty list and nothing is ever seeded.
 */

async function read(): Promise<Deployment[]> {
  const redis = await getRedis();
  const raw = await redis.get(DEPLOYMENTS_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed?.deployments) ? (parsed.deployments as Deployment[]) : [];
}

async function spyCloses(): Promise<DailyClose[]> {
  try {
    const res = await fetch("https://query2.finance.yahoo.com/v8/finance/chart/SPY?range=2y&interval=1d", {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const r = (await res.json())?.chart?.result?.[0];
    const ts: number[] = r?.timestamp ?? [];
    const cl: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
    const out: DailyClose[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = cl[i];
      if (typeof c === "number" && isFinite(c)) out.push({ date: new Date(ts[i] * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" }), close: c });
    }
    return out;
  } catch {
    return [];
  }
}

export async function GET() {
  try {
    const deployments = await read();
    const scorecard = deployments.some((d) => !d.voided) ? timingScorecard(deployments, await spyCloses()) : { rows: [], monthsBeaten: 0, monthsGraded: 0, avgAdvantagePct: null };
    return NextResponse.json({ deployments, scorecard });
  } catch (e) {
    log.error("read failed:", e);
    return NextResponse.json({ deployments: [], scorecard: { rows: [], monthsBeaten: 0, monthsGraded: 0, avgAdvantagePct: null } });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { add?: { date?: string; portion?: string; note?: string }; voidId?: string };
    const redis = await getRedis();
    const current = await read();
    const today = easternToday();

    if (typeof body.voidId === "string" && body.voidId) {
      if (!current.some((d) => d.id === body.voidId)) return NextResponse.json({ error: "No such entry" }, { status: 404 });
      const next = current.map((d) => (d.id === body.voidId ? { ...d, voided: true, voidedAt: new Date().toISOString() } : d));
      await redis.set(DEPLOYMENTS_KEY, JSON.stringify({ deployments: next }));
      return NextResponse.json({ ok: true, deployments: next });
    }

    const add = body.add;
    if (!add || typeof add.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(add.date)) return NextResponse.json({ error: "A date (YYYY-MM-DD) is required" }, { status: 400 });
    if (add.portion !== "full" && add.portion !== "half") return NextResponse.json({ error: 'portion must be "full" or "half"' }, { status: 400 });
    // Back-dating is allowed (log it the next morning) but bounded: the
    // current or the previous calendar month, never the future.
    const prevMonth = (() => { const [y, m] = today.split("-").map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; })();
    if (add.date > today) return NextResponse.json({ error: "A deployment cannot be dated in the future" }, { status: 400 });
    if (add.date.slice(0, 7) !== today.slice(0, 7) && add.date.slice(0, 7) !== prevMonth) return NextResponse.json({ error: "Only the current or previous month can be logged" }, { status: 400 });

    // Snapshot what the brief said that day (read-only vs pm:brief).
    let brief: Deployment["brief"] = null;
    try {
      const raw = await redis.get("pm:brief");
      const b = raw ? (JSON.parse(raw) as { dateISO?: string; cashDeploymentCall?: { action?: string; score?: number } }) : null;
      if (b?.dateISO?.slice(0, 10) === add.date && b.cashDeploymentCall?.action) {
        brief = { action: b.cashDeploymentCall.action, score: typeof b.cashDeploymentCall.score === "number" ? b.cashDeploymentCall.score : null };
      }
    } catch { /* snapshot is best-effort */ }

    const entry: Deployment = {
      id: `dep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      date: add.date,
      month: add.date.slice(0, 7),
      portion: add.portion,
      ...(typeof add.note === "string" && add.note.trim() ? { note: add.note.trim().slice(0, 280) } : {}),
      loggedAt: new Date().toISOString(),
      brief,
    };
    const next = [...current, entry];
    await redis.set(DEPLOYMENTS_KEY, JSON.stringify({ deployments: next }));
    return NextResponse.json({ ok: true, deployments: next, added: entry });
  } catch (e) {
    log.error("write failed:", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
