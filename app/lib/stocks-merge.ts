/* ─── Three-way merge for pm:stocks (the stale-tab guard) ───
 *
 * Every open copy of the dashboard keeps its own copy of the stock list and
 * re-saves the WHOLE array. Without a guard, a tab holding an older copy wipes
 * whatever changed on the server since it loaded (a server ingest, a rescore,
 * another tab's role tags / Watchlist moves). The server now refuses a save
 * whose base fingerprint is stale (PUT /api/kv/stocks → 409 + current copy),
 * and the client re-applies ONLY its own edits onto the newer copy:
 *
 *   base   = the server copy this tab last synced with
 *   local  = what this tab wants to save (base + its own edits)
 *   server = the current server copy
 *
 * Per ticker, per top-level field: a field this tab changed (local ≠ base)
 * takes the local value; every other field takes the server value. A ticker
 * added on either side is kept; a ticker removed on one side is dropped only
 * when the other side left it untouched (an edit is never silently lost).
 * Pure — no I/O. */

type Rec = { ticker: string } & Record<string, unknown>;

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function mergeRecord(b: Rec | undefined, l: Rec, s: Rec): Rec {
  const out: Record<string, unknown> = { ...s };
  const keys = new Set([...Object.keys(l), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    const lv = l[k];
    const bv = b?.[k];
    if (same(lv, bv)) continue; // untouched locally → server wins
    if (lv === undefined) delete out[k]; // removed locally
    else out[k] = lv;
  }
  return out as Rec;
}

export function mergeStocks<T extends { ticker: string }>(base: T[], local: T[], server: T[]): T[] {
  const B = new Map(base.map((x) => [x.ticker, x as unknown as Rec]));
  const L = new Map(local.map((x) => [x.ticker, x as unknown as Rec]));
  const S = new Map(server.map((x) => [x.ticker, x as unknown as Rec]));
  const out: Rec[] = [];
  const seen = new Set<string>();
  const take = (t: string) => {
    if (seen.has(t)) return;
    seen.add(t);
    const b = B.get(t), l = L.get(t), s = S.get(t);
    if (l && s) { out.push(b ? (same(l, b) ? s : mergeRecord(b, l, s)) : mergeRecord(undefined, l, s)); return; }
    if (s && !l) {
      // Gone locally: drop only if this tab deleted it and the server didn't change it since.
      if (b && same(s, b)) return;
      out.push(s);
      return;
    }
    if (l && !s) {
      // Gone on the server: drop only if this tab didn't edit it (or never had it from the server).
      if (b && same(l, b)) return;
      out.push(l);
    }
  };
  for (const x of server) take(x.ticker);
  for (const x of local) take(x.ticker);
  return out as unknown as T[];
}
