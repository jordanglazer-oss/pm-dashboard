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
  { key: "beta", formula: "P_BETA", note: "Beta" },
  { key: "price", formula: "P_PRICE", note: "Current price (for forward P/E)" },
  // 52-week high/low — validated: the daily-price functions need a -52W
  // relative window (-1Y / -1AY give "Invalid Daily Price Date Specification").
  { key: "high52w", formula: "P_PRICE_HIGH(-52W,0)", note: "52-week high" },
  { key: "low52w", formula: "P_PRICE_LOW(-52W,0)", note: "52-week low" },
  { key: "epsEstFy1", formula: "FE_ESTIMATE(EPS,MEAN,ANN_ROLL,1,NOW,'')", note: "Mean EPS estimate, FY+1" },
  { key: "salesEstFy1", formula: "FE_ESTIMATE(SALES,MEAN,ANN_ROLL,1,NOW,'')", note: "Mean revenue estimate, FY+1" },
  // FY+2 estimates — a second forward year so growth/secular reads off a
  // 2-year trajectory rather than a single (noisy) forward year.
  { key: "epsEstFy2", formula: "FE_ESTIMATE(EPS,MEAN,ANN_ROLL,2,NOW,'')", note: "Mean EPS estimate, FY+2" },
  { key: "salesEstFy2", formula: "FE_ESTIMATE(SALES,MEAN,ANN_ROLL,2,NOW,'')", note: "Mean revenue estimate, FY+2" },
  { key: "tgtPriceMean", formula: "FE_ESTIMATE(PRICE_TGT,MEAN,ANN_ROLL,0,NOW,'')", note: "Mean target price" },
  { key: "numEstFy1", formula: "FE_ESTIMATE(EPS,NEST,ANN_ROLL,1,NOW,'')", note: "# analysts (estimate count)" },
  // ── Analyst signals (validated). Recommendation consensus (REC/REC_MARK)
  //    returns null through our Formula API entitlement — so we rely on target
  //    dispersion + estimate revisions. Analyst count = numEstFy1 (# with an
  //    FY+1 estimate; == # with a price target). ──
  { key: "tgtHigh", formula: "FE_ESTIMATE(PRICE_TGT,HIGH,ANN_ROLL,0,NOW,'')", note: "Target price high (dispersion)" },
  { key: "tgtLow", formula: "FE_ESTIMATE(PRICE_TGT,LOW,ANN_ROLL,0,NOW,'')", note: "Target price low (dispersion)" },
  { key: "revUp", formula: "FE_ESTIMATE(EPS,UP,ANN_ROLL,1,NOW,'')", note: "EPS FY+1 up-revisions (30d)" },
  { key: "revDown", formula: "FE_ESTIMATE(EPS,DOWN,ANN_ROLL,1,NOW,'')", note: "EPS FY+1 down-revisions (30d)" },
  { key: "epsDispersion", formula: "FE_ESTIMATE(EPS,STDDEV,ANN_ROLL,1,NOW,'')", note: "EPS FY+1 estimate dispersion (predictability / persistence proxy — low = analysts agree)" },
  // Management guidance (FE_GUIDANCE — validated error 0; MSFT next-Q revenue
  // returned $87.25B). Populates for names that issue guidance; null-safe
  // otherwise. Company guidance vs the analyst consensus above is a catalyst
  // signal — guiding above the street is bullish, below is a warning.
  { key: "guidSalesQMean", formula: "FE_GUIDANCE(SALES,MEAN,QTR_ROLL,1,NOW,'')", note: "Revenue guidance mean, next Q" },
  { key: "guidSalesQHigh", formula: "FE_GUIDANCE(SALES,HIGH,QTR_ROLL,1,NOW,'')", note: "Revenue guidance high, next Q" },
  { key: "guidSalesQLow", formula: "FE_GUIDANCE(SALES,LOW,QTR_ROLL,1,NOW,'')", note: "Revenue guidance low, next Q" },
  { key: "guidEpsQMean", formula: "FE_GUIDANCE(EPS,MEAN,QTR_ROLL,1,NOW,'')", note: "EPS guidance mean, next Q" },
  { key: "guidEpsQHigh", formula: "FE_GUIDANCE(EPS,HIGH,QTR_ROLL,1,NOW,'')", note: "EPS guidance high, next Q" },
  { key: "guidEpsQLow", formula: "FE_GUIDANCE(EPS,LOW,QTR_ROLL,1,NOW,'')", note: "EPS guidance low, next Q" },
  { key: "guidSalesAMean", formula: "FE_GUIDANCE(SALES,MEAN,ANN_ROLL,1,NOW,'')", note: "Revenue guidance mean, FY+1" },
  { key: "guidEpsAMean", formula: "FE_GUIDANCE(EPS,MEAN,ANN_ROLL,1,NOW,'')", note: "EPS guidance mean, FY+1" },
  // Trailing total return (dividend + split adjusted), % — momentum / track
  // record. P_TOTAL_RETURNC takes the calendar-relative date form (-1Y is
  // validated for this function; the -52W week form belongs to the daily-price
  // high/low parser, a different function). Candidate shapes — validate via
  // ?snapshot= before relying on them; a bad code renders "n/a" and is harmless.
  { key: "ret1m", formula: "P_TOTAL_RETURNC(-1M,0)", note: "Total return, 1 month %" },
  { key: "ret3m", formula: "P_TOTAL_RETURNC(-3M,0)", note: "Total return, 3 month %" },
  { key: "ret6m", formula: "P_TOTAL_RETURNC(-6M,0)", note: "Total return, 6 month %" },
  // Validated: P_TOTAL_RETURNC takes the MONTH form (-1M/-3M/-6M work); the
  // year form (-1Y/-3Y) throws "Invalid Daily Price Date Specification", so use
  // -12M/-36M for the 1y/3y windows.
  { key: "ret1y", formula: "P_TOTAL_RETURNC(-12M,0)", note: "Total return, 1 year %" },
  { key: "ret3y", formula: "P_TOTAL_RETURNC(-36M,0)", note: "Total return, 3 year %" },
  // NOTE: own-history P/E band is NOT built from cross-sectional point metrics —
  // FG_PE(ANN,-i) echoes the current P/E and price÷EPS misaligns fiscal years.
  // It's pulled via the /time-series endpoint instead (FG_PE monthly over 5y →
  // true point-in-time band). See timeSeriesRaw() in factset.ts + the probe's
  // ?timeseries= mode; wired into the snapshot once the shape is confirmed.
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

