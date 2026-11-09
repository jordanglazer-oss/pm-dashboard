import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { THESIS_ARCHIVE_KEY, MAX_ARCHIVED_PER_TICKER, type ArchivedThesis } from "@/app/lib/thesis-archive";

/**
 * pm:position-theses — the HUMAN "why I own it" seed per holding (Phase 03).
 *
 * The optional human half of the Living Thesis Tracker. Deliberately a
 * SEPARATE key from pm:thesis-health (the automated verdict cache) — the
 * two-writer rule — so the human seed and the machine verdict can never
 * clobber each other. Joined at read time by the UI.
 *
 * Shape: { [ticker: string]: { why: string, updatedAt: string } }
 *
 * SAFETY INVARIANTS:
 *   1. GET returns { theses: {} } on missing/error — never seeds defaults.
 *   2. POST is per-ticker READ-MODIFY-WRITE — every other ticker preserved.
 *   3. An empty `why` DELETES that ticker's entry (clearing a note), never
 *      wipes the blob.
 *   4. This is irreplaceable user data — captured by the nightly backup
 *      (NOT in EXCLUDE_PATTERNS).
 */

const KEY = "pm:position-theses";

/** Extended (2026-07, preview thesis-discipline build) with optional
 *  structured fields. All additive; entries written by the old UI parse
 *  unchanged, and read-merge-write below preserves fields it doesn't know. */
type PositionThesis = {
  why: string;
  updatedAt: string;
  /** Pre-registered machine-checkable exit criteria (app/lib/kill-conditions). */
  killConditions?: unknown[];
  underwrittenAt?: string; // YYYY-MM-DD the thesis was (re)underwritten
  underwritePrice?: number | null;
  reUnderwriteBy?: string; // YYYY-MM-DD the quarterly re-check is due
  /** Provenance: thesis started from an AI draft (the PM still edited/signed). */
  aiDrafted?: boolean;
  /** Conditions that proved STRUCTURALLY unverifiable for this name (the
   *  metric isn't disclosed, or isn't on a quarterly cadence) and were
   *  rewritten away. Fed back into the draft prompt as a do-not-propose list
   *  so a redraft cannot reintroduce the same dead end. Append-only, capped. */
  unverifiableNotes?: string[];
  /** The 2-4 things the case rests on (app/lib/kill-conditions ThesisPillar). */
  pillars?: unknown[];
  /** Prior signed versions, newest last, capped — so the desk can show how
   *  the case evolved and whether a review changed it. Written server-side
   *  whenever the prose, pillars or conditions change on a save that carries
   *  `versionReason`. */
  history?: ThesisVersion[];
  /** Phase 2: themes the company belongs to and its place in each
   *  ({ name, role, exposure? }) — drafted by AI, signed with the thesis. */
  themes?: unknown[];
  /** LEGACY: the retired Tactical sleeve's plan (entry / target / stop).
   *  Nothing reads or writes it any more; it is carried through untouched by
   *  the read-merge-write below so no stored data is lost. */
  tacticalPlan?: unknown;
};
type ThesisVersion = {
  savedAt: string;
  reason: string;
  why: string;
  pillars?: unknown[];
  killConditions?: unknown[];
  underwrittenAt?: string;
};
const MAX_HISTORY = 12;

const STANCES = new Set(["intact", "watch", "broken"]);
type PillarLike = { id?: unknown; status?: unknown; statusSince?: unknown; [k: string]: unknown };

/**
 * Phase 2: a pillar's PM-signed status carries the date it last changed.
 * Stamped HERE, against the stored pillar with the same id, so the date is
 * the server's and can't drift with a stale tab: a changed (or first-set)
 * status gets today; an unchanged one keeps its stored date; an unknown
 * status value is dropped. Every other pillar field passes through untouched.
 */
