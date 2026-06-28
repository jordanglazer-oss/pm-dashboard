/**
 * FactSet "company snapshot" for stock scoring — the financial / valuation /
 * estimate block that feeds Claude (replacing the Yahoo + EDGAR-XBRL context).
 *
 * DEPTH: multi-year history so the model can establish TRENDS, not just read a
 * single year. Core P&L / cash-flow / margin metrics pull 5 fiscal years; some
 * balance-sheet items pull 3; revenue + EPS also pull the last 4 quarters for
 * momentum, plus TTM for freshness. This matches/exceeds the 5-year history the
 * EDGAR block used to provide (which strict-FactSet mode now withholds).
 *
 * The exact FactSet formula CODES are validated via
 * /api/admin/factset-probe?snapshot=<id> before being relied on. Families
 * confirmed working: P_ (prices), FF_ (fundamentals), FG_ (global metrics),
 * FE_ (estimates). Inner commas are encoded %2C downstream automatically —
 * write them as plain commas here.
 *
 * Periodicity: ANN = annual, QTR = quarterly, LTM = last twelve months.
 * Relative period: 0 = most recent, -1 = one prior, etc.
 */

import { crossSectional, type FactsetValue } from "@/app/lib/factset";

export type ScoringFormula = {
  /** Stable key we map into the snapshot (e.g. salesAnn0, salesQtr1, pe). */
  key: string;
  /** FactSet formula (plain commas; encoding handled by the client). */
  formula: string;
  /** What it's for / which scoring category it supports. */
  note: string;
};

/**
 * Metrics pulled as a multi-year ANNUAL series (rel 0..-(years-1)), optionally
 * with a recent QUARTERLY series (rel 0..-(quarters-1)) for momentum.
 */
const ANNUAL_METRICS: { base: string; formula: string; label: string; years: number; quarters?: number }[] = [
  { base: "sales", formula: "FF_SALES", label: "Revenue", years: 5, quarters: 4 },
  { base: "eps", formula: "FF_EPS", label: "EPS", years: 5, quarters: 4 },
  { base: "netInc", formula: "FF_NET_INC", label: "Net income", years: 5 },
  { base: "fcf", formula: "FF_FREE_CF", label: "Free cash flow", years: 5 },
  { base: "ocf", formula: "FF_OPER_CF", label: "Operating cash flow", years: 3 },
  { base: "capex", formula: "FF_CAPEX", label: "Capex", years: 3 },
  { base: "grossMgn", formula: "FF_GROSS_MGN", label: "Gross margin %", years: 5 },
  { base: "operMgn", formula: "FF_OPER_MGN", label: "Operating margin %", years: 5 },
  { base: "roe", formula: "FF_ROE", label: "ROE %", years: 3 },
  { base: "debt", formula: "FF_DEBT", label: "Total debt", years: 3 },
  { base: "ebitda", formula: "FF_EBITDA_OPER", label: "EBITDA", years: 3 },
  { base: "cash", formula: "FF_CASH_ST", label: "Cash & ST investments", years: 1 },
  { base: "intExp", formula: "FF_INT_EXP_DEBT", label: "Interest expense", years: 1 },
];

/** Point-in-time metrics (current value, no series). */
const POINT_METRICS: ScoringFormula[] = [
  { key: "salesLtm", formula: "FF_SALES(LTM,0)", note: "Revenue, trailing 12m" },
  { key: "epsLtm", formula: "FF_EPS(LTM,0)", note: "EPS, trailing 12m" },
  { key: "pe", formula: "FG_PE", note: "P/E" },
  { key: "pbk", formula: "FG_PBK", note: "P/B" },
  { key: "psales", formula: "FG_PSALES", note: "P/S" },
  { key: "divYld", formula: "FG_DIV_YLD", note: "Dividend yield" },
  { key: "mktVal", formula: "FG_MKT_VALUE", note: "Market cap" },
  { key: "epsEstFy1", formula: "FE_ESTIMATE(EPS,MEAN,ANN_ROLL,1,NOW,'')", note: "Mean EPS estimate, FY+1" },
  { key: "salesEstFy1", formula: "FE_ESTIMATE(SALES,MEAN,ANN_ROLL,1,NOW,'')", note: "Mean revenue estimate, FY+1" },
  { key: "tgtPriceMean", formula: "FE_ESTIMATE(PRICE_TGT,MEAN,ANN_ROLL,0,NOW,'')", note: "Mean target price" },
  { key: "numEstFy1", formula: "FE_ESTIMATE(EPS,NEST,ANN_ROLL,1,NOW,'')", note: "# analysts (estimate count)" },
];

function buildScoringFormulas(): ScoringFormula[] {
  const out: ScoringFormula[] = [];
  for (const m of ANNUAL_METRICS) {
    for (let i = 0; i < m.years; i++) {
      const rel = i === 0 ? "0" : `-${i}`;
      out.push({ key: `${m.base}Ann${i}`, formula: `${m.formula}(ANN,${rel})`, note: `${m.label}, FY${i === 0 ? "" : "-" + i}` });
    }
    for (let q = 0; q < (m.quarters ?? 0); q++) {
      const rel = q === 0 ? "0" : `-${q}`;
      out.push({ key: `${m.base}Qtr${q}`, formula: `${m.formula}(QTR,${rel})`, note: `${m.label}, Q${q === 0 ? "" : "-" + q}` });
    }
  }
  return [...out, ...POINT_METRICS];
}

export const SCORING_FORMULAS: ScoringFormula[] = buildScoringFormulas();

/** FactSet company-name formula — drives the ticker→company guard so scoring
 *  never trusts a snapshot whose resolved id landed on the wrong company. */
const NAME_FORMULA = "FG_COMPANY_NAME";

