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

export type SiaCsvParseResult = {
  rows: ScrapedSia[];
  errors: string[];
};

export function parseSiaCsv(text: string): SiaCsvParseResult {
  const errors: string[] = [];
  // Strip BOM and split on any line ending.
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    errors.push("CSV looks empty (no data rows found).");
    return { rows: [], errors };
  }
  const sep = detectCsvSeparator(lines[0]);
  const header = splitCsvRow(lines[0], sep).map((h) => h.toLowerCase());
  const idx = {
    symbol: header.findIndex((h) => h === "sym" || h === "symbol" || h === "ticker"),
    smax: header.findIndex((h) => h === "smax" || h === "s-max" || h === "smax score"),
  };
  if (idx.symbol < 0) {
    errors.push("CSV is missing a 'SYM' column (also accepts 'Symbol' or 'Ticker').");
    return { rows: [], errors };
  }
  if (idx.smax < 0) {
    errors.push("CSV is missing a 'SMAX' column.");
    return { rows: [], errors };
  }
  const rows: ScrapedSia[] = [];
  for (const raw of lines.slice(1)) {
    const cells = splitCsvRow(raw, sep);
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
  }
  return { rows, errors };
}
