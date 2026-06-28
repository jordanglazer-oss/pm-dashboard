/**
 * FactSet client — talks to the static-IP relay (factset-relay/), never to
 * FactSet directly. The relay holds the FactSet API key; this client only
 * knows the relay URL + shared secret (FACTSET_RELAY_URL / FACTSET_RELAY_SECRET
 * env vars). See factset-relay/README.md for the security model.
 *
 * Request contract (matches the relay):
 *   GET <RELAY_URL>/?u=<url-encoded FactSet path + query>
 *   Header: x-relay-key: <RELAY_SECRET>
 *
 * Nothing imports this yet — it's wired into the price / fund-data / refresh
 * paths one data type at a time, FactSet-primary with the existing source as
 * fallback. Dormant until FACTSET_RELAY_URL + FACTSET_RELAY_SECRET are set.
 */

import { createLogger } from "@/app/lib/logger";

const log = createLogger("FactSet");

const RELAY_URL = process.env.FACTSET_RELAY_URL;
const RELAY_SECRET = process.env.FACTSET_RELAY_SECRET;

export function factsetConfigured(): boolean {
  return !!(RELAY_URL && RELAY_SECRET);
}

/** Formula codes confirmed working via live testing (June 2026). */
export const FACTSET_FORMULAS = {
  price: "P_PRICE",
  beta: "P_BETA",
  pe: "FG_PE",
  marketCap: "FG_MKT_VALUE",
  dividendYield: "FG_DIV_YLD",
  sector: "FG_GICS_SECTOR",
  priceTargetMean: "FE_ESTIMATE(PRICE_TGT,MEAN,ANN_ROLL,0,NOW,'')",
  salesAnnual: "FF_SALES(ANN,0)",
} as const;

/** Total return between two YYYYMMDD dates (e.g. P_TOTAL_RETURNC(20250626,20260626)). */
export function totalReturnFormula(startYYYYMMDD: string, endYYYYMMDD: string): string {
  return `P_TOTAL_RETURNC(${startYYYYMMDD},${endYYYYMMDD})`;
}

export type FactsetValue = number | string | null;

type FactsetDataItem = {
  dataItemName: string;
  result: FactsetValue[];
  dataType: string;
  error: number;
  errorMessage?: string;
};
type FactsetCrossSectional = { data?: FactsetDataItem[]; meta?: unknown };

function relayBase(): string {
  return (RELAY_URL || "").replace(/\/$/, "");
}

/** Low-level: pass a raw FactSet API path+query through the relay. */
async function relayGet(factsetPath: string): Promise<unknown> {
  if (!factsetConfigured()) throw new Error("FactSet relay not configured");
  const url = `${relayBase()}/?u=${encodeURIComponent(factsetPath)}`;
  const res = await fetch(url, {
    headers: { "x-relay-key": RELAY_SECRET as string },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`FactSet relay returned ${res.status}`);
  return res.json();
}

/** Unauthenticated relay health check. */
export async function relayHealthy(): Promise<boolean> {
  try {
    if (!RELAY_URL) return false;
    const res = await fetch(`${relayBase()}/health`, { cache: "no-store" });
    if (!res.ok) return false;
    const j = (await res.json()) as { ok?: boolean };
    return j?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Map the cross-sectional response into { [factsetId]: { [formula]: value } }.
 * The `requestId` data item carries the id order FactSet used; every other
 * data item is one formula, aligned to that id order by index. A formula whose
 * `error` is non-zero (e.g. 107 "Unknown expression") yields null for all ids.
 */
function parseCrossSectional(
  raw: FactsetCrossSectional,
  requestedFormulas: string[]
): Record<string, Record<string, FactsetValue>> {
  const out: Record<string, Record<string, FactsetValue>> = {};
  const items = raw?.data || [];
  const reqIdItem = items.find((d) => d.dataItemName === "requestId");
  const idOrder = (reqIdItem?.result || []).map((x) => String(x));
  const formulaItems = items.filter((d) => d.dataItemName !== "requestId");

  for (const id of idOrder) out[id] = {};

  formulaItems.forEach((item, fi) => {
    const key = requestedFormulas[fi] ?? item.dataItemName;
    if (item.error !== 0 && item.errorMessage) {
      log.warn(`formula "${key}" -> error ${item.error}: ${item.errorMessage}`);
    }
    idOrder.forEach((id, i) => {
      out[id][key] = item.error === 0 ? item.result?.[i] ?? null : null;
    });
  });

  return out;
}

/**
 * Cross-sectional query: N FactSet ids x M formulas in one round trip.
 * Inner commas in a formula (FF_SALES(ANN,0)) are encoded %2C so they aren't
 * read as formula separators; the relay's ?u= transport preserves the
 * distinction between an inner %2C and a separator comma (see factset-relay).
 */
export async function crossSectional(
  ids: string[],
  formulas: string[]
): Promise<Record<string, Record<string, FactsetValue>>> {
  if (ids.length === 0 || formulas.length === 0) return {};
  const idStr = ids.join(",");
  const formulaStr = formulas.map((f) => f.replace(/,/g, "%2C")).join(",");
  const path = `/formula-api/v1/cross-sectional?ids=${idStr}&formulas=${formulaStr}`;
  const raw = (await relayGet(path)) as FactsetCrossSectional;
  return parseCrossSectional(raw, formulas);
}

/** Convenience: latest price for one or more FactSet ids ({ id: price|null }). */
export async function getPrices(ids: string[]): Promise<Record<string, number | null>> {
  const data = await crossSectional(ids, [FACTSET_FORMULAS.price]);
  const out: Record<string, number | null> = {};
  for (const id of Object.keys(data)) {
    const v = data[id][FACTSET_FORMULAS.price];
    out[id] = typeof v === "number" ? v : null;
  }
  return out;
}
