/**
 * Candidate FactSet formula set for the stock-scoring "company snapshot".
 *
 * These are the financial / valuation / estimate fields the scorer needs to
 * feed Claude (replacing the Yahoo + EDGAR-XBRL context). The exact FactSet
 * formula CODES below are best-guess starting points — some may come back as
 * error 107 "Unknown expression" and need correcting. That's the whole point
 * of validating via /api/admin/factset-probe?snapshot=<id> BEFORE we wire any
 * of this into the live score route.
 *
 * Families already confirmed working: P_ (prices), FF_ (fundamentals),
 * FG_ (global metrics), FE_ (estimates). See app/lib/factset.ts.
 *
 * Periodicity codes: ANN = annual, LTM = last twelve months, QTR = quarterly.
 * Relative period: 0 = most recent, -1 = one prior, etc. Inner commas are
 * encoded %2C downstream automatically — write them as plain commas here.
 */

export type ScoringFormula = {
  /** Stable key we map into the snapshot. */
  key: string;
  /** FactSet formula (plain commas; encoding handled by the client). */
  formula: string;
  /** What it's for / which scoring category it supports. */
  note: string;
};

export const SCORING_FORMULAS: ScoringFormula[] = [
  // ── Growth: multi-year revenue / EPS / FCF (annual + trailing) ──────────
  { key: "salesAnn0", formula: "FF_SALES(ANN,0)", note: "Revenue, latest FY (growth, valuation)" },
  { key: "salesAnn1", formula: "FF_SALES(ANN,-1)", note: "Revenue, FY-1 (growth YoY)" },
  { key: "salesAnn2", formula: "FF_SALES(ANN,-2)", note: "Revenue, FY-2 (growth trend)" },
  { key: "salesLtm", formula: "FF_SALES(LTM,0)", note: "Revenue, trailing 12m (freshness)" },
  { key: "epsAnn0", formula: "FF_EPS(ANN,0)", note: "EPS, latest FY (growth)" },
  { key: "epsAnn1", formula: "FF_EPS(ANN,-1)", note: "EPS, FY-1 (growth YoY)" },
  { key: "epsLtm", formula: "FF_EPS(LTM,0)", note: "EPS, trailing 12m (freshness)" },
  { key: "netIncAnn0", formula: "FF_NET_INC(ANN,0)", note: "Net income (growth, quality)" },
  { key: "fcfAnn0", formula: "FF_FREE_CF(ANN,0)", note: "Free cash flow (growth, cashFlowQuality)" },
  { key: "ocfAnn0", formula: "FF_OPER_CF(ANN,0)", note: "Operating cash flow (cashFlowQuality)" },
  { key: "capexAnn0", formula: "FF_CAPEX(ANN,0)", note: "Capex (cashFlowQuality)" },

  // ── Leverage & coverage ─────────────────────────────────────────────────
  { key: "debtAnn0", formula: "FF_DEBT(ANN,0)", note: "Total debt (leverageCoverage)" },
  { key: "cashAnn0", formula: "FF_CASH_ST(ANN,0)", note: "Cash & ST investments (net debt)" },
  { key: "ebitdaAnn0", formula: "FF_EBITDA_OPER(ANN,0)", note: "EBITDA (net debt/EBITDA)" },
  { key: "intExpAnn0", formula: "FF_INT_EXP_DEBT(ANN,0)", note: "Interest expense (coverage)" },

  // ── Margins / moat ──────────────────────────────────────────────────────
  { key: "grossMgn0", formula: "FF_GROSS_MGN(ANN,0)", note: "Gross margin (competitiveMoat)" },
  { key: "operMgn0", formula: "FF_OPER_MGN(ANN,0)", note: "Operating margin (competitiveMoat)" },
  { key: "roe0", formula: "FF_ROE(ANN,0)", note: "Return on equity (moat, quality)" },

  // ── Valuation ───────────────────────────────────────────────────────────
  { key: "pe", formula: "FG_PE", note: "P/E (relative/historical valuation)" },
  { key: "pbk", formula: "FG_PBK", note: "P/B (valuation)" },
  { key: "psales", formula: "FG_PSALES", note: "P/S (valuation)" },
  { key: "divYld", formula: "FG_DIV_YLD", note: "Dividend yield" },
  { key: "mktVal", formula: "FG_MKT_VALUE", note: "Market cap" },

  // ── Estimates / analyst (researchCoverage, analystConsensus, catalysts) ──
  { key: "epsEstFy1", formula: "FE_ESTIMATE(EPS,MEAN,ANN_ROLL,1,NOW,'')", note: "Mean EPS estimate, FY+1" },
  { key: "salesEstFy1", formula: "FE_ESTIMATE(SALES,MEAN,ANN_ROLL,1,NOW,'')", note: "Mean revenue estimate, FY+1" },
  { key: "tgtPriceMean", formula: "FE_ESTIMATE(PRICE_TGT,MEAN,ANN_ROLL,0,NOW,'')", note: "Mean target price" },
  { key: "numEstFy1", formula: "FE_ESTIMATE(EPS,NEST,ANN_ROLL,1,NOW,'')", note: "# analysts (estimate count)" },
  // NOTE: mean analyst recommendation (FE_ESTIMATE(REC,...)) returned null on
  // validation — wrong item code. Revisit with the correct recommendation code.
];

