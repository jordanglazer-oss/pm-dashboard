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
import { resolveFactsetId } from "@/app/lib/factset-symbols";

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
  { base: "sales", formula: "FF_SALES", label: "Revenue", years: 5, quarters: 8 },
  { base: "eps", formula: "FF_EPS", label: "EPS", years: 5, quarters: 8 },
  { base: "netInc", formula: "FF_NET_INC", label: "Net income", years: 5, quarters: 8 },
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
  { key: "price", formula: "P_PRICE", note: "Current price (for forward P/E)" },
  // 52-week high/low — validated: the daily-price functions need a -52W
  // relative window (-1Y / -1AY give "Invalid Daily Price Date Specification").
  { key: "high52w", formula: "P_PRICE_HIGH(-52W,0)", note: "52-week high" },
  { key: "low52w", formula: "P_PRICE_LOW(-52W,0)", note: "52-week low" },
  { key: "epsEstFy1", formula: "FE_ESTIMATE(EPS,MEAN,ANN_ROLL,1,NOW,'')", note: "Mean EPS estimate, FY+1" },
  { key: "salesEstFy1", formula: "FE_ESTIMATE(SALES,MEAN,ANN_ROLL,1,NOW,'')", note: "Mean revenue estimate, FY+1" },
  { key: "tgtPriceMean", formula: "FE_ESTIMATE(PRICE_TGT,MEAN,ANN_ROLL,0,NOW,'')", note: "Mean target price" },
  { key: "numEstFy1", formula: "FE_ESTIMATE(EPS,NEST,ANN_ROLL,1,NOW,'')", note: "# analysts (estimate count)" },
  // ── Analyst signals (validated; recMean null for thinly-covered names) ──
  { key: "recMean", formula: "FE_ESTIMATE(REC_MARK,MEAN,ANN_ROLL,0,NOW,'')", note: "Mean analyst recommendation (1=buy .. 5=sell)" },
  { key: "tgtHigh", formula: "FE_ESTIMATE(PRICE_TGT,HIGH,ANN_ROLL,0,NOW,'')", note: "Target price high (dispersion)" },
  { key: "tgtLow", formula: "FE_ESTIMATE(PRICE_TGT,LOW,ANN_ROLL,0,NOW,'')", note: "Target price low (dispersion)" },
  { key: "revUp", formula: "FE_ESTIMATE(EPS,UP,ANN_ROLL,1,NOW,'')", note: "EPS FY+1 up-revisions (30d)" },
  { key: "revDown", formula: "FE_ESTIMATE(EPS,DOWN,ANN_ROLL,1,NOW,'')", note: "EPS FY+1 down-revisions (30d)" },
  // ── Analyst-count candidates — find which matches the terminal's headline
  //    count (e.g. ORCL = 45). numEstFy1 (FY+1 EPS estimates) undercounts. ──
  { key: "numTgt", formula: "FE_ESTIMATE(PRICE_TGT,NEST,ANN_ROLL,0,NOW,'')", note: "# analysts with a price target" },
  { key: "numRec", formula: "FE_ESTIMATE(REC_MARK,NEST,ANN_ROLL,0,NOW,'')", note: "# analysts with a recommendation" },
  { key: "numEstCurFy", formula: "FE_ESTIMATE(EPS,NEST,ANN_ROLL,0,NOW,'')", note: "# current-FY EPS estimates" },
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
  /** FactSet GICS sector / industry (strings, not numeric). */
  sector: string | null;
  industry: string | null;
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
const SECTOR_FORMULA = "FG_GICS_SECTOR";
const INDUSTRY_FORMULA = "FG_GICS_INDUSTRY";

