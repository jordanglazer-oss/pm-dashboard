/**
 * Fundstrat Large-Cap / SMID Core lists, read straight out of Tom Lee's daily
 * note — no screenshot, no Anthropic call.
 *
 * Lee's FLASH notes periodically carry both lists in plain text:
 *
 *   Part I: 46 Large-cap Core Ideas: Updated list is below
 *   …
 *   The Current Large-cap Core List as of 8/21/2026 is as follows:
 *   Communication Services: $$ECHO, $$GOOGL, $$NFLX
 *   Consumer Discretionary: $$AMZN, $$TJX, $$TSLA
 *   …
 *   Part II: 65 SMID Core Ideas: Updated list is below
 *   …
 *   The Current SMID Core List as of 8/21/2026 is as follows:
 *   …
 *
 * so the parse is deterministic: GICS sector labels + "$$TICKER" tokens
 * between the "Current … Core List as of" header and the next "Part N" /
 * section end. Every list is CHECKED against the count the note states in its
 * "Part I: 46 Large-cap Core Ideas" heading — a mismatch (a page break that
 * ate a line, a format change) means the list is NOT applied, never a partial
 * replace.
 *
 * The note repeats the same list for weeks, so a list is applied only when its
 * as-of date is NEWER than the one last applied (ResearchState.coreListAsOf).
 * That keeps a manual edit or a screenshot upload made in between from being
 * reverted by the next morning's note. The screenshot scanner stays the
 * manual override.
 *
 * Writes ONLY fundstratLcCoreList / fundstratSmidCoreList — never the Top /
 * SMID Top Ideas (the monthly top 5) or the DQM "Core Ideas" screens.
 */

import { getRedis } from "./redis";
import type { ResearchState } from "./defaults";
import { applyResearchEntries, type ResearchMergeSummary } from "./research-merge";
import { logResearchRemovals } from "./research-removals";
import type { ScrapedRbcRow } from "@/app/api/research-scrape/route";

export type CoreListKind = "largeCap" | "smid";

export type ParsedCoreList = {
  kind: CoreListKind;
  /** "M/D/YYYY" exactly as the note prints it. */
  asOf: string;
  /** Count from the "Part N: 46 Large-cap Core Ideas" heading, if found. */
  statedCount: number | null;
  rows: { ticker: string; sector?: string }[];
};

const SECTORS = [
  "Communication Services",
  "Consumer Discretionary",
  "Consumer Staples",
  "Energy",
  "Financials",
  "Health Care",
  "Healthcare",
  "Industrials",
  "Information Technology",
  "Technology",
  "Materials",
  "Real Estate",
  "Utilities",
];

const LISTS: { kind: CoreListKind; header: RegExp; count: RegExp }[] = [
  {
    kind: "largeCap",
    header: /Current\s+Large[-\s]?cap\s+Core\s+List\s+as\s+of\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
    count: /(\d{1,3})\s+Large[-\s]?cap\s+Core\s+(?:Stock\s+)?Ideas/i,
  },
  {
    kind: "smid",
    header: /Current\s+SMID(?:[-\s]?cap)?\s+Core\s+List\s+as\s+of\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
    count: /(\d{1,3})\s+SMID(?:[-\s]?cap)?\s+Core\s+(?:Stock\s+)?Ideas/i,
  },
];

/** Where a list's ticker block ends: the next "Part N" heading, the other
 *  list's header, or the note's standing back-matter. */
const SECTION_END = /\bPart\s+[IVX]+\b|Current\s+(?:Large[-\s]?cap|SMID(?:[-\s]?cap)?)\s+Core\s+List|Key\s+Incoming\s+Data|\bDisclosures\b/i;

/** pdf.js glues the running page header onto whatever ends a page
 *  ("$$TLNFLASH September 3, 2026Page 11"). Drop it first so it can never be
 *  read as part of a ticker. */
function stripRunningHeaders(text: string): string {
  return text.replace(/FLASH\s*[A-Z][a-z]+\s+\d{1,2},\s*\d{4}\s*(?:Page\s*\d+)?/g, " ");
}

function normalizeTicker(raw: string): string {
  // "BRK.B" / "BRK/B" → "BRK-B" (the app's dash convention for share classes).
  return raw.toUpperCase().replace(/[./]/g, "-").replace(/-+$/, "");
}

export function parseCoreListsFromNote(rawText: string): ParsedCoreList[] {
  const text = stripRunningHeaders(rawText);
  const out: ParsedCoreList[] = [];
  for (const def of LISTS) {
    const h = def.header.exec(text);
    if (!h) continue;
    const start = h.index + h[0].length;
    const rest = text.slice(start);
    const end = rest.search(SECTION_END);
    const block = end >= 0 ? rest.slice(0, end) : rest.slice(0, 6000);

    const c = def.count.exec(text);
    const statedCount = c ? Number(c[1]) : null;

    const sectorAlt = SECTORS.map((s) => s.replace(/ /g, "\\s+")).join("|");
    const tokenRe = new RegExp(`(${sectorAlt})\\s*:|\\$\\$?([A-Z][A-Z0-9]{0,5}(?:[./][A-Z]{1,2})?)\\b`, "g");
    const rows: ParsedCoreList["rows"] = [];
    const seen = new Set<string>();
    let sector: string | undefined;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(block))) {
      if (m[1]) {
        sector = m[1].replace(/\s+/g, " ");
        continue;
      }
      const ticker = normalizeTicker(m[2]);
      if (seen.has(ticker)) continue;
      seen.add(ticker);
      rows.push({ ticker, sector });
    }
    out.push({ kind: def.kind, asOf: h[1], statedCount, rows });
  }
  return out;
}