function stampPillarStatus(incoming: unknown[], prevPillars: unknown[] | undefined): unknown[] {
  const today = new Date().toISOString().slice(0, 10);
  const prevById = new Map<string, PillarLike>();
  for (const p of prevPillars ?? []) {
    const pl = p as PillarLike;
    if (pl && typeof pl.id === "string") prevById.set(pl.id, pl);
  }
  return incoming.map((p) => {
    if (!p || typeof p !== "object") return p;
    const pl = { ...(p as PillarLike) };
    if (pl.status === undefined || pl.status === null || pl.status === "") {
      delete pl.status;
      delete pl.statusSince;
      return pl;
    }
    if (typeof pl.status !== "string" || !STANCES.has(pl.status)) {
      delete pl.status;
      delete pl.statusSince;
      return pl;
    }
    const before = typeof pl.id === "string" ? prevById.get(pl.id) : undefined;
    if (before && before.status === pl.status && typeof before.statusSince === "string") pl.statusSince = before.statusSince;
    else pl.statusSince = today;
    return pl;
  });
}
type PositionTheses = Record<string, PositionThesis>;

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ theses: {} as PositionTheses });
    return NextResponse.json({ theses: JSON.parse(raw) as PositionTheses });
  } catch (e) {
    console.error("Redis read error (position-theses):", e);
    return NextResponse.json({ theses: {} as PositionTheses });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const ticker = typeof body?.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
    const why = typeof body?.why === "string" ? body.why.trim() : "";
    if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });

    const redis = await getRedis();
    const raw = await redis.get(KEY);
    // Read-modify-write: preserve every other ticker's note.
    const current: PositionTheses = raw ? (JSON.parse(raw) as PositionTheses) : {};
    const prev = current[ticker];

    // Structured fields arrive on the same POST; each is applied only when
    // present so a why-only save (old UI) can never clobber conditions and a
    // conditions-only save can never clobber the note.
    const hasConditions = Array.isArray(body?.killConditions);
    const next: PositionThesis = {
      ...prev,
      why: body?.why !== undefined ? why : (prev?.why ?? ""),
      updatedAt: new Date().toISOString(),
    };
    if (hasConditions) next.killConditions = body.killConditions as unknown[];
    if (Array.isArray(body?.pillars)) next.pillars = stampPillarStatus(body.pillars as unknown[], prev?.pillars);
    // Version the PREVIOUS signed state when a substantive save says why
    // (underwrite / review applied / edit). Trip-stamp saves (conditions only,
    // no reason) never create versions.
    if (prev && typeof body?.versionReason === "string" && body.versionReason.trim()) {
      const changed =
        (body?.why !== undefined && why !== (prev.why ?? "")) ||
        (hasConditions && JSON.stringify(body.killConditions) !== JSON.stringify(prev.killConditions ?? [])) ||
        (Array.isArray(body?.pillars) && JSON.stringify(next.pillars) !== JSON.stringify(prev.pillars ?? []));
      if (changed) {
        const version: ThesisVersion = {
          savedAt: prev.updatedAt,
          reason: body.versionReason.trim().slice(0, 80),
          why: prev.why ?? "",
          pillars: prev.pillars,
          killConditions: prev.killConditions,
          underwrittenAt: prev.underwrittenAt,
        };
        next.history = [...(prev.history ?? []), version].slice(-MAX_HISTORY);
      }
    }
    if (Array.isArray(body?.themes)) {
      next.themes = (body.themes as unknown[])
        .filter((t): t is { name: string; role: string; exposure?: unknown } => !!t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string" && typeof (t as { role?: unknown }).role === "string")
        .slice(0, 5)
        .map((t) => ({ name: t.name.trim().slice(0, 50), role: t.role.trim().slice(0, 220), ...(typeof t.exposure === "string" && t.exposure.trim() ? { exposure: t.exposure.trim().slice(0, 60) } : {}) }))
        .filter((t) => t.name && t.role);
    }
    if (typeof body?.underwrittenAt === "string") next.underwrittenAt = body.underwrittenAt;
    if (typeof body?.underwritePrice === "number") next.underwritePrice = body.underwritePrice;
    if (typeof body?.reUnderwriteBy === "string") next.reUnderwriteBy = body.reUnderwriteBy;
    if (typeof body?.aiDrafted === "boolean") next.aiDrafted = body.aiDrafted;
    // Append-only, de-duplicated, capped — a learned blocklist, not user prose.
    if (Array.isArray(body?.unverifiableNotes)) {
      const incoming = (body.unverifiableNotes as unknown[])
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim());
      const merged = [...(prev?.unverifiableNotes ?? []), ...incoming];
      next.unverifiableNotes = [...new Set(merged)].slice(-20);
    }

    const empty = !next.why && !(next.killConditions && next.killConditions.length) && !next.tacticalPlan;
    if (empty) {
      delete current[ticker]; // clearing both halves removes the entry
    } else {
      current[ticker] = next;
    }
    await redis.set(KEY, JSON.stringify(current));
    return NextResponse.json({ ok: true, ticker, cleared: empty });
  } catch (e) {
    console.error("Redis write error (position-theses):", e);
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}

/**
 * DELETE /api/kv/position-theses?ticker=TK&confirm=YES — remove ONE name's
 * thesis (e.g. a stock that has been sold) so it leaves the Thesis desk, the
 * kill-condition sweep and the alerts.
 *
 * Never a hard delete: the entry is first copied to
 * `pm:position-theses-archive` (`{ [TICKER]: ArchivedThesis[] }`, newest
 * last, capped) and only then removed from the live key — so
 * `POST /api/kv/position-theses/archive` can put it back. Both writes are
 * per-ticker read-modify-write; every other name is preserved.
 */

export async function DELETE(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });
  if (req.nextUrl.searchParams.get("confirm") !== "YES") {
    return NextResponse.json({ error: "Confirmation required (append &confirm=YES)" }, { status: 400 });
  }
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    const current: PositionTheses = raw ? (JSON.parse(raw) as PositionTheses) : {};
    const entry = current[ticker];
    if (!entry) return NextResponse.json({ ok: true, ticker, removed: false });

    // 1. Archive first — if this write fails, the live entry is untouched.
    const rawArchive = await redis.get(THESIS_ARCHIVE_KEY);
    const archive: Record<string, ArchivedThesis[]> = rawArchive ? JSON.parse(rawArchive) : {};
    archive[ticker] = [...(archive[ticker] ?? []), { ...entry, removedAt: new Date().toISOString() }].slice(-MAX_ARCHIVED_PER_TICKER);
    await redis.set(THESIS_ARCHIVE_KEY, JSON.stringify(archive));

    // 2. Then drop it from the live key (re-read to narrow the race window).
    const rawAgain = await redis.get(KEY);
    const live: PositionTheses = rawAgain ? (JSON.parse(rawAgain) as PositionTheses) : {};
    delete live[ticker];
    await redis.set(KEY, JSON.stringify(live));
    return NextResponse.json({ ok: true, ticker, removed: true, archived: true });
  } catch (e) {
    console.error("Redis write error (position-theses delete):", e);
    return NextResponse.json({ error: "remove failed" }, { status: 500 });
  }
}