import { crossSectional, type FactsetValue } from "@/app/lib/factset";

/** FactSet company-name formula — drives the ticker→company guard so scoring
 *  never trusts a snapshot whose resolved id landed on the wrong company. */
const NAME_FORMULA = "FG_COMPANY_NAME";

export type CompanySnapshot = {
  factsetId: string;
  /** FactSet's company name for this id (null if unavailable). */
  name: string | null;
  /** Keyed by SCORING_FORMULAS key (salesAnn0, pe, ...). null = no data. */
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

const fmt = (v: number | null, digits = 1): string =>
  v == null ? "n/a" : v.toLocaleString("en-US", { maximumFractionDigits: digits });

/**
 * Render the snapshot as an analyst-readable block for the scoring prompt,
 * clearly attributed to FactSet (the authoritative, current source). Currency
 * figures are in millions as FactSet returns them. TTM lines are included so
 * the model scores off the freshest numbers, not just the last annual filing.
 */
export function formatSnapshotForPrompt(snap: CompanySnapshot): string {
  const v = snap.values;
  return [
    `=== FACTSET FUNDAMENTALS (primary source, fetched ${snap.fetchedAt.slice(0, 10)}) ===`,
    `Revenue (USD mm): FY ${fmt(v.salesAnn0)} | FY-1 ${fmt(v.salesAnn1)} | FY-2 ${fmt(v.salesAnn2)} | TTM ${fmt(v.salesLtm)}`,
    `EPS: FY ${fmt(v.epsAnn0, 2)} | FY-1 ${fmt(v.epsAnn1, 2)} | TTM ${fmt(v.epsLtm, 2)}`,
    `Net income (FY): ${fmt(v.netIncAnn0)} | FCF (FY): ${fmt(v.fcfAnn0)} | OCF: ${fmt(v.ocfAnn0)} | Capex: ${fmt(v.capexAnn0)}`,
    `Leverage: Total debt ${fmt(v.debtAnn0)} | Cash & ST ${fmt(v.cashAnn0)} | EBITDA ${fmt(v.ebitdaAnn0)} | Interest exp ${fmt(v.intExpAnn0)}`,
    `Margins: Gross ${fmt(v.grossMgn0)}% | Operating ${fmt(v.operMgn0)}% | ROE ${fmt(v.roe0)}%`,
    `Valuation: P/E ${fmt(v.pe)} | P/B ${fmt(v.pbk)} | P/S ${fmt(v.psales)} | Div yield ${fmt(v.divYld, 2)}% | Mkt cap ${fmt(v.mktVal)}`,
    `Estimates: EPS FY+1 ${fmt(v.epsEstFy1, 2)} | Revenue FY+1 ${fmt(v.salesEstFy1)} | Mean target price ${fmt(v.tgtPriceMean, 2)} | # analysts ${fmt(v.numEstFy1, 0)}`,
  ].join("\n");
}
