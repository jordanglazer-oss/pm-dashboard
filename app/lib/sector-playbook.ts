/**
 * Sector playbooks — DETERMINISTIC metric selection for the six fundamental
 * scoring categories (growth, returnsMargins, relativeValuation,
 * historicalValuation, leverageCoverage, cashFlowQuality), chosen server-side from the company's
 * FactSet GICS sector + industry rather than left to model discretion.
 *
 * Rationale (user direction, 2026-07-20): the 41-pt framework stays exactly
 * as-is — same categories, scales, thresholds. What changes is that "which
 * metrics matter for what this company does" becomes a computed input instead
 * of a per-rescore judgment call, making scores consistent rescore-to-rescore
 * and preventing nonsense like Debt/EBITDA on a bank.
 *
 * Pure string module — no I/O, no scoring math.
 */

type Playbook = { label: string; body: string; /** false when the playbook grades own-history valuation on a multiple other than P/E. */ peHistory?: boolean };

const P = (label: string, body: string): Playbook => ({ label, body: body.trim() });

const PLAYBOOKS: Record<string, Playbook> = {
  bank: P("Banks", `
growth: loan growth, deposit growth, net interest income / NIM trajectory, fee-income mix. Do NOT grade on generic "revenue growth".
returnsMargins: ROE and ROTCE (primary) vs the bank's cost of equity (~10–11%); ROA as the secondary check; efficiency ratio trajectory as the margin read. ROIC and operating margin are MEANINGLESS for banks — never cite them.
relativeValuation: P/B (primary) and P/E vs bank peers; a premium P/B must be justified by superior ROE/ROTE.
historicalValuation: P/B vs the bank's own history, adjusted for the rate environment.
leverageCoverage: CET1 / Tier 1 ratios, credit-loss provisions, NPL trends. Debt/EBITDA and interest coverage are MEANINGLESS for banks — debt is their raw material; never cite them.
cashFlowQuality: FCF is not a bank concept. Use ROE/ROTE, provision adequacy, and dividend/buyback sustainability from earnings.`),

  capmarkets: P("Capital Markets / Diversified Financials", `
growth: AUM / net flows, fee-related earnings, advisory backlog (cycle-aware).
returnsMargins: ROE (primary) and fee-related-earnings margin / operating margin on net revenue; for alt managers, FRE margin trajectory. ROIC is not meaningful where the balance sheet is the product.
relativeValuation: P/E on operating EPS vs peers; P/AUM or fee-multiple where relevant.
historicalValuation: P/E vs own history across a full market cycle — trough multiples on peak markets deceive.
leverageCoverage: balance-sheet leverage and funding mix; Debt/EBITDA rarely meaningful.
cashFlowQuality: earnings-to-distributable-cash conversion, comp ratio discipline.`),

  insurance: P("Insurance", `
growth: net premiums written, book value per share growth (the compounding engine), float growth.
returnsMargins: ROE vs cost of equity (primary); combined ratio trajectory is the margin read (lower = better; sub-95% is strong for P&C). ROIC and operating margin do not apply.
relativeValuation: P/B vs peers (primary); P/E on operating EPS excluding mark-to-market noise.
historicalValuation: P/B vs own history.
leverageCoverage: financial leverage, reserve adequacy/development, ratings headroom. Debt/EBITDA not meaningful.
cashFlowQuality: combined ratio (P&C) or benefit ratio trends, investment income quality, ROE.`),

  reit: P("REITs / Real Estate", `
growth: FFO/AFFO per share growth, same-property NOI, occupancy and leasing spreads.
returnsMargins: ROE and FFO / AFFO margin on revenue; NOI margin trend and same-property NOI growth as the margin read. ROIC on book is distorted by depreciated real estate — do not anchor on it.
relativeValuation: P/FFO or P/AFFO vs peers, implied cap rate vs private-market, premium/discount to NAV. GAAP P/E is near-meaningless (depreciation).
historicalValuation: P/FFO vs own history, spread vs rates.
leverageCoverage: net debt/EBITDA, debt/gross assets, fixed-charge coverage, maturity ladder.
cashFlowQuality: AFFO payout ratio sustainability; development pipeline funding.`),

  software: P("Software / IT Services", `
growth: revenue or ARR growth PLUS net revenue retention; Rule of 40 (growth + FCF margin) as the quality bar.
returnsMargins: operating margin and FCF margin trajectory (Rule of 40 context), gross margin level (≥70% for true software), incremental operating margin as evidence of operating leverage; ROIC is inflated by low invested capital — use it directionally only.
relativeValuation: EV/Sales calibrated to growth+margin, EV/FCF; P/E only when earnings are mature and representative.
historicalValuation: EV/Sales and EV/FCF vs own history.
leverageCoverage: usually net cash — the REAL balance-sheet drag is stock-based-comp dilution; grade SBC as % of revenue.
cashFlowQuality: FCF margin, SBC-adjusted FCF, deferred revenue / billings trends (leading indicator).`),

  semis: P("Semiconductors", `
growth: cycle-aware — separate content/secular growth from cycle swings; inventory and channel health are leading signals.
returnsMargins: ROIC through the cycle (mid-cycle, not peak), gross margin level and direction (the key competitive-position signal in semis), operating margin trajectory; a peak-cycle ROIC scores on mid-cycle.
relativeValuation: P/E and EV/EBITDA vs semis peers at a SIMILAR cycle position; through-cycle earnings power beats spot multiples.
historicalValuation: multiples vs own history across the full cycle — cheap-on-peak is expensive.
leverageCoverage: net debt/EBITDA (fabless usually net cash; foundry/IDM carry capex debt).
cashFlowQuality: FCF conversion through the cycle, capex intensity, buyback discipline at cycle highs.`),

  hardware: P("Tech Hardware / Electronics", `
growth: units × ASP decomposition, attach/services mix shift, backlog.
returnsMargins: ROIC (primary) and operating margin trajectory; gross margin direction signals pricing power vs commoditisation; incremental margin on mix shifts.
relativeValuation: P/E and EV/EBITDA vs hardware peers (structurally lower multiples than software — do not cross-compare).
historicalValuation: vs own history; re-rating requires a mix-shift story, not hope.
leverageCoverage: net debt/EBITDA, working-capital cycle.
cashFlowQuality: FCF conversion ≥ net income as the quality bar; inventory turns.`),

  pharma: P("Pharmaceuticals", `
growth: portfolio growth NET of patent-cliff exposure (name the cliffs and dates), pipeline contribution.
returnsMargins: ROIC (primary — R&D is the invested capital being tested), operating margin level and trajectory; gross margin is structurally high and uninformative; watch margin compression from loss-of-exclusivity.
relativeValuation: P/E vs pharma peers, adjusted for cliff timing; EV/EBITDA secondary.
historicalValuation: P/E vs own history, cliff-adjusted.
leverageCoverage: net debt/EBITDA vs deal capacity; litigation reserves where material.
cashFlowQuality: FCF stability, R&D productivity (approvals per R&D dollar), dividend coverage.`),

  biotech: P("Biotechnology", `
growth: pipeline milestones and addressable markets, not trailing revenue; for commercial names, launch trajectory.
returnsMargins: for pre-profit names the category is DATA GAP (1, confidence low) — returns are not yet a meaningful test. For commercial-stage names: gross margin on product sales and the path to positive operating margin.
relativeValuation: for profitable names P/E vs peers; for pre-profit names EV vs pipeline value and cash — conventional multiples are meaningless.
historicalValuation: use cautiously across approval cycles.
leverageCoverage: CASH RUNWAY IN QUARTERS is the leverage metric; convertible/debt maturities vs runway.
cashFlowQuality: burn rate vs milestones for pre-commercial; gross-to-net dynamics for commercial.`),

  medtech: P("MedTech / Life Sciences Tools", `
growth: procedure volumes / utilization, new-product cycles, recurring consumables mix.
returnsMargins: ROIC (primary) and operating margin trajectory; gross margin (≥60% typical for devices, tools lower) direction; incremental margin as evidence of scale.
relativeValuation: P/E and EV/EBITDA vs medtech peers (premium justified by recurring mix).
historicalValuation: vs own history.
leverageCoverage: net debt/EBITDA vs M&A cadence.
cashFlowQuality: FCF conversion, R&D as % sales sustainability.`),

  energy: P("Energy (Oil & Gas)", `
growth: production per share growth and reserve replacement — NOT nominal revenue (price-driven).
returnsMargins: ROCE / ROIC through the cycle at a mid-cycle commodity deck (state the deck), FCF margin at strip; operating margin is commodity-driven — judge the RELATIVE cost position vs peers, not the absolute level.
relativeValuation: EV/EBITDA, P/CF, and FCF yield AT STRIP prices vs peers. A low P/E on peak commodity earnings is EXPENSIVE — say so explicitly when it applies.
historicalValuation: through-cycle multiples vs own history at comparable commodity decks.
leverageCoverage: net debt/EBITDA at a CONSERVATIVE price deck, hedge book coverage, maturity wall.
cashFlowQuality: FCF at strip, capital discipline (reinvestment rate), shareholder-return framework durability.`),

  mining: P("Metals & Mining", `
growth: production growth per share, reserve life, grade trends.
returnsMargins: ROIC / ROCE at mid-cycle prices, AISC (all-in sustaining cost) position vs peers as the margin read, FCF margin at spot; a peak-price ROIC scores on mid-cycle.
relativeValuation: EV/EBITDA and P/NAV vs peers; cost-curve position (AISC quartile) is the moat proxy.
historicalValuation: through-cycle vs own history — cheap-on-peak-prices deceives.
leverageCoverage: net debt/EBITDA at conservative commodity prices, capex commitments vs balance sheet.
cashFlowQuality: FCF at spot AND at conservative deck, sustaining vs growth capex split.`),

  materials: P("Materials / Chemicals", `
growth: volume vs price decomposition, capacity additions vs demand.
returnsMargins: ROIC vs the company's own cycle history and vs peers, EBITDA margin trajectory (the standard chemicals read), incremental margin on volume recovery.
relativeValuation: EV/EBITDA vs peers mid-cycle; specialty deserves premium to commodity chemistry — compare within the right bucket.
historicalValuation: mid-cycle multiple vs own history.
leverageCoverage: net debt/EBITDA through-cycle, pension where material.
cashFlowQuality: FCF conversion mid-cycle, working-capital swings with input costs.`),

  utility: P("Utilities", `
growth: rate-base growth (the earnings algorithm) and allowed-ROE trajectory; regulatory relationships.
returnsMargins: allowed ROE vs earned ROE (the gap is the read — earning at or above the allowed return is strong), regulatory lag; ROIC and operating margin are rate-base outputs, not competitive signals.
relativeValuation: P/E vs regulated peers, dividend yield spread vs long bonds.
historicalValuation: P/E and yield-spread vs own history.
leverageCoverage: FFO/debt (ratings lens), regulatory support for recovery; absolute debt levels are structural, not a red flag per se.
cashFlowQuality: dividend coverage from regulated earnings; heavy capex with NEGATIVE FCF is the normal model when rate-base funded — do not penalize it as poor quality.`),

  retail: P("Retail / Consumer Discretionary", `
growth: comparable-store sales (traffic vs ticket), unit growth, e-commerce mix.
returnsMargins: ROIC (primary — inventory and stores are the invested capital), operating margin trajectory, gross margin direction (promotional intensity, shrink); incremental margin on same-store-sales growth.
relativeValuation: P/E and EV/EBITDA vs peers; lease-adjusted where leases are large.
historicalValuation: vs own history at similar margin levels.
leverageCoverage: LEASE-ADJUSTED net debt/EBITDAR, inventory position vs sales trend.
cashFlowQuality: inventory turns, working-capital discipline, FCF through the seasonal cycle.`),

  staples: P("Consumer Staples", `
growth: ORGANIC growth split into volume vs price/mix — price-only growth is lower quality; market-share trends.
returnsMargins: ROIC (primary; brand-led names should clear 15% comfortably), gross margin direction (pricing vs input costs), operating margin trajectory; watch for margin held up only by price without volume.
relativeValuation: P/E vs staples peers; the stability premium is legitimate but bounded.
historicalValuation: P/E vs own history and vs the staples group's premium to market.
leverageCoverage: net debt/EBITDA vs the sector's tolerance (typically 2-3x), dividend commitment.
cashFlowQuality: FCF conversion ≥ 90% of net income as the bar, promotional-spend discipline.`),

  telecom: P("Telecom", `
growth: subscriber adds and ARPU by segment; converged-bundle penetration.
returnsMargins: ROIC vs cost of capital (structurally thin — a spread above ~1–2 pts is good), EBITDA margin trajectory, FCF margin after spectrum and capex.
relativeValuation: EV/EBITDA and FCF yield vs telecom peers; P/E distorted by D&A.
historicalValuation: EV/EBITDA vs own history.
leverageCoverage: net debt/EBITDA (sector norms run higher, ~2.5-3.5x), spectrum commitments, dividend vs FCF.
cashFlowQuality: FCF AFTER spectrum and network capex; dividend coverage from that FCF.`),

  media: P("Media / Entertainment / Interactive", `
growth: engagement (users/subs) × monetization (ARPU/ad pricing); content or platform flywheel evidence.
returnsMargins: ROIC (primary), operating margin trajectory; for ad-driven and platform names, incremental operating margin on revenue growth is the operating-leverage test; for content names, content-cost amortisation vs revenue.
relativeValuation: EV/EBITDA vs peers; for ad-driven platforms P/E and EV/FCF; content amortization distorts GAAP.
historicalValuation: vs own history.
leverageCoverage: net debt/EBITDA vs content-spend commitments.
cashFlowQuality: FCF after content/platform capex; conversion trends as spend matures.`),

  industrial: P("Industrials", `
growth: organic growth vs M&A split, backlog and book-to-bill, aftermarket/services mix.
returnsMargins: ROIC (primary; quality industrials clear 15%), operating margin trajectory through the cycle, incremental margin on volume (should exceed the current margin in an upcycle), FCF margin.
relativeValuation: EV/EBITDA and P/E vs peers at similar cycle position.
historicalValuation: vs own history mid-cycle.
leverageCoverage: net debt/EBITDA through-cycle, pension where material.
cashFlowQuality: FCF conversion ≥ 90-100% of net income as the quality bar, working-capital discipline through the cycle.`),

  autos: P("Autos & Components", `
growth: unit volumes × mix / average selling price, EV and software attach, order book; cycle-aware (regional production and SAAR).
returnsMargins: ROIC through the cycle (automakers rarely earn their cost of capital — a sustained spread is the distinction), automotive EBIT margin vs peers EXCLUDING the captive finance arm, incremental margin on volume.
relativeValuation: P/E and EV/EBITDA on the INDUSTRIAL business (strip the captive finance arm's debt) vs auto peers; suppliers vs suppliers, manufacturers vs manufacturers.
historicalValuation: through-cycle multiples vs own history — a low P/E at peak volumes is expensive.
leverageCoverage: industrial net cash or debt EXCLUDING captive-finance debt; pension and warranty obligations; liquidity against a downturn cash burn.
cashFlowQuality: automotive FCF after capex and working capital; capex and R&D intensity through the EV transition; dividend covered by industrial FCF.`),

  managedcare: P("Managed Care / Health Care Services", `
growth: membership growth by line (commercial, Medicare Advantage, Medicaid), premium yield, services / pharmacy-benefit revenue.
returnsMargins: medical loss ratio trajectory (the margin read — lower is better, within regulatory floors), operating margin by segment, ROE / ROIC.
relativeValuation: P/E vs managed-care peers; distributors and services on EV/EBITDA and P/E.
historicalValuation: P/E vs own history, mindful of the rate-notice and election cycle.
leverageCoverage: debt / capital (sector norm ~40%), dividend capacity of the regulated subsidiaries, interest coverage.
cashFlowQuality: operating cash flow ÷ net income (≥ 1.0 is normal; the timing of government payments distorts single quarters), reserve development (days claims payable).`),

  transports: P("Transportation & Logistics", `
growth: volumes (carloads, tonne-miles, packages, passenger miles) × yield / pricing; mix.
returnsMargins: operating ratio for railroads and truckers (lower is better; below 60% is best-in-class for a railroad), ROIC (primary), unit cost excluding fuel for airlines, incremental margin.
relativeValuation: P/E and EV/EBITDA vs SAME-MODE peers (railroads vs railroads, airlines vs airlines); airlines lease-adjusted.
historicalValuation: through-cycle multiples vs own history.
leverageCoverage: net debt/EBITDA (railroads run 2-3x by design; airlines lease-adjusted), fleet and equipment commitments, fuel hedging.
cashFlowQuality: FCF conversion after maintenance capex, capex intensity, buybacks funded from FCF rather than debt.`),

  payments: P("Payments, Exchanges & Financial Data", `
growth: payment volume or transactions × take rate; for exchanges and data providers, recurring subscription revenue growth and volumes (cycle-aware).
returnsMargins: operating margin (networks 50%+; exchanges and data 40-60%), incremental margin; ROIC is inflated by low invested capital — use it directionally. Bank metrics (ROE vs cost of equity, NIM, CET1) do NOT apply.
relativeValuation: P/E and EV/EBITDA vs payments / exchange / data peers — NOT vs banks; a premium must be justified by growth and recurring mix.
historicalValuation: P/E vs own history.
leverageCoverage: net debt/EBITDA (standard framework); settlement and clearing balances are pass-through, not leverage.
cashFlowQuality: FCF conversion ≥ 90-100% of net income (asset-light); stock-based comp as % of revenue for fintechs.`),
};

