/**
 * Sanity rules for stored fund / ETF data (Nov 2026). Pure — no I/O.
 *
 * Found 2026-11-26: XUH.TO showed "102% Financials". A fund that holds ONE
 * other fund (a currency-hedged wrapper: XUH → XUU, XSP → IVV) is listed by
 * the data provider as a single holding tagged "Financials" (the wrapper is a
 * trust unit), so a sector breakdown built from its holdings is the WRAPPER's
 * tag, not what the fund is exposed to. The report's look-through already
 * ignores such a breakdown; this is the same rule for the fund page and for
 * new fetches, plus a read-only audit of every fund on file.
 *
 * Nothing here guesses a replacement: an unreliable breakdown is withheld and
 * said to be withheld.
 */

type Holding = { symbol?: string; name?: string; weight?: number };
type SectorWeight = { sector: string; weight: number };
export type FundLike = {
  topHoldings?: Holding[];
  sectorWeightings?: SectorWeight[];
  assetAllocation?: { stock?: number; bond?: number; cash?: number; other?: number };
  expenseRatio?: number;
  holdingsLastUpdated?: string;
  lastUpdated?: string;
  holdingsSource?: string;
  performance?: Record<string, unknown>;
};

export const FUND_SANITY = {
  /** One holding at or above this % of the fund = a wrapper around another fund. */
  wrapperHoldingPct: 80,
  /** ...and one sector at or above this % means the breakdown is that holding's tag, not the fund's exposure. */
  wrapperSectorPct: 90,
  /** A sector breakdown adding to more than this is not a breakdown. */
  sectorSumMax: 105,
  /** ...and one adding to less than this is partial. */
  sectorSumMin: 80,
  /** Asset allocation should add to about 100. */
  allocationTolerance: 3,
  /** Holdings older than this many days are flagged. */
  holdingsStaleDays: 120,
};

const sum = (xs: (number | undefined)[]) => xs.reduce<number>((a, v) => a + (typeof v === "number" && Number.isFinite(v) ? v : 0), 0);

/** The single holding that makes this fund a wrapper, if any. */
export function wrapperHolding(fd: FundLike): Holding | null {
  const top = [...(fd.topHoldings ?? [])].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];
  return top && (top.weight ?? 0) >= FUND_SANITY.wrapperHoldingPct ? top : null;
}

/**
 * The sector breakdown that can be shown, or null with the reason it is
 * withheld. Never rescales or fills in.
 */
/** The breakdown is the wrapper's own tag: one holding IS the fund, and one sector is (nearly) all of it. */
export function isWrapperTag(fd: FundLike): boolean {
  const sectors = fd.sectorWeightings ?? [];
  if (!sectors.length || !wrapperHolding(fd)) return false;
  const top = Math.max(...sectors.map((s) => s.weight || 0));
  return top >= FUND_SANITY.wrapperSectorPct;
}

/**
 * The sector breakdown that can be shown as is, or null with the reason.
 * A wrapper whose breakdown is already diversified (the feed looked through
 * for us: XUS.U, QQC.F) is shown as is. When `lookThrough` is set, the page
 * should show the UNDERLYING fund's sectors instead. Never rescales or fills in.
 */
export function usableSectors(fd: FundLike): { sectors: SectorWeight[] | null; withheld: string | null; lookThrough: Holding | null } {
  const sectors = fd.sectorWeightings ?? [];
  if (!sectors.length) return { sectors: null, withheld: null, lookThrough: null };
  const w = wrapperHolding(fd);
  if (w && isWrapperTag(fd)) return { sectors: null, lookThrough: w, withheld: `This fund holds one other fund (${w.name || w.symbol}, ${(w.weight ?? 0).toFixed(0)}%). Its sector mix is that fund's sector mix.` };
  const total = sum(sectors.map((s) => s.weight));
  if (total > FUND_SANITY.sectorSumMax) return { sectors: null, lookThrough: null, withheld: `The sector breakdown on file adds to ${total.toFixed(0)}%, so it is not shown.` };
  return { sectors, withheld: null, lookThrough: null };
}

