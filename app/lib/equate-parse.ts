import type { SourceHit } from "./watchlist-candidates";

/**
 * RBC EQUATE Model Ranks — weekly quant rank sheets.
 *
 * Three files arrive: US Large Cap, US All Cap, Canada All Cap. They share one
 * layout: SYM, NAME, PRICE, COMPOSITE RANK, COMPOSITE DECILE SCORE, then the
 * four factor deciles (VALUE / MOMENTUM / GROWTH / QUALITY), the individual
 * factor deciles, SECTOR, GICS, and a size column.
 *
 WHICH SHEETS COUNT. US Large Cap and Canada All Cap are the sources; US All
 * Cap is IGNORED by default. Its decile-1 cut is ~136 rows dominated by names
 * far below the size the book will ever hold, so it is a weekly review burden
 * that surfaces almost nothing actionable. A name from it can still be looked
 * up by hand when one genuinely comes up.
 *
 * The three sheets overlap heavily — every US Large Cap name also sits in US
 * All Cap at the IDENTICAL composite rank (measured: 500/500 on the 2026-08-14
 * files). They are one source filtered differently, not independent opinions,
 * which is why loading both would be wrong even if All Cap were wanted. Both US
 * sheets emit the same `rbc-equate-usd` source key, so the candidate engine
 * cannot double-count them regardless of what gets ingested.
 *
 * LOW NUMBERS ARE GOOD. Composite rank 1 is the best name in the universe and
 * decile 1 is the best decile, for every factor column too. Inverting that
 * would recommend the worst-ranked names while looking entirely plausible.
 *
 * Parsing is deterministic (the xlsx library), so it costs no model tokens —
 * unlike the screenshot sources, sheet size is not a cost consideration.
 */

export type EquateRow = {
  symbol: string;
  name: string;
  price?: number;
  /** 1 = best in universe. */
  compositeRank: number;
  /** 1 = best decile. */
  decile: number;
  value?: number;
  momentum?: number;
  growth?: number;
  quality?: number;
  sector?: string;
};

export type EquateSheet = {
  /** "us" (Large Cap or All Cap) or "canada". */
  region: "us" | "canada";
  /** True when the file is the Large Cap cut — a filtered view, not a source. */
  largeCapOnly: boolean;
  rows: EquateRow[];
  errors: string[];
};

const num = (v: unknown): number | undefined => {
  if (v == null || v === "") return undefined;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
};

/** Region + cut, from the filename or sheet name. */
export function classifyEquateSheet(label: string): { region: "us" | "canada"; largeCapOnly: boolean } {
  const flat = label.toLowerCase().replace(/[^a-z0-9]/g, "");
  return {
    region: /canada|cad|tsx/.test(flat) ? "canada" : "us",
    largeCapOnly: /largecap/.test(flat),
  };
}

/** Parse already-extracted rows (header row first) into typed rows. */
export function parseEquateRows(rows: unknown[][], label: string): EquateSheet {
  const { region, largeCapOnly } = classifyEquateSheet(label);
  const errors: string[] = [];
  if (!rows.length) return { region, largeCapOnly, rows: [], errors: ["empty sheet"] };

  const header = rows[0].map((h) => String(h ?? "").trim().toUpperCase());
  const at = (want: string) => header.findIndex((h) => h === want);
  const iSym = at("SYM"), iName = at("NAME"), iRank = at("COMPOSITE RANK");
  const iDecile = at("COMPOSITE DECILE SCORE"), iSector = at("SECTOR"), iPrice = at("PRICE");
  const iValue = at("VALUE"), iMom = at("MOMENTUM"), iGrowth = at("GROWTH"), iQual = at("QUALITY");

  if (iSym < 0) errors.push("missing SYM column");
  if (iRank < 0) errors.push("missing COMPOSITE RANK column");
  if (errors.length) return { region, largeCapOnly, rows: [], errors };

  const out: EquateRow[] = [];
  for (const r of rows.slice(1)) {
    const symbol = String(r[iSym] ?? "").trim().toUpperCase();
    const compositeRank = num(r[iRank]);
    if (!symbol || compositeRank == null) continue;
    out.push({
      symbol,
      name: String(r[iName] ?? symbol).trim(),
      price: num(r[iPrice]),
      compositeRank,
      decile: num(r[iDecile]) ?? 10,
      value: iValue >= 0 ? num(r[iValue]) : undefined,
      momentum: iMom >= 0 ? num(r[iMom]) : undefined,
      growth: iGrowth >= 0 ? num(r[iGrowth]) : undefined,
      quality: iQual >= 0 ? num(r[iQual]) : undefined,
      sector: iSector >= 0 ? String(r[iSector] ?? "").trim() || undefined : undefined,
    });
  }
  return { region, largeCapOnly, rows: out, errors };
}

/**
 * Turn a parsed sheet into candidate hits.
 *
 * US Large Cap and Canada All Cap produce hits. US All Cap produces none
 * unless explicitly asked for: its extra names are below the size the book
 * buys, and everything it shares with Large Cap is already covered at the same
 * rank.
 */
export function equateHits(
  sheet: EquateSheet,
  opts?: { maxDecile?: number; includeUsAllCap?: boolean },
): SourceHit[] {
  const isUsAllCap = sheet.region === "us" && !sheet.largeCapOnly;
  if (isUsAllCap && !opts?.includeUsAllCap) return [];
  const maxDecile = opts?.maxDecile ?? 1;
  const source = sheet.region === "canada" ? "rbc-equate-cad" : "rbc-equate-usd";
  return sheet.rows
    .filter((r) => r.decile <= maxDecile)
    .map((r) => ({
      ticker: sheet.region === "canada" ? `${r.symbol}.TO` : r.symbol,
      name: r.name,
      source,
      sector: r.sector,
      rank: r.compositeRank,
      // Top of the universe is a conviction call, not just presence on a list.
      signal: r.compositeRank <= 25 ? ("strong-buy" as const) : ("buy" as const),
    }));
}
