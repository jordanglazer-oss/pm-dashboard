/**
 * Shared MarketEdge ("ChartScout") CSV parser. Reads the ChartScout Likes
 * export by HEADER NAME — Symbol / Opinion / Score (or Opinion Score) /
 * Power Rating / Opinion Date — so re-ordered exports keep working. Other
 * columns are ignored. Tab- and comma-separated both work.
 *
 * Used by both the manual CSV importer on the Inbox tab and the email
 * webhook so a CSV that arrives by email follows the EXACT same parsing +
 * matching path as a manual upload.
 */

import type { MarketEdgeOpinion } from "./external-scoring";
import { splitCsvRow, detectCsvSeparator } from "./csv-utils";

export type MarketEdgeCsvRow = {
  ticker: string;
  opinion?: MarketEdgeOpinion;
  opinionScore?: number;
  powerRating?: number;
  opinionDate?: string;
};

export type MarketEdgeParseResult = {
  rows: MarketEdgeCsvRow[];
  errors: string[];
};

export function parseMarketEdgeCsv(text: string): MarketEdgeParseResult {
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
    symbol: header.findIndex((h) => h === "symbol" || h === "ticker"),
    opinion: header.findIndex((h) => h === "opinion"),
    score: header.findIndex((h) => h === "score" || h === "opinion score"),
    powerRating: header.findIndex((h) => h === "power rating"),
    date: header.findIndex((h) => h === "opinion date" || h === "date"),
  };
  if (idx.symbol < 0) {
    errors.push("CSV is missing a 'Symbol' column.");
    return { rows: [], errors };
  }
  const rows: MarketEdgeCsvRow[] = [];
  for (const raw of lines.slice(1)) {
    const cells = splitCsvRow(raw, sep);
    const sym = (cells[idx.symbol] ?? "").trim().toUpperCase();
    if (!sym) continue;
    const row: MarketEdgeCsvRow = { ticker: sym };
    if (idx.opinion >= 0) {
      const v = (cells[idx.opinion] ?? "").trim().toLowerCase();
      if (v === "long") row.opinion = "long";
      else if (v === "avoid") row.opinion = "avoid";
      else if (v === "neutral") row.opinion = "neutral";
    }
    if (idx.score >= 0) {
      const n = parseFloat((cells[idx.score] ?? "").trim());
      if (Number.isFinite(n)) row.opinionScore = Math.max(-4, Math.min(4, Math.round(n)));
    }
    if (idx.powerRating >= 0) {
      const n = parseFloat((cells[idx.powerRating] ?? "").trim());
      if (Number.isFinite(n)) row.powerRating = Math.max(-60, Math.min(100, Math.round(n)));
    }
    if (idx.date >= 0) {
      const d = (cells[idx.date] ?? "").trim();
      if (d) row.opinionDate = d;
    }
    rows.push(row);
  }
  return { rows, errors };
}
