import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import type { ScenarioAction, WeightBasis, ResidualPolicy } from "@/app/lib/model-scenarios";

/**
 * pm:model-scenarios — saved "what if" model proposals.
 *
 * A SEPARATE key from pm:pim-models on purpose. Scenarios are drafts; the live
 * model is the book. Nothing here can reach pm:pim-models — applying a
 * scenario is a distinct, confirmed action through the normal write path, so a
 * bug in this route can cost you a draft and never a real weight.
 *
 * Stores ACTIONS, not materialised weights (see app/lib/model-scenarios): the
 * base model moves underneath a scenario, and a frozen weight table would
 * quietly start comparing against a model that no longer exists.
 *
 * RETENTION: scenarios expire EXPIRY_DAYS after they were last touched, so a
 * proposal stays available across refreshes for evaluation without the store
 * growing forever. Editing one renews it. They are small — an action list per
 * scenario — but this is a drafts drawer, not an archive.
 *
 * SAFETY INVARIANTS:
 *   1. GET returns { scenarios: [] } on missing/error — never seeds.
 *   2. POST is per-scenario read-modify-write; other scenarios preserved.
 *   3. DELETE removes exactly one id.
 */

const KEY = "pm:model-scenarios";
const EXPIRY_DAYS = 90;
const MAX_SCENARIOS = 40;

export type ModelScenario = {
  id: string;
  name: string;
  groupId: string;
  /** Which profile the preview is rendered against (display only). */
  profile?: string;
  actions: ScenarioAction[];
  basis: WeightBasis;
  residual?: ResidualPolicy;
  residualTargets?: string[];
  /** Where class allocations come from: the profile, the live book, or a
   *  hypothetical the PM typed in (the only way to model moving money BETWEEN
   *  sleeves, e.g. selling bonds to fund alts). */
  allocBasis?: "target" | "actual" | "custom";
  customAlloc?: { equity: number; fixedIncome: number; alternative: number; cash: number };
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

const isFresh = (s: ModelScenario) => {
  const t = Date.parse(s.updatedAt || s.createdAt);
  return !isFinite(t) || Date.now() - t < EXPIRY_DAYS * 86400_000;
};

async function readAll(): Promise<ModelScenario[]> {
  try {
    const raw = await (await getRedis()).get(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.scenarios) ? (parsed.scenarios as ModelScenario[]) : [];
  } catch (e) {
    console.error("Redis read error (model-scenarios):", e);
    return [];
  }
}

export async function GET() {
  const all = await readAll();
  // Expiry applied on READ so a stale draft never shows, even if no write has
  // happened since it lapsed.
  return NextResponse.json({ scenarios: all.filter(isFresh) });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const id = typeof body?.id === "string" && body.id.trim() ? body.id.trim() : null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const groupId = typeof body?.groupId === "string" ? body.groupId.trim() : "";
    if (!name || !groupId) {
      return NextResponse.json({ error: "name and groupId required" }, { status: 400 });
    }
    if (!Array.isArray(body?.actions)) {
      return NextResponse.json({ error: "actions array required" }, { status: 400 });
    }

    const now = new Date().toISOString();
    const current = (await readAll()).filter(isFresh);
    const existing = id ? current.find((s) => s.id === id) : undefined;

    const next: ModelScenario = {
      id: existing?.id ?? id ?? `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      groupId,
      profile: typeof body?.profile === "string" ? body.profile : existing?.profile,
      actions: body.actions as ScenarioAction[],
      basis: body?.basis === "model" ? "model" : "actual",
      residual: ["core", "proportional", "named"].includes(body?.residual) ? body.residual : "core",
      residualTargets: Array.isArray(body?.residualTargets) ? body.residualTargets : undefined,
      allocBasis: ["actual", "custom"].includes(body?.allocBasis) ? body.allocBasis : "target",
      customAlloc:
        body?.customAlloc && typeof body.customAlloc === "object"
          ? {
              equity: Number(body.customAlloc.equity) || 0,
              fixedIncome: Number(body.customAlloc.fixedIncome) || 0,
              alternative: Number(body.customAlloc.alternative) || 0,
              cash: Number(body.customAlloc.cash) || 0,
            }
          : existing?.customAlloc,
      notes: typeof body?.notes === "string" ? body.notes : existing?.notes,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now, // touching a scenario renews its expiry
    };

    const others = current.filter((s) => s.id !== next.id);
    const merged = [next, ...others].slice(0, MAX_SCENARIOS);
    await (await getRedis()).set(KEY, JSON.stringify({ scenarios: merged }));
    return NextResponse.json({ ok: true, scenario: next });
  } catch (e) {
    console.error("Redis write error (model-scenarios):", e);
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const current = await readAll();
    const next = current.filter((s) => s.id !== id && isFresh(s));
    await (await getRedis()).set(KEY, JSON.stringify({ scenarios: next }));
    return NextResponse.json({ ok: true, removed: current.length - next.length });
  } catch (e) {
    console.error("Redis delete error (model-scenarios):", e);
    return NextResponse.json({ error: "delete failed" }, { status: 500 });
  }
}
