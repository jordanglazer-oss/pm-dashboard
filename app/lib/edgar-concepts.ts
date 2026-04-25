/**
 * Industry-aware XBRL concept registry.
 *
 * Maps a "logical metric" (revenue, netIncome, FCF, NIM, FFO, etc.) to
 * an ordered list of XBRL concept tags to try. The first tag that
 * returns data wins. Industry-specific overrides take precedence over
 * the default list, and the default list is always tried as a fallback.
 *
 * This is the layer that fixes problems Stage 1 surfaced:
 *
 *   1. AAPL's `Revenues` concept stopped after 2018-09-29 because Apple
 *      switched to `RevenueFromContractWithCustomerExcludingAssessedTax`
 *      after ASC 606 adoption. Default registry tries the post-606 tag
 *      FIRST and falls back to the legacy `Revenues` tag for older
 *      issuers / older periods.
 *
 *   2. EarningsPerShareDiluted came back as `available: false` because
 *      the unit is `USD/shares`, not the default `USD`. Each registry
 *      entry now declares its expected unit explicitly.
 *
 *   3. 10-K and 10-Q for the same period end double-counted in Stage 1.
 *      The normalizer below dedupes (prefer 10-K over 10-Q for the
 *      same `end` date) and prefers `Q4` quarters that come from the
 *      annual filing where possible.
 *
 * Industry-specific blocks add metrics that only make sense for that
 * industry (e.g. NetInterestIncome for banks, FundsFromOperations for
 * REITs, RevenueRemainingPerformanceObligation for SaaS).
 */

import type { EdgarCompanyFacts, EdgarFact } from "./edgar";
import { getConceptSeries } from "./edgar";
import type { EdgarIndustry } from "./edgar-industry";

/** A single XBRL tag to try for a logical metric. */
export type ConceptTry = {
  concept: string;
  /** Default "USD". Use "USD/shares" for per-share, "shares" for share counts, "pure" for ratios. */
  unit?: string;
  /** Optional taxonomy override; defaults to "us-gaap". */
  taxonomy?: string;
};

/**
 * Logical metric names. Generic ones apply to every issuer; the
 * industry-specific ones are populated only for matching SIC codes.
 */
export type LogicalMetric =
  // Universal
  | "revenue"
  | "operatingIncome"
  | "netIncome"
  | "epsDiluted"
  | "ocf"                    // operating cash flow
  | "capex"
  | "totalDebt"
  | "longTermDebt"
  | "totalEquity"
  | "cash"
  | "totalAssets"
  | "sharesDilutedWeighted"
  | "researchAndDevelopment"
  | "stockBasedCompensation"
  | "grossProfit"
  | "interestExpense"
  // Bank-specific
  | "netInterestIncome"
  | "nonInterestIncome"
  | "tier1Capital"
  | "provisionForLoanLosses"
  | "totalDeposits"
  // Insurance-specific
  | "netPremiumsEarned"
  | "lossesIncurred"
  // REIT-specific
  | "ffo"                    // funds from operations
  | "noi"                    // net operating income
  // SaaS / software-specific
  | "deferredRevenue"
  | "remainingPerformanceObligation"
  // Energy-specific
  | "explorationExpense"
  | "depletionExpense";

