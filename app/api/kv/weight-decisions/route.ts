import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { WEIGHT_DECISIONS_KEY, type MonthReview, type WeightDecision, type WeightDecisionStore } from "@/app/lib/weight-decisions";
import type { PimProfileType } from "@/app/lib/pim-types";

/**
 * pm:weight-decisions — the monthly meeting's per-name target decisions.
 * Shape: { months: { "YYYY-MM": MonthReview } } (app/lib/weight-decisions).
 *
 * GET  → { store }  ({ months: {} } on miss — never seeds)
 * POST { month, groupId, profile, decisions: { [symbol]: WeightDecision | null } }
 *      read-merge-write of ONE month's DRAFT: listed symbols are set (null
 *      removes that symbol's decision), every other symbol is kept. A committed
 *      month is immutable here. No whole-store PUT, no delete.
 * The commit that writes pm:pim-models is a separate route
 * (/api/weight-decisions/commit) and is disabled until production cutover.
 */

const log = createLogger("Weight-decisions");
const MONTH_RE = /^\d{4}-\d{2}$/;

export async function readStore(): Promise<WeightDecisionStore> {
  try {
    const raw = await (await getRedis()).get(WEIGHT_DECISIONS_KEY);
    const parsed = raw ? (JSON.parse(raw) as WeightDecisionStore) : null;
    return parsed && parsed.months && typeof parsed.months === "object" ? parsed : { months: {} };
  } catch (e) {
    log.error("read error:", e);
    return { months: {} };
  }
}

export async function GET() {
  return NextResponse.json({ store: await readStore() });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { month?: string; groupId?: string; profile?: string; decisions?: Record<string, WeightDecision | null> };
    const month = typeof body.month === "string" && MONTH_RE.test(body.month) ? body.month : "";
    if (!month) return NextResponse.json({ error: "month (YYYY-MM) required" }, { status: 400 });
    const groupId = typeof body.groupId === "string" && body.groupId ? body.groupId : "pim";
    const profile = (typeof body.profile === "string" ? body.profile : "balanced") as PimProfileType;
    if (!body.decisions || typeof body.decisions !== "object") return NextResponse.json({ error: "decisions required" }, { status: 400 });

    const redis = await getRedis();
    const raw = await redis.get(WEIGHT_DECISIONS_KEY);
    let store: WeightDecisionStore = { months: {} };
    if (raw) {
      try { store = JSON.parse(raw) as WeightDecisionStore; } catch { return NextResponse.json({ error: "store unreadable — refusing to overwrite" }, { status: 500 }); }
      if (!store.months || typeof store.months !== "object") store = { ...store, months: {} };
    }
    const prev = store.months[month];
    if (prev?.status === "committed") return NextResponse.json({ error: `${month} is committed and cannot be edited` }, { status: 409 });
    const at = new Date().toISOString();
    const decisions: Record<string, WeightDecision> = { ...(prev?.decisions ?? {}) };
    for (const [symbol, d] of Object.entries(body.decisions)) {
      if (!symbol) continue;
      if (d === null) { delete decisions[symbol]; continue; }
      if (!d || !["keep", "adopt", "set"].includes(d.action)) continue;
      const target = typeof d.targetInClass === "number" && Number.isFinite(d.targetInClass) && d.targetInClass >= 0 && d.targetInClass <= 1 ? d.targetInClass : undefined;
      if (d.action !== "keep" && target == null) continue;
      decisions[symbol] = {
        action: d.action,
        ...(target != null ? { targetInClass: target } : {}),
        ...(typeof d.liveInClass === "number" ? { liveInClass: d.liveInClass } : {}),
        ...(typeof d.note === "string" && d.note.trim() ? { note: d.note.trim().slice(0, 300) } : {}),
        at,
      };
    }
    const next: MonthReview = { ...(prev ?? {}), month, groupId, profile, status: "draft", decisions, updatedAt: at };
    store.months[month] = next;
    await redis.set(WEIGHT_DECISIONS_KEY, JSON.stringify(store));
    return NextResponse.json({ ok: true, review: next });
  } catch (e) {
    log.error("write error:", e);
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}
