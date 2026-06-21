/**
 * Shared BoostedAI CSV parser. Reads the Boosted.ai "unified data" export
 * by HEADER NAME — pulls TICKER, AVERAGE RATING (→ the 0-5 numeric rating)
 * and CONSENSUS RECOMMENDATION (→ the strong-buy…strong-sell label), and
 * ignores every other column (watchlist name, horizon, country, excess
 * returns, style match, etc.).
 *
 * Output entries are SHAPE-COMPATIBLE with the vision scraper's output
 * (`ScrapedBoosted` in screenshot-extractors.ts), so the existing
 * applyBoostedEntries helper handles them WITHOUT change — same priority
 * rule, same dual-listing match (a bare "CLS" / "CNR" matches a held
 * "CLS.TO" / "CNR.TO"), same per-stock chip behavior.
 *
 * The export is TAB-separated but its SECURITY NAME values contain commas
 * (e.g. "Amazon.com, Inc."), so the delimiter is detected from the header
 * line rather than per-row.
 */

import type { ScrapedBoosted } from "./screenshot-extractors";
import type { BoostedAiConsensus } from "./external-scoring";
import { splitCsvRow, detectCsvSeparator } from "./csv-utils";

export type BoostedCsvParseResult = {
  rows: ScrapedBoosted[];
  errors: string[];
};

function normalizeConsensus(raw: string): BoostedAiConsensus | undefined {
  const s = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
  switch (s) {
    case "strong-buy": case "strongly-buy": return "strong-buy";
    case "buy": return "buy";
    case "hold": case "neutral": return "hold";
    case "sell": return "sell";
    case "strong-sell": case "strongly-sell": return "strong-sell";
    default: return undefined;
  }
}

export function parseBoostedCsv(text: string): BoostedCsvParseResult {
  const errors: string[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    errors.push("CSV looks empty (no data rows found).");
    return { rows: [], errors };
  }
  const sep = detectCsvSeparator(lines[0]);
  const header = splitCsvRow(lines[0], sep).map((h) => h.toLowerCase().trim());
  const idx = {
    ticker: header.findIndex((h) => h === "ticker" || h === "symbol"),
    // exact match so "AVERAGE RATING DELTA" and "PREVIOUS CONSENSUS
    // RECOMMENDATION" don't get picked by mistake.
    rating: header.findIndex((h) => h === "average rating"),
    consensus: header.findIndex((h) => h === "consensus recommendation"),
  };
  if (idx.ticker < 0) {
    errors.push("CSV is missing a 'TICKER' column.");
    return { rows: [], errors };
  }
  if (idx.rating < 0 && idx.consensus < 0) {
    errors.push("CSV needs an 'AVERAGE RATING' and/or 'CONSENSUS RECOMMENDATION' column.");
    return { rows: [], errors };
  }
  const rows: ScrapedBoosted[] = [];
  for (const raw of lines.slice(1)) {
    const cells = splitCsvRow(raw, sep);
    const sym = (cells[idx.ticker] ?? "").trim().toUpperCase();
    if (!sym || sym === "-" || sym === "CASH") continue;
    const ticker = sym.replace(/\//g, "-").replace(/^\$+/, "");
    const row: ScrapedBoosted = { ticker };
    if (idx.rating >= 0) {
      const n = parseFloat((cells[idx.rating] ?? "").trim());
      if (Number.isFinite(n)) row.rating = Math.max(0, Math.min(5, Math.round(n * 10) / 10));
    }
    if (idx.consensus >= 0) {
      const c = normalizeConsensus(cells[idx.consensus] ?? "");
      if (c) row.consensus = c;
    }
    rows.push(row);
  }
  return { rows, errors };
}