export type CompanySnapshot = {
  factsetId: string;
  /** FactSet's company name for this id (null if unavailable). */
  name: string | null;
  /** Keyed by SCORING_FORMULAS key (salesAnn0, salesQtr1, pe, ...). null = no data. */
  values: Record<string, number | null>;
  /** ISO timestamp this snapshot was fetched. */
  fetchedAt: string;
  /** True if at least the core revenue figure came back — i.e. FactSet has this issuer. */
  hasData: boolean;
};

/**
 * Fetch the full scoring snapshot for one FactSet id. Pure read through the
 * relay; no Redis, no persistence. Returns hasData=false when FactSet doesn't
 * recognize/cover the issuer, which the caller uses to fall back to EDGAR or
 * flag the affected categories for manual scoring.
 */
export async function companySnapshot(factsetId: string): Promise<CompanySnapshot> {
  const formulas = [...SCORING_FORMULAS.map((f) => f.formula), NAME_FORMULA];
  const data = await crossSectional([factsetId], formulas);
  const row = data[factsetId] || {};
  const values: Record<string, number | null> = {};
  for (const f of SCORING_FORMULAS) {
    const v: FactsetValue = row[f.formula];
    values[f.key] = typeof v === "number" ? v : null;
  }
  const nameVal = row[NAME_FORMULA];
  const name = typeof nameVal === "string" && nameVal.trim() ? nameVal.trim() : null;
  const hasData = values.salesAnn0 != null || values.salesLtm != null;
  return { factsetId, name, values, fetchedAt: new Date().toISOString(), hasData };
}

const fmt = (v: number | null | undefined, digits = 1): string =>
  v == null ? "n/a" : v.toLocaleString("en-US", { maximumFractionDigits: digits });

/** Join a metric's annual (or quarterly) series oldest-label-first into a row. */
function seriesRow(values: Record<string, number | null>, base: string, n: number, kind: "Ann" | "Qtr", digits = 1): string {
  return Array.from({ length: n }, (_, i) => fmt(values[`${base}${kind}${i}`], digits)).join(" | ");
}

/**
 * Render the snapshot as an analyst-readable block for the scoring prompt,
 * clearly attributed to FactSet. Shows multi-year series (FY .. FY-4) so the
 * model can read trends, recent quarters for revenue/EPS momentum, and TTM for
 * freshness. Currency figures are in millions as FactSet returns them.
 */
export function formatSnapshotForPrompt(snap: CompanySnapshot): string {
  const v = snap.values;
  return [
    `=== FACTSET FUNDAMENTALS (primary source, fetched ${snap.fetchedAt.slice(0, 10)}) ===`,
    `Series are most-recent-first: FY | FY-1 | FY-2 | FY-3 | FY-4 (annual) and Q | Q-1 | Q-2 | Q-3 (quarterly). Figures in USD millions unless a % is shown.`,
    `Revenue — FY: ${seriesRow(v, "sales", 5, "Ann")} | TTM ${fmt(v.salesLtm)} | recent Q: ${seriesRow(v, "sales", 4, "Qtr")}`,
    `EPS — FY: ${seriesRow(v, "eps", 5, "Ann", 2)} | TTM ${fmt(v.epsLtm, 2)} | recent Q: ${seriesRow(v, "eps", 4, "Qtr", 2)}`,
    `Net income — FY: ${seriesRow(v, "netInc", 5, "Ann")}`,
    `Free cash flow — FY: ${seriesRow(v, "fcf", 5, "Ann")}`,
    `Operating CF — FY: ${seriesRow(v, "ocf", 3, "Ann")} | Capex — FY: ${seriesRow(v, "capex", 3, "Ann")}`,
    `Gross margin % — FY: ${seriesRow(v, "grossMgn", 5, "Ann")}`,
    `Operating margin % — FY: ${seriesRow(v, "operMgn", 5, "Ann")}`,
    `ROE % — FY: ${seriesRow(v, "roe", 3, "Ann")}`,
    `Leverage — Total debt FY: ${seriesRow(v, "debt", 3, "Ann")} | EBITDA FY: ${seriesRow(v, "ebitda", 3, "Ann")} | Cash & ST ${fmt(v.cashAnn0)} | Interest exp ${fmt(v.intExpAnn0)}`,
    `Valuation (current): P/E ${fmt(v.pe)} | P/B ${fmt(v.pbk)} | P/S ${fmt(v.psales)} | Div yield ${fmt(v.divYld, 2)}% | Mkt cap ${fmt(v.mktVal)}`,
    `Estimates: EPS FY+1 ${fmt(v.epsEstFy1, 2)} | Revenue FY+1 ${fmt(v.salesEstFy1)} | Mean target price ${fmt(v.tgtPriceMean, 2)} | # analysts ${fmt(v.numEstFy1, 0)}`,
  ].join("\n");
}

/**
 * Loose company-name match for the ticker→company guard. Normalizes by
 * lower-casing, stripping punctuation and common corporate suffixes, then
 * checks for meaningful token overlap. Lenient by design — its job is to catch
 * a resolved id landing on a clearly WRONG company (zero overlap), not to
 * demand exact equality ("Enbridge Inc" vs "Enbridge Inc."). Returns true when
 * it can't compare (a missing name shouldn't block scoring on its own).
 */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return true;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[.,&'"()/-]/g, " ")
      .replace(
        /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|llc|lp|the|holdings|group|sa|nv|ag|class|cl|a|b)\b/g,
        " "
      )
      .replace(/\s+/g, " ")
      .trim();
  const ta = new Set(norm(a).split(" ").filter((w) => w.length > 1));
  const tb = new Set(norm(b).split(" ").filter((w) => w.length > 1));
  if (ta.size === 0 || tb.size === 0) return true;
  for (const w of ta) if (tb.has(w)) return true;
  return false;
}
