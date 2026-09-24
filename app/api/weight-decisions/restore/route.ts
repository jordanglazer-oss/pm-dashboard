import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { readModelVersion, snapshotModels, diffModels } from "@/app/lib/model-versions";
import type { PimModelData } from "@/app/lib/pim-types";

/**
 * POST /api/weight-decisions/restore — put a saved version of the models back.
 * Body: { versionId, confirm: "RESTORE <versionId>" }
 * Snapshots the CURRENT models first (source "restore"), so a restore is itself
 * undoable, then writes the chosen version with a bumped revision. Decisions
 * records are left alone — the history of what was decided stays true.
 */
const log = createLogger("Weight-restore");

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { versionId?: string; confirm?: string };
    const id = typeof body.versionId === "string" ? body.versionId : "";
    if (!id) return NextResponse.json({ error: "versionId required" }, { status: 400 });
    if (body.confirm !== `RESTORE ${id}`) return NextResponse.json({ error: `type RESTORE ${id} to confirm` }, { status: 400 });
    const version = await readModelVersion(id);
    if (!version?.groups?.length) return NextResponse.json({ error: "unknown or empty version" }, { status: 404 });

    const redis = await getRedis();
    const curRaw = await redis.get("pm:pim-models");
    const current = curRaw ? (JSON.parse(curRaw) as PimModelData) : null;
    const undoId = await snapshotModels("restore", `before restoring ${id}`);
    if (!undoId) return NextResponse.json({ error: "could not snapshot the current models — nothing written" }, { status: 500 });

    const next: PimModelData = { ...version, revision: (current?.revision ?? 0) + 1, lastUpdated: new Date().toISOString() };
    await redis.set("pm:pim-models", JSON.stringify(next));
    const diff = current ? diffModels(current, next) : [];
    log.info(`restored ${id} (${diff.length} weight changes); undo snapshot ${undoId}`);
    return NextResponse.json({ ok: true, restored: id, undoVersionId: undoId, revision: next.revision, diff });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: "restore failed" }, { status: 500 });
  }
}