/** Playbooks that grade own-history valuation on something other than P/E —
 *  the P/E history band is then only a cross-check (valuation-band.ts). */
const NON_PE_HISTORY = new Set(["bank", "insurance", "reit", "software", "biotech", "energy", "mining", "materials", "telecom", "media"]);

/** GICS reports payments networks under "Financial Services" and exchanges /
 *  data providers under "Capital Markets" at the industry level, so they cannot
 *  be told from lenders and brokers by industry string alone. This explicit,
 *  reviewable list routes the obvious names; anything else keeps its GICS route. */
const PAYMENTS_TICKERS = new Set(["V", "MA", "PYPL", "FI", "FIS", "GPN", "CPAY", "JKHY", "XYZ", "ICE", "CME", "NDAQ", "CBOE", "SPGI", "MCO", "MSCI", "FDS", "X.TO", "X-T"]);

/** Every playbook label+body concatenated, in stable key order — the input
 *  app/lib/rubric-version.ts hashes so playbook edits change RUBRIC_HASH. */
export const ALL_PLAYBOOK_BODIES = Object.keys(PLAYBOOKS)
  .sort()
  .map((k) => `${PLAYBOOKS[k].label}\n${PLAYBOOKS[k].body}`)
  .join("\n\n");

/** Regex router: FactSet GICS industry string first (most specific), then
 *  sector fallback. Returns null only when we know nothing — the prompt's
 *  generic guidance then applies unchanged. */
