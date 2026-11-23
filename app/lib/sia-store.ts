import { getRedis } from "./redis";
import { createLogger } from "./logger";
import type { SiaTxn, SplitTable } from "./sia-holdings";

/**
 * pm:sia-transactions — the SIA Charts transaction log for the PIM All-Equity
 * book, as loaded by the PM (Nov 2026). A NEW key that holds only this: the
 * parsed trades, the split history looked up at load time, and an on/off
 * switch. Nothing else is stored in it and nothing reads it except the
 * read-only "Contribution by holding" calculation, so it cannot affect a
 * performance series, a position, a model or a score.
 *
 * Writers: ONLY /api/admin/sia-transactions (load a file — dry run by
 * default, prior value stashed at pm:sia-transactions.pre-import-<ts>; or
 * flip `enabled`). Never deleted: switching it off keeps the data and makes
 * the panel fall back to the dashboard's own trade log.
 */

const log = createLogger("SIA-store");
export const SIA_KEY = "pm:sia-transactions";

/** Compact row: [date, symbol as exported, "B" | "S", units, price]. */
export type SiaRow = [string, string, "B" | "S", number, number];
export type SiaStore = {
  importedAt: string;
  fileName?: string;
  rows: number;
  first: string;
  last: string;
  enabled: boolean;
  txns: SiaRow[];
  splits: SplitTable;
  splitsNoData: string[];
};

export const packTxns = (txns: SiaTxn[]): SiaRow[] => txns.map((t) => [t.date, t.symbol, t.action === "BUY" ? "B" : "S", t.units, t.price]);
export const unpackTxns = (rows: SiaRow[]): SiaTxn[] => rows.map((r) => ({ date: r[0], symbol: r[1], action: r[2] === "B" ? "BUY" : "SELL", units: r[3], price: r[4] }));

/** The stored log, or null when none is on file or it cannot be read. Never throws, never seeds. */
export async function readSiaStore(): Promise<SiaStore | null> {
  try {
    const raw = await (await getRedis()).get(SIA_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as SiaStore;
    if (!v || !Array.isArray(v.txns) || typeof v.last !== "string") return null;
    return v;
  } catch (e) {
    log.error("read failed:", e);
    return null;
  }
}

/** What the panel and the status route may show — never the trades themselves. */
export function siaStatus(s: SiaStore | null) {
  return s ? { onFile: true, enabled: s.enabled !== false, rows: s.rows, first: s.first, last: s.last, importedAt: s.importedAt, fileName: s.fileName ?? null } : { onFile: false, enabled: false };
}
