import type { SourceHit } from "./watchlist-candidates";

/**
 * RBC EQUATE Model Ranks — weekly quant rank sheets.
 *
 * Three files arrive: US Large Cap, US All Cap, Canada All Cap. They share one
 * layout: SYM, NAME, PRICE, COMPOSITE RANK, COMPOSITE DECILE SCORE, then the
 * four factor deciles (VALUE / MOMENTUM / GROWTH / QUALITY), the individual
 * factor deciles, SECTOR, GICS, and a size column.
 *
 * TWO THINGS THAT WOULD SILENTLY CORRUPT THE RANKING IF MISSED:
 *
 * 1. US LARGE CAP IS A SUBSET OF US ALL CAP. Measured on the 2026-08-14 files:
 *    all 500 Large Cap names appear in All Cap with the IDENTICAL composite
 *    rank. They are one source filtered two ways, not two opinions. Scoring
 *    both would double every large-cap name for appearing in a redundant file
 *    and tilt the whole suggested watchlist toward mega-caps — the opposite of
 *    surfacing new ideas. Large Cap is therefore folded into the same source
 *    and used only to TAG membership.
 *
 * 2. LOW NUMBERS ARE GOOD. Composite rank 1 is the best name in the universe
 *    and decile 1 is the best decile, for every factor column too. Inverting
 *    that would recommend the worst-ranked names while looking entirely
 *    plausible.
 *
 * US All Cap is ~1,360 rows, so a cutoff is mandatory — every name cannot be a
 * candidate. The default takes the top decile only.
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
 * A Large Cap sheet yields NOTHING on its own — All Cap already contains every
 * one of its names at the same rank, so emitting hits here would double-count.
 * Load it only if All Cap is unavailable.
 */
export function equateHits(
  sheet: EquateSheet,
  opts?: { maxDecile?: number; allowLargeCapAsSource?: boolean },
): SourceHit[] {
  if (sheet.largeCapOnly && !opts?.allowLargeCapAsSource) return [];
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