const DEFAULT_REGISTRY: Partial<Record<LogicalMetric, ConceptTry[]>> = {
  revenue: [
    // Post-ASC-606 (post-2018 for most filers) — try first.
    { concept: "RevenueFromContractWithCustomerExcludingAssessedTax" },
    { concept: "RevenueFromContractWithCustomerIncludingAssessedTax" },
    // Legacy + general fallbacks.
    { concept: "Revenues" },
    { concept: "SalesRevenueNet" },
    { concept: "SalesRevenueGoodsNet" },
  ],
  operatingIncome: [
    { concept: "OperatingIncomeLoss" },
  ],
  netIncome: [
    { concept: "NetIncomeLoss" },
    { concept: "ProfitLoss" },
  ],
  epsDiluted: [
    { concept: "EarningsPerShareDiluted", unit: "USD/shares" },
    { concept: "IncomeLossFromContinuingOperationsPerDilutedShare", unit: "USD/shares" },
  ],
  ocf: [
    { concept: "NetCashProvidedByUsedInOperatingActivities" },
    { concept: "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations" },
  ],
  capex: [
    { concept: "PaymentsToAcquirePropertyPlantAndEquipment" },
    { concept: "PaymentsToAcquireProductiveAssets" },
  ],
  totalDebt: [
    { concept: "LongTermDebt" },
    { concept: "LongTermDebtNoncurrent" },
    { concept: "DebtLongtermAndShorttermCombinedAmount" },
  ],
  longTermDebt: [
    { concept: "LongTermDebtNoncurrent" },
    { concept: "LongTermDebt" },
  ],
  totalEquity: [
    { concept: "StockholdersEquity" },
    { concept: "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest" },
  ],
  cash: [
    { concept: "CashAndCashEquivalentsAtCarryingValue" },
    { concept: "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents" },
    { concept: "Cash" },
    { concept: "CashAndDueFromBanks" }, // banks
    { concept: "CashCashEquivalentsAndFederalFundsSold" }, // banks
  ],
  totalAssets: [
    { concept: "Assets" },
  ],
  sharesDilutedWeighted: [
    { concept: "WeightedAverageNumberOfDilutedSharesOutstanding", unit: "shares" },
    { concept: "WeightedAverageNumberOfSharesOutstandingDiluted", unit: "shares" },
  ],
  researchAndDevelopment: [
    { concept: "ResearchAndDevelopmentExpense" },
    { concept: "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost" },
  ],
  stockBasedCompensation: [
    { concept: "ShareBasedCompensation" },
    { concept: "AllocatedShareBasedCompensationExpense" },
  ],
  grossProfit: [
    { concept: "GrossProfit" },
  ],
  interestExpense: [
    { concept: "InterestExpense" },
    { concept: "InterestExpenseDebt" },
    { concept: "InterestExpenseLongTermDebt" },
    { concept: "InterestExpenseOperating" },
    { concept: "InterestExpenseBorrowings" },
  ],
};

/**
 * Industry-specific overrides. Each industry's entries are tried
 * BEFORE the default registry. Default tags are always tried as a
 * fallback so a quirky filer doesn't drop out entirely.
 */
const INDUSTRY_REGISTRY: Record<EdgarIndustry, Partial<Record<LogicalMetric, ConceptTry[]>>> = {
  default: {},
  bank: {
    // Banks report "interest income" and "non-interest income" rather
    // than a single revenue line; the score prompt should know to
    // combine them or look at NIM directly.
    revenue: [
      { concept: "Revenues" },
      { concept: "InterestAndDividendIncomeOperating" },
    ],
    // Banks tag long-term debt under bank-specific concepts post-2013.
    // The freshness-aware lookup picks the most recently filed concept;
    // the order here is just secondary tiebreaker.
    // Verified for JPM (FY2025): LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities
    // is their canonical tag (the bare LongTermDebt stopped at 2013).
    longTermDebt: [
      { concept: "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities" },
      { concept: "LongTermDebtAndCapitalLeaseObligations" },
      { concept: "LongTermDebt" },
      { concept: "Borrowings" },
      { concept: "BeneficialInterestsIssuedByConsolidatedVariableInterestEntities" },
    ],
    cash: [
      { concept: "CashAndDueFromBanks" },
      { concept: "CashCashEquivalentsAndFederalFundsSold" },
      { concept: "CashAndCashEquivalentsAtCarryingValue" },
    ],
    netInterestIncome: [
      { concept: "InterestIncomeExpenseNet" },
      { concept: "InterestIncomeExpenseAfterProvisionForLoanLoss" },
    ],
    nonInterestIncome: [
      { concept: "NoninterestIncome" },
    ],
    tier1Capital: [
      { concept: "Tier1RiskBasedCapital" },
    ],
    provisionForLoanLosses: [
      { concept: "ProvisionForLoanLeaseAndOtherLosses" },
      { concept: "ProvisionForLoanAndLeaseLosses" },
      { concept: "ProvisionForCreditLosses" },
    ],
    totalDeposits: [
      { concept: "Deposits" },
    ],
  },
  insurance: {
    revenue: [
      { concept: "Revenues" },
      { concept: "PremiumsEarnedNet" },
    ],
    netPremiumsEarned: [
      { concept: "PremiumsEarnedNet" },
      { concept: "PremiumsWrittenNet" },
    ],
    lossesIncurred: [
      { concept: "PolicyholderBenefitsAndClaimsIncurredNet" },
      { concept: "LiabilityForFuturePolicyBenefitsPeriodIncreaseDecrease" },
    ],
  },
  reit: {
    // REITs don't have ASC 606 customer contracts — revenue is rental
    // / lease income tagged under different concepts.
    revenue: [
      { concept: "Revenues" },
      { concept: "OperatingLeasesIncomeStatementLeaseRevenue" },
      { concept: "OperatingLeaseLeaseIncome" },
      { concept: "RealEstateInvestmentRevenues" },
      { concept: "RentalIncome" },
    ],
    operatingIncome: [
      { concept: "OperatingIncomeLoss" },
      { concept: "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest" },
      { concept: "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments" },
    ],
    longTermDebt: [
      { concept: "LongTermDebtNoncurrent" },
      { concept: "LongTermDebt" },
      { concept: "MortgageNotesPayable" },
      { concept: "SeniorNotes" },
      { concept: "LineOfCredit" },
      { concept: "NotesPayable" },
      { concept: "LongTermNotesPayable" },
      { concept: "DebtLongtermAndShorttermCombinedAmount" },
    ],
    ffo: [
      // FFO is non-GAAP and rarely tagged in us-gaap directly. REITs
      // often report it under company-specific extensions. Best-effort.
      { concept: "FundsFromOperations" },
    ],
    noi: [
      { concept: "OperatingIncomeLoss" }, // closest GAAP proxy
      { concept: "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest" },
    ],
  },
  saas: {
    deferredRevenue: [
      { concept: "ContractWithCustomerLiability" },         // post-ASC-606
      { concept: "DeferredRevenue" },
      { concept: "DeferredRevenueNoncurrent" },
    ],
    remainingPerformanceObligation: [
      { concept: "RevenueRemainingPerformanceObligation" },
    ],
  },
  biotech: {
    // R&D is the headline expense; cash runway matters more than EPS.
    researchAndDevelopment: [
      { concept: "ResearchAndDevelopmentExpense" },
      { concept: "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost" },
    ],
  },
  energy: {
    explorationExpense: [
      { concept: "ExplorationExpense" },
      { concept: "ExplorationAbandonmentAndImpairmentExpense" },
    ],
    depletionExpense: [
      { concept: "DepreciationDepletionAndAmortization" },
      { concept: "DepletionOfOilAndGasProperties" },
    ],
  },
  utility: {},
  retail: {},
  consumer: {},
  industrial: {},
  telecom: {},
  media: {},
};