export type FundIssue = { severity: "wrong" | "check" | "missing"; what: string };

/** Every problem found in one fund's stored data. Empty = nothing found by these rules. */
export function auditFund(fd: FundLike | null | undefined, today: string): FundIssue[] {
  const out: FundIssue[] = [];
  if (!fd) return [{ severity: "missing", what: "No fund data on file." }];
  const sectors = fd.sectorWeightings ?? [];
  const w = wrapperHolding(fd);
  const sTotal = sum(sectors.map((s) => s.weight));
  if (sectors.length) {
    const top = [...sectors].sort((a, b) => b.weight - a.weight)[0];
    if (w && isWrapperTag(fd)) out.push({ severity: "wrong", what: `Stored sector breakdown is the wrapper's tag: ${top.sector} ${top.weight.toFixed(1)}%, while the fund holds ${w.name || w.symbol} at ${(w.weight ?? 0).toFixed(0)}%. The fund page shows the underlying fund's sectors instead.` });
    else if (sTotal > FUND_SANITY.sectorSumMax) out.push({ severity: "wrong", what: `Sectors add to ${sTotal.toFixed(1)}%.` });
    else if (sTotal < FUND_SANITY.sectorSumMin) out.push({ severity: "check", what: `Sectors add to only ${sTotal.toFixed(1)}% (partial breakdown).` });
    else if (top.weight >= 90 && sectors.length === 1) out.push({ severity: "check", what: `A single sector at ${top.weight.toFixed(0)}% (${top.sector}). Correct for a sector fund; otherwise wrong.` });
    if (sectors.some((s) => s.weight < 0)) out.push({ severity: "wrong", what: "A sector has a negative weight." });
  } else out.push({ severity: "missing", what: "No sector breakdown on file." });

  const a = fd.assetAllocation;
  if (a) {
    const aTotal = sum([a.stock, a.bond, a.cash, a.other]);
    if (Math.abs(aTotal - 100) > FUND_SANITY.allocationTolerance) out.push({ severity: aTotal > 110 || aTotal < 60 ? "wrong" : "check", what: `Asset allocation adds to ${aTotal.toFixed(1)}%.` });
  } else out.push({ severity: "missing", what: "No asset allocation on file." });

  const holdings = fd.topHoldings ?? [];
  if (!holdings.length) out.push({ severity: "missing", what: "No holdings on file (look-through cannot see inside this fund)." });
  else {
    const hTotal = sum(holdings.map((h) => h.weight));
    if (hTotal > 101.5 && !w) out.push({ severity: "check", what: `Top holdings add to ${hTotal.toFixed(1)}%.` });
    if (holdings.some((h) => (h.weight ?? 0) < 0)) out.push({ severity: "wrong", what: "A holding has a negative weight." });
    const seen = new Set<string>();
    for (const h of holdings) {
      const k = (h.symbol || h.name || "").toUpperCase();
      if (k && seen.has(k)) {
        out.push({ severity: "check", what: `Holding listed twice: ${k}.` });
        break;
      }
      seen.add(k);
    }
  }
  const stamp = fd.holdingsLastUpdated ?? fd.lastUpdated;
  if (!stamp) out.push({ severity: "missing", what: "No date on the holdings data." });
  else {
    const age = Math.round((Date.parse(today) - Date.parse(stamp.slice(0, 10))) / 86_400_000);
    if (age > FUND_SANITY.holdingsStaleDays) out.push({ severity: "check", what: `Holdings last fetched ${age} days ago (${stamp.slice(0, 10)}).` });
  }
  if (!(typeof fd.expenseRatio === "number" && fd.expenseRatio > 0)) out.push({ severity: "missing", what: "No fee (MER) on file." });
  else if (fd.expenseRatio > 5) out.push({ severity: "wrong", what: `Fee reads ${fd.expenseRatio}% — likely a units error.` });
  return out;
}
