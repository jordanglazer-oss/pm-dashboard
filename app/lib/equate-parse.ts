import type { SourceHit } from "./watchlist-candidates";

/**
 * RBC EQUATE Model Ranks — weekly quant rank sheets.
 *
 * Three files arrive: US Large Cap, US All Cap, Canada All Cap. They share one
 * layout: SYM, NAME, PRICE, COMPOSITE RANK, COMPOSITE DECILE SCORE, then the
 * four factor deciles (VALUE / MOMENTUM / GROWTH / QUALITY), the individual
 * factor deciles, SECTOR, GICS, and a size column.
 *
 WHICH SHEETS COUNT. US All Cap and Canada All Cap are the sources. US Large
 * Cap is IGNORED: every one of its names already sits in All Cap at the
 * IDENTICAL composite rank (measured 500/500 on the 2026-08-14 files), so it
 * is a filtered view of the same opinion and adds nothing but a second reading
 * of names already covered.
 *
 * Investability is handled by SIZE, not by choosing a smaller file. Filtering
 * on market cap keeps the full 1,360-name universe in play while excluding the
 * micro caps the book will not buy — strictly better than dropping All Cap,
 * which would have discarded 860 names to avoid a few hundred unwanted ones.
 * `minMarketCap` is off by default; set it to trade coverage for relevance.
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
  /** MKT CAP (US) / M FLOAT (Canada), in millions of local currency. */
  marketCapM?: number;
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
  // US sheets carry MKT CAP; the Canadian sheet carries M FLOAT instead.
  const iCap = at("MKT CAP") >= 0 ? at("MKT CAP") : at("M FLOAT");

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
      marketCapM: iCap >= 0 ? num(r[iCap]) : undefined,
    });
  }
  return { region, largeCapOnly, rows: out, errors };
}

/**
 * Turn a parsed sheet into candidate hits.
 *
 * US All Cap and Canada All Cap produce hits. US Large Cap produces none: All
 * Cap already holds every one of its names at the same rank.
 *
 * `minMarketCap` (millions) drops names below a size floor — the investable
 * filter, applied to the full universe rather than by picking a smaller file.
 * Rows with no size figure are KEPT: a missing column should not silently
 * delete a name, and the Canadian sheet reports float rather than cap.
 */
export function equateHits(
  sheet: EquateSheet,
  opts?: { maxDecile?: number; minMarketCap?: number; includeLargeCapSheet?: boolean },
): SourceHit[] {
  if (sheet.largeCapOnly && !opts?.includeLargeCapSheet) return [];
  const maxDecile = opts?.maxDecile ?? 1;
  const minCap = opts?.minMarketCap ?? 0;
  const source = sheet.region === "canada" ? "rbc-equate-cad" : "rbc-equate-usd";
  return sheet.rows
    .filter((r) => r.decile <= maxDecile)
    .filter((r) => minCap <= 0 || r.marketCapM == null || r.marketCapM >= minCap)
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