export function pickPlaybook(sector: string | null, industry: string | null, ticker?: string | null): Playbook | null {
  const ind = (industry || "").toLowerCase();
  const sec = (sector || "").toLowerCase();

  if (ticker && PAYMENTS_TICKERS.has(ticker.toUpperCase())) return PLAYBOOKS.payments;
  if (ind) {
    if (/transaction|payment processing|financial exchanges/.test(ind)) return PLAYBOOKS.payments;
    if (/automobile|auto components|automotive/.test(ind)) return PLAYBOOKS.autos;
    if (/health care providers|health care services|managed health|health care facilities|health care distributors/.test(ind)) return PLAYBOOKS.managedcare;
    // Word boundaries matter: "Broadline Retail" contains "road".
    if (/\bground transportation\b|\broad\b|\brail|air freight|airlines|\bmarine\b|transportation infrastructure/.test(ind)) return PLAYBOOKS.transports;
    if (/bank/.test(ind)) return PLAYBOOKS.bank;
    if (/insurance/.test(ind)) return PLAYBOOKS.insurance;
    if (/capital markets|financial services|consumer finance|mortgage/.test(ind)) return PLAYBOOKS.capmarkets;
    if (/reit|real estate/.test(ind)) return PLAYBOOKS.reit;
    if (/software|it services|internet software/.test(ind)) return PLAYBOOKS.software;
    if (/semiconductor/.test(ind)) return PLAYBOOKS.semis;
    if (/technology hardware|electronic equip|communications equip|computers/.test(ind)) return PLAYBOOKS.hardware;
    if (/pharmaceutical/.test(ind)) return PLAYBOOKS.pharma;
    if (/biotech/.test(ind)) return PLAYBOOKS.biotech;
    if (/health care equip|health care supplies|life sciences|health care technology/.test(ind)) return PLAYBOOKS.medtech;
    if (/oil|gas|consumable fuels|energy equip/.test(ind)) return PLAYBOOKS.energy;
    if (/metals|mining|gold|copper|steel/.test(ind)) return PLAYBOOKS.mining;
    if (/chemical|construction materials|containers|packaging|paper|forest/.test(ind)) return PLAYBOOKS.materials;
    if (/utilit|independent power|renewable electricity/.test(ind)) return PLAYBOOKS.utility;
    if (/retail|distributors/.test(ind) && !/staples/.test(ind)) return PLAYBOOKS.retail;
    if (/food|beverage|tobacco|household|personal (care|products)|staples/.test(ind)) return PLAYBOOKS.staples;
    if (/telecom|wireless/.test(ind)) return PLAYBOOKS.telecom;
    if (/media|entertainment|interactive/.test(ind)) return PLAYBOOKS.media;
    if (/aerospace|machinery|road|rail|air freight|airlines|marine|construction|electrical equip|industrial conglom|trading companies|commercial services|professional services|transportation/.test(ind)) return PLAYBOOKS.industrial;
  }

  // Sector-level fallbacks. Technology deliberately has NO fallback (audit
  // Finding 11): the hardware playbook (units × ASP, structurally-lower
  // multiples) is wrong for any Tech name that isn't hardware, and a wrong
  // playbook is worse than none — null lets the master prompt's generic
  // metric guidance stand. Unmatched industry strings are logged below so
  // the router's regex list can be extended from real misses.
  if (ind) {
    console.warn(`[Playbook] no industry match for "${industry}" (sector "${sector}") — using sector fallback`);
  }
  if (/financial/.test(sec)) return PLAYBOOKS.capmarkets;
  if (/real estate/.test(sec)) return PLAYBOOKS.reit;
  if (/health/.test(sec)) return PLAYBOOKS.medtech;
  if (/energy/.test(sec)) return PLAYBOOKS.energy;
  if (/materials/.test(sec)) return PLAYBOOKS.materials;
  if (/utilit/.test(sec)) return PLAYBOOKS.utility;
  if (/consumer discretionary/.test(sec)) return PLAYBOOKS.retail;
  if (/consumer staples/.test(sec)) return PLAYBOOKS.staples;
  if (/communication/.test(sec)) return PLAYBOOKS.media;
  if (/industrial/.test(sec)) return PLAYBOOKS.industrial;
  return null;
}

