import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import {
  THEMES_KEY,
  parseThemeStore,
  loadThemeViews,
  loadThemeEvidence,
  themeSlug,
  type Bellwether,
  type Theme,
  type ThemePillar,
} from "@/app/lib/themes";

/**
 * GET  /api/themes — every live theme joined with the book (members, Alpha
 *      share), thesis theme names no theme claims yet, and the latest
 *      bellwether evidence. Read-only; returns empty lists on error.
 * POST /api/themes { theme } — the PM saves (signs) ONE theme. Read-merge-
 *      write of that id; every other theme preserved; the previous signed
 *      version kept in `history`. { id, archive: true } archives (never a
 *      hard delete); { id, restore: true } brings it back.
 */

export const dynamic = "force-dynamic";
const log = createLogger("Themes");
const STANCES = new Set(["intact", "watch", "broken"]);
const MAX_HISTORY = 8;

export async function GET() {
  try {
    const [views, evidence] = await Promise.all([loadThemeViews(), loadThemeEvidence()]);
    const wanted = new Set(views.themes.flatMap((t) => t.bellwethers.map((b) => b.ticker.toUpperCase())));
    const bellwetherEvidence: Record<string, unknown[]> = {};
    for (const tk of wanted) if (evidence[tk]?.length) bellwetherEvidence[tk] = evidence[tk].slice(0, 2);
    return NextResponse.json({ ...views, bellwetherEvidence });
  } catch (e) {
    log.error("GET failed:", e);
    return NextResponse.json({ themes: [], detected: [], alphaTotal: 0, bellwetherEvidence: {} });
  }
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function cleanPillars(raw: unknown, prev: ThemePillar[] | undefined): ThemePillar[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: ThemePillar[] = [];
  for (const p of Array.isArray(raw) ? raw : []) {
    if (!p || typeof p !== "object") continue;
    const pp = p as Record<string, unknown>;
    const title = str(pp.title, 50);
    const claim = str(pp.claim, 300);
    if (!title || !claim) continue;
    const id = str(pp.id, 60) || `${themeSlug(title)}-${out.length + 1}`;
    const status = typeof pp.status === "string" && STANCES.has(pp.status) ? (pp.status as ThemePillar["status"]) : undefined;
    const before = prev?.find((x) => x.id === id);
    out.push({
      id,
      title,
      claim,
      ...(status
        ? {
            status,
            statusSince: before?.status === status && before.statusSince ? before.statusSince : today,
            ...(str(pp.statusNote, 300) ? { statusNote: str(pp.statusNote, 300) } : {}),
            statusBy: pp.statusBy === "ai" ? ("ai" as const) : ("pm" as const),
          }
        : {}),
    });
    if (out.length >= 6) break;
  }
  return out;
}

function cleanBellwethers(raw: unknown): Bellwether[] {
  const out: Bellwether[] = [];
  for (const b of Array.isArray(raw) ? raw : []) {
    if (!b || typeof b !== "object") continue;
    const bb = b as Record<string, unknown>;
    const ticker = str(bb.ticker, 16).toUpperCase();
    if (!/^[A-Z0-9.\-]{1,16}$/.test(ticker) || out.some((x) => x.ticker === ticker)) continue;
    out.push({ ticker, ...(str(bb.name, 80) ? { name: str(bb.name, 80) } : {}), why: str(bb.why, 200) });
    if (out.length >= 10) break;
  }
  return out;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const redis = await getRedis();
    const store = parseThemeStore(await redis.get(THEMES_KEY));
    const now = new Date().toISOString();

    if (typeof body?.id === "string" && (body.archive === true || body.restore === true)) {
      const t = store.themes[body.id];
      if (!t) return NextResponse.json({ error: "unknown theme" }, { status: 404 });
      const next: Theme = { ...t, updatedAt: now };
      if (body.archive === true) next.archivedAt = now;
      else delete next.archivedAt;
      await redis.set(THEMES_KEY, JSON.stringify({ ...store, themes: { ...store.themes, [t.id]: next } }));
      return NextResponse.json({ ok: true, id: t.id, archived: body.archive === true });
    }

    const t = body?.theme as Record<string, unknown> | undefined;
    const name = str(t?.name, 60);
    if (!t || !name) return NextResponse.json({ error: "theme.name required" }, { status: 400 });
    const id = str(t.id, 60) || themeSlug(name);
    const prev = store.themes[id];
    const pillars = cleanPillars(t.pillars, prev?.pillars);
    if (pillars.length === 0) return NextResponse.json({ error: "a theme needs at least one pillar" }, { status: 400 });
    const aliases = (Array.isArray(t.aliases) ? t.aliases : [])
      .map((a) => str(a, 60))
      .filter((a, i, arr) => a && a.toLowerCase() !== name.toLowerCase() && arr.indexOf(a) === i)
      .slice(0, 12);
    const next: Theme = {
      ...(prev ?? {}),
      id,
      name,
      aliases,
      summary: str(t.summary, 600) || undefined,
      pillars,
      bellwethers: cleanBellwethers(t.bellwethers),
      aiDrafted: t.aiDrafted === true || prev?.aiDrafted === true,
      signedAt: now,
      updatedAt: now,
    };
    delete next.archivedAt;
    if (prev) {
      next.history = [
        ...(prev.history ?? []),
        { savedAt: prev.updatedAt, summary: prev.summary, pillars: prev.pillars, bellwethers: prev.bellwethers },
      ].slice(-MAX_HISTORY);
    }
    await redis.set(THEMES_KEY, JSON.stringify({ ...store, themes: { ...store.themes, [id]: next } }));
    return NextResponse.json({ ok: true, id, created: !prev });
  } catch (e) {
    log.error("POST failed:", e);
    return NextResponse.json({ error: "save failed" }, { status: 500 });
  }
}
