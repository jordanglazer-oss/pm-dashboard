import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

/**
 * Per-thread storage for the /chat feature. Each conversation lives under
 * its own Redis key so listing the sidebar manifest doesn't pay the message-
 * log cost. Messages are stored verbatim (role, content, timestamp, plus
 * optional search-citation metadata for assistant turns).
 */

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  // Optional metadata captured during a web_search-enabled assistant turn.
  searchQueries?: string[];
  citations?: Array<{ url: string; title?: string }>;
};

export type ChatThreadData = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  contextEnabled: boolean;
};

function keyFor(id: string): string {
  return `pm:chat-thread:${id}`;
}

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  try {
    const redis = await getRedis();
    const raw = await redis.get(keyFor(id));
    if (!raw) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(JSON.parse(raw));
  } catch (e) {
    console.error("Redis read error (chat-thread/[id]):", e);
    return NextResponse.json({ error: "Read failed" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  try {
    const body = (await req.json()) as ChatThreadData;
    if (!body || typeof body !== "object" || body.id !== id) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    const redis = await getRedis();
    await redis.set(keyFor(id), JSON.stringify(body));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (chat-thread/[id]):", e);
    return NextResponse.json({ error: "Write failed" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  try {
    const redis = await getRedis();
    await redis.del(keyFor(id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis delete error (chat-thread/[id]):", e);
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}
