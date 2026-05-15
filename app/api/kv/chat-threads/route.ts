import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

/**
 * Chat thread manifest. Mirrors the attachments split pattern:
 *   - `pm:chat-threads` holds a lightweight array (id/title/timestamps/count).
 *   - `pm:chat-thread:<id>` holds the full message log for one thread.
 *
 * Keeping the manifest small means listing 100 conversations is one tiny
 * Redis read, while the message-heavy bodies only load when you click in.
 */

const KEY = "pm:chat-threads";

export type ChatThreadManifestEntry = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ threads: [] });
    const parsed = JSON.parse(raw);
    const threads: ChatThreadManifestEntry[] = Array.isArray(parsed?.threads)
      ? parsed.threads
      : Array.isArray(parsed)
      ? parsed
      : [];
    return NextResponse.json({ threads });
  } catch (e) {
    console.error("Redis read error (chat-threads):", e);
    return NextResponse.json({ threads: [] });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const threads: ChatThreadManifestEntry[] = Array.isArray(body?.threads) ? body.threads : [];
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify({ threads }));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (chat-threads):", e);
    return NextResponse.json({ error: "Write failed" }, { status: 500 });
  }
}
