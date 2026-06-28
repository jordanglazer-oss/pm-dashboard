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
  { key: "recMean", formula: "FE_ESTIMATE(REC,MEAN,ANN_ROLL,0,NOW,'')", note: "Mean analyst recommendation" },
];
