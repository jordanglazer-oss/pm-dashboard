import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { defaultResearch } from "@/app/lib/defaults";
import { createHash } from "node:crypto";

const KEY = "pm:research";

// Fingerprint of the stored blob. The Sources page sends back the one it last
// saw as `baseHash`; if the blob has changed since (an emailed list was
// ingested, another tab saved), the save is refused with the current copy so
// the page can fold its own change into it instead of writing over it.
const fingerprint = (raw: string | null) => (raw ? createHash("sha1").update(raw).digest("hex") : "empty");

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    // Per CLAUDE.md: NEVER seed Redis on read. If a stale client later PUTs
    // its in-memory defaults, the seed would overwrite whatever was there.
    // Return defaults in-memory only; the first user PUT creates the key.
    if (!raw) return NextResponse.json({ research: defaultResearch, hash: fingerprint(null) });
    return NextResponse.json({ research: JSON.parse(raw), hash: fingerprint(raw) });
  } catch (e) {
    console.error("Redis read error (research):", e);
    return NextResponse.json({ research: defaultResearch });
  }
}

async function save(req: NextRequest) {
  try {
    const { research, baseHash } = (await req.json()) as { research?: unknown; baseHash?: unknown };
    // Never store anything but a research object ("null" would read back as
    // an empty page and then be saved over the real lists).
    if (research === null || typeof research !== "object" || Array.isArray(research)) {
      return NextResponse.json({ error: "research must be an object" }, { status: 400 });
    }
    const redis = await getRedis();
    const currentRaw = await redis.get(KEY);
    const currentHash = fingerprint(currentRaw);
    // A caller that sends no baseHash is written as before (older open tabs).
    if (typeof baseHash === "string" && baseHash !== currentHash) {
      return NextResponse.json(
        { error: "stale", research: currentRaw ? JSON.parse(currentRaw) : defaultResearch, hash: currentHash },
        { status: 409 },
      );
    }
    const nextRaw = JSON.stringify(research);
    await redis.set(KEY, nextRaw);
    return NextResponse.json({ ok: true, hash: fingerprint(nextRaw) });
  } catch (e) {
    console.error("Redis write error (research):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  return save(req);
}

// navigator.sendBeacon can only POST. The Sources page uses it to flush a
// pending edit when the tab closes; without this handler that request got a
// 405 and the edit was lost.
export async function POST(req: NextRequest) {
  return save(req);
}