// ─── Normalizer ─────────────────────────────────────────────────────

/** Normalized fact: deduped, sorted, with form-precedence applied. */
export type NormalizedFact = {
  end: string;
  val: number;
  fy: number;
  fp: string;
  form: string;
  filed: string;
  start?: string;
};

/**
 * Dedupes XBRL facts by `end` date. When the same period end appears
 * in multiple filings (e.g. Q4 in both the 10-Q and the 10-K), prefer
 * the 10-K — it's the audited annual restated value. Within forms of
 * the same precedence, prefer the most recent `filed` date.
 */
function dedupeAndSort(series: EdgarFact[]): NormalizedFact[] {
  const formRank: Record<string, number> = {
    "10-K": 1, "10-K/A": 1,    // best
    "20-F": 1, "40-F": 1,
    "10-Q": 2, "10-Q/A": 2,
    "8-K": 3,
  };
  const rankOf = (form: string) => formRank[form] ?? 9;

  const byEnd = new Map<string, EdgarFact>();
  for (const f of series) {
    const existing = byEnd.get(f.end);
    if (!existing) {
      byEnd.set(f.end, f);
      continue;
    }
    const better =
      rankOf(f.form) < rankOf(existing.form) ||
      (rankOf(f.form) === rankOf(existing.form) && f.filed > existing.filed);
    if (better) byEnd.set(f.end, f);
  }
  return Array.from(byEnd.values())
    .sort((a, b) => b.end.localeCompare(a.end));
}

// ─── Lookup ─────────────────────────────────────────────────────────

/**
 * Returns the normalized series for a logical metric, applying the
 * industry-specific concept list first and falling back to the default
 * list. Returns null if no concept variant returned data.
 *
 * The optional `limit` caps the returned observations (newest-first).
 * Pass `frequency: "annual"` to filter to FY periods only,
 * `"quarterly"` to filter to Q1/Q2/Q3 plus FY (which is implicitly
 * Q4), or omit to get everything.
 */
