import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";

/**
 * Append-only, date-guarded KV store factory.
 *
 * Phase 00 of the forward-looking roadmap (docs/forward-looking-roadmap.md).
 * Centralises the append-only invariants that pm:score-history and
 * pm:portfolio-snapshots implement by hand, so the timeseries stores added by
 * later phases (pm:thesis-history, pm:attribution-history, pm:decision-journal)
 * can't reimplement the date guard incorrectly and silently corrupt history.
 *
 * Store shape (single JSON blob):
 *   { [outerId: string]: Entry[] }   // e.g. { "AAPL": [ {date, ...}, ... ] }
 *
 * SAFETY INVARIANTS (identical to pm:score-history):
 *   1. GET returns { store: {} } on missing key OR read error — never seeds
 *      defaults that a later PUT could clobber real data with.
 *   2. POST validates entry.date === today (server UTC); past-dated writes
 *      are rejected with 400. This is the append-only guarantee.
 *   3. Every write is read-merge-write: other outer ids are preserved, the
 *      target id's array is appended to (never overwritten wholesale).
 *   4. No DELETE handler is produced — history is immutable.
 *
 * Stores with bespoke needs (score-history's patch-recent / delta response)
 * keep their own route; this factory is for the plain append case.
 */

/** Server-authoritative UTC date (YYYY-MM-DD). */
export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export type DatedEntry = { date: string } & Record<string, unknown>;
export type AppendOnlyStore<E extends DatedEntry> = Record<string, E[]>;

export function createAppendOnlyStore<E extends DatedEntry>(opts: {
  /** The pm:* Redis key this store lives in. */
  key: string;
  /** Log tag (e.g. "Thesis-history") for createLogger. */
  label: string;
  /** POST body field naming the outer dimension. Default "id". */
  idField?: string;
  /** Uppercase + trim the outer id (use for tickers). Default false. */
  upperId?: boolean;
  /** Optional per-entry shape guard. Return false to reject with 400. */
  validateEntry?: (entry: DatedEntry) => boolean;
}) {
  const { key, label, idField = "id", upperId = false, validateEntry } = opts;
  const log = createLogger(label);

  async function GET() {
    try {
      const redis = await getRedis();
      const raw = await redis.get(key);
      if (!raw) return NextResponse.json({ store: {} as AppendOnlyStore<E> });
      return NextResponse.json({ store: JSON.parse(raw) as AppendOnlyStore<E> });
    } catch (e) {
      log.error("read error:", e);
      return NextResponse.json({ store: {} as AppendOnlyStore<E> });
    }
  }

  async function POST(req: NextRequest) {
    try {
      const body = await req.json();
      const rawId = typeof body?.[idField] === "string" ? (body[idField] as string).trim() : "";
      const id = upperId ? rawId.toUpperCase() : rawId;
      const entry = body?.entry as E | undefined;

      if (!id) return NextResponse.json({ error: `${idField} required` }, { status: 400 });
      if (!entry || typeof entry !== "object") {
        return NextResponse.json({ error: "entry required" }, { status: 400 });
      }
      if (typeof entry.date !== "string") {
        return NextResponse.json({ error: "entry.date required" }, { status: 400 });
      }
      const today = todayUTC();
      if (entry.date !== today) {
        return NextResponse.json(
          { error: `Entry date ${entry.date} is not today (${today}). Past-dated writes are not allowed.` },
          { status: 400 },
        );
      }
      if (validateEntry && !validateEntry(entry)) {
        return NextResponse.json({ error: "entry failed validation" }, { status: 400 });
      }

      const redis = await getRedis();
      const raw = await redis.get(key);
      // Read-merge-write: preserve every other outer id's array.
      const current: AppendOnlyStore<E> = raw ? (JSON.parse(raw) as AppendOnlyStore<E>) : {};
      const arr = Array.isArray(current[id]) ? current[id] : [];
      arr.push({ ...entry });
      current[id] = arr;
      await redis.set(key, JSON.stringify(current));
      return NextResponse.json({ ok: true, count: arr.length });
    } catch (e) {
      log.error("write error:", e);
      return NextResponse.json({ error: "write failed" }, { status: 500 });
    }
  }

  return { GET, POST };
}
