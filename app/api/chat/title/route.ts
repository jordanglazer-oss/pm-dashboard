import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/chat/title
 *
 * Generates a 4-6 word title for a chat thread based on the first user
 * message. Called by the client right after the first assistant response
 * completes — the result populates the sidebar entry.
 *
 * Body: { firstUserMessage: string }
 * Response: { title: string }
 */

const client = new Anthropic();

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const firstUserMessage: string = typeof body?.firstUserMessage === "string" ? body.firstUserMessage : "";
    if (!firstUserMessage.trim()) {
      return NextResponse.json({ title: "New chat" });
    }

    const msg = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 32,
      messages: [
        {
          role: "user",
          content: `Generate a 4-6 word title for a chat thread that opens with this message. Return ONLY the title, no quotes, no preamble.

Message: ${firstUserMessage.slice(0, 500)}`,
        },
      ],
    });

    const text = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";
    // Sanitize: strip surrounding quotes/dashes, cap length.
    const cleaned = text.replace(/^["'`\-–—\s]+|["'`\-–—\s]+$/g, "").slice(0, 60);
    return NextResponse.json({ title: cleaned || "New chat" });
  } catch (e) {
    console.error("chat/title error:", e);
    return NextResponse.json({ title: "New chat" });
  }
}
