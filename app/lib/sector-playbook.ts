/**
 * Sector playbooks — DETERMINISTIC metric selection for the five fundamental
 * scoring categories (growth, relativeValuation, historicalValuation,
 * leverageCoverage, cashFlowQuality), chosen server-side from the company's
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

type Playbook = { label: string; body: string };

const P = (label: string, body: string): Playbook => ({ label, body: body.trim() });

const PLAYBOOKS: Record<string, Playbook> = {
  bank: P("Banks", `
growth: loan growth, deposit growth, net interest income / NIM trajectory, fee-income mix. Do NOT grade on generic "revenue growth".
relativeValuation: P/B (primary) and P/E vs bank peers; a premium P/B must be justified by superior ROE/ROTE.
historicalValuation: P/B vs the bank's own history, adjusted for the rate environment.
leverageCoverage: CET1 / Tier 1 ratios, credit-loss provisions, NPL trends. Debt/EBITDA and interest coverage are MEANINGLESS for banks — debt is their raw material; never cite them.
cashFlowQuality: FCF is not a bank concept. Use ROE/ROTE, provision adequacy, and dividend/buyback sustainability from earnings.`),

  capmarkets: P("Capital Markets / Diversified Financials", `
growth: AUM / net flows, fee-related earnings, advisory backlog (cycle-aware).
relativeValuation: P/E on operating EPS vs peers; P/AUM or fee-multiple where relevant.
historicalValuation: P/E vs own history across a full market cycle — trough multiples on peak markets deceive.
leverageCoverage: balance-sheet leverage and funding mix; Debt/EBITDA rarely meaningful.
cashFlowQuality: earnings-to-distributable-cash conversion, comp ratio discipline.`),

  insurance: P("Insurance", `
growth: net premiums written, book value per share growth (the compounding engine), float growth.
relativeValuation: P/B vs peers (primary); P/E on operating EPS excluding mark-to-market noise.
historicalValuation: P/B vs own history.
leverageCoverage: financial leverage, reserve adequacy/development, ratings headroom. Debt/EBITDA not meaningful.
cashFlowQuality: combined ratio (P&C) or benefit ratio trends, investment income quality, ROE.`),

  reit: P("REITs / Real Estate", `
growth: FFO/AFFO per share growth, same-property NOI, occupancy and leasing spreads.
relativeValuation: P/FFO or P/AFFO vs peers, implied cap rate vs private-market, premium/discount to NAV. GAAP P/E is near-meaningless (depreciation).
historicalValuation: P/FFO vs own history, spread vs rates.
leverageCoverage: net debt/EBITDA, debt/gross assets, fixed-charge coverage, maturity ladder.
cashFlowQuality: AFFO payout ratio sustainability; development pipeline funding.`),

  software: P("Software / IT Services", `
growth: revenue or ARR growth PLUS net revenue retention; Rule of 40 (growth + FCF margin) as the quality bar.
relativeValuation: EV/Sales calibrated to growth+margin, EV/FCF; P/E only when earnings are mature and representative.
historicalValuation: EV/Sales and EV/FCF vs own history.
leverageCoverage: usually net cash — the REAL balance-sheet drag is stock-based-comp dilution; grade SBC as % of revenue.
cashFlowQuality: FCF margin, SBC-adjusted FCF, deferred revenue / billings trends (leading indicator).`),

  semis: P("Semiconductors", `
growth: cycle-aware — separate content/secular growth from cycle swings; inventory and channel health are leading signals.
relativeValuation: P/E and EV/EBITDA vs semis peers at a SIMILAR cycle position; through-cycle earnings power beats spot multiples.
historicalValuation: multiples vs own history across the full cycle — cheap-on-peak is expensive.
leverageCoverage: net debt/EBITDA (fabless usually net cash; foundry/IDM carry capex debt).
cashFlowQuality: FCF conversion through the cycle, capex intensity, buyback discipline at cycle highs.`),

  hardware: P("Tech Hardware / Electronics", `
growth: units × ASP decomposition, attach/services mix shift, backlog.
relativeValuation: P/E and EV/EBITDA vs hardware peers (structurally lower multiples than software — do not cross-compare).
historicalValuation: vs own history; re-rating requires a mix-shift story, not hope.
leverageCoverage: net debt/EBITDA, working-capital cycle.
cashFlowQuality: FCF conversion ≥ net income as the quality bar; inventory turns.`),

  pharma: P("Pharmaceuticals", `
growth: portfolio growth NET of patent-cliff exposure (name the cliffs and dates), pipeline contribution.
relativeValuation: P/E vs pharma peers, adjusted for cliff timing; EV/EBITDA secondary.
historicalValuation: P/E vs own history, cliff-adjusted.
leverageCoverage: net debt/EBITDA vs deal capacity; litigation reserves where material.
cashFlowQuality: FCF stability, R&D productivity (approvals per R&D dollar), dividend coverage.`),

  biotech: P("Biotechnology", `
growth: pipeline milestones and addressable markets, not trailing revenue; for commercial names, launch trajectory.
relativeValuation: for profitable names P/E vs peers; for pre-profit names EV vs pipeline value and cash — conventional multiples are meaningless.
historicalValuation: use cautiously across approval cycles.
leverageCoverage: CASH RUNWAY IN QUARTERS is the leverage metric; convertible/debt maturities vs runway.
cashFlowQuality: burn rate vs milestones for pre-commercial; gross-to-net dynamics for commercial.`),

  medtech: P("MedTech / Life Sciences Tools", `
growth: procedure volumes / utilization, new-product cycles, recurring consumables mix.
relativeValuation: P/E and EV/EBITDA vs medtech peers (premium justified by recurring mix).
historicalValuation: vs own history.
leverageCoverage: net debt/EBITDA vs M&A cadence.
cashFlowQuality: FCF conversion, R&D as % sales sustainability.`),

  energy: P("Energy (Oil & Gas)", `
growth: production per share growth and reserve replacement — NOT nominal revenue (price-driven).
relativeValuation: EV/EBITDA, P/CF, and FCF yield AT STRIP prices vs peers. A low P/E on peak commodity earnings is EXPENSIVE — say so explicitly when it applies.
historicalValuation: through-cycle multiples vs own history at comparable commodity decks.
leverageCoverage: net debt/EBITDA at a CONSERVATIVE price deck, hedge book coverage, maturity wall.
cashFlowQuality: FCF at strip, capital discipline (reinvestment rate), shareholder-return framework durability.`),

  mining: P("Metals & Mining", `
growth: production growth per share, reserve life, grade trends.
relativeValuation: EV/EBITDA and P/NAV vs peers; cost-curve position (AISC quartile) is the moat proxy.
historicalValuation: through-cycle vs own history — cheap-on-peak-prices deceives.
leverageCoverage: net debt/EBITDA at conservative commodity prices, capex commitments vs balance sheet.
cashFlowQuality: FCF at spot AND at conservative deck, sustaining vs growth capex split.`),

  materials: P("Materials / Chemicals", `
growth: volume vs price decomposition, capacity additions vs demand.
relativeValuation: EV/EBITDA vs peers mid-cycle; specialty deserves premium to commodity chemistry — compare within the right bucket.
historicalValuation: mid-cycle multiple vs own history.
leverageCoverage: net debt/EBITDA through-cycle, pension where material.
cashFlowQuality: FCF conversion mid-cycle, working-capital swings with input costs.`),

  utility: P("Utilities", `
growth: rate-base growth (the earnings algorithm) and allowed-ROE trajectory; regulatory relationships.
relativeValuation: P/E vs regulated peers, dividend yield spread vs long bonds.
historicalValuation: P/E and yield-spread vs own history.
leverageCoverage: FFO/debt (ratings lens), regulatory support for recovery; absolute debt levels are structural, not a red flag per se.
cashFlowQuality: dividend coverage from regulated earnings; heavy capex with NEGATIVE FCF is the normal model when rate-base funded — do not penalize it as poor quality.`),

  retail: P("Retail / Consumer Discretionary", `
growth: comparable-store sales (traffic vs ticket), unit growth, e-commerce mix.
relativeValuation: P/E and EV/EBITDA vs peers; lease-adjusted where leases are large.
historicalValuation: vs own history at similar margin levels.
leverageCoverage: LEASE-ADJUSTED net debt/EBITDAR, inventory position vs sales trend.
cashFlowQuality: inventory turns, working-capital discipline, FCF through the seasonal cycle.`),

  staples: P("Consumer Staples", `
growth: ORGANIC growth split into volume vs price/mix — price-only growth is lower quality; market-share trends.
relativeValuation: P/E vs staples peers; the stability premium is legitimate but bounded.
historicalValuation: P/E vs own history and vs the staples group's premium to market.
leverageCoverage: net debt/EBITDA vs the sector's tolerance (typically 2-3x), dividend commitment.
cashFlowQuality: FCF conversion ≥ 90% of net income as the bar, promotional-spend discipline.`),

  telecom: P("Telecom", `
growth: subscriber adds and ARPU by segment; converged-bundle penetration.
relativeValuation: EV/EBITDA and FCF yield vs telecom peers; P/E distorted by D&A.
historicalValuation: EV/EBITDA vs own history.
leverageCoverage: net debt/EBITDA (sector norms run higher, ~2.5-3.5x), spectrum commitments, dividend vs FCF.
cashFlowQuality: FCF AFTER spectrum and network capex; dividend coverage from that FCF.`),

  media: P("Media / Entertainment / Interactive", `
growth: engagement (users/subs) × monetization (ARPU/ad pricing); content or platform flywheel evidence.
relativeValuation: EV/EBITDA vs peers; for ad-driven platforms P/E and EV/FCF; content amortization distorts GAAP.
historicalValuation: vs own history.
leverageCoverage: net debt/EBITDA vs content-spend commitments.
cashFlowQuality: FCF after content/platform capex; conversion trends as spend matures.`),

  industrial: P("Industrials", `
growth: organic growth vs M&A split, backlog and book-to-bill, aftermarket/services mix.
relativeValuation: EV/EBITDA and P/E vs peers at similar cycle position.
historicalValuation: vs own history mid-cycle.
leverageCoverage: net debt/EBITDA through-cycle, pension where material.
cashFlowQuality: FCF conversion ≥ 90-100% of net income as the quality bar, working-capital discipline through the cycle.`),
};

/** Regex router: FactSet GICS industry string first (most specific), then
 *  sector fallback. Returns null only when we know nothing — the prompt's
 *  generic guidance then applies unchanged. */
export function pickPlaybook(sector: string | null, industry: string | null): Playbook | null {
  const ind = (industry || "").toLowerCase();
  const sec = (sector || "").toLowerCase();

  if (ind) {
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

  if (/financial/.test(sec)) return PLAYBOOKS.capmarkets;
  if (/real estate/.test(sec)) return PLAYBOOKS.reit;
  if (/technology/.test(sec)) return PLAYBOOKS.hardware;
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
export function sectorPlaybookBlock(sector: string | null, industry: string | null): string | null {
  const pb = pickPlaybook(sector, industry);
  if (!pb) return null;
  return [
    `=== SECTOR PLAYBOOK: ${pb.label} ===`,
    `Selected deterministically from GICS classification (sector: ${sector || "n/a"}${industry ? `, industry: ${industry}` : ""}).`,
    `For the five fundamental categories, the metric selections below OVERRIDE any generic guidance. Grade each category on ITS listed metrics; never cite a metric this playbook marks as not meaningful for this business model. Category scales and definitions are unchanged.`,
    pb.body,
  ].join("\n");
}
