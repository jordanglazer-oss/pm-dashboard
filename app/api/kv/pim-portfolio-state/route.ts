import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

const KEY = "pm:pim-portfolio-state";

type Tx = { id?: string; date?: string } & Record<string, unknown>;
type GroupState = {
  groupId: string;
  lastRebalance?: unknown;
  trackingStart?: unknown;
  transactions?: Tx[];
} & Record<string, unknown>;
type StateBody = { groupStates: GroupState[] } & Record<string, unknown>;

const txKey = (t: Tx) => (typeof t.id === "string" && t.id ? t.id : JSON.stringify(t));

/** Body wins for everything it carries; stored groups / transactions it lacks are kept. */
function mergeTradeLog(storedRaw: string | null, body: StateBody) {
  let stored: StateBody | null = null;
  try {
    const parsed = storedRaw ? JSON.parse(storedRaw) : null;
    if (parsed && Array.isArray(parsed.groupStates)) stored = parsed as StateBody;
  } catch {
    stored = null;
  }
  if (!stored) return { merged: body, keptGroups: 0, keptTransactions: 0 };

  let keptGroups = 0;
  let keptTransactions = 0;
  const storedById = new Map(stored.groupStates.map((g) => [g.groupId, g]));
  const groupStates: GroupState[] = body.groupStates.map((g) => {
    const prev = storedById.get(g.groupId);
    if (!prev) return g;
    const bodyTx = Array.isArray(g.transactions) ? g.transactions : [];
    const have = new Set(bodyTx.map(txKey));
    const missing = (Array.isArray(prev.transactions) ? prev.transactions : []).filter((t) => !have.has(txKey(t)));
    let transactions = bodyTx;
    if (missing.length > 0) {
      keptTransactions += missing.length;
      // Stable sort by date keeps the log chronological after the merge.
      transactions = [...missing, ...bodyTx]
        .map((t, i) => ({ t, i }))
        .sort((a, b) => String(a.t.date ?? "").localeCompare(String(b.t.date ?? "")) || a.i - b.i)
        .map((x) => x.t);
    }
    return {
      ...g,
      lastRebalance: g.lastRebalance ?? prev.lastRebalance ?? null,
      trackingStart: g.trackingStart ?? prev.trackingStart ?? null,
      transactions,
    };
  });
  const inBody = new Set(body.groupStates.map((g) => g.groupId));
  for (const g of stored.groupStates) {
    if (!inBody.has(g.groupId)) {
      groupStates.push(g);
      keptGroups += 1;
    }
  }
  return { merged: { ...body, groupStates }, keptGroups, keptTransactions };
}

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) {
      return NextResponse.json({ groupStates: [], lastUpdated: null });
    }
    return NextResponse.json(JSON.parse(raw));
  } catch (e) {
    console.error("Redis read error (pim-portfolio-state):", e);
    return NextResponse.json({ groupStates: [], lastUpdated: null });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const data = await req.json();
    // Shape guard: must be an object with a 'groupStates' array. This blob
    // holds per-group transactions and rebalance snapshots — losing it
    // means losing the entire trade history. Reject anything malformed.
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      console.error("[pm:pim-portfolio-state PUT] Rejected non-object body:", typeof data);
      return NextResponse.json(
        { error: "pm:pim-portfolio-state body must be an object with a 'groupStates' array" },
        { status: 400 },
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!Array.isArray((data as any).groupStates)) {
      console.error("[pm:pim-portfolio-state PUT] Rejected body missing 'groupStates' array");
      return NextResponse.json(
        { error: "pm:pim-portfolio-state body must include a 'groupStates' array" },
        { status: 400 },
      );
    }
    const redis = await getRedis();
    // The trade log only ever GROWS from the browser: a settle replaces a
    // pending entry under the same id, nothing deletes one. So a body that is
    // missing a stored group, or missing stored transactions inside a group,
    // comes from a tab that never loaded them (failed load) or loaded them
    // before a server-side write (a staged rebalance). Keep what is stored
    // rather than let that tab erase it.
    const storedRaw = await redis.get(KEY);
    const { merged, keptGroups, keptTransactions } = mergeTradeLog(storedRaw, data as StateBody);
    if (keptGroups > 0 || keptTransactions > 0) {
      console.warn(`[pm:pim-portfolio-state PUT] kept ${keptGroups} group(s) and ${keptTransactions} transaction(s) missing from the body`);
    }
    await redis.set(KEY, JSON.stringify(merged));
    return NextResponse.json({ ok: true, keptGroups, keptTransactions });
  } catch (e) {
    console.error("Redis write error (pim-portfolio-state):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
