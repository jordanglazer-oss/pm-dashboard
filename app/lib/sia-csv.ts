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
  /** Rows in this file's ranked block — 504 for the S&P 500, 62 for the TSX.
   *  Carried per row so a rank can be read as a position WITHIN ITS OWN index
   *  after the two files are merged into one snapshot. Without it, rank 60
   *  from a 62-name index and rank 60 from a 504-name index are
   *  indistinguishable, and any threshold applied to the merged set means
   *  something different for each. Taken from the file's contents, not its
   *  name, so it needs no renaming and keeps working for any index SIA adds.
   */
  universeSize?: number;
  dChg?: number;
  wChg?: number;
  mChg?: number;
  qChg?: number;
  sector?: string;
  /** SIA's own relative-strength percentile ("97.18%"), as a 0-100 number.
   *  Present in the HOLDINGS exports, which have no RANK column; the index
   *  exports carry rank instead. Continuous where SMAX is a 0-10 integer that
   *  ties dozens of names together. */
  percentile?: number;
};

export type SiaCsvParseResult = {
  rows: ScrapedSia[];
  /** Same rows with the ranked-export extras, when those columns are present. */
  ranked: SiaRankedRow[];
  errors: string[];
};

/** SIA's ranked export, in the order the vendor publishes it. Used ONLY when a
 *  file arrives with no header row, and only after the data confirms the fit. */
const RANKED_LAYOUT = [
  "rank", "d chg", "w chg", "m chg", "q chg", "name", "sym",
  "smax", "sector", "price", "pnf 1%", "1d", "1w", "1m", "3m", "ytd",
];

const TICKER_RE = /^[A-Z][A-Z0-9]{0,5}(?:[.\-][A-Z0-9]{1,3}){0,2}$/;

/**
 * Try to read a headerless file as SIA's ranked export.
 *
 * Refuses unless the data actually behaves like the layout claims: the SYM
 * column must look like tickers and SMAX must be small integers. Column count
 * alone is not evidence — plenty of CSVs have sixteen columns.
 */
type CsvSep = ReturnType<typeof detectCsvSeparator>;

function inferHeaderlessLayout(
  lines: string[],
  sepIn: CsvSep,
): { ok: true; header: string[]; sep: CsvSep } | { ok: false; reason: string } {
  const sep = detectCsvSeparator(lines[0]) || sepIn;
  const rows = lines.slice(0, 40).map((l) => splitCsvRow(l, sep));
  if (rows.length === 0) return { ok: false, reason: "no rows" };

  // Allow the known leading-blank quirk: data may carry one extra column.
  const width = rows[0].length;
  const offset = width === RANKED_LAYOUT.length + 1 ? 1 : 0;
  if (width - offset !== RANKED_LAYOUT.length) {
    return { ok: false, reason: `expected ${RANKED_LAYOUT.length} columns, found ${width}` };
  }

  const symIdx = RANKED_LAYOUT.indexOf("sym") + offset;
  const smaxIdx = RANKED_LAYOUT.indexOf("smax") + offset;

  let tickerLike = 0, smaxLike = 0, counted = 0;
  for (const r of rows) {
    const sym = (r[symIdx] ?? "").trim().toUpperCase();
    const smax = Number((r[smaxIdx] ?? "").trim());
    if (!sym) continue;
    counted++;
    if (TICKER_RE.test(sym)) tickerLike++;
    if (Number.isFinite(smax) && smax >= 0 && smax <= 10) smaxLike++;
  }
  if (counted === 0) return { ok: false, reason: "no populated rows" };
  if (tickerLike / counted < 0.8) {
    return { ok: false, reason: `column ${symIdx} does not look like tickers (${tickerLike}/${counted})` };
  }
  if (smaxLike / counted < 0.8) {
    return { ok: false, reason: `column ${smaxIdx} does not look like SMAX 0-10 (${smaxLike}/${counted})` };
  }

  // Synthesize the header the rest of the parser expects, including the blank
  // leading column when present so the existing shift logic still applies.
  const header = offset ? ["", ...RANKED_LAYOUT] : [...RANKED_LAYOUT];
  return { ok: true, header, sep };
}