export async function companySnapshot(factsetId: string): Promise<CompanySnapshot> {
  const formulas = [...SCORING_FORMULAS.map((f) => f.formula), NAME_FORMULA, SECTOR_FORMULA, INDUSTRY_FORMULA];
  const data = await crossSectional([factsetId], formulas);
  const row = data[factsetId] || {};
  const values: Record<string, number | null> = {};
  for (const f of SCORING_FORMULAS) {
    const v: FactsetValue = row[f.formula];
    values[f.key] = typeof v === "number" ? v : null;
  }
  const str = (f: string): string | null => {
    const v = row[f];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const hasData = values.salesAnn0 != null || values.salesLtm != null;
  return {
    factsetId,
    name: str(NAME_FORMULA),
    sector: str(SECTOR_FORMULA),
    industry: str(INDUSTRY_FORMULA),
    values,
    fetchedAt: new Date().toISOString(),
    hasData,
  };
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
  // Derived valuation — inputs are all FactSet, so these count as FactSet data.
  const fwdPe = v.price != null && v.epsEstFy1 ? v.price / v.epsEstFy1 : null;
  const ev = v.mktVal != null && v.debtAnn0 != null && v.cashAnn0 != null ? v.mktVal + v.debtAnn0 - v.cashAnn0 : null;
  const evEbitda = ev != null && v.ebitdaAnn0 ? ev / v.ebitdaAnn0 : null;
  return [
    `=== FACTSET FUNDAMENTALS (primary source, fetched ${snap.fetchedAt.slice(0, 10)}) ===`,
    `Classification: GICS sector ${snap.sector ?? "n/a"} | industry ${snap.industry ?? "n/a"} (use for the secular growth-trend read).`,
    `Series are most-recent-first: FY | FY-1 | FY-2 | FY-3 | FY-4 (annual) and Q | Q-1 | ... | Q-7 (last 8 quarters). Q-4 is the YEAR-AGO quarter, so Q vs Q-4 is the quarter-over-quarter YoY comparison — compute these from the series below; do NOT web-search for quarterly results, FactSet carries them here. Figures in USD millions unless a % is shown.`,
    `Revenue — FY: ${seriesRow(v, "sales", 5, "Ann")} | TTM ${fmt(v.salesLtm)} | last 8 Q: ${seriesRow(v, "sales", 8, "Qtr")}`,
    `EPS — FY: ${seriesRow(v, "eps", 5, "Ann", 2)} | TTM ${fmt(v.epsLtm, 2)} | last 8 Q: ${seriesRow(v, "eps", 8, "Qtr", 2)}`,
    `Net income — FY: ${seriesRow(v, "netInc", 5, "Ann")} | last 8 Q: ${seriesRow(v, "netInc", 8, "Qtr")}`,
    `Free cash flow — FY: ${seriesRow(v, "fcf", 5, "Ann")}`,
    `Operating CF — FY: ${seriesRow(v, "ocf", 3, "Ann")} | Capex — FY: ${seriesRow(v, "capex", 3, "Ann")}`,
    `Gross margin % — FY: ${seriesRow(v, "grossMgn", 5, "Ann")}`,
    `Operating margin % — FY: ${seriesRow(v, "operMgn", 5, "Ann")}`,
    `ROE % — FY: ${seriesRow(v, "roe", 3, "Ann")}`,
    `Leverage — Total debt FY: ${seriesRow(v, "debt", 3, "Ann")} | EBITDA FY: ${seriesRow(v, "ebitda", 3, "Ann")} | Cash & ST ${fmt(v.cashAnn0)} | Interest exp ${fmt(v.intExpAnn0)}`,
    `Valuation (current): P/E ${fmt(v.pe)} | Forward P/E ${fmt(fwdPe)} | EV/EBITDA ${fmt(evEbitda)} | P/B ${fmt(v.pbk)} | P/S ${fmt(v.psales)} | Div yield ${fmt(v.divYld, 2)}% | Mkt cap ${fmt(v.mktVal)} | EV ${fmt(ev)}`,
    `Price: ${fmt(v.price, 2)} | 52-week range: ${fmt(v.low52w, 2)} – ${fmt(v.high52w, 2)}`,
    `Estimates: EPS FY+1 ${fmt(v.epsEstFy1, 2)} | Revenue FY+1 ${fmt(v.salesEstFy1)} | # analysts ${fmt(v.numEstFy1, 0)}`,
    `Analyst signals: mean recommendation ${fmt(v.recMean, 2)} (1=Buy .. 5=Sell; n/a = thin coverage) | target ${fmt(v.tgtPriceMean, 2)} (range ${fmt(v.tgtLow, 2)}–${fmt(v.tgtHigh, 2)}) | EPS FY+1 est. revisions: ${fmt(v.revUp, 0)} up / ${fmt(v.revDown, 0)} down (breadth = research coverage; revisions + recommendation = track-record / catalysts signal).`,
  ].join("\n");
}

/** Formulas pulled per peer for the relative-valuation comparison block. */
const PEER_FORMULAS = [
  "FG_PE",
  "FG_PBK",
  "FG_PSALES",
  "FG_MKT_VALUE",
  "P_PRICE",
  "FF_EBITDA_OPER(ANN,0)",
  "FF_DEBT(ANN,0)",
  "FF_CASH_ST(ANN,0)",
  "FF_GROSS_MGN(ANN,0)",
  "FF_ROE(ANN,0)",
  "FE_ESTIMATE(EPS,MEAN,ANN_ROLL,1,NOW,'')",
  "FF_SALES(ANN,0)",
  "FF_SALES(ANN,-1)",
];

/**
 * Price a set of peer tickers via FactSet (one batched call) and render a
 * comparison block for the relativeValuation / competitiveMoat categories.
 * Peer SELECTION still comes from the caller (FMP); this replaces the Yahoo
 * PRICING so peer multiples are FactSet too. Returns "" if no peer resolves —
 * the caller then falls back to the Yahoo peer block.
 */
export async function factsetPeerBlock(tickers: string[]): Promise<string> {
  const idToTicker = new Map<string, string>();
  for (const t of tickers) {
    const r = resolveFactsetId(t);
    if (r.source === "factset" && !idToTicker.has(r.id)) idToTicker.set(r.id, t);
  }
  const ids = [...idToTicker.keys()];
  if (ids.length === 0) return "";

  const data = await crossSectional(ids, PEER_FORMULAS);
  const lines: string[] = [];
  for (const id of ids) {
    const row = data[id] || {};
    const num = (f: string): number | null => {
      const v: FactsetValue = row[f];
      return typeof v === "number" ? v : null;
    };
    const price = num("P_PRICE");
    const epsEst = num("FE_ESTIMATE(EPS,MEAN,ANN_ROLL,1,NOW,'')");
    const fwdPe = price != null && epsEst ? price / epsEst : null;
    const mkt = num("FG_MKT_VALUE");
    const debt = num("FF_DEBT(ANN,0)");
    const cash = num("FF_CASH_ST(ANN,0)");
    const ebitda = num("FF_EBITDA_OPER(ANN,0)");
    const ev = mkt != null && debt != null && cash != null ? mkt + debt - cash : null;
    const evEbitda = ev != null && ebitda ? ev / ebitda : null;
    const s0 = num("FF_SALES(ANN,0)");
    const s1 = num("FF_SALES(ANN,-1)");
    const revGrowth = s0 != null && s1 ? ((s0 - s1) / Math.abs(s1)) * 100 : null;
    // Skip peers FactSet doesn't actually cover (no P/E and no market cap).
    if (num("FG_PE") == null && mkt == null) continue;
    lines.push(
      `PEER ${idToTicker.get(id)}: P/E ${fmt(num("FG_PE"))} | Fwd P/E ${fmt(fwdPe)} | EV/EBITDA ${fmt(evEbitda)} | P/B ${fmt(num("FG_PBK"))} | P/S ${fmt(num("FG_PSALES"))} | Gross margin ${fmt(num("FF_GROSS_MGN(ANN,0)"))}% | ROE ${fmt(num("FF_ROE(ANN,0)"))}% | Rev growth ${fmt(revGrowth)}% | Mkt cap ${fmt(mkt)}`
    );
  }
  if (lines.length === 0) return "";
  return `=== PEER COMPARISONS (FactSet — for relativeValuation/competitiveMoat; tag these source:"factset") ===\n${lines.join("\n")}`;
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
