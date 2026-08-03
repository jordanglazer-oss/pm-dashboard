/**
 * Shared SIA (SIACharts) CSV parser. Reads the SIA watchlist export by
 * HEADER NAME — looks for `SYM` (or `Symbol` / `Ticker`) and `SMAX` and
 * ignores every other column (Weight, NAME, PRICE, SIA Rank, acb/s, G/L,
 * YTD, etc.). Tab- and comma-separated both work; quoted commas/tabs are
 * preserved. CASH rows or rows with dash placeholders are skipped.
 *
 * Output entries are SHAPE-COMPATIBLE with the vision scraper's output
 * (`ScrapedSia` in screenshot-extractors.ts), so the existing
 * applySiaEntries helper in stock-patches.ts handles them WITHOUT change.
 */

import type { ScrapedSia } from "./screenshot-extractors";
import { splitCsvRow, detectCsvSeparator } from "./csv-utils";

/**
 * A row from a RANKED index export (S&P 500 / TSX), which carries columns the
 * watchlist export doesn't: the name's position in SIA's ranking and how that
 * position moved over each window.
 *
 * Rank matters more than SMAX for ranking a universe: SMAX is a 0-10 integer,
 * so across ~750 names hundreds tie at 8/9/10 (every row of the sample export
 * sits at 10). Rank is continuous and its change is the momentum signal —
 * and because the export carries the change directly, movement is available
 * from the FIRST upload rather than needing two weeks of snapshots.
 */
export type SiaRankedRow = ScrapedSia & {
  rank?: number;
  dChg?: number;
  wChg?: number;
  mChg?: number;
  qChg?: number;
  sector?: string;
};

export type SiaCsvParseResult = {
  rows: ScrapedSia[];
  /** Same rows with the ranked-export extras, when those columns are present. */
  ranked: SiaRankedRow[];
  errors: string[];
};

export function parseSiaCsv(text: string): SiaCsvParseResult {
  const errors: string[] = [];
  // Strip BOM and split on any line ending.
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    errors.push("CSV looks empty (no data rows found).");
    return { rows: [], ranked: [], errors };
  }
  const sep = detectCsvSeparator(lines[0]);
  const header = splitCsvRow(lines[0], sep).map((h) => h.toLowerCase());
  const idx = {
    symbol: header.findIndex((h) => h === "sym" || h === "symbol" || h === "ticker"),
    smax: header.findIndex((h) => h === "smax" || h === "s-max" || h === "smax score"),
    // Ranked-export extras — absent from the watchlist export, hence optional.
    rank: header.findIndex((h) => h === "rank"),
    dChg: header.findIndex((h) => h === "d chg" || h === "dchg"),
    wChg: header.findIndex((h) => h === "w chg" || h === "wchg"),
    mChg: header.findIndex((h) => h === "m chg" || h === "mchg"),
    qChg: header.findIndex((h) => h === "q chg" || h === "qchg"),
    sector: header.findIndex((h) => h === "sector"),
  };
  if (idx.symbol < 0) {
    errors.push("CSV is missing a 'SYM' column (also accepts 'Symbol' or 'Ticker').");
    return { rows: [], ranked: [], errors };
  }
  if (idx.smax < 0) {
    errors.push("CSV is missing a 'SMAX' column.");
    return { rows: [], ranked: [], errors };
  }
  // Ranked index exports (S&P 500 / TSX) carry an unnamed leading column, so
  // every DATA row has one more field than the header and each value lands one
  // column right of its heading — the ticker would be read as the company NAME
  // and SMAX as the ticker string, silently producing garbage for every row.
  // Detected per row (rather than assumed for the file) and only when the
  // extra leading cell is genuinely blank.
  const shiftFor = (cells: string[]): string[] =>
    cells.length === header.length + 1 && (cells[0] ?? "").trim() === "" ? cells.slice(1) : cells;

  const rows: ScrapedSia[] = [];
  const ranked: SiaRankedRow[] = [];
  for (const raw of lines.slice(1)) {
    const cells = shiftFor(splitCsvRow(raw, sep));
    const sym = (cells[idx.symbol] ?? "").trim().toUpperCase();
    // Skip CASH rows + any row whose ticker is "-" or empty.
    if (!sym || sym === "-" || sym === "CASH") continue;
    // Normalize dual-class slashes and strip leading "$".
    const ticker = sym.replace(/\//g, "-").replace(/^\$+/, "");
    const row: ScrapedSia = { ticker };
    const rawSmax = (cells[idx.smax] ?? "").trim();
    if (rawSmax && rawSmax !== "-") {
      const n = Number(rawSmax.replace(/[^0-9.\-]/g, ""));
      if (Number.isFinite(n)) {
        row.smax = Math.max(0, Math.min(10, Math.round(n)));
      }
    }
    rows.push(row);

    const num = (i: number): number | undefined => {
      if (i < 0) return undefined;
      const v = (cells[i] ?? "").trim();
      if (!v || v === "-") return undefined;
      const n = Number(v.replace(/[^0-9.\-]/g, ""));
      return Number.isFinite(n) ? n : undefined;
    };
    const rankedRow: SiaRankedRow = { ...row };
    const rank = num(idx.rank);
    if (rank != null) rankedRow.rank = rank;
    const d = num(idx.dChg); if (d != null) rankedRow.dChg = d;
    const w = num(idx.wChg); if (w != null) rankedRow.wChg = w;
    const m = num(idx.mChg); if (m != null) rankedRow.mChg = m;
    const q = num(idx.qChg); if (q != null) rankedRow.qChg = q;
    const sec = idx.sector >= 0 ? (cells[idx.sector] ?? "").trim() : "";
    if (sec) rankedRow.sector = sec;
    ranked.push(rankedRow);
  }
  return { rows, ranked, errors };
}
