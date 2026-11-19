import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import type { PimPerformanceData } from "@/app/lib/pim-types";

/**
 * GET /api/admin/backfill-managed-alpha/undo[?stash=<ts>][&confirm=YES]
 *
 * Undoes a Managed Alpha / Total Alpha backfill from the stash it wrote
 * (`pm:pim-performance.pre-managed-alpha-backfill-<ts>` + the Appendix one).
 *
 * NOT a blind copy-back, so days the daily job recorded AFTER the backfill
 * are kept: only the `pim|thematic` and `pim|alpha` series (and their
 * Appendix ledgers) are touched. Each goes back to its stashed entries; any
 * LATER day now on file keeps its daily return, with its value re-chained
 * from the stash's last value. Every other series and field stays as it is
 * live today.
 *
 * No `stash` → lists the stashes on file. DRY RUN by default (writes
 * nothing). `&confirm=YES` stashes the current two keys at
 * `<key>.pre-managed-alpha-undo-<ts>` first, then writes.
 */

export const dynamic = "force-dynamic";

const log = createLogger("Backfill-managed-alpha-undo");
const PERF = "pm:pim-performance";
const APPX = "pm:appendix-daily-values";
const TAG = ".pre-managed-alpha-backfill-";
const SERIES = ["thematic", "alpha"];
const r4 = (n: number) => parseFloat(n.toFixed(4));

type Row = { date: string; value: number; dailyReturn: number };
type Ledger = { profile: string; entries: Row[] };
type Appendix = { ledgers: Ledger[] } & Record<string, unknown>;

/** Stashed rows, then any later live rows re-chained off the stash's last value. */
function rejoin<T extends Row>(stashed: T[], live: T[]): { rows: T[]; laterKept: number } {
  const last = stashed[stashed.length - 1];
  if (!last) return { rows: live, laterKept: 0 };
  let prev = last.value;
  const later = live.filter((e) => e.date > last.date).map((e) => {
    prev = prev * (1 + e.dailyReturn / 100);
    return { ...e, value: r4(prev) };
  });
  return { rows: [...stashed, ...later], laterKept: later.length };
}
const brief = (rows: Row[]) => ({ entries: rows.length, first: rows[0]?.date ?? null, last: rows[rows.length - 1]?.date ?? null, lastValue: rows[rows.length - 1]?.value ?? null });

export async function GET(req: NextRequest) {
  try {
    const q = new URL(req.url).searchParams;
    const stamp = q.get("stash");
    const redis = await getRedis();

    if (!stamp) {
      const found: string[] = [];
      for await (const key of redis.scanIterator({ MATCH: `${PERF}${TAG}*`, COUNT: 200 })) {
        if (Array.isArray(key)) found.push(...key);
        else found.push(key);
      }
      const stashes = found.map((k) => k.slice((PERF + TAG).length)).sort().map((ts) => ({ stash: ts, writtenAt: Number(ts) ? new Date(Number(ts)).toISOString() : null }));
      return NextResponse.json({ mode: "LIST — nothing written", stashes, next: stashes.length ? "add ?stash=<stash> for a dry run of the undo" : "no backfill stash on file — nothing to undo" });
    }
    if (!/^\d{10,16}$/.test(stamp)) return NextResponse.json({ error: "stash must be the number from the list" }, { status: 400 });

    const [perfRaw, appxRaw, sPerfRaw, sAppxRaw] = await Promise.all([redis.get(PERF), redis.get(APPX), redis.get(`${PERF}${TAG}${stamp}`), redis.get(`${APPX}${TAG}${stamp}`)]);
    if (!perfRaw || !sPerfRaw) return NextResponse.json({ error: "the live series or that stash is missing" }, { status: 409 });
    const perf = JSON.parse(perfRaw) as PimPerformanceData;
    const sPerf = JSON.parse(sPerfRaw) as PimPerformanceData;
    if (!Array.isArray(perf.models) || !Array.isArray(sPerf.models)) return NextResponse.json({ error: "unexpected shape — nothing changed" }, { status: 409 });

    const report: Record<string, unknown>[] = [];
    const nextPerf: PimPerformanceData = {
      ...perf,
      models: perf.models.map((m) => {
        if (m.groupId !== "pim" || !SERIES.includes(m.profile)) return m;
        const s = sPerf.models.find((x) => x.groupId === "pim" && x.profile === m.profile);
        if (!s) return m;
        const { rows, laterKept } = rejoin(s.history, m.history);
        report.push({ series: m.profile, now: brief(m.history), stashed: brief(s.history), afterUndo: brief(rows), laterDaysKept: laterKept });
        return { ...m, history: rows };
      }),
    };

    let nextAppx: Appendix | null = null;
    if (appxRaw && sAppxRaw) {
      const appx = JSON.parse(appxRaw) as Appendix;
      const sAppx = JSON.parse(sAppxRaw) as Appendix;
      if (Array.isArray(appx.ledgers) && Array.isArray(sAppx.ledgers)) {
        nextAppx = {
          ...appx,
          ledgers: appx.ledgers.map((l) => {
            if (!SERIES.includes(l.profile)) return l;
            const s = sAppx.ledgers.find((x) => x.profile === l.profile);
            if (!s) return l;
            const { rows, laterKept } = rejoin(s.entries, l.entries);
            report.push({ appendixLedger: l.profile, now: brief(l.entries), stashed: brief(s.entries), afterUndo: brief(rows), laterDaysKept: laterKept });
            return { ...l, entries: rows };
          }),
        };
      }
    }

    if (q.get("confirm") !== "YES") return NextResponse.json({ mode: "DRY RUN — nothing written", stash: stamp, untouched: "every series other than pim|thematic and pim|alpha", report });

    if ((await redis.get(PERF)) !== perfRaw) return NextResponse.json({ mode: "refused", refuse: "pm:pim-performance changed while the undo was being built — run it again" }, { status: 409 });
    const now = Date.now();
    await redis.set(`${PERF}.pre-managed-alpha-undo-${now}`, perfRaw);
    if (appxRaw) await redis.set(`${APPX}.pre-managed-alpha-undo-${now}`, appxRaw);
    await redis.set(PERF, JSON.stringify(nextPerf));
    if (nextAppx) await redis.set(APPX, JSON.stringify(nextAppx));
    log.info(`undone from stash ${stamp}; pre-undo stashes .pre-managed-alpha-undo-${now}`);
    return NextResponse.json({ mode: "UNDONE", stash: stamp, preUndoStashes: [`${PERF}.pre-managed-alpha-undo-${now}`, appxRaw ? `${APPX}.pre-managed-alpha-undo-${now}` : null].filter(Boolean), report });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