/** Format the playbook as a prompt block. Null when no playbook applies. */
/** The FactSet multiple the playbook grades own-history valuation on, WHEN the
 *  feed can band it: P/B for banks and insurers, P/S for software (the closest
 *  banded read to EV/Sales), P/E otherwise. null = the playbook's multiple
 *  (P/FFO, EV/EBITDA) has no history band, so P/E is sent as a cross-check. */
export function historyBandFormula(sector: string | null, industry: string | null, ticker?: string | null): "FG_PE" | "FG_PBK" | "FG_PSALES" | null {
  const pb = pickPlaybook(sector, industry, ticker);
  if (!pb) return "FG_PE";
  const key = Object.keys(PLAYBOOKS).find((k) => PLAYBOOKS[k] === pb);
  if (key === "bank" || key === "insurance") return "FG_PBK";
  if (key === "software") return "FG_PSALES";
  return key && NON_PE_HISTORY.has(key) ? null : "FG_PE";
}

export function sectorPlaybookBlock(sector: string | null, industry: string | null, ticker?: string | null): string | null {
  const pb = pickPlaybook(sector, industry, ticker);
  if (!pb) return null;
  return [
    `=== SECTOR PLAYBOOK: ${pb.label} ===`,
    `Selected deterministically from GICS classification (sector: ${sector || "n/a"}${industry ? `, industry: ${industry}` : ""}).`,
    `For the six fundamental categories, the metric selections below OVERRIDE any generic guidance. Grade each category on ITS listed metrics; never cite a metric this playbook marks as not meaningful for this business model. Where this playbook states a number for a category (a return bar, a conversion bar, a leverage norm), it REPLACES the generic number in the category list. Category scales (0-3, 0-2, 0-1) are unchanged. The growth line names what drives growth for this business — use it to explain the computed growth score and to judge your single adjustment.`,
    pb.body,
  ].join("\n");
}