export function getMetric(
  facts: EdgarCompanyFacts,
  industry: EdgarIndustry,
  metric: LogicalMetric,
  opts: { limit?: number; frequency?: "annual" | "quarterly" } = {}
): { conceptUsed: string; unit: string; series: NormalizedFact[] } | null {
  const tries = [
    ...(INDUSTRY_REGISTRY[industry]?.[metric] ?? []),
    ...(DEFAULT_REGISTRY[metric] ?? []),
  ];

  // ── Freshness-aware selection.
  //
  // Earlier this function returned the FIRST matching concept and
  // stopped. That broke for issuers who switched concept tags over
  // time — e.g. JPM stopped using `LongTermDebt` (last filed 2013) and
  // moved to `LongTermDebtAndCapitalLeaseObligations` (current). The
  // lookup found `LongTermDebt` first, returned its 2013 series, and
  // never tried the bank-specific fallback.
  //
  // Now we collect EVERY matching concept and pick the one whose most
  // recent observation is newest. Tiebreak by priority order so an
  // industry-specific tag still wins when both are equally fresh.
  type Candidate = {
    t: ConceptTry;
    priority: number; // index in `tries` (lower = higher priority)
    normalized: NormalizedFact[];
    latestEnd: string;
  };
  const candidates: Candidate[] = [];

  for (let i = 0; i < tries.length; i++) {
    const t = tries[i];
    const unit = t.unit ?? "USD";
    const raw = getConceptSeries(facts, t.concept, {
      taxonomy: t.taxonomy ?? "us-gaap",
      unit,
      limit: 1000,
    });
    if (raw.length === 0) continue;
    const normalized = dedupeAndSort(raw);
    if (normalized.length === 0) continue;
    candidates.push({ t, priority: i, normalized, latestEnd: normalized[0].end });
  }

  if (candidates.length === 0) return null;

  // Sort: newest latestEnd first, then priority asc as tiebreaker.
  candidates.sort((a, b) => {
    if (a.latestEnd !== b.latestEnd) return b.latestEnd.localeCompare(a.latestEnd);
    return a.priority - b.priority;
  });

  const winner = candidates[0];
  let series = winner.normalized;

  if (opts.frequency === "annual") {
    series = series.filter((f) => f.fp === "FY");
  } else if (opts.frequency === "quarterly") {
    // All quarterly observations including FY (which represents Q4
    // when paired with the prior 9-month YTD value, but we don't
    // attempt that here — the consumer can decompose).
    series = series.filter((f) => /^Q[1-3]$/.test(f.fp) || f.fp === "FY");
  }

  if (opts.limit) series = series.slice(0, opts.limit);

  return { conceptUsed: winner.t.concept, unit: winner.t.unit ?? "USD", series };
}

/**
 * Convenience: pull a standard "scoring snapshot" of metrics for an
 * issuer, using the appropriate industry-specific concept list. This
 * is the payload Stage 2b will hand to the score prompt.
 */
export function buildScoringSnapshot(
  facts: EdgarCompanyFacts,
  industry: EdgarIndustry,
  opts: { limitAnnual?: number; limitQuarterly?: number } = {}
): Record<string, { conceptUsed: string; unit: string; latest: NormalizedFact | null; annual: NormalizedFact[]; quarterly: NormalizedFact[] }> {
  const limA = opts.limitAnnual ?? 10;
  const limQ = opts.limitQuarterly ?? 8;

  const universalMetrics: LogicalMetric[] = [
    "revenue", "operatingIncome", "netIncome", "epsDiluted",
    "ocf", "capex", "longTermDebt", "totalEquity", "cash",
    "totalAssets", "sharesDilutedWeighted", "researchAndDevelopment",
    "stockBasedCompensation", "grossProfit", "interestExpense",
  ];

  const industryMetrics: Partial<Record<EdgarIndustry, LogicalMetric[]>> = {
    bank: ["netInterestIncome", "nonInterestIncome", "tier1Capital", "provisionForLoanLosses", "totalDeposits"],
    insurance: ["netPremiumsEarned", "lossesIncurred"],
    reit: ["ffo", "noi"],
    saas: ["deferredRevenue", "remainingPerformanceObligation"],
    energy: ["explorationExpense", "depletionExpense"],
  };

  const metrics = [...universalMetrics, ...(industryMetrics[industry] ?? [])];

  const out: Record<string, { conceptUsed: string; unit: string; latest: NormalizedFact | null; annual: NormalizedFact[]; quarterly: NormalizedFact[] }> = {};
  for (const m of metrics) {
    const annual = getMetric(facts, industry, m, { frequency: "annual", limit: limA });
    const quarterly = getMetric(facts, industry, m, { frequency: "quarterly", limit: limQ });
    const source = annual ?? quarterly;
    if (!source) continue;
    out[m] = {
      conceptUsed: source.conceptUsed,
      unit: source.unit,
      latest: source.series[0] ?? null,
      annual: annual?.series ?? [],
      quarterly: quarterly?.series ?? [],
    };
  }
  return out;
}