/**
 * Normalize FactSet's official GICS sector label to the app's sector vocabulary
 * (defaults.ts GICS_SECTORS) so a FactSet-sourced sector groups identically to
 * the existing Yahoo-sourced ones in sector breakdowns. The only divergence is
 * "Information Technology" (GICS) → "Technology" (app); every other GICS sector
 * name already matches the app's list. Unknown labels pass through unchanged.
 */
export function normalizeFactsetSector(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (/^information technology$/i.test(t)) return "Technology";
  return t;
}

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
  // Management guidance line — only shown when the company actually issues
  // guidance (most names won't; those render nothing rather than a row of n/a).
  const hasGuidance = [
    v.guidSalesQMean, v.guidSalesQHigh, v.guidSalesQLow,
    v.guidEpsQMean, v.guidEpsQHigh, v.guidEpsQLow,
    v.guidSalesAMean, v.guidEpsAMean,
  ].some((x) => typeof x === "number");
  const guidanceLine = hasGuidance
    ? `Management guidance (FactSet, company-issued): next Q — revenue ${fmt(v.guidSalesQMean)} (${fmt(v.guidSalesQLow)}–${fmt(v.guidSalesQHigh)}), EPS ${fmt(v.guidEpsQMean, 2)} (${fmt(v.guidEpsQLow, 2)}–${fmt(v.guidEpsQHigh, 2)}) | FY+1 — revenue ${fmt(v.guidSalesAMean)}, EPS ${fmt(v.guidEpsAMean, 2)}. Compare to the consensus estimates above: guiding ABOVE the street is a positive catalyst, BELOW a warning (feeds catalysts / growth).`
    : null;
  return [
    `=== FACTSET FUNDAMENTALS (primary source, fetched ${snap.fetchedAt.slice(0, 10)}) ===`,
    `Classification: GICS sector ${snap.sector ?? "n/a"} | industry ${snap.industry ?? "n/a"} (use for the secular growth-trend read).`,
    `Series are most-recent-first: FY | FY-1 | FY-2 | FY-3 | FY-4 (annual) and Q | Q-1 | ... | Q-7 (last 8 quarters). Q-4 is the YEAR-AGO quarter, so Q vs Q-4 is the quarter-over-quarter YoY comparison — compute these from the series below; do NOT web-search for quarterly results, FactSet carries them here. Figures in USD millions unless a % is shown.`,
    `Revenue — FY: ${seriesRow(v, "sales", 5, "Ann")} | TTM ${fmt(v.salesLtm)} | last 8 Q: ${seriesRow(v, "sales", 8, "Qtr")}`,
    `EPS — FY: ${seriesRow(v, "eps", 5, "Ann", 2)} | TTM ${fmt(v.epsLtm, 2)} | last 8 Q: ${seriesRow(v, "eps", 8, "Qtr", 2)}`,
    `Net income — FY: ${seriesRow(v, "netInc", 5, "Ann")} | last 8 Q: ${seriesRow(v, "netInc", 8, "Qtr")}`,
    `Free cash flow — FY: ${seriesRow(v, "fcf", 5, "Ann")}`,
    `Operating CF — FY: ${seriesRow(v, "ocf", 3, "Ann")} | Capex — FY: ${seriesRow(v, "capex", 3, "Ann")}`,
    `Earnings quality / persistence — OCF ÷ net income by FY: ${[0, 1, 2].map((i) => {
      const ni = v[`netIncAnn${i}`]; const ocf = v[`ocfAnn${i}`];
      return typeof ni === "number" && ni !== 0 && typeof ocf === "number" ? `${(ocf / ni).toFixed(2)}x` : "n/a";
    }).join(" | ")} (cash conversion: a ratio persistently ≥1 means earnings are backed by real operating cash = high-quality, PERSISTENT earnings; consistently <1 or volatile signals accruals-heavy, lower-persistence earnings that tend to mean-revert — weigh into cashFlowQuality).`,
    `Gross margin % — FY: ${seriesRow(v, "grossMgn", 5, "Ann")}`,
    `Operating margin % — FY: ${seriesRow(v, "operMgn", 5, "Ann")}`,
    `ROE % — FY: ${seriesRow(v, "roe", 3, "Ann")}`,
    `Leverage — Total debt FY: ${seriesRow(v, "debt", 3, "Ann")} | EBITDA FY: ${seriesRow(v, "ebitda", 3, "Ann")} | Cash & ST ${fmt(v.cashAnn0)} | Interest exp ${fmt(v.intExpAnn0)}`,
    `Valuation (current): P/E ${fmt(v.pe)} | Forward P/E ${fmt(fwdPe)} | EV/EBITDA ${fmt(evEbitda)} | P/B ${fmt(v.pbk)} | P/S ${fmt(v.psales)} | Div yield ${fmt(v.divYld, 2)}% | Mkt cap ${fmt(v.mktVal)} | EV ${fmt(ev)}`,
    `Price: ${fmt(v.price, 2)} | 52-week range: ${fmt(v.low52w, 2)} – ${fmt(v.high52w, 2)}`,
    `Total return % (div+split adj): 1M ${fmt(v.ret1m)} | 3M ${fmt(v.ret3m)} | 6M ${fmt(v.ret6m)} | 1Y ${fmt(v.ret1y)} | 3Y ${fmt(v.ret3y)} (shareholder momentum / track record — supporting evidence for trackRecord).`,
    `Estimates: EPS FY+1 ${fmt(v.epsEstFy1, 2)} → FY+2 ${fmt(v.epsEstFy2, 2)} | Revenue FY+1 ${fmt(v.salesEstFy1)} → FY+2 ${fmt(v.salesEstFy2)} | # analysts ${fmt(v.numEstFy1, 0)} (the FY+1→FY+2 ramp is the forward growth trajectory for growth/secular).`,
    `Analyst signals: target ${fmt(v.tgtPriceMean, 2)} (range ${fmt(v.tgtLow, 2)}–${fmt(v.tgtHigh, 2)}) | EPS FY+1 est. revisions: ${fmt(v.revUp, 0)} up / ${fmt(v.revDown, 0)} down | EPS FY+1 estimate dispersion (stddev) ${fmt(v.epsDispersion, 2)} vs mean ${fmt(v.epsEstFy1, 2)} (LOW dispersion relative to the estimate = analysts agree = predictable/persistent earnings — a positive cashFlowQuality/trackRecord signal; wide dispersion = uncertain, lower-persistence earnings). (coverage breadth = # analysts above; revisions + target dispersion = track-record / catalysts signals).`,
    guidanceLine,
  ].filter(Boolean).join("\n");
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
 *
 * When `subject` (the scored company's GICS classification) is provided, the
 * auto-picked peers are VALIDATED against it: a peer whose GICS industry (or,
 * when industries are unavailable, sector) doesn't match is dropped before it
 * can distort relative valuation — the FMP picker occasionally returns
 * headline-adjacent names rather than true comps (observed: AAPL as an NVDA
 * "peer"). Unknown-classification peers get the benefit of the doubt; if
 * fewer than 2 peers survive, the original set is kept (bad comps beat an
 * empty comparison, and the block labels each peer's industry either way).
 */
export async function factsetPeerBlock(
  tickers: string[],
  subject?: { sector?: string | null; industry?: string | null },
): Promise<string> {
  const idToTicker = new Map<string, string>();
  for (const t of tickers) {
    const r = resolveFactsetId(t);
    if (r.source === "factset" && !idToTicker.has(r.id)) idToTicker.set(r.id, t);
  }
  let ids = [...idToTicker.keys()];
  if (ids.length === 0) return "";

  const data = await crossSectional(ids, [...PEER_FORMULAS, SECTOR_FORMULA, INDUSTRY_FORMULA]);

  // ── Peer-quality gate (GICS industry first, sector fallback) ──
  const cls = (id: string, f: string): string | null => {
    const v = data[id]?.[f];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  if (subject?.industry || subject?.sector) {
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const id of ids) {
      const pInd = cls(id, INDUSTRY_FORMULA);
      const pSec = cls(id, SECTOR_FORMULA);
      let ok = true;
      if (subject.industry && pInd) ok = pInd === subject.industry;
      else if (subject.sector && pSec) ok = pSec === subject.sector;
      (ok ? kept : dropped).push(id);
    }
    if (dropped.length && kept.length >= 2) {
      console.log(
        `[FactSet] peer-quality gate dropped ${dropped.map((id) => idToTicker.get(id)).join(", ")} ` +
          `(GICS mismatch vs subject ${subject.industry || subject.sector}); kept ${kept.map((id) => idToTicker.get(id)).join(", ")}`,
      );
      ids = kept;
    } else if (dropped.length) {
      console.warn(
        `[FactSet] peer-quality gate would leave <2 peers — keeping original set (${[...idToTicker.values()].join(", ")})`,
      );
    }
  }

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
    const pInd = cls(id, INDUSTRY_FORMULA);
    lines.push(
      `PEER ${idToTicker.get(id)}${pInd ? ` [${pInd}]` : ""}: P/E ${fmt(num("FG_PE"))} | Fwd P/E ${fmt(fwdPe)} | EV/EBITDA ${fmt(evEbitda)} | P/B ${fmt(num("FG_PBK"))} | P/S ${fmt(num("FG_PSALES"))} | Gross margin ${fmt(num("FF_GROSS_MGN(ANN,0)"))}% | ROE ${fmt(num("FF_ROE(ANN,0)"))}% | Rev growth ${fmt(revGrowth)}% | Mkt cap ${fmt(mkt)}`
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
