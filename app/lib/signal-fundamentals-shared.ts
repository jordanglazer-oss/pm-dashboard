/**
 * Fundamentals behind the signal grid — pure types and maths (no I/O).
 * The loader is signal-fundamentals.ts. Every figure is from FactSet; a figure
 * that cannot be formed is null and reads "no data", never a guess.
 */

export type RawFundamentals = {
  pe?: number | null;
  mktVal?: number | null;
  debt?: number | null;
  cash?: number | null;
  ebitdaLtm?: number | null;
  ebitdaAnn?: number | null;
  operIncLtm?: number | null;
  intExp?: number | null;
  fcfLtm?: number | null;
  salesLtm?: number | null;
  salesLtm4?: number | null;
  roic?: number | null;
  ltg?: number | null;
  sector?: string | null;
};

export type NameFundamentals = {
  sector: string | null;
  pe: number | null;
  /** % above (+) or below (−) the median P/E of the S&P 500 + TSX 60. */
  peVsMarketPct: number | null;
  /** % above or below the median P/E of its GICS sector in that universe. */
  peVsSectorPct: number | null;
  evEbitda: number | null;
  /** (Total debt − cash) ÷ EBITDA. Negative = net cash. */
  netDebtEbitda: number | null;
  /** Operating income ÷ interest expense. */
  interestCoverage: number | null;
  /** True when the company has no debt on file (coverage is not meaningful, and that is good). */
  noDebt: boolean;
  fcfMargin: number | null;
  roic: number | null;
  revenueGrowth: number | null;
  peg: number | null;
  forwardPE5yAvg?: number | null;
  ntmPe?: number | null;
  evEbitda5yAvg?: number | null;
  evEbitdaForHistory?: number | null;
  valuationAsOf?: string | null;
};

export type SignalFundamentals = {
  at: string;
  source: "FactSet";
  market: { peMedian: number | null; names: number };
  sectors: Record<string, { peMedian: number; names: number }>;
  names: Record<string, NameFundamentals>;
  notes: string[];
  error?: string;
};

const pos = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const fin = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const round = (v: number, d = 2) => parseFloat(v.toFixed(d));

export function median(xs: number[]): number | null {
  const s = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** P/E values that can be ranked: positive and not absurd (a near-zero-earnings 900x is not a valuation). */
export const usablePe = (v: number | null | undefined): v is number => pos(v) && v < 150;

/** Banks, insurers and the like: debt, EBITDA, interest cover and free cash flow do not describe them (checked 2026-11-26: Goldman read a 102% cash-flow margin). */
export const isFinancial = (sector: string | null | undefined) => /financ/i.test(sector ?? "");

export function deriveFundamentals(raw: RawFundamentals, marketPe: number | null, sectorPe: number | null): NameFundamentals {
  const fincl = isFinancial(raw.sector);
  const ebitda = pos(raw.ebitdaLtm) ? raw.ebitdaLtm : pos(raw.ebitdaAnn) ? raw.ebitdaAnn : null;
  const pe = usablePe(raw.pe) ? raw.pe : null;
  const netDebt = fin(raw.debt) && fin(raw.cash) ? raw.debt - raw.cash : null;
  const ev = pos(raw.mktVal) && netDebt != null ? raw.mktVal + netDebt : null;
  const noDebt = fin(raw.debt) && raw.debt <= 0;
  return {
    sector: raw.sector ?? null,
    pe: pe != null ? round(pe, 1) : null,
    peVsMarketPct: pe != null && pos(marketPe) ? round((pe / marketPe - 1) * 100, 1) : null,
    peVsSectorPct: pe != null && pos(sectorPe) ? round((pe / sectorPe - 1) * 100, 1) : null,
    evEbitda: !fincl && ev != null && ebitda != null && ev > 0 ? round(ev / ebitda, 1) : null,
    netDebtEbitda: !fincl && netDebt != null && ebitda != null ? round(netDebt / ebitda, 2) : null,
    interestCoverage: !fincl && pos(raw.intExp) && fin(raw.operIncLtm) ? round(raw.operIncLtm / raw.intExp, 1) : null,
    noDebt: !fincl && noDebt,
    fcfMargin: !fincl && fin(raw.fcfLtm) && pos(raw.salesLtm) ? round((raw.fcfLtm / raw.salesLtm) * 100, 1) : null,
    roic: fin(raw.roic) ? round(raw.roic, 1) : null,
    revenueGrowth: pos(raw.salesLtm) && pos(raw.salesLtm4) ? round((raw.salesLtm / raw.salesLtm4 - 1) * 100, 1) : null,
    peg: pe != null && pos(raw.ltg) ? round(pe / raw.ltg, 2) : null,
  };
}
