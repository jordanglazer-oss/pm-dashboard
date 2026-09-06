import { NextRequest, NextResponse } from "next/server";
import { reviewThesis, readThesisReview, updateThesisReview } from "@/app/lib/thesis-review";

/**
 * Post-earnings thesis review (app/lib/thesis-review).
 *
 * GET  ?ticker=X            → the cached review (zero spend), or null.
 * POST { ticker, force? }   → generate (hash-gated; force re-runs on unchanged facts).
 * PATCH { ticker, dismiss?: string[], applied?: true }
 *                           → remember dismissed change ids / mark applied.
 *
 * The review never writes the thesis. Applying a change happens in the
 * ThesisTile editor and lands via the normal signed save.
 */

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const tk = (new URL(req.url).searchParams.get("ticker") || "").trim().toUpperCase();
  if (!tk) return NextResponse.json({ error: "ticker required" }, { status: 400 });
  return NextResponse.json({ review: await readThesisReview(tk) });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const tk = typeof body?.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
    if (!tk) return NextResponse.json({ error: "ticker required" }, { status: 400 });
    const r = await reviewThesis(tk, { force: body?.force === true });
    if (!r.review) return NextResponse.json({ error: r.error ?? "review failed" }, { status: r.error === "no thesis on file" ? 404 : 502 });
    return NextResponse.json({ review: r.review, cached: r.cached, error: r.error });
  } catch (e) {
    console.error("thesis-review failed:", e);
    return NextResponse.json({ error: "review failed" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const tk = typeof body?.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
    if (!tk) return NextResponse.json({ error: "ticker required" }, { status: 400 });
    const cur = await readThesisReview(tk);
    if (!cur) return NextResponse.json({ error: "no review" }, { status: 404 });
    const patch: Parameters<typeof updateThesisReview>[1] = {};
    if (Array.isArray(body?.dismiss)) {
      const ids = (body.dismiss as unknown[]).filter((x): x is string => typeof x === "string");
      patch.dismissed = [...new Set([...(cur.dismissed ?? []), ...ids])];
    }
    if (body?.applied === true) patch.appliedAt = new Date().toISOString();
    const next = await updateThesisReview(tk, patch);
    return NextResponse.json({ review: next });
  } catch (e) {
    console.error("thesis-review patch failed:", e);
    return NextResponse.json({ error: "patch failed" }, { status: 500 });
  }
}
