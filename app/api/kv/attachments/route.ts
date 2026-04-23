import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

const KEY = "pm:attachments";

/**
 * Attachment **manifest** storage. The manifest holds metadata for each
 * screenshot (id, label, section, addedAt) WITHOUT the base64 dataUrl.
 * Each image is stored separately under `pm:attachment:<id>` via the
 * /[id] route — see ./[id]/route.ts for the rationale.
 *
 * Backward compat: if the stored manifest still has `dataUrl` fields on
 * entries (pre-split schema), GET transparently splits them into per-image
 * keys and writes back a stripped manifest. This is a one-shot migration
 * that happens on the first read after the deploy — no manual step needed
 * and no data is lost.
 */

export type AttachmentManifestEntry = {
  id: string;
  label: string;
  section: string; // e.g. "equityFlows", "breadth", etc.
  addedAt: string;
};

type LegacyEntry = AttachmentManifestEntry & { dataUrl?: string };

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ attachments: [] });
    const parsed: LegacyEntry[] = JSON.parse(raw);

    // Lazy migration: split any legacy entries that still carry a dataUrl
    // into per-image keys, then save the stripped manifest back.
    const needsMigration = parsed.some((e) => typeof e.dataUrl === "string" && e.dataUrl.length > 0);
    if (needsMigration) {
      console.log(`[attachments] migrating ${parsed.filter((e) => e.dataUrl).length} legacy entries to per-image keys`);
      for (const entry of parsed) {
        if (entry.dataUrl) {
          await redis.set(`pm:attachment:${entry.id}`, entry.dataUrl);
        }
      }
      const stripped: AttachmentManifestEntry[] = parsed.map((e) => ({
        id: e.id,
        label: e.label,
        section: e.section,
        addedAt: e.addedAt,
      }));
      await redis.set(KEY, JSON.stringify(stripped));
      return NextResponse.json({ attachments: stripped });
    }

    return NextResponse.json({ attachments: parsed });
  } catch (e) {
    console.error("Redis read error (attachments):", e);
    return NextResponse.json({ attachments: [] });
  }
}

/**
 * Manifest-only write. Callers must send entries WITHOUT dataUrls — the
 * per-image payload goes to the /[id] route. We defensively strip dataUrl
 * from any incoming entry so an older client can't accidentally balloon
 * the manifest back to the pre-split size.
 */
export async function PUT(req: NextRequest) {
  try {
    const { attachments } = await req.json();
    if (!Array.isArray(attachments)) {
      return NextResponse.json({ error: "attachments must be an array" }, { status: 400 });
    }
    const stripped: AttachmentManifestEntry[] = attachments.map((e: LegacyEntry) => ({
      id: e.id,
      label: e.label,
      section: e.section,
      addedAt: e.addedAt,
    }));
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(stripped));
    return NextResponse.json({ attachments: stripped });
  } catch (e) {
    console.error("Redis write error (attachments):", e);
    return NextResponse.json({ error: "Failed to save manifest" }, { status: 500 });
  }
}
