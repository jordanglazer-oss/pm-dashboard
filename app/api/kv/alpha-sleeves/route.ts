import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";

/**
 * pm:alpha-sleeves — the Thesis / Tactical split of the Alpha half of equity.
 *
 * Shape: { thesisShare: number (0–1), updatedAt: ISO, log: [{ at, from, to }] }
 *
 * GET  → { config }  ({} on miss / read error — never seeds; the client applies
 *        DEFAULT_THESIS_SHARE from app/lib/sleeve-weights.ts until one is saved)
 * POST { thesisShare } → read-merge-write. Unknown top-level fields are kept,
 *        and every change is appended to `log` (capped at 200) so the history
 *        of split decisions survives. There is no delete and no whole-blob PUT.
 *
 * Today this feeds only the read-only "Proposed sleeve weights" panel — it
 * does not move a single live weight.
 */

const KEY = "pm:alpha-sleeves";
const MAX_LOG = 200;
const log = createLogger("Alpha-sleeves");

type SplitChange = { at: string; from: number | null; to: number };
type AlphaSleeveConfig = { thesisShare?: number; updatedAt?: string; log?: SplitChange[] } & Record<string, unknown>;

export async function GET() {
  try {
    const raw = await (await getRedis()).get(KEY);
    return NextResponse.json({ config: raw ? (JSON.parse(raw) as AlphaSleeveConfig) : {} });
  } catch (e) {
    log.error("read error:", e);
    return NextResponse.json({ config: {} });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { thesisShare?: unknown };
    const share = typeof body.thesisShare === "number" ? body.thesisShare : NaN;
    if (!Number.isFinite(share) || share < 0 || share > 1) {
      return NextResponse.json({ error: "thesisShare must be a number between 0 and 1" }, { status: 400 });
    }
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    const prev: AlphaSleeveConfig = raw ? (JSON.parse(raw) as AlphaSleeveConfig) : {};
    const from = typeof prev.thesisShare === "number" ? prev.thesisShare : null;
    if (from !== null && Math.abs(from - share) < 1e-9) return NextResponse.json({ ok: true, config: prev });
    const at = new Date().toISOString();
    const next: AlphaSleeveConfig = {
      ...prev,
      thesisShare: share,
      updatedAt: at,
      log: [...(Array.isArray(prev.log) ? prev.log : []), { at, from, to: share }].slice(-MAX_LOG),
    };
    await redis.set(KEY, JSON.stringify(next));
    log.info("split changed", from, "→", share);
    return NextResponse.json({ ok: true, config: next });
  } catch (e) {
    log.error("write error:", e);
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}
