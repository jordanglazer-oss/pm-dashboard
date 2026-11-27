import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { MANAGERS_KEY, STATUSES, mergeManager, missingSeeds, parseStore, sanitizeScreen, setStatus, upsertScreen, type ManagerStatus, type ManagersStore } from "@/app/lib/third-party-managers";

/**
 * Third-Party Managers (pm:third-party-managers) — manual entry only.
 *
 * GET  → { managers } — an EMPTY store on a missing key or a read error.
 *        Never seeds.
 * POST { manager: {...} }        save ONE manager (new, or an edit when it
 *                                carries an `id`): descriptive fields + annual
 *                                returns. Its screens are kept as stored.
 * POST { id, screen: {...} }     add ONE screen result, or replace the one on
 *                                file for that date.
 * POST { id, status }            Watching / Owned / Removed.
 * POST { seed: true }            add the three entries named by the team that
 *                                are not on file yet (a button the person
 *                                presses; never overwrites).
 *
 * Every write is a read-merge-write of ONE manager; the prior version goes
 * into that manager's history. There is no whole-store write and no delete:
 * "Removed" is a status.
 */

export const dynamic = "force-dynamic";

const log = createLogger("Third-party-managers");

export async function GET() {
  try {
    const store = parseStore(await (await getRedis()).get(MANAGERS_KEY));
    return NextResponse.json({ managers: store.managers, updatedAt: store.updatedAt ?? null });
  } catch (e) {
    log.error("read failed:", e);
    return NextResponse.json({ managers: {}, updatedAt: null });
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { manager?: unknown; id?: unknown; screen?: unknown; status?: unknown; seed?: unknown } | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  try {
    const redis = await getRedis();
    const raw = await redis.get(MANAGERS_KEY);
    // A stored value that cannot be read is left alone rather than written over.
    if (raw) {
      try {
        JSON.parse(raw);
      } catch {
        return NextResponse.json({ error: "The stored list could not be read. Nothing was saved." }, { status: 409 });
      }
    }
    const store: ManagersStore = parseStore(raw);
    const now = new Date().toISOString();
    const id = typeof body.id === "string" ? body.id.trim() : "";
    let savedId = id;

    if (body.seed === true) {
      const add = missingSeeds(store, now);
      if (!add.length) return NextResponse.json({ ok: true, added: 0, managers: store.managers });
      for (const m of add) store.managers[m.id] = m;
      savedId = add.map((m) => m.id).join(",");
    } else if (body.screen !== undefined) {
      const m = store.managers[id];
      if (!m) return NextResponse.json({ error: "That manager is not on file." }, { status: 404 });
      const screen = sanitizeScreen(body.screen, now);
      if ("error" in screen) return NextResponse.json({ error: screen.error }, { status: 400 });
      store.managers[id] = upsertScreen(m, screen, now);
    } else if (body.status !== undefined) {
      const m = store.managers[id];
      if (!m) return NextResponse.json({ error: "That manager is not on file." }, { status: 404 });
      if (!(STATUSES as readonly string[]).includes(body.status as string)) return NextResponse.json({ error: "Unknown status." }, { status: 400 });
      store.managers[id] = setStatus(m, body.status as ManagerStatus, now);
    } else if (body.manager && typeof body.manager === "object") {
      const rawId = (body.manager as { id?: unknown }).id;
      const wantedId = typeof rawId === "string" ? rawId.trim() : "";
      const prior = wantedId ? store.managers[wantedId] : undefined;
      if (wantedId && !prior) return NextResponse.json({ error: "That manager is not on file." }, { status: 404 });
      const merged = mergeManager(body.manager, prior, now);
      if ("error" in merged) return NextResponse.json({ error: merged.error }, { status: 400 });
      if (!prior && store.managers[merged.id]) return NextResponse.json({ error: "An entry with that fund code or name is already on file. Open it to edit." }, { status: 409 });
      store.managers[merged.id] = merged;
      savedId = merged.id;
    } else {
      return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
    }

    await redis.set(MANAGERS_KEY, JSON.stringify({ ...store, updatedAt: now }));
    log.info("saved", savedId);
    return NextResponse.json({ ok: true, id: savedId, managers: store.managers });
  } catch (e) {
    log.error("save failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "save failed" }, { status: 500 });
  }
}
