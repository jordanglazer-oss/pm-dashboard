/* ─── Merge-on-write + revision rules for the PIM KV routes ───
 *
 * Pure helpers moved out of the route files so the "never drop stored data"
 * rules can be unit-tested (tests/kv-merge.test.ts). The routes call these
 * with exactly the inputs they used inline before — behaviour is unchanged.
 * No Redis access here. */

/* ── PUT /api/kv/pim-portfolio-state ── */

type Tx = { id?: string; date?: string } & Record<string, unknown>;
type GroupState = {
  groupId: string;
  lastRebalance?: unknown;
  trackingStart?: unknown;
  transactions?: Tx[];
} & Record<string, unknown>;
export type StateBody = { groupStates: GroupState[] } & Record<string, unknown>;

const txKey = (t: Tx) => (typeof t.id === "string" && t.id ? t.id : JSON.stringify(t));

/** Body wins for everything it carries; stored groups / transactions it lacks are kept. */
export function mergeTradeLog(storedRaw: string | null, body: StateBody) {
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

/* ── PUT /api/kv/pim-positions (books) + PUT /api/kv/pim-performance (series) ── */

type Keyed = { groupId: string; profile: string };

/** Stored entries (books or series, keyed by groupId|profile) the incoming
 *  list lacks. The routes append these to the body so nothing is dropped. */
export function missingFromBody<T extends Keyed>(stored: T[], incoming: Keyed[]): T[] {
  const keys = new Set(incoming.map((b) => `${b.groupId}|${b.profile}`));
  return stored.filter((b) => !keys.has(`${b.groupId}|${b.profile}`));
}

/* ── PUT /api/kv/pim-models revision guard ── */

/** The stored revision (0 when none), the body's (null when missing), and
 *  whether the write must be refused: once the stored model has a revision, a
 *  body with an older OR missing revision is stale. */
export function checkModelsRevision(stored: { revision?: unknown } | null, body: { revision?: unknown }) {
  const storedRev = typeof stored?.revision === "number" ? stored.revision : 0;
  const bodyRev = typeof body.revision === "number" ? body.revision : null;
  const refuse = storedRev > 0 && (bodyRev === null || bodyRev < storedRev);
  return { storedRev, bodyRev, refuse };
}
