import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";

/**
 * pm:action-state — the PM's done / snoozed marks on the Brief action queue.
 *
 * Shape: { [actionId]: { status: "done" | "snoozed", at: ISO, until?: ISO } }
 *
 * GET  → { state }  ({} on miss / read error — never seeds)
 * POST { id, status, until? } → read-merge-write of ONE entry; `status:
 *      "clear"` removes the entry. Entries older than 45 days are pruned on
 *      write so the blob can't grow without bound (action ids are date-
 *      scoped, so a stale mark can't match a live item anyway).
 */

export const KEY = "pm:action-state";
const PRUNE_MS = 45 * 24 * 60 * 60 * 1000;
const log = createLogger("Action-state");

export type ActionMark = { status: "done" | "snoozed"; at: string; until?: string };
export type ActionState = Record<string, ActionMark>;

export async function GET() {
  try {
    const raw = await (await getRedis()).get(KEY);
    return NextResponse.json({ state: raw ? (JSON.parse(raw) as ActionState) : {} });
  } catch (e) {
    log.error("read error:", e);
    return NextResponse.json({ state: {} });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { id?: string; status?: string; until?: string };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    if (!["done", "snoozed", "clear"].includes(body.status ?? "")) {
      return NextResponse.json({ error: "status must be done | snoozed | clear" }, { status: 400 });
    }
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    const state: ActionState = raw ? (JSON.parse(raw) as ActionState) : {};
    const now = Date.now();
    for (const [k, v] of Object.entries(state)) {
      if (!v || !Number.isFinite(Date.parse(v.at)) || now - Date.parse(v.at) > PRUNE_MS) delete state[k];
    }
    if (body.status === "clear") delete state[id];
    else state[id] = { status: body.status as ActionMark["status"], at: new Date(now).toISOString(), ...(body.until ? { until: body.until } : {}) };
    await redis.set(KEY, JSON.stringify(state));
    return NextResponse.json({ ok: true, state });
  } catch (e) {
    log.error("write error:", e);
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}
