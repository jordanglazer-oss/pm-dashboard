import { getRedis } from "./redis";
import type { EquateSheet } from "./equate-parse";

/**
 * pm:equate:{region} — the latest RBC EQUATE rank sheet per region.
 *
 * Latest-only, replaced each week. The ranks are a snapshot of a quant model's
 * current view; last week's are not additive and keeping a history here would
 * repeat the Blob/transfer bloat that the SIA universe store was trimmed for.
 * What DOES need history — when a name first appeared and when it fell off —
 * is the candidate store's job, and it keeps that per candidate rather than by
 * re-storing whole universes.
 *
 * The US Large Cap sheet is stored under its own key rather than overwriting
 * All Cap: it is a subset at identical ranks, so letting it land on the same
 * key would silently shrink the US universe from 1,360 names to 500 depending
 * on which email arrived last.
 */

const key = (region: string, largeCapOnly: boolean) =>
  `pm:equate:${region}${largeCapOnly ? "-largecap" : ""}`;

export type StoredEquate = {
  region: "us" | "canada";
  largeCapOnly: boolean;
  capturedAt: string;
  rows: EquateSheet["rows"];
};

export async function writeEquateSheet(sheet: EquateSheet): Promise<string> {
  const k = key(sheet.region, sheet.largeCapOnly);
  const payload: StoredEquate = {
    region: sheet.region,
    largeCapOnly: sheet.largeCapOnly,
    capturedAt: new Date().toISOString(),
    rows: sheet.rows,
  };
  await (await getRedis()).set(k, JSON.stringify(payload));
  return k;
}

export async function readEquateSheet(
  region: "us" | "canada",
  largeCapOnly = false,
): Promise<StoredEquate | null> {
  try {
    const raw = await (await getRedis()).get(key(region, largeCapOnly));
    return raw ? (JSON.parse(raw) as StoredEquate) : null;
  } catch (e) {
    console.error("Redis read error (equate):", e);
    return null;
  }
}