export function parseSiaCsv(text: string): SiaCsvParseResult {
  const errors: string[] = [];
  // Strip BOM and split on any line ending.
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    errors.push("CSV looks empty (no data rows found).");
    return { rows: [], ranked: [], errors };
  }
  // ── Find the header row ────────────────────────────────────────────────
  // It is not always line 1. The larger SIA exports carry title / filter /
  // date lines above the column names, so assuming lines[0] made a perfectly
  // good universe file fail with "missing a SYM column" while the small
  // holdings exports — which have no preamble — went through. Scan the first
  // few lines for the row that actually names the columns.
  const SYMBOL_NAMES = ["sym", "symbol", "ticker"];
  let headerLine = -1;
  let sep = detectCsvSeparator(lines[0]);
  let header: string[] = [];
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const trySep = detectCsvSeparator(lines[i]);
    const cells = splitCsvRow(lines[i], trySep).map((h) => h.trim().toLowerCase());
    if (cells.some((c) => SYMBOL_NAMES.includes(c))) {
      headerLine = i;
      sep = trySep;
      header = cells;
      break;
    }
  }
  // ── Headerless exports ─────────────────────────────────────────────────
  // Some SIA exports ship with NO header row at all — the file opens straight
  // on data ("1 | 35 | 60 | SHOPIFY INC | SHOP.TO"). The column ORDER is fixed
  // and documented by the vendor, so the layout can be applied positionally.
  //
  // But positional mapping is only safe if it is CHECKED. Guessing wrong here
  // does not fail loudly — it reads the company name as the ticker and a rank
  // change as SMAX, then writes hundreds of plausible-looking wrong rows. So
  // the inferred layout has to prove itself against the data before it is
  // used, and a file that does not fit is refused rather than half-read.
  let headerless = false;
  if (headerLine < 0) {
    const probe = inferHeaderlessLayout(lines, sep);
    if (probe.ok) {
      headerless = true;
      header = probe.header;
      headerLine = -1; // no header line to skip: data starts at line 0
      sep = probe.sep;
    } else {
      // Dump enough to identify the file. "Missing a SYM column" with no
      // sample made a wrong file and a layout change indistinguishable.
      const dump = lines.slice(0, 3).map((l, i) => {
        const cells = splitCsvRow(l, detectCsvSeparator(l));
        return `  row ${i}: [${cells.length} cols] ` + cells.slice(0, 12).map((c) => c.trim() || "\u2205").join(" | ");
      }).join("\n");
      errors.push(
        `No SYM / Symbol / Ticker column in the first ${Math.min(lines.length, 15)} lines, and the columns do not match SIA's ranked layout (${probe.reason}).\n${dump}`,
      );
      return { rows: [], ranked: [], errors };
    }
  }
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
    // Holdings-export only: SIA's relative-strength percentile. Deliberately
    // NOT matched by the bare "rank" alias above — "SIA Rank" here is a
    // percentile string ("97.18%"), not a position, and reading it as a rank
    // would put 97 into a field the pipeline treats as "97th best name".
    percentile: header.findIndex((h) => h === "sia rank" || h === "sia rank %"),
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
  // Data starts after the header WHEREVER it was found — slice(1) silently
  // fed preamble lines in as data when the header was not line 1.
  for (const raw of lines.slice(headerless ? 0 : headerLine + 1)) {
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
    const pctRaw = idx.percentile >= 0 ? (cells[idx.percentile] ?? "").trim() : "";
    if (pctRaw && pctRaw !== "-") {
      const n = Number(pctRaw.replace(/[^0-9.\-]/g, ""));
      if (Number.isFinite(n) && n >= 0 && n <= 100) rankedRow.percentile = n;
    }
    ranked.push(rankedRow);
  }
  // Stamp each row with the size of the ranked block it came from. Only for a
  // COMPLETE cut (ranks 1..N, no gaps) — a holdings export's ranks are
  // scattered positions within SIA's whole universe, so its row count says
  // nothing about the universe those ranks refer to and labelling it would be
  // a lie the pipeline would then divide by.
  const ranks = ranked.map((r) => r.rank).filter((r): r is number => typeof r === "number");
  if (ranks.length === ranked.length && ranks.length > 0) {
    const unique = new Set(ranks);
    if (unique.size === ranks.length && Math.min(...ranks) === 1 && Math.max(...ranks) === ranks.length) {
      for (const r of ranked) r.universeSize = ranked.length;
    }
  }

  return { rows, ranked, errors };
}