function asOfMs(d: string | undefined): number {
  if (!d) return 0;
  const [m, day, y] = d.split("/").map(Number);
  if (!m || !day || !y) return 0;
  return Date.UTC(y < 100 ? 2000 + y : y, m - 1, day);
}

export type CoreListSyncResult = {
  kind: CoreListKind;
  asOf: string;
  parsed: number;
  statedCount: number | null;
  status: "applied" | "unchanged" | "count-mismatch" | "empty";
  summary?: ResearchMergeSummary;
};

/**
 * Parse Lee's note and apply any Core list whose as-of date is newer than the
 * one last applied. Read-modify-write of pm:research: only the two Core LISTS
 * (fundstratLcCoreList / fundstratSmidCoreList),
 * `scanDates` and `coreListAsOf` change; every other list on the blob is
 * carried through untouched by applyResearchEntries' `{ ...state }` spread.
 *
 * Never writes when nothing qualifies, and refuses to write if pm:research
 * can't be read (a defaults blob written back would wipe every list).
 */
export async function syncCoreListsFromLeeNote(text: string): Promise<CoreListSyncResult[]> {
  const parsed = parseCoreListsFromNote(text);
  if (parsed.length === 0) return [];

  const redis = await getRedis();
  const raw = await redis.get("pm:research");
  if (!raw) return []; // no research blob yet — nothing to merge into
  let state = JSON.parse(raw) as ResearchState;

  const results: CoreListSyncResult[] = [];
  const removals: { tickers: string[]; source: "fundstrat-lc-core-list" | "fundstrat-smid-core-list" }[] = [];
  let changed = false;

  for (const list of parsed) {
    const base = { kind: list.kind, asOf: list.asOf, parsed: list.rows.length, statedCount: list.statedCount };
    if (list.rows.length === 0) { results.push({ ...base, status: "empty" }); continue; }
    if (list.statedCount == null || list.statedCount !== list.rows.length) {
      results.push({ ...base, status: "count-mismatch" });
      continue;
    }
    const prevAsOf = state.coreListAsOf?.[list.kind];
    if (asOfMs(list.asOf) <= asOfMs(prevAsOf)) { results.push({ ...base, status: "unchanged" }); continue; }

    // ONLY the Core LISTS. The Top / SMID Top Ideas (monthly top 5) and the
    // DQM "Core Ideas" screens are never touched by the note.
    const source = list.kind === "largeCap" ? "fundstrat-lc-core-list" : "fundstrat-smid-core-list";
    // No dateAdded: a name already on the list keeps its own, and the note's
    // as-of date is the list's revision date, not when each name joined.
    const entries: ScrapedRbcRow[] = list.rows.map((r) => ({ ticker: r.ticker, sector: r.sector }));
    const { nextState, summary } = applyResearchEntries(state, source, entries);
    state = { ...nextState, coreListAsOf: { ...(state.coreListAsOf ?? {}), [list.kind]: list.asOf } };
    changed = true;
    if (summary.removedTickers.length > 0) removals.push({ tickers: summary.removedTickers, source });
    results.push({ ...base, status: "applied", summary });
  }

  if (changed) {
    await redis.set("pm:research", JSON.stringify(state));
    for (const r of removals) {
      await logResearchRemovals(redis, r.tickers, r.source).catch((err) =>
        console.error("[Core lists] removal log failed:", err),
      );
    }
  }
  return results;
}

/** One-line human summary for the Inbox log / route response. */
export function describeCoreSync(results: CoreListSyncResult[]): string {
  if (results.length === 0) return "";
  const label = (k: CoreListKind) => (k === "largeCap" ? "Fundstrat Large-Cap Core List" : "Fundstrat SMID Core List");
  return results
    .map((r) => {
      if (r.status === "applied" && r.summary) {
        const s = r.summary;
        return `${label(r.kind)} list (as of ${r.asOf}) applied: ${s.added} added · ${s.removed} removed · ${s.matched} kept${s.mode === "additive" ? " (additive)" : ""}`;
      }
      if (r.status === "unchanged") return `${label(r.kind)} list as of ${r.asOf} already applied`;
      if (r.status === "count-mismatch") return `${label(r.kind)} list NOT applied — parsed ${r.parsed} names but the note says ${r.statedCount ?? "?"}`;
      return `${label(r.kind)} list header found but no tickers parsed`;
    })
    .join("; ");
}
