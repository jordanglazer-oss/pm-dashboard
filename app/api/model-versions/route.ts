import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { listModelVersions, readModelVersion, diffModels } from "@/app/lib/model-versions";
import type { PimModelData } from "@/app/lib/pim-types";

/** GET /api/model-versions            → { versions }        (newest first)
 *  GET /api/model-versions?id=<id>    → { version, diff }   diff = what restoring it would change vs the live model
 *  Read-only. */
export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  const versions = (await listModelVersions()).slice().reverse();
  if (!id) return NextResponse.json({ versions });
  const version = await readModelVersion(id);
  if (!version) return NextResponse.json({ error: "unknown version" }, { status: 404 });
  const raw = await (await getRedis()).get("pm:pim-models");
  const current = raw ? (JSON.parse(raw) as PimModelData) : { groups: [] };
  return NextResponse.json({ versions, version: versions.find((v) => v.id === id) ?? null, diff: diffModels(current, version) });
}
