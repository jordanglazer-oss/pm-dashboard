import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getRedis } from "@/app/lib/redis";
import {
  fetchForwardLookingData,
  classifyRegime,
  loadStrategistHistory,
  type ForwardLookingData,
  type ForwardPoint,
  type StrategistHistory,
} from "@/app/lib/forward-looking";
import type { ResearchState } from "@/app/lib/defaults";
import { defaultResearch } from "@/app/lib/defaults";
import { buildHedgingCostsBlock } from "@/app/lib/hedging";
import { crossSectional, factsetConfigured } from "@/app/lib/factset";
import { buildCatalystCalendar, type CatalystCalendar } from "@/app/lib/catalyst-calendar";
import type { MarketRegimeData } from "@/app/lib/market-regime";
import { isCreditError, recordAnthropicCreditError, markAnthropicHealthy } from "@/app/lib/anthropic-status";
import { getDataUrl } from "@/app/lib/blob-store";

/**
 * Best-effort read of the deterministic market regime snapshot
 * persisted by /api/market-regime (key: pm:market-regime). Returns
 * null on missing/error — the brief prompt will then simply omit the
 * regime block rather than fail. We deliberately do NOT trigger a
 * recompute here; if the cache is cold, the dashboard / regime tile
 * will warm it on next page load.
 */
async function readMarketRegime(): Promise<MarketRegimeData | null> {
  try {
    const redis = await getRedis();
    const raw = await redis.get("pm:market-regime");
    if (!raw) return null;
    return JSON.parse(raw) as MarketRegimeData;
  } catch (e) {
    console.error("morning-brief: failed to read pm:market-regime", e);
    return null;
  }
}

const client = new Anthropic();

// Fetch live sector ETF performance from Yahoo Finance
const SECTOR_ETFS: Record<string, string> = {
  "Technology": "XLK",
  "Health Care": "XLV",
  "Financials": "XLF",
  "Consumer Discretionary": "XLY",
  "Consumer Staples": "XLP",
  "Energy": "XLE",
  "Utilities": "XLU",
  "Industrials": "XLI",
  "Materials": "XLB",
  "Communication Services": "XLC",
  "Real Estate": "XLRE",
};

type SectorPerf = { sector: string; etf: string; dayPct: number | null };

async function fetchSectorPerformance(): Promise<{ text: string; sectors: SectorPerf[] }> {
  const entries = Object.entries(SECTOR_ETFS);
  const empty = { text: "Sector data unavailable", sectors: [] as SectorPerf[] };

  // Yahoo FIRST for the sector heatmap: it carries a LIVE intraday day %
  // (regularMarketPrice vs previous close). FactSet's Formula API total-return
  // is delayed/EOD and its -1D form returns null intraday, which left the tiles
  // blank. FactSet stays as a fallback (and adds 1M context to the prompt text)
  // only when Yahoo is unavailable. Returns BOTH the prompt text and structured
  // per-sector day % (for the brief UI's Sector Rotation tile grid).
  try {
    const results = await Promise.all(
      entries.map(async ([sector, etf]) => {
        try {
          const res = await fetch(
            `https://query2.finance.yahoo.com/v8/finance/chart/${etf}?range=1d&interval=1d`,
            {
              headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
              },
              cache: "no-store",
            }
          );
          if (!res.ok) return null;
          const data = await res.json();
          const meta = data?.chart?.result?.[0]?.meta;
          if (!meta) return null;
          const price = meta.regularMarketPrice;
          const prevClose = meta.chartPreviousClose ?? meta.previousClose;
          const dayPct = prevClose && price != null ? ((price - prevClose) / prevClose) * 100 : null;
          return { sector, etf, dayPct, price: price as number | null };
        } catch {
          return null;
        }
      })
    );
    const valid = results.filter(Boolean) as { sector: string; etf: string; dayPct: number | null; price: number | null }[];
    if (valid.length > 0) {
      const sectors: SectorPerf[] = valid.map(({ sector, etf, dayPct }) => ({ sector, etf, dayPct }));
      const lines = valid.map(({ sector, etf, dayPct, price }) =>
        `- ${sector} (${etf}): ${dayPct != null ? `${dayPct >= 0 ? "+" : ""}${dayPct.toFixed(2)}% today, ` : ""}price $${price != null ? price.toFixed(2) : "N/A"}`
      );
      return { text: lines.join("\n"), sectors };
    }
  } catch (e) {
    console.error("Yahoo sector performance failed, trying FactSet:", e);
  }

  // FactSet fallback — only when Yahoo returned nothing.
  if (factsetConfigured()) {
    try {
      const ids = entries.map(([, etf]) => `${etf}-US`);
      const data = await crossSectional(ids, ["P_PRICE", "P_TOTAL_RETURNC(-1D,0)", "P_TOTAL_RETURNC(-1M,0)"]);
      const num = (row: Record<string, unknown> | undefined, f: string): number | null => {
        const v = row?.[f];
        return typeof v === "number" ? v : null;
      };
      const sectors: SectorPerf[] = [];
      const lines: string[] = [];
      for (const [sector, etf] of entries) {
        const row = data[`${etf}-US`];
        const price = num(row, "P_PRICE");
        if (price == null) continue;
        const d1 = num(row, "P_TOTAL_RETURNC(-1D,0)");
        const m1 = num(row, "P_TOTAL_RETURNC(-1M,0)");
        sectors.push({ sector, etf, dayPct: d1 });
        const dayStr = d1 != null ? `${d1 >= 0 ? "+" : ""}${d1.toFixed(2)}% today, ` : "";
        const monStr = m1 != null ? `${m1 >= 0 ? "+" : ""}${m1.toFixed(1)}% 1M, ` : "";
        lines.push(`- ${sector} (${etf}): ${dayStr}${monStr}price $${price.toFixed(2)}`);
      }
      if (lines.length > 0) return { text: lines.join("\n"), sectors };
    } catch (e) {
      console.error("FactSet sector performance fallback failed:", e);
    }
  }

  return empty;
}

const ATTACHMENT_CACHE_KEY = "pm:attachment-analysis";
const OSCILLATOR_ATTACHMENT_CACHE_KEY = "pm:oscillator-screenshot-analysis";
const NEWTON_TECHNICAL_CACHE_KEY = "pm:newton-technical-analysis";
// Generic analyst/strategist report dropbox — any research PDF/screenshot
// (a strategist note, a sell-side deck, an economics piece). Same
// hash-gated, parse-once-then-cache behavior as the Newton deck. NOTE: this
// is distinct from pm:analyst-reports (the per-ticker RBC/JPM analyst
// snapshots in analyst-snapshots.ts) — different data entirely.
const STRATEGIST_REPORTS_CACHE_KEY = "pm:strategist-reports-analysis";

const BRIEF_PROMPT = `You are a senior portfolio strategist generating a daily morning brief for a portfolio management team. Your audience is professional portfolio managers who need actionable, institutional-quality market intelligence.

Given current market data indicators, a pre-classified regime, forward-looking data (yield curve, forward P/E, SPX YTD, credit and vol week-over-week deltas), portfolio holdings, strategist research, and any attached screenshots, generate a comprehensive morning brief. When screenshots are provided (oscillator charts, etc.), incorporate their data points where relevant — but weigh them equally with all other inputs. Screenshots are supplementary context, not the primary driver of the brief.

Be direct, opinionated, and specific. Avoid generic platitudes. Write like a seasoned PM talking to their team.

CRITICAL — DATE ANCHORING & NO HISTORICAL HALLUCINATION:
The user payload contains an explicit "Today's Date" line. That is the authoritative date for this brief. You MUST obey these rules:
1. Do NOT reference macro events, tariff announcements, policy decisions, or Fed actions that are more than 30 days before Today's Date, even if you "remember" them from training data or see them mentioned in attached screenshots. Old events like "Liberation Day" (April 2025 tariff announcement), specific past CPI prints, past FOMC meetings, prior earnings seasons, or any dated historical reference that predates the last 30 days are OFF LIMITS as current narrative.
2. If an attached screenshot references an older event as historical context, do NOT treat it as a current driver. A research piece citing "the Liberation Day spike" means the spike happened in the past — do not describe it as a recent move or frame current credit levels as "unwinding" it unless the numerical week-over-week data in the payload clearly shows such an unwind.
3. Every specific catalyst or "recent move" you reference MUST be supported by either (a) a week-over-week delta in the forward-looking data block, (b) a YTD number in the data block, or (c) a number explicitly visible in an attached screenshot dated within the last 30 days. If you can't cite it from the payload, don't say it.
4. If you genuinely don't know what catalysts are on deck in the next 2 weeks (CPI, FOMC, earnings, etc.) because no attached screenshot or data field tells you, say "the next scheduled data releases and earnings" generically — do NOT invent specific dates or events.
5. Absolutely NO phrases like "coming off the Liberation Day spike", "post-Liberation Day unwind", "following the April tariff shock" unless Today's Date is within 30 days of April 2025.

CRITICAL — TONE ADAPTATION:
The user input contains a deterministic "Pre-classified Regime" line. Your marketRegime output MUST match it unless a data point in the payload contradicts it clearly (if so, explain briefly in bottomLine). Adapt tone accordingly:
- Risk-On → Lean constructive. Highlight what's working, where to add exposure, which defensive names to rotate out of. Do NOT manufacture bearish warnings when breadth, credit, and trend are healthy.
- Neutral → Balanced. Identify the swing variable and what would tip it either direction.
- Risk-Off → Defensive. Emphasize protection, quality, what to avoid.

CRITICAL — FORWARD-LOOKING ORIENTATION:
The brief is forward-looking across THREE horizons, not a recap of yesterday. The three horizon fields (tacticalView, cyclicalView, structuralView) are the primary forward statements; everything else (compositeAnalysis, hedgingAnalysis, etc.) should interpret current data through a forward lens.

The horizons map to specific time windows and weights in the overall composite:
- tacticalView (1-3M, 50% weight): What the PM should DO this month. Driven by VIX, breadth, momentum-vs-defensive leadership. Concrete: lean in / take chips / add OTM tail protection.
- cyclicalView (3-6M, 30% weight): Sector rotation and business-cycle pulse. Driven by ISM PMI 50-line, XLY/XLP, XLK/XLU. Concrete: which sectors are accelerating / decelerating, what to rotate into.
- structuralView (6-12M, 20% weight): Long-term trend overlay. Driven by SPX 10-month MA and ISM PMI direction. Concrete: are we in a bull cycle that allows risk-taking, or a topping process that vetoes tactical aggression?

Each horizon view must be 2-3 sentences, reference at least one of its driving signals by name (from the Multi-Horizon Rollup block), and be concrete enough that a PM can act on it. If a horizon's signals contradict an adjacent one, NAME the disagreement — that's actionable information. If the horizon has "no signals available", lean qualitative for that horizon rather than fabricating a quantitative read.

CRITICAL — SYNTHESIS QUALITY (this is what makes the brief worth reading for a desk running $1.5B):
- RECONCILE, DON'T AVERAGE. You are synthesizing multiple sources (the deterministic regime, Newton's notes, strategist reports, live macro/forward data, sentiment, the portfolio's own positioning). When they DISAGREE, that disagreement is the most important thing in the brief — name it explicitly, weigh the sources, and take a reasoned side with a concrete posture. Never blend conflicting signals into non-committal mush. The value you add is resolving tension the raw data can't.
- ONE JOB PER FIELD; EVERY LINE EARNS ITS PLACE. Each field should primarily do its own job, and every analytical sentence must carry a so-what — a number or signal tied to a concrete action or implication, not just a description of the data. Some overlap is fine where it aids readability (don't strip a genuinely useful point purely to avoid repetition), but never say the same thing twice in different words.
- TIE IT TO THIS BOOK. When a PORTFOLIO POSITIONING block is present, translate the macro / regime / sector-rotation read into what it means for THIS specific portfolio — cite its actual sector concentration (e.g. 'you're heaviest in Tech at 22% of names and XLK/XLU is rolling — direct exposure to the rotation'). Flag when a LEADING sector has little/no exposure (a gap) or when a LAGGING/at-risk sector is a top concentration. This belongs primarily in bottomLine and cyclicalView. Remember the book is equal-weight: recommend own/don't-own/rebalance/hedge, NEVER trim-vs-overweight specific names.

Respond ONLY with valid JSON matching this exact structure (fields are intentionally ordered so Bottom Line → Tactical/Cyclical/Structural Views → Composite → Risk Scan flows naturally in the UI):
{
  "marketRegime": "Risk-On or Neutral or Risk-Off — match the Pre-classified Regime unless clearly contradicted.",
  "regimeVerdict": "ONE punchy line (≤30 words) for the BOTTOM of the brief that fuses the OBJECTIVE quant regime with YOUR synthesized judgment (notes + reports + data). Exact format: 'Regime: <Risk-On|Neutral|Risk-Off> (quant) — Brief <concurs|cautions|diverges>: <terse actionable so-what>'. Use 'concurs' when your read aligns with the quant regime; 'cautions' when you broadly agree but flag a real caveat (narrowing breadth, Newton flipping, rich sentiment); 'diverges' when the notes+data lead you to position AGAINST the tape. The so-what must be a concrete posture (e.g. 'deploy on dips', 'trim into strength + add tail hedge', 'wait for breadth to confirm'). The <quant> label MUST equal marketRegime. Example: 'Regime: Risk-On (quant) — Brief cautions: tape constructive but breadth narrowing and Newton flipped; deploy partial, keep dry powder.'",
  "bottomLine": "2-4 sentences: THE single decisive takeaway + positioning posture across the three horizons — the one thing to know today. State the call and the so-what plainly; reference the weighted composite. Keep the driver MECHANICS light here (which signals and why lives in compositeAnalysis) so the two don't echo each other. Be bold and direct.",
  "whatChanged": "ONE-TWO sentences on what has MATERIALLY CHANGED since the Prior Brief (provided above, if any): a regime flip, a hedging or cash-deployment call change, a signal crossing a key threshold, a new/escalated portfolio risk, or Newton flipping direction. Be specific and cite the delta (e.g. 'Regime held Risk-On but cash-deploy dropped 72→58 as breadth narrowed'). If little changed, say so in one line. Return an EMPTY STRING only when no Prior Brief was provided.",
  "catalystWatch": "2-4 sentences on the NEXT ~2 WEEKS, grounded STRICTLY in the CATALYST CALENDAR block below. Name the specific dated events on deck (earnings for owned names, CPI / jobs / GDP / PCE / FOMC) and translate each into how THIS book is exposed — which sector concentration or single name is most in the line of fire. Lead with the single biggest event risk. Do NOT invent events that aren't in the calendar block. Return an EMPTY STRING if the calendar block lists no events.",
  "tacticalView": "2-3 sentences for the 1-3M tactical horizon. What the PM should DO this month. Cite at least one tactical-bucket signal by name (VIX Level, Breadth (RSP/SPY), MTUM/USMV). Concrete posture call: lean in, take chips, add OTM tail protection, or hold. Reference live SPY hedging premiums if attached. This pairs with hedgingAnalysis.",
  "tacticalInvalidator": "ONE sentence (≤25 words) naming the specific data point(s) that, if seen, would invalidate the tactical view. Be CONCRETE — cite the signal and the threshold. Example: 'VIX above 25 with breadth ratio inverting' or 'MTUM/USMV breaks below 1.05'. NEVER 'unknown' or 'various factors'.",
  "cyclicalView": "2-3 sentences for the 3-6M cyclical horizon. Sector rotation + business cycle. Cite at least one cyclical-bucket signal by name (XLY/XLP, XLK/XLU, ISM PMI 50-line). Concrete: which sectors are accelerating, which to rotate into, whether the cycle is mid or late. Call out an ISM PMI 50-line CROSSOVER explicitly if one is flagged.",
  "cyclicalInvalidator": "ONE sentence (≤25 words) naming the specific cyclical data point(s) whose move would invalidate this view. Cite specific signals/thresholds. Example: 'ISM PMI back below 50 OR XLY/XLP reversing below 1.0' or 'XLK/XLU losing leadership for 3+ weeks'.",
  "structuralView": "2-3 sentences for the 6-12M structural horizon. Long-term trend + macro direction. Cite at least one structural-bucket signal by name (SPX 10-Month Trend, ISM PMI Trend). Concrete: is the trend overlay supportive or vetoing? If structural disagrees with tactical, name the disagreement — the PM trades tactically but should know when the long window is pulling against them.",
  "structuralInvalidator": "ONE sentence (≤25 words) naming the specific structural data point(s) whose move would invalidate this view. Cite specific signals/thresholds. Example: 'SPX closes below the 10-month MA for 2 consecutive months' or 'ISM PMI trend turns negative for 3+ months'.",
  "compositeAnalysis": "2-3 sentences on the MECHANICS behind the signal — which specific signals are driving the composite and the internal tension between them (e.g. 'breadth healthy but oscillator overbought and momentum unconfirmed'). Cite the readings by name. This is where the 'why' lives; do NOT restate the positioning takeaway (that's bottomLine's job).",
  "underpriced": "ONE-TWO sentences: the single most important thing the current tape / consensus appears to be UNDER-pricing or over-looking, distilled across ALL integrated sources (Newton's notes, strategist reports, live macro/forward data, sentiment, the portfolio's own positioning). This is the non-consensus edge a senior PM is paid to spot — be specific and cite what points to it. If nothing genuinely stands out as mispriced today, return an empty string rather than manufacturing a contrarian angle.",
  "creditAnalysis": "2-3 sentences on credit spreads. LEAD with what CHANGED week-over-week and its implication for risk appetite / equity positioning, then cite the specific levels driving that read (HY/IG OAS in bps) so the summary stands on its own for a reader who skips the tiles.",
  "volatilityAnalysis": "2-3 sentences on the volatility regime. LEAD with what CHANGED (VIX/MOVE week-over-week, term-structure shift) and what it means for hedging and position sizing, then cite the specific levels (VIX, term structure, MOVE) so the summary is self-contained.",
  "breadthAnalysis": "2-3 sentences on breadth and participation. LEAD with what CHANGED (DMA participation, NYSE A/D, new highs vs lows) and the market-structure implication — is the move broad or narrow? — then cite the specific figures (S&P/broad % above 50/200 DMA, new H/L) so the summary stands alone.",
  "contrarianAnalysis": "2-3 sentences providing the contrarian take. ALWAYS state WHERE each of the four indicators sits (S&P Oscillator, Put/Call, Fear & Greed, AAII survey) and its trajectory — the reader relies on this to know current positioning. All four are interpreted INVERSELY: oversold/fearful = BULLISH opportunity, overbought/greedy = BEARISH warning. Calibrate the signal HONESTLY: a genuine multi-decade extreme is a strong signal; a mid-range reading is a neutral one and must be described as neutral rather than forced into a directional verdict. Close with the overall contrarian read and what it means for positioning.",
  "hedgingAnalysis": "3-4 sentences on whether current conditions favor adding SPY put protection. OSCILLATOR ANCHOR (CRITICAL): when referencing the S&P Oscillator in hedging context, cite the actual current reading and treat the -1.5% to +2.5% range as the normal monthly band where most hedging decisions happen. Do NOT anchor on -5% as the threshold — that's a panic-capitulation extreme seen 1-3x per year, not a typical signal. Hedging decisions rely far more on VIX level + term structure, breadth quality, and late-cycle warnings than on oscillator extremes. HEDGING PHILOSOPHY: this is tail-risk INSURANCE, not a directional bet — we own equities and want to cap left-tail drawdowns, not speculate on near-term direction. Hedging is NOT a default — it's something we implement only when the cost is reasonable AND the broader picture warrants it (overheated/extended market, deteriorating breadth, rich sentiment, weakening leadership, etc.). Many briefs should land on 'skip' even when premiums are cheap, if the macro/breadth backdrop doesn't justify the spend. Restricted to PROTECTIVE PUTS only — no speculative positions, no weeklies, no LEAPS. STRIKES ARE 5–10% OTM (this is where genuine tail protection lives — ATM puts behave more like directional shorts and carry rich extrinsic premium). ATM strikes are reserved for the rare case where tail risk is acutely elevated within ~30 days (confirmed Risk-Off across all three horizons, VIX above 25 and rising, OR a hard-dated event risk like an FOMC decision priced into front-month vol) — call out the trigger explicitly when recommending ATM, otherwise default to 5–10% OTM. Tenor band is strictly 2–9 months: tactical (Risk-Off in the 1-3M bucket) → 2–3 month monthly contracts; cyclical (Risk-Off in the 3-6M bucket) → 3–6 month quarterly contracts; structural (Risk-Off in the 6-12M bucket while tactical holds up) → 6–9 month contracts as a strategic overlay (capped at 9M — never recommend LEAPS). When a 'Live SPY Hedging Costs' block is present, cite at least one specific 5–10% OTM premium (e.g. '3-month 7% OTM SPY put is X% of spot at $Y') and reference the week-over-week or month-over-month direction of those OTM premiums when provided. Integrate VIX, term structure, and sentiment as the qualitative lens on top of the actual option prices. Give a clear directional recommendation — ADD, HOLD, or SKIP. ADD has TWO entry paths: (1) classic Risk-Off — at least one horizon flagged Risk-Off and breadth/momentum confirming, OR (2) cheap-insurance — premiums depressed (OTM premiums in the lower decile, VVIX low, skew flat) AND the market shows late-cycle warning signs: extended runup over the last 6-12M, overbought oscillator readings, narrowing breadth (waning DMA participation, NYSE A/D fading), or leadership thinning. Insurance is most valuable when it's cheap AND a setup is forming, not when one or the other is true alone. SKIP IS A FIRST-CLASS RECOMMENDATION: if neither ADD path is clearly engaged, the right call is 'skip — protection here would be premium spent without a thesis'. Do not hedge for the sake of hedging; an explicit skip is more valuable than a wishy-washy 'hold and reassess'.",
  "sectorRotation": {
    "summary": "1-2 sentence overview of which sectors are leading vs lagging based on the LIVE sector ETF performance data provided.",
    "leading": ["Sector (+X.XX% today, reason)", "Sector (+X.XX% today, reason)"],
    "lagging": ["Sector (-X.XX% today, reason)", "Sector (-X.XX% today, reason)"],
    "pmImplication": "1-2 sentence implication for the portfolio given its current sector exposures."
  },
  "riskScan": [
    {
      "ticker": "TICKER",
      "priority": "High",
      "summary": "Brief explanation of why this holding is flagged.",
      "action": "Specific recommended action."
    }
  ],
  "forwardActions": [
    {
      "priority": "High",
      "title": "Short actionable title",
      "detail": "1-2 sentence explanation of why this action matters now."
    }
  ],
  "topActionsToday": [
    "Imperative one-liner action #1 (≤ 12 words, starts with a verb, specific enough that the PM could execute today).",
    "Imperative one-liner action #2.",
    "Imperative one-liner action #3."
  ],
  "hedgingCall": {
    "action": "ADD or HOLD or SKIP — must match the directional recommendation in hedgingAnalysis.",
    "strike": "5% OTM or 7% OTM etc. — required when action=ADD, omit otherwise.",
    "tenor": "3 months / 6 months etc. — required when action=ADD, omit otherwise.",
    "reason": "ONE sentence, ≤ 25 words, plain English. Why this call is right today."
  },
  "cashDeploymentCall": {
    "action": "DEPLOY or DEPLOY_PARTIAL or WAIT — see rubric below.",
    "score": 78,
    "window": "≤ 12 words — when to act. Examples: 'Deploy now', 'Next 1-2 sessions', 'Wait 3-5 trading days'.",
    "reason": "ONE sentence, ≤ 25 words. The single most important factor tipping today's call.",
    "triggersMet": ["≤ 8 word bullets of what's working today. 0-4 entries."],
    "triggersMissing": ["≤ 8 word bullets of what's NOT yet in place. 0-4 entries."],
    "newtonPersistence": "ONE line on Newton's 30-day pattern: persistence, inflection, or staleness. Omit if no Newton notes are in the strategist context."
  }
}

Notes:
- sectorRotation.leading and .lagging should each have 2-3 entries with sector name, approximate MTD performance, and a brief reason.
- riskScan MUST ONLY include holdings tagged "(Portfolio, ...)" — NEVER include Watchlist names (those are candidates, not owned positions). Order from highest risk to lowest, with priority: "High", "Medium-High", "Medium", or "Low-Medium". Focus on the weakest/most at-risk Portfolio names. Include 4-7 entries drawn exclusively from the Portfolio bucket. USE the [RISK: ...] annotations on each holding — holdings tagged CRITICAL or WARNING should be prioritized highest. Incorporate specific risk signals (trend, momentum, MACD, volume, Ichimoku, valuation) into your summaries and actions. Do NOT reference short interest as a risk driver — it is informational only.
- MARKETEDGE DETERIORATION RULE: Any Portfolio holding tagged "[MARKETEDGE: deteriorating Long, …]" MUST appear in riskScan with priority at least "Medium" — this is a deliberate flag from MarketEdge that a winning position's technicals are significantly breaking down (Long opinion with Score ≤ −3). Cite the Opinion Score and Power Rating in the summary. If the broader environment corroborates (Risk-Off regime, weakening breadth, deteriorating tactical view, or matching CRITICAL/WARNING riskAlert on the same name), ELEVATE to "High" and add a forwardActions item proposing a concrete next step (review/trim/tighten thesis). Do NOT silently downgrade or omit a MARKETEDGE deteriorating-Long flag.
- catalystWatch MUST be grounded ONLY in the CATALYST CALENDAR block — cite the actual dated events (never invent dates or events not listed). Tie each to the book's exposure (e.g. 'CPI on the 15th pressures your Tech concentration'; 'NVDA earnings on the 21st is your biggest single-name event risk'). Lead with the single highest-impact event. If the block lists no events, return an empty string.
- forwardActions should contain 4-6 specific, actionable recommendations ordered by priority. Use "High", "Medium", or "Low" for priority. Actions should be forward-looking (what to do THIS week or next), not reactive to yesterday.
- topActionsToday is the PM's at-a-glance executive summary — 3 to 5 imperative one-liners that distill the most important decisions for today. Each entry must (a) start with a verb (Add / Trim / Hedge / Rotate / Watch / Skip / Hold), (b) be ≤ 12 words, (c) be specific enough that the PM could execute on it without further interpretation ("Add 2% SPY 3M 7%-OTM puts" not "Consider hedging"), and (d) be a subset/restatement of the most important forwardActions and hedgingCall items so the executive summary is consistent with the detail panels below it. Do NOT include "review", "monitor", "consider" — those are too vague. If a forwardAction is High priority it should usually have a corresponding topActionsToday entry.
- hedgingCall MUST mirror the recommendation in hedgingAnalysis. If hedgingAnalysis says "SKIP", hedgingCall.action is "SKIP" and strike/tenor are omitted (null/missing). If it says "ADD", populate strike + tenor with the specific values referenced in the prose (e.g. "5% OTM" / "3 months"). reason must be one short sentence that captures the WHY (cheap insurance + late-cycle warning, classic Risk-Off, etc.) so the PM can decide in one read whether to act.

- cashDeploymentCall answers a SPECIFIC question: "We make monthly-installment deployments of new client cash, normally between the 1st and the 20th. Is today a good day to deploy, or should we wait a few sessions for a better entry?" This is NOT macro market timing — the decision to deploy this month is already made; we are only optimizing day-of-deployment within a roughly 2-week window. Apply this rubric:
  INPUT WEIGHTS (blend in this order of priority):
    40% — Mark Newton's daily strategist note + the 30-day Newton history block. This is the dominant signal. Look explicitly for:
      (a) PERSISTENCE: Has Newton been calling the same dip-buy / pullback opportunity for multiple consecutive sessions? (Mature signal — strong DEPLOY tilt; he's been right and a bounce is overdue, OR he's been wrong and the setup is fading. Use his tone in the most recent note to disambiguate.)
      (b) INFLECTION: Did Newton flip direction recently (cautious → constructive, or vice versa)? A fresh constructive flip after 2+ weeks of caution is the strongest single DEPLOY signal we can identify. The reverse — fresh caution after a constructive run — is the strongest single WAIT signal.
      (c) STALENESS: Is Newton's bullish thesis 2+ weeks old without confirming market action? Reduce his weight in that case; the call is no longer fresh.
      Populate newtonPersistence with a ONE-line summary of which of these patterns is active (e.g. "Newton calling dip-buy 4 sessions running; constructive tone holding" or "Newton flipped cautious 2 sessions ago — wait"). Omit the field entirely if no Newton notes are in the context.
    25% — S&P Oscillator (from the oscillator screenshot if attached, otherwise from oscContext text). CALIBRATION (CRITICAL — do not drift to extreme thresholds): the S&P Oscillator typically reads between -2% and +2% in normal weeks. Reference these bands directly:
       0 to -1%:    Normal weekly drift — no edge from this input.
      -1.5% to -2.5%: MEANINGFUL pullback. This is already a real DEPLOY signal — do not treat it as 'almost there'. Most monthly deployment opportunities sit in this band.
      -2.5% to -4%: Sharp pullback (occurs ~5-10x per year). Strong DEPLOY signal.
      -5% or deeper: Panic / capitulation lows (occurs 1-3x per year — March 2020, October 2022, March 2023 SVB). Aggressive DEPLOY. DO NOT anchor on this level as the threshold — it is the extreme tail, not the trigger.
      +1.5% to +2.5%: Stretched. Mild WAIT tilt.
      +2.5% or higher: Overbought (occurs ~3-5x per year). WAIT signal.
      When citing the oscillator in reason/triggersMet/triggersMissing, ALWAYS reference the actual current reading and the appropriate band, not a generic "if oscillator hits -5%". Saying "Oscillator at -1.8% — meaningful pullback" is correct; saying "Oscillator not yet at -5%" is anchoring wrong.
    15% — Breadth: blend SP500 + broad-market % above 50/200-DMA plus NYSE new highs / new lows when present. The "broad-market" field is universe-agnostic — the PM's source is typically Barchart BCMM (~5,168 stocks) but may also be Russell 3000 (~3,000 stocks) or another broader-than-SPX measure. Decision tree:
      (a) SP500 and broad-market BOTH in the same band (both ~40% or both ~60%) → clean signal, weight breadth normally.
      (b) SP500 healthy (≥50%) but broad-market materially weaker (≥10pp gap, e.g. SP500 55% / broad 38%) → NARROWING LEADERSHIP. Newton's classic late-cycle warning. Tilt toward WAIT or DEPLOY_PARTIAL even if SPX-only metrics look fine. Call this out explicitly in the reason field when active.
      (c) Both deeply oversold (<30%) AND new lows spiking (>150-200/day) → CAPITULATION. Tradable bottom often forms within days. Strong DEPLOY signal.
      (d) Both stretched (>70%) AND new highs expanding (>100/day) → healthy thrust, confirms DEPLOY when other signals support.
      (f) UP-VOLUME % (conviction gauge, when present): NYSE advancing volume as a % of total. This is the one breadth field that measures CONVICTION rather than participation. >85-90% up-volume = a breadth-thrust day; coming off a pullback or oversold reading this is one of the strongest DEPLOY-now confirmations available (the bounce has real money behind it). <10-15% up-volume (i.e. >85-90% down-volume) = capitulation selling — pair with oversold %above-DMA + new-low spike for a strong "buy the panic" DEPLOY. Mid-range (35-65%) = no edge from this signal. Cite the actual figure: "up-volume 91% — breadth thrust" not "strong volume."
      (e) When any breadth field is missing (PM didn't enter today's broad-market or new H/L numbers), explicitly note in reason that you're working without that data — don't fabricate the divergence read.
      Cite specific numbers when present: "SP500 55%, broad market 38% — 17pp gap" not "breadth divergent."
      EQUIVALENCY NOTE — BCMM vs Russell 3000: When Newton's strategist note references Russell 3000 breadth and the "Broad Market" field in this brief contains a BCMM value (or vice versa), treat them as near-equivalent readings of the same underlying broad-participation signal. The two universes typically read within 3-5pp of each other directionally — confirming readings, not independent inputs. If the two diverge by more than ~5pp, note the gap explicitly in the reason rather than picking one — the gap itself is a signal worth surfacing. Do NOT double-count BCMM and R3000 as separate signals.
    10% — VIX state. A VIX spike to 20-25 that's stalling/reversing is a classic DEPLOY trigger. A runaway VIX above 28 still climbing is WAIT (we haven't hit peak fear). VIX <16 is mid-range — no edge either way from this signal alone.
    6%  — Sentiment: Fear & Greed below 30, AAII bears > bulls, elevated put/call. Capitulation is DEPLOY.
    4%  — Short-term momentum: 5-day SPY return. A clean -2% to -5% pullback over 5 days is a healthy DEPLOY setup; deeper than -7% may indicate a regime break (WAIT for the bottom to confirm).
  COMPUTING THE SCORE (0-100): Anchor to this banding — do NOT drift to 50 when uncertain.
    85-100: At least 3 weights firing DEPLOY with no major WAIT signal. Rare; reserve for genuine "buy the dip" days.
    70-84:  Newton constructive + at least one quant signal confirming + no major WAIT signal. Strong default for a clean DEPLOY day.
    55-69:  Mixed but tilting DEPLOY (e.g. Newton constructive but quant neutral, or quant oversold but Newton cautious). Action = DEPLOY_PARTIAL (deploy half now, hold half for stronger setup).
    40-54:  Mid-range / no edge. Default action = DEPLOY anyway (mid-range is fine; never WAIT just because signals are quiet).
    25-39:  WAIT zone — affirmative evidence a better day is likely within ~5 trading days (Newton cautious + overbought oscillator + narrow breadth).
    Below 25: Strong WAIT — multiple WAIT signals stacking. Very rare; should only trigger on clear deterioration.
  ACTION → SCORE mapping (must be consistent):
    score >= 70  → action "DEPLOY"
    score 55-69  → action "DEPLOY_PARTIAL"
    score 40-54  → action "DEPLOY" (mid-range defaults to deploy; never WAIT in this band)
    score < 40   → action "WAIT"
  HARD RULES:
    - Mid-range (40-54) is ALWAYS DEPLOY, never WAIT. We do not delay deployment for "no edge". WAIT requires AFFIRMATIVE evidence a better day is likely.
    - window must be specific: "Deploy now", "Next 1-2 sessions", "Wait 3-5 trading days" — never vague like "soon" or "this week."
    - triggersMet and triggersMissing should each be 2-4 short bullets (≤ 8 words each). Cite specific signals/levels, not generalities. "Oscillator -2.3" not "Oscillator weak."
    - reason is the SINGLE most important factor tipping today's call. If the call is DEPLOY because Newton flipped constructive after 3 weeks cautious, the reason is THAT — not a summary of all signals.
    - The same inputs MUST produce the same score (temperature=0). Anchor to the rubric; resist drifting to round numbers.
- IMPORTANT: All portfolio positions are equally weighted and we only rebalance (restore equal weights), never trim individual positions relative to others. Do NOT recommend trimming, reducing, or overweighting specific names. Instead, recommend actions like: adding new names, removing names entirely if the thesis is broken, rebalancing back to equal weight, hedging, or adjusting overall portfolio exposure. Think in terms of "own or don't own" rather than position sizing.`;

type AttachmentInput = {
  section: string;
  label: string;
  dataUrl: string;
};

function buildImageBlocks(attachments: AttachmentInput[]): Anthropic.Messages.ContentBlockParam[] {
  const blocks: Anthropic.Messages.ContentBlockParam[] = [];

  if (!attachments || attachments.length === 0) return blocks;

  // Group by section
  const bySection: Record<string, AttachmentInput[]> = {};
  for (const att of attachments) {
    if (!bySection[att.section]) bySection[att.section] = [];
    bySection[att.section].push(att);
  }

  // Strict base64 payload regex — Anthropic rejects anything outside
  // [A-Za-z0-9+/=] and certain SDKs throw "The string did not match the
  // expected pattern" when validation fails. We'd rather skip a single
  // corrupted attachment than have the whole brief call blow up.
  const validBase64 = /^[A-Za-z0-9+/]+={0,2}$/;

  for (const [section, atts] of Object.entries(bySection)) {
    type ValidImg = { kind: "image"; att: AttachmentInput; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string };
    type ValidPdf = { kind: "pdf"; att: AttachmentInput; data: string };
    const validAtts: (ValidImg | ValidPdf)[] = [];
    for (const att of atts) {
      // Try PDF first.
      const pdfMatch = att.dataUrl.match(/^data:application\/pdf;base64,(.+)$/);
      if (pdfMatch) {
        const data = pdfMatch[1].replace(/\s/g, "");
        if (!data || !validBase64.test(data) || data.length % 4 !== 0) {
          console.warn(`[brief] skipping PDF '${att.label}' — invalid base64 payload`);
          continue;
        }
        validAtts.push({ kind: "pdf", att, data });
        continue;
      }
      const match = att.dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (!match) {
        console.warn(`[brief] skipping attachment '${att.label}' — malformed data URL`);
        continue;
      }
      const rawMediaType = match[1];
      const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
      const mediaType = (allowedTypes.includes(rawMediaType) ? rawMediaType : "image/png") as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
      const data = match[2].replace(/\s/g, "");
      if (!data || !validBase64.test(data) || data.length % 4 !== 0) {
        console.warn(`[brief] skipping attachment '${att.label}' — invalid base64 payload (${data.length} chars)`);
        continue;
      }
      validAtts.push({ kind: "image", att, mediaType, data });
    }

    if (validAtts.length === 0) continue;

    const imgCount = validAtts.filter((v) => v.kind === "image").length;
    const pdfCount = validAtts.filter((v) => v.kind === "pdf").length;
    const summary = [
      imgCount > 0 ? `${imgCount} image${imgCount > 1 ? "s" : ""}` : null,
      pdfCount > 0 ? `${pdfCount} PDF${pdfCount > 1 ? "s" : ""}` : null,
    ].filter(Boolean).join(" + ");

    blocks.push({
      type: "text",
      text: `\n--- Attached files for ${section} (${summary}) ---\nAnalyze these carefully and incorporate findings into your brief:`,
    });

    for (const v of validAtts) {
      if (v.kind === "pdf") {
        blocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: v.data },
        });
        blocks.push({ type: "text", text: `(PDF: ${v.att.label})` });
      } else {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: v.mediaType, data: v.data },
        });
        blocks.push({ type: "text", text: `(Image: ${v.att.label})` });
      }
    }
  }

  return blocks;
}

// Generate a fingerprint of the current attachments so we know if they changed
function hashAttachments(attachments: AttachmentInput[]): string {
  if (!attachments || attachments.length === 0) return "none";
  const ids = attachments.map((a) => a.dataUrl.slice(-100)).sort().join("|");
  return createHash("md5").update(ids).digest("hex");
}

type CachedAnalysis = {
  hash: string;
  summary: string;
  equityFlowsSignal?: string;
  analyzedAt: string;
};

// Get cached analysis from KV, or null if cache miss / images changed
async function getCachedAnalysis(hash: string): Promise<{ summary: string; equityFlowsSignal?: string } | null> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(ATTACHMENT_CACHE_KEY);
    if (!raw) return null;
    const cached: CachedAnalysis = JSON.parse(raw);
    if (cached.hash === hash) return { summary: cached.summary, equityFlowsSignal: cached.equityFlowsSignal };
    return null;
  } catch {
    return null;
  }
}

// Parse the equity flows signal from the analysis text
function parseEquityFlowsSignal(text: string): string | undefined {
  const match = text.match(/^EQUITY_FLOWS_SIGNAL:\s*(.+)$/m);
  if (!match) return undefined;
  const signal = match[1].trim();
  const valid = ["Strong Inflows", "Moderate Inflows", "Mixed", "Moderate Outflows", "Heavy Outflows"];
  return valid.includes(signal) ? signal : undefined;
}

// Save analysis to KV cache
async function saveCachedAnalysis(hash: string, summary: string, equityFlowsSignal?: string) {
  try {
    const redis = await getRedis();
    const cached: CachedAnalysis = {
      hash,
      summary,
      equityFlowsSignal,
      analyzedAt: new Date().toISOString(),
    };
    await redis.set(ATTACHMENT_CACHE_KEY, JSON.stringify(cached));
  } catch (e) {
    console.error("Failed to cache attachment analysis:", e);
  }
}

// Run a separate Claude call to analyze screenshots, then cache the result
async function analyzeAttachments(attachments: AttachmentInput[]): Promise<string> {
  const imageBlocks = buildImageBlocks(attachments);
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    temperature: 0,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `You are a senior portfolio strategist. Analyze these JPM Flows & Liquidity report screenshots. Extract all key data points: fund flow figures ($bn), asset class flows (equity, bond, money market), regional flows, sector positioning, and any notable trends. Be specific with numbers.

IMPORTANT: Your response must start with a single classification line in this exact format:
EQUITY_FLOWS_SIGNAL: <one of: Strong Inflows, Moderate Inflows, Mixed, Moderate Outflows, Heavy Outflows>

Then write a concise 3-5 paragraph summary that a PM can reference daily.`,
          },
          ...imageBlocks,
        ],
      },
    ],
  });
  return message.content[0].type === "text" ? message.content[0].text : "";
}

// Separate vision pass for the S&P Oscillator chart screenshot. The oscillator
// stays manually entered (MarketEdge requires login) and Redis only logs the
// PM's saved values, so a 6-month logged history is sparse at best. When the
// PM uploads a chart screenshot from MarketEdge, this analyzer extracts the
// shape and key levels so Claude can reason about it in the contrarian section
// even when our internal log doesn't yet have enough data points.
async function analyzeOscillatorScreenshot(
  attachments: AttachmentInput[]
): Promise<string> {
  const imageBlocks = buildImageBlocks(attachments);
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    temperature: 0,
    max_tokens: 600,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `You are reading an S&P Oscillator chart from MarketEdge. Extract concrete observations a PM can use:
- Current value (approximate, with sign)
- Recent extremes visible on the chart and roughly when they occurred
- Whether the oscillator is crossing through key levels (-4, -2, 0, +2, +4) and the direction
- Shape over the visible window (rolling over from overbought, basing in oversold, mean-reverting, etc.)

Be concise: 4-6 bullet points, no preamble. Use only what is visible in the chart — do not guess about dates that aren't labeled.`,
          },
          ...imageBlocks,
        ],
      },
    ],
  });
  return message.content[0].type === "text" ? message.content[0].text : "";
}

async function getCachedOscillatorAnalysis(
  hash: string
): Promise<string | null> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(OSCILLATOR_ATTACHMENT_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as { hash: string; summary: string };
    return cached.hash === hash ? cached.summary : null;
  } catch {
    return null;
  }
}

async function saveCachedOscillatorAnalysis(hash: string, summary: string) {
  try {
    const redis = await getRedis();
    await redis.set(
      OSCILLATOR_ATTACHMENT_CACHE_KEY,
      JSON.stringify({
        hash,
        summary,
        analyzedAt: new Date().toISOString(),
      })
    );
  } catch (e) {
    console.error("Failed to cache oscillator screenshot analysis:", e);
  }
}

// Separate vision pass for the Mark Newton (Fundstrat) Technical Presentation
// PDF. Newton publishes a multi-page deck monthly/quarterly covering the
// medium-term technical setup: regime, key SPX/NDX levels, sector leadership,
// breadth, risk-asset relative strength, and event calendar. We parse it once
// (hash-gated) and reuse the structured summary across every subsequent brief
// until the user uploads a new copy. The brief route adds an age-based decay
// note in the prompt so Claude weights stale analyses less heavily.
async function analyzeNewtonTechnical(
  attachments: AttachmentInput[]
): Promise<string> {
  const docBlocks = buildImageBlocks(attachments);
  if (docBlocks.length === 0) return "";
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    temperature: 0,
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `You are reading Mark Newton's (Fundstrat Head of Technical Strategy) monthly/quarterly Technical Presentation PDF. Extract a concise, structured summary a portfolio manager can reference for the next 4-12 weeks.

Cover (only what is clearly stated — do not infer beyond the deck):
- **Overall view**: bullish / neutral / bearish, plus time horizon (e.g. "constructive next 1-2 months, cautious into Q3")
- **SPX key levels**: support and resistance from the deck
- **NDX / sector leadership**: which sectors / themes Newton flags as leading or weakening
- **Breadth & momentum**: any commentary on advance-decline, % of stocks above 200DMA, etc.
- **Key risks / dates**: cycle/seasonal warnings or specific dates highlighted
- **Conviction names** (if any tickers are explicitly called out as top picks or to avoid)

Format as 6-10 tight bullets, no preamble, no markdown headers. Cite specific numbers/dates from the deck wherever possible. If the deck doesn't cover a section, omit it rather than padding.`,
          },
          ...docBlocks,
        ],
      },
    ],
  });
  return message.content[0].type === "text" ? message.content[0].text : "";
}

type CachedNewtonTechnical = { hash: string; summary: string; analyzedAt: string };

async function getCachedNewtonTechnical(
  hash: string
): Promise<CachedNewtonTechnical | null> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(NEWTON_TECHNICAL_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedNewtonTechnical;
    return cached.hash === hash ? cached : null;
  } catch {
    return null;
  }
}

async function saveCachedNewtonTechnical(hash: string, summary: string) {
  try {
    const redis = await getRedis();
    await redis.set(
      NEWTON_TECHNICAL_CACHE_KEY,
      JSON.stringify({
        hash,
        summary,
        analyzedAt: new Date().toISOString(),
      } satisfies CachedNewtonTechnical)
    );
  } catch (e) {
    console.error("Failed to cache Newton technical presentation analysis:", e);
  }
}

// Generic analyst/strategist report vision pass. Same parse-once-then-cache
// pattern as the Newton deck, but the prompt is source-agnostic so it works
// for any research the PM drops in — a strategist note, a sell-side deck, an
// economics piece, etc. Hash-gated: tokens are only spent when the file set
// changes. The brief route adds the same age-based decay note as Newton.
async function analyzeStrategistReports(
  attachments: AttachmentInput[]
): Promise<string> {
  const docBlocks = buildImageBlocks(attachments);
  if (docBlocks.length === 0) return "";
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    temperature: 0,
    max_tokens: 1800,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `You are reading one or more analyst / strategist research reports a portfolio manager has attached (could be a sell-side strategy note, an economics piece, a technical deck, a thematic report — anything). Extract a concise, structured summary the PM can reference over the coming weeks.

For EACH distinct report/author present, cover (only what is clearly stated — do not infer beyond the document):
- **Source & author**: firm / strategist name and the report date if visible
- **Overall view**: bullish / neutral / bearish (or the report's central thesis), plus time horizon
- **Key calls**: specific market/sector/asset-class recommendations, target levels, over/underweights
- **Supporting drivers**: the main reasons given (macro, earnings, valuation, technicals, positioning)
- **Risks / catalysts**: what the author flags as the key risks or upcoming catalysts/dates
- **Named tickers** (if any are explicitly called out as buys/sells/avoids)

If multiple reports are attached, summarize each under its own clearly-labeled mini-section. Format as tight bullets, no preamble, no long markdown headers. Cite specific numbers/dates wherever the report provides them. Omit any section a report doesn't cover rather than padding.`,
          },
          ...docBlocks,
        ],
      },
    ],
  });
  return message.content[0].type === "text" ? message.content[0].text : "";
}

type CachedStrategistReports = { hash: string; summary: string; analyzedAt: string };

async function getCachedStrategistReports(
  hash: string
): Promise<CachedStrategistReports | null> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(STRATEGIST_REPORTS_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedStrategistReports;
    return cached.hash === hash ? cached : null;
  } catch {
    return null;
  }
}

async function saveCachedStrategistReports(hash: string, summary: string) {
  try {
    const redis = await getRedis();
    await redis.set(
      STRATEGIST_REPORTS_CACHE_KEY,
      JSON.stringify({
        hash,
        summary,
        analyzedAt: new Date().toISOString(),
      } satisfies CachedStrategistReports)
    );
  } catch (e) {
    console.error("Failed to cache strategist reports analysis:", e);
  }
}

// Compute dynamic hedge timing score from market data (mirrors HedgingIndicator logic)
function computeHedgeScore(vix: number, termStructure: string, fearGreed: number): number {
  let optimalCount = 0;

  // Put cost: VIX <= 18 → cheap/moderate → optimal
  if (vix <= 18) optimalCount++;

  // VIX context: low vol (<=16) optimal; moderate (<=22) optimal only if not backwardation
  if (vix <= 16) optimalCount++;
  else if (vix <= 22 && termStructure !== "Backwardation") optimalCount++;

  // Sentiment: fearGreed >= 45 → neutral/greedy → complacency → optimal
  if (fearGreed >= 45) optimalCount++;

  // Score: 0 optimal = ~15, 1 = ~40, 2 = ~65, 3 = ~90
  return Math.round((optimalCount / 3) * 80 + 10);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { marketData, holdings } = body;

    if (!marketData) {
      return NextResponse.json(
        { error: "Market data is required" },
        { status: 400 }
      );
    }

    // ── Day-cache short-circuit ────────────────────────────────────────
    // If today's brief already lives in pm:brief and the caller didn't
    // explicitly request a regenerate, return it directly without paying
    // the Anthropic round-trip. Cuts token cost dramatically when the PM
    // (or another team member, on the same Redis) reloads the dashboard
    // mid-day. The "force" flag from the frontend Regenerate button
    // bypasses the cache.
    //
    // Determinism note: with temperature=0 the same input always produces
    // the same output, but day-caching is still worth doing because (a)
    // it avoids the cost, (b) it eliminates round-trip latency on every
    // page load, and (c) the brief is timestamped — readers know "this is
    // today's brief" rather than "this is freshly generated 5 minutes ago
    // and might subtly differ from what my colleague saw at 9am."
    const force = body?.force === true;
    if (!force) {
      try {
        const redis = await getRedis();
        const cachedRaw = await redis.get("pm:brief");
        if (cachedRaw) {
          const cached = JSON.parse(cachedRaw) as { generatedAt?: string; date?: string };
          const todayUTC = new Date().toISOString().slice(0, 10);
          // Match on generatedAt date-prefix (covers ISO timestamps written
          // by either the frontend persist path or this route's prior runs).
          const cachedDay = cached?.generatedAt
            ? cached.generatedAt.slice(0, 10)
            : cached?.date
              ? cached.date.slice(0, 10)
              : null;
          if (cachedDay === todayUTC) {
            console.log("[Brief] day-cache hit — returning today's pm:brief without Anthropic call");
            return NextResponse.json({ ...cached, cached: true });
          }
        }
      } catch (e) {
        // Cache miss / parse error is non-fatal — fall through and generate fresh.
        console.warn("[Brief] day-cache check failed; generating fresh:", e);
      }
    }

    // Attachments may arrive two ways:
    //   (a) Legacy: full `[{section, label, dataUrl}]` inline — heavy; kept
    //       for backward compat but avoid on the client.
    //   (b) Preferred: `attachmentRefs: [{id, section, label}]` — tiny POST
    //       body; the server fetches each image's dataUrl from its per-image
    //       Redis key. Fixes the "The string did not match the expected
    //       pattern" DOMException thrown when the request body got too big
    //       for the platform / fetch encoder.
    let attachments: AttachmentInput[] = Array.isArray(body.attachments) ? body.attachments : [];
    if (Array.isArray(body.attachmentRefs) && body.attachmentRefs.length > 0) {
      try {
        const redis = await getRedis();
        const fetched = await Promise.all(
          (body.attachmentRefs as { id: string; section: string; label: string }[]).map(async (ref) => {
            try {
              // Blob first (attachments now live there); fall back to any
              // legacy Redis copy until the migration runs.
              let dataUrl = await getDataUrl(`attachments/${ref.id}`);
              if (!dataUrl) dataUrl = await redis.get(`pm:attachment:${ref.id}`);
              if (!dataUrl || typeof dataUrl !== "string") return null;
              return { section: ref.section, label: ref.label, dataUrl } as AttachmentInput;
            } catch {
              return null;
            }
          })
        );
        attachments = fetched.filter((x): x is AttachmentInput => x !== null);
      } catch (e) {
        console.error("Failed to hydrate attachmentRefs from Blob/Redis:", e);
        // Fall through with whatever was in body.attachments (possibly empty).
      }
    }

    type HoldingInput = {
      ticker: string;
      bucket: string;
      sector: string;
      instrumentType?: string;
      scores?: Record<string, number>;
      weights: { portfolio: number };
      riskAlert?: { level: string; summary: string; dangerCount: number; cautionCount: number; signals?: { name: string; status: string; detail: string }[] };
      // MarketEdge ("ChartScout") technical read. Used to surface
      // deteriorating-Long warnings in the brief's risk context.
      marketEdge?: {
        opinion?: "long" | "neutral" | "avoid";
        opinionScore?: number;
        powerRating?: number;
        opinionDate?: string;
      };
    };

    const holdingsSummary = holdings
      ? (holdings as HoldingInput[])
          .map((h) => {
              const isEtfOrFund = h.instrumentType === "etf" || h.instrumentType === "mutual-fund";
              const typeLabel = h.instrumentType === "etf" ? "ETF" : h.instrumentType === "mutual-fund" ? "Fund" : null;

              // ETFs and mutual funds are not scored in our system — omit score
              // to prevent Claude from interpreting 0/40 as a weakness signal.
              // Individual stocks are all equally weighted in the portfolio — omit
              // the legacy weights.portfolio field to prevent Claude from making
              // incorrect weight-based conclusions (e.g. "0% weight = not held").
              // The bucket field (Portfolio/Watchlist) is the real indicator.
              let line: string;
              if (isEtfOrFund) {
                line = `${h.ticker} (${typeLabel}, ${h.bucket}, ${h.sector}, ${h.weights.portfolio}% weight)`;
              } else {
                const rawScore = h.scores ? Object.values(h.scores).reduce((a: number, b: number) => a + b, 0) : 0;
                line = `${h.ticker} (${h.bucket}, ${h.sector}, score ${rawScore}/40)`;
              }

              // Risk alerts apply to all instrument types (technicals are universal)
              if (h.riskAlert && h.riskAlert.level !== "clear") {
                const dangerSignals = h.riskAlert.signals?.filter(s => s.status === "danger").map(s => s.name) || [];
                const cautionSignals = h.riskAlert.signals?.filter(s => s.status === "caution").map(s => s.name) || [];
                line += ` [RISK: ${h.riskAlert.level.toUpperCase()} — ${h.riskAlert.summary}`;
                if (dangerSignals.length > 0) line += ` | Danger: ${dangerSignals.join(", ")}`;
                if (cautionSignals.length > 0) line += ` | Caution: ${cautionSignals.join(", ")}`;
                line += `]`;
              }
              // MarketEdge deteriorating-Long / reversal-Avoid early warning.
              // Inline so Claude can reference the specific name + score in
              // the risk callout. Held Long with score ≤ −3 = winner's thesis
              // cracking; Avoid with score ≥ +3 = reversal watch.
              if (h.marketEdge) {
                const me = h.marketEdge;
                if (me.opinion === "long" && typeof me.opinionScore === "number" && me.opinionScore <= -3) {
                  line += ` [MARKETEDGE: deteriorating Long, Opinion Score ${me.opinionScore}${typeof me.powerRating === "number" ? `, Power Rating ${me.powerRating}` : ""} — technicals breaking down since ${me.opinionDate ?? "the opinion date"}]`;
                } else if (me.opinion === "avoid" && typeof me.opinionScore === "number" && me.opinionScore >= 3) {
                  line += ` [MARKETEDGE: reversal watch, Opinion Score ${me.opinionScore}${typeof me.powerRating === "number" ? `, Power Rating ${me.powerRating}` : ""}]`;
                }
              }
              return line;
            }
          )
          .join("\n")
      : "No holdings provided";

    // ── Portfolio positioning (sector exposure of the equal-weight book) ───
    // The book is equal-weight ("own or don't own"), so its sector TILT = how
    // many Portfolio names sit in each sector. Aggregate it so the brief can
    // tie the macro / rotation read to the book's ACTUAL concentration rather
    // than talk about markets in the abstract (e.g. "XLK/XLU rolling and you're
    // heaviest in Tech", or "a leading sector you have zero exposure to").
    const portfolioPositioning = (() => {
      if (!holdings) return "";
      const port = (holdings as HoldingInput[]).filter((h) => h.bucket === "Portfolio");
      if (port.length === 0) return "";
      const bySector = new Map<string, number>();
      for (const h of port) {
        const s = (h.sector || "").trim() || "Unclassified";
        bySector.set(s, (bySector.get(s) ?? 0) + 1);
      }
      const total = port.length;
      const rows = [...bySector.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([sector, n]) => `- ${sector}: ${n} name${n === 1 ? "" : "s"} (${Math.round((n / total) * 100)}% of the book)`);
      return `

PORTFOLIO POSITIONING (equal-weight book — sector tilt = share of the ${total} owned names; we think "own or don't own", never position sizing):
${rows.join("\n")}`;
    })();

    // Fetch live sector ETF data, forward-looking data, strategist history,
    // and research state in parallel. Each is wrapped in try/catch so a
    // single failure never blocks the whole brief — we just degrade.
    const loadResearch = async (): Promise<ResearchState> => {
      try {
        const redis = await getRedis();
        const raw = await redis.get("pm:research");
        if (!raw) return defaultResearch;
        return { ...defaultResearch, ...JSON.parse(raw) };
      } catch {
        return defaultResearch;
      }
    };

    // Extract the manual breadth override from the caller's marketData so
    // the forward-looking fetch can use today's PM-entered values instead
    // of (no longer running) the Finviz/Yahoo scrape. Shape matches
    // MarketData.breadthOverride in app/lib/types.ts.
    const manualBreadth = (marketData as { breadthOverride?: { date?: string; above200?: number; above50?: number } })
      ?.breadthOverride;

    const [sectorPerf, forwardData, strategistHistory, research, hedgingCostsBlock, marketRegime] =
      await Promise.all([
        fetchSectorPerformance(),
        fetchForwardLookingData(manualBreadth).catch((e) => {
          console.error("Forward-looking fetch failed:", e);
          return null as ForwardLookingData | null;
        }),
        loadStrategistHistory().catch((e) => {
          console.error("Strategist history load failed:", e);
          return { newton: [], lee: [] } as StrategistHistory;
        }),
        loadResearch(),
        buildHedgingCostsBlock().catch((e) => {
          console.error("Hedging costs block failed:", e);
          return "";
        }),
        // pm:market-regime is a best-effort cached snapshot. Missing →
        // regime block is simply omitted from the prompt; brief still
        // generates from the forward-looking signals.
        readMarketRegime(),
      ]);

    // ── Catalyst Calendar (Phase 01) ──────────────────────────────────────
    // Forward event calendar: earnings dates off pm:stocks (refresh-data
    // already stores them) + FRED econ releases + FOMC. Best-effort — any
    // failure just omits the block, never blocks the brief. The structured
    // result is also returned to the client so the UI can render the event
    // strip deterministically alongside the model's catalystWatch prose.
    let catalystCalendar: CatalystCalendar | null = null;
    try {
      const calRedis = await getRedis();
      const rawStocks = await calRedis.get("pm:stocks");
      const parsedStocks = rawStocks ? JSON.parse(rawStocks) : [];
      const calStocks = Array.isArray(parsedStocks)
        ? (parsedStocks as Array<{ ticker?: string; bucket?: string; earningsDate?: string }>)
        : [];
      catalystCalendar = await buildCatalystCalendar(calStocks, 14);
    } catch (e) {
      console.error("Catalyst calendar build failed:", e);
    }
    const catalystBlock =
      catalystCalendar && catalystCalendar.events.length > 0
        ? `\n\nCATALYST CALENDAR (scheduled events in the next ${catalystCalendar.windowDays} days — the SOURCE for catalystWatch; also make the three horizon views forward-referencing where relevant):\n${catalystCalendar.events
            .map(
              (e) =>
                `- ${e.date} · ${e.title}${e.kind === "earnings" && e.bucket ? ` (${e.bucket})` : ""}${e.importance === "high" ? " [HIGH]" : ""}`,
            )
            .join("\n")}`
        : "\n\nCATALYST CALENDAR: no scheduled earnings/econ/FOMC events in the look-ahead window (or the calendar was unavailable this run) — return an empty string for catalystWatch.";

    const fmt = (p: ForwardPoint | undefined, unit = ""): string => {
      if (!p || p.value == null) {
        return p?.note ? `N/A (${p.note})` : "N/A";
      }
      return `${p.value}${unit}`;
    };
    const delta = (p: ForwardPoint | undefined, unit = ""): string => {
      if (!p || p.value == null || p.previous == null) return "";
      const d = Number(p.value) - Number(p.previous);
      if (isNaN(d)) return "";
      const sign = d >= 0 ? "+" : "";
      return ` (wk/wk ${sign}${d.toFixed(unit === "bps" ? 0 : 2)}${unit})`;
    };
    // Breadth tiles compare two percentages, so the delta is in percentage
    // points. The history may not yet contain an entry for the target lag
    // (fresh Redis cache), in which case the ForwardPoint exposes a value
    // but no `previous` — we emit an explicit "(mo/mo n/a)" token so the
    // model doesn't infer a bogus zero.
    const breadthDelta = (
      p: ForwardPoint | undefined,
      period: "wk/wk" | "mo/mo"
    ): string => {
      if (!p || p.value == null) return "";
      if (p.previous == null) return ` (${period} n/a)`;
      const d = Number(p.value) - Number(p.previous);
      if (isNaN(d)) return "";
      const sign = d >= 0 ? "+" : "";
      return ` (${period} ${sign}${d.toFixed(1)}pp)`;
    };
    // Render the trajectory + multi-horizon delta context for any sentiment
    // ForwardPoint that has a `trend` block. Falls back to an empty string if
    // the point doesn't have one.
    //
    // Intentionally omits the "Nth percentile of trailing range" phrase that
    // used to live here. Our rolling window is only as old as the app's own
    // logging, which skews the percentile badly (e.g. F&G ranges that only
    // span 40-70 make "p95" look meaningful when it isn't). Level-vs-history
    // commentary is now the model's job using its trained knowledge of each
    // indicator's true multi-decade range — see the IMPORTANT note below.
    const trendBlurb = (p: ForwardPoint | undefined): string => {
      if (!p || !p.trend) return "";
      const t = p.trend;
      const parts: string[] = [];
      const fmtDelta = (d: number | null | undefined): string | null => {
        if (d == null) return null;
        const sign = d >= 0 ? "+" : "";
        return `${sign}${d}`;
      };
      const d1w = fmtDelta(t.delta1w);
      const d1m = fmtDelta(t.delta1m);
      const d3m = fmtDelta(t.delta3m);
      const deltas: string[] = [];
      if (d1w != null) deltas.push(`1w ${d1w}`);
      if (d1m != null) deltas.push(`1m ${d1m}`);
      if (d3m != null) deltas.push(`3m ${d3m}`);
      parts.push(t.trajectory);
      if (deltas.length > 0) parts.push(deltas.join(", "));
      return ` — ${parts.join("; ")}`;
    };

    const pctDelta = (
      p: ForwardPoint | undefined
    ): { str: string; value: number | null } => {
      if (!p || p.value == null || p.previous == null) {
        return { str: "", value: null };
      }
      const cur = Number(p.value);
      const prev = Number(p.previous);
      if (prev === 0 || isNaN(cur) || isNaN(prev))
        return { str: "", value: null };
      const dPct = ((cur - prev) / prev) * 100;
      const sign = dPct >= 0 ? "+" : "";
      return { str: ` (wk/wk ${sign}${dPct.toFixed(1)}%)`, value: dPct };
    };

    // ── Deterministic regime pre-classification ─────────────────────────────
    const vixWeekPctObj = forwardData ? pctDelta(forwardData.vixWeek) : { str: "", value: null };
    const hyOasDeltaBps =
      forwardData && forwardData.hyOasTrend.value != null && forwardData.hyOasTrend.previous != null
        ? Number(forwardData.hyOasTrend.value) - Number(forwardData.hyOasTrend.previous)
        : null;
    // Pull regime inputs from forward-looking data (auto). Fall back to neutral
     // defaults if forward fetch failed entirely so the brief still generates.
    const fwdVix =
      forwardData && typeof forwardData.vixWeek.value === "number"
        ? forwardData.vixWeek.value
        : null;
    const fwdHyOas =
      forwardData && typeof forwardData.hyOasTrend.value === "number"
        ? forwardData.hyOasTrend.value
        : null;
    const fwdBreadth =
      forwardData && typeof forwardData.breadth200Wk?.value === "number"
        ? forwardData.breadth200Wk.value
        : null;
    const classification = classifyRegime({
      vix: fwdVix ?? 20,
      vixWeekDeltaPct: vixWeekPctObj.value,
      hyOas: fwdHyOas ?? 350,
      hyOasWeekDeltaBps: hyOasDeltaBps,
      spxYtd:
        forwardData && typeof forwardData.spxYtd.value === "number"
          ? forwardData.spxYtd.value
          : null,
      spxWeek:
        forwardData && typeof forwardData.spxWeek.value === "number"
          ? forwardData.spxWeek.value
          : null,
      breadth: fwdBreadth ?? 50,
      curve10y2y:
        forwardData && typeof forwardData.curve10y2y.value === "number"
          ? forwardData.curve10y2y.value
          : null,
    });

    const forwardBlock = forwardData
      ? `\n\nForward-Looking Data (use for Forward View and tone calibration):
- S&P 500 YTD: ${fmt(forwardData.spxYtd, "%")}
- S&P 500 Week: ${fmt(forwardData.spxWeek, "%")}
- SPY Forward P/E: ${fmt(forwardData.spyForwardPE)}
- SPY Trailing P/E: ${fmt(forwardData.spyTrailingPE)}
- Implied 1Y EPS Growth (P/E compression): ${fmt(forwardData.impliedEpsGrowth, "%")}
- Est 3-5Y EPS Growth (SSGA/FactSet analyst consensus): ${fmt(forwardData.eps35Growth, "%")}
- 10Y Treasury: ${fmt(forwardData.yield10y, "%")}
- 2Y Treasury: ${fmt(forwardData.yield2y, "%")}
- 3M T-Bill: ${fmt(forwardData.yield3m, "%")}
- 10Y-2Y Curve: ${fmt(forwardData.curve10y2y, "bps")}
- 10Y-3M Curve: ${fmt(forwardData.curve10y3m, "bps")}
- HY OAS Trend: ${fmt(forwardData.hyOasTrend, "bps")}${delta(forwardData.hyOasTrend, "bps")}
- IG OAS Trend: ${fmt(forwardData.igOasTrend, "bps")}${delta(forwardData.igOasTrend, "bps")}
- VIX Week: ${fmt(forwardData.vixWeek)}${vixWeekPctObj.str}
- MOVE Week: ${fmt(forwardData.moveWeek)}${pctDelta(forwardData.moveWeek).str}
- S&P 500 % >200DMA: ${fmt(forwardData.breadth200Wk, "%")}${breadthDelta(
          forwardData.breadth200Wk,
          "wk/wk"
        )}${breadthDelta(forwardData.breadth200Mo, "mo/mo")}
- S&P 500 % >50DMA: ${fmt(forwardData.breadth50Wk, "%")}${breadthDelta(
          forwardData.breadth50Wk,
          "wk/wk"
        )}`
      : "\n\nForward-looking data unavailable for this run — fall back to the current snapshot indicators below.";

    // Deterministic cross-asset / breadth regime from pm:market-regime.
    // This is strictly context — Claude should treat it as additional
    // confirmation signal for marketRegime, NOT as an override of the
    // pre-classified regime above (which is computed from the macro
    // inputs Claude is asked to cite).
    const regimeBlock = marketRegime
      ? (() => {
          const r = marketRegime;
          const fmtPct = (v: number | null | undefined): string =>
            v == null || !isFinite(v) ? "N/A" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
          const ratio = (tag: string, x: { distancePct: number; change20dPct: number; direction: string } | null): string =>
            x ? `${tag}: ${x.direction} (${x.distancePct >= 0 ? "+" : ""}${x.distancePct.toFixed(1)}% vs 50D, 20d ${x.change20dPct >= 0 ? "+" : ""}${x.change20dPct.toFixed(2)}%)` : `${tag}: n/a`;
          const lines: string[] = [];
          if (r.spx10m) {
            lines.push(
              `- SPX 10-Month Trend: ${r.spx10m.direction} — price ${r.spx10m.distancePct >= 0 ? "+" : ""}${r.spx10m.distancePct.toFixed(1)}% vs 10M MA`
            );
          }
          if (r.breadth) lines.push(`- ${ratio("RSP/SPY Breadth", r.breadth)}`);
          if (r.sectorRatios.xlyXlp) lines.push(`- ${ratio("XLY/XLP", r.sectorRatios.xlyXlp)}`);
          if (r.sectorRatios.xlkXlu) lines.push(`- ${ratio("XLK/XLU", r.sectorRatios.xlkXlu)}`);
          if (r.sectorRatios.mtumUsmv) lines.push(`- ${ratio("MTUM/USMV", r.sectorRatios.mtumUsmv)}`);
          if (r.crossAsset.vix) lines.push(`- VIX Level: ${r.crossAsset.vix.direction} (${r.crossAsset.vix.price.toFixed(1)})`);
          // ISM PMI feeds two named signals: level (cyclical horizon) and
          // 3M trend (structural). Crossover events are flagged because
          // they historically lead sector leadership shifts by 1-2 months.
          if (r.ismPmi) {
            const cross = r.ismPmi.crossedFiftyThisMonth
              ? r.ismPmi.crossDirection === "below-to-above"
                ? " — CROSSED ABOVE 50 this month"
                : " — CROSSED BELOW 50 this month"
              : "";
            lines.push(
              `- ISM PMI: ${r.ismPmi.level.toFixed(1)} (prior ${r.ismPmi.prior.toFixed(1)}, 3M ${r.ismPmi.change3mAbs >= 0 ? "+" : ""}${r.ismPmi.change3mAbs.toFixed(1)}pt)${cross}`
            );
          }
          const crossParts: string[] = [];
          if (r.crossAsset.dxy) crossParts.push(`DXY 20d ${fmtPct(r.crossAsset.dxy.change20dPct)}`);
          if (r.crossAsset.tnx) crossParts.push(`10Y ${r.crossAsset.tnx.price.toFixed(2)}% (20d ${fmtPct(r.crossAsset.tnx.change20dPct)})`);
          if (r.crossAsset.oil) crossParts.push(`WTI ${fmtPct(r.crossAsset.oil.change20dPct)}`);
          if (crossParts.length > 0) lines.push(`- Cross-Asset Context: ${crossParts.join(" · ")}`);
          const globalParts: string[] = [];
          if (r.global.stoxx) globalParts.push(`STOXX 20d ${fmtPct(r.global.stoxx.change20dPct)}`);
          if (r.global.nikkei) globalParts.push(`Nikkei 20d ${fmtPct(r.global.nikkei.change20dPct)}`);
          if (globalParts.length > 0) lines.push(`- Global Context: ${globalParts.join(" · ")}`);
          // Per-horizon rollup — drives the new tacticalView / cyclicalView
          // / structuralView fields. Empty buckets render as "no signals"
          // so Claude knows to lean qualitative for that horizon rather
          // than hallucinate a quantitative read.
          let horizonsBlock = "";
          if (r.horizons) {
            const h = r.horizons;
            const hLine = (id: "tactical" | "cyclical" | "structural", label: string) => {
              const b = h.byHorizon[id];
              if (b.total === 0) return `- ${label}: no signals available`;
              const sigs = b.signals.map((s) => `${s.name} ${s.direction}`).join(", ");
              const score = isFinite(b.score) ? (b.score >= 0 ? "+" : "") + b.score.toFixed(2) : "n/a";
              return `- ${label}: ${b.label_} (${b.riskOn}-${b.riskOff}/${b.total}, score ${score}) — ${sigs}`;
            };
            const weighted = isFinite(h.weightedScore)
              ? `${h.weightedLabel} (weighted score ${h.weightedScore >= 0 ? "+" : ""}${h.weightedScore.toFixed(2)})`
              : "n/a";
            horizonsBlock = `

Multi-Horizon Rollup (1-3M tactical 50% / 3-6M cyclical 30% / 6-12M structural 20%):
${hLine("tactical", "Tactical (1-3M)")}
${hLine("cyclical", "Cyclical (3-6M)")}
${hLine("structural", "Structural (6-12M)")}
- Weighted Overall: ${weighted}

Use this rollup as the SCAFFOLDING for tacticalView, cyclicalView, and structuralView. Each horizon view should be 2-3 sentences and reference at least one of its driving signals by name. The horizons are intentionally interlocking: tactical sets the immediate posture, cyclical confirms or contests the rotation, structural is the "don't-fight-the-tape" overlay. If two horizons disagree, name the disagreement explicitly — the PM trades on the tactical lens but should know when the longer windows are pulling the other way.`;
          }
          return `\n\nDeterministic Regime Snapshot (from pm:market-regime, computed ${r.computedAt}):
Composite: ${r.composite.label} (${r.composite.score}/${r.composite.total} risk-on signals)
${lines.join("\n")}${horizonsBlock}

Use this as additional confirmation for your marketRegime call, your breadthAnalysis (sector leadership rotation), and your three horizon views. If the deterministic label conflicts with the pre-classified macro regime above, briefly reconcile in bottomLine — do not ignore either.`;
        })()
      : "";

    // Inject today's date explicitly so Claude cannot drift to training-data
    // anchored events. This is enforced by the DATE ANCHORING section of the
    // system prompt.
    const today = new Date();
    const todayLong = today.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const todayIso = today.toISOString().slice(0, 10);

    // ── Prior brief (continuity / "what changed") ──────────────────────────
    // pm:brief holds the LAST generated brief (the client persists the new one
    // only AFTER this route returns), so at generation time it's the previous
    // brief. Feed a compact digest so the model can lead with what has CHANGED
    // day-to-day (regime flip, hedging/deploy call change, a new risk) instead
    // of resetting from scratch. Read-only; best-effort (first-ever run has none).
    let priorBriefContext = "";
    try {
      const priorRedis = await getRedis();
      const priorRaw = await priorRedis.get("pm:brief");
      if (priorRaw) {
        const prior = JSON.parse(priorRaw) as {
          marketRegime?: string; regimeVerdict?: string; bottomLine?: string;
          hedgingCall?: { action?: string }; cashDeploymentCall?: { action?: string; score?: number };
          date?: string; generatedAt?: string;
        };
        if (prior.bottomLine || prior.marketRegime) {
          const priorDate = prior.date || (prior.generatedAt ? prior.generatedAt.slice(0, 10) : "");
          priorBriefContext = `

PRIOR BRIEF (the last one generated${priorDate ? ` — ${priorDate}` : ""}) — for CONTINUITY ONLY. Use it to identify what has CHANGED since; do NOT repeat it:
- Prior regime: ${prior.marketRegime ?? "n/a"}${prior.regimeVerdict ? ` — "${prior.regimeVerdict}"` : ""}
- Prior bottom line: ${prior.bottomLine ?? "n/a"}
- Prior hedging call: ${prior.hedgingCall?.action ?? "n/a"}
- Prior cash-deployment call: ${prior.cashDeploymentCall?.action ?? "n/a"}${typeof prior.cashDeploymentCall?.score === "number" ? ` (${prior.cashDeploymentCall.score}/100)` : ""}`;
        }
      }
    } catch { /* no readable prior brief — whatChanged just leads qualitatively */ }

    // Build content blocks: text prompt + any image attachments
    const textContent = `Generate the morning brief for today.

TODAY'S DATE: ${todayLong} (${todayIso}). This is the authoritative date for this brief. Do NOT reference macro events older than 30 days before this date — including "Liberation Day" (April 2025), older FOMC meetings, or past CPI prints — even if they appear in attached screenshots or you remember them from training data. Every "recent move" you cite must come from the numerical data below.${priorBriefContext}

Here are the current market indicators:

Composite Signal: ${marketData.compositeSignal}
Conviction: ${marketData.conviction}

Pre-classified Regime: ${classification.regime} (score ${classification.score})
Regime drivers: ${classification.signals.length > 0 ? classification.signals.join("; ") : "mixed / no dominant signal"}
IMPORTANT: Your marketRegime output MUST equal "${classification.regime}" unless the data below clearly contradicts it (in which case briefly note the contradiction in bottomLine).${forwardBlock}${regimeBlock}${catalystBlock}

Volatility Structure:
- VIX Term Structure: ${marketData.termStructure}

Contrarian Indicators (ALL interpreted INVERSELY — oversold/fearful = BULLISH, overbought/greedy = BEARISH):
- S&P Oscillator: ${
      forwardData?.spOscillator?.value ?? marketData.spOscillator
    }${trendBlurb(forwardData?.spOscillator)} — negative = oversold = BULLISH, positive = overbought = BEARISH
- Put/Call Ratio (Total): ${
      forwardData?.putCallRatio?.value ?? marketData.putCall
    }${trendBlurb(forwardData?.putCallRatio)} — >1.0 = excessive fear = BULLISH, <0.7 = complacency = BEARISH
- Fear & Greed Index: ${
      forwardData?.fearGreed?.value ?? marketData.fearGreed
    }/100${trendBlurb(forwardData?.fearGreed)} — <25 = extreme fear = BULLISH, >75 = extreme greed = BEARISH
- AAII Bull-Bear Spread: ${
      forwardData?.aaiiBullBear?.value ?? marketData.aaiiBullBear
    }%${trendBlurb(forwardData?.aaiiBullBear)} — <-20 = excessive bearishness = BULLISH, >+30 = excessive bullishness = BEARISH

IMPORTANT — interpret trajectory: a value at an extreme that is REVERSING (e.g. F&G at 22 but rising) is much weaker as a contrarian signal than the same value still moving deeper into the extreme. Use the trajectory descriptors above plus your own knowledge of each indicator's true multi-decade historical range (NOT any short rolling window) when forming the contrarianAnalysis — e.g. VIX typically sits 12-20 in quiet markets and spikes to 30+ in stress, AAII Bull-Bear spreads beyond ±25 are historically extreme, CBOE put/call typically oscillates 0.7-1.2 with >1.2 marking fear washouts, CNN F&G treats <25 as extreme fear and >75 as extreme greed. Characterize the level as elevated / subdued / extreme against THAT long-run backdrop, not against the few months of local data we happen to have cached.

Hedge Timing Score: ${computeHedgeScore(fwdVix ?? 20, marketData.termStructure ?? "Contango", forwardData?.fearGreed?.value ?? marketData.fearGreed ?? 50)}/100 (dynamically computed from VIX, term structure, and sentiment)
${hedgingCostsBlock ? `\n${hedgingCostsBlock}\n\nWhen writing hedgingAnalysis, cite at least one specific 5–10% OTM premium from the table above (e.g. "the 3-month 7% OTM SPY put costs X% of spot") and reference the week-over-week or month-over-month direction of OTM premiums when available. Anchor claims like "tail puts are cheap" or "protection is expensive" to these actual dollar/percent figures at the OTM strikes rather than generalizing from VIX alone. Default strike framing is 5–10% OTM; only quote ATM premiums when explicitly recommending an ATM hedge (rare exception case).` : ""}

Live Sector ETF Performance (from Yahoo Finance — use this for sector rotation analysis):
${sectorPerf.text}
${(() => {
  // Build strategist notes block from the rolling 30-day Redis history.
  // Today's full note is labeled "TODAY"; prior days are labeled by date
  // so Claude can track how a strategist's view evolves across the past
  // month (e.g. Newton flags a key support level for multiple consecutive
  // sessions, or Lee shifts from cautious to outright bullish over a
  // longer window). 30-day window surfaces both short-term repetition
  // and longer-arc shifts.
  const formatEntries = (
    entries: { date: string; text: string }[],
    name: string,
    title: string,
    todayTiming?: string
  ): string | null => {
    if (entries.length === 0) return null;
    const today = new Date().toISOString().slice(0, 10);
    const lines = entries.map((e) => {
      const label = e.date === today ? (todayTiming ? `TODAY · ${todayTiming}` : "TODAY") : e.date;
      return `[${label}] ${e.text}`;
    });
    return `--- ${name} (${title}) — trailing ${entries.length} day${entries.length > 1 ? "s" : ""} ---\n${lines.join("\n\n")}`;
  };
  // Manual "information horizon" tag the PM set on TODAY's note (see
  // MarketData.strategistNotes.*Timing). Surfaced inline on the TODAY line so
  // the model knows whether the read has seen the overnight move.
  const sn = (marketData as {
    strategistNotes?: {
      newton?: string; newtonDate?: string;
      lee?: string; leeDate?: string;
      newtonTiming?: "prior-close" | "pre-market";
      leeTiming?: "prior-close" | "pre-market";
    };
  }).strategistNotes;
  const timingLabel = (t?: "prior-close" | "pre-market"): string | undefined =>
    t === "prior-close" ? "as of prior close (has NOT seen the overnight / pre-market move)"
      : t === "pre-market" ? "pre-market today (already digests the overnight tape)"
        : undefined;
  // Overlay TODAY's note straight from the request body so it's guaranteed in
  // the brief even if the async history append (fired by /api/kv/market on
  // save) hasn't landed yet — the Redis history still supplies prior days.
  // The body text always wins for its own date (it's the freshest copy).
  const todayIso2 = new Date().toISOString().slice(0, 10);
  const withTodayNote = (
    hist: { date: string; text: string }[],
    todayText?: string,
    todayDate?: string,
  ): { date: string; text: string }[] => {
    const t = (todayText ?? "").trim();
    if (!t) return hist;
    const d = todayDate || todayIso2;
    const idx = hist.findIndex((e) => e.date === d);
    if (idx >= 0) {
      if (hist[idx].text === t) return hist;
      const copy = hist.slice();
      copy[idx] = { date: d, text: t };
      return copy;
    }
    return [...hist, { date: d, text: t }];
  };
  const blocks: string[] = [];
  const nb = formatEntries(
    withTodayNote(strategistHistory.newton, sn?.newton, sn?.newtonDate),
    "Mark Newton",
    "Fundstrat Technical Strategy",
    timingLabel(sn?.newtonTiming)
  );
  const lb = formatEntries(
    withTodayNote(strategistHistory.lee, sn?.lee, sn?.leeDate),
    "Tom Lee",
    "Fundstrat Head of Research",
    timingLabel(sn?.leeTiming)
  );
  if (nb) blocks.push(nb);
  if (lb) blocks.push(lb);
  if (blocks.length === 0) return "";
  return `

STRATEGIST NOTES — The PM follows these Fundstrat strategists. Notes below contain the trailing 30 days where available. Note: Tom Lee primarily communicates via video, so his written notes will often be absent — that is normal, not an error. When Lee notes ARE present, treat them like Newton's. When they are absent, rely on his Focus Areas (in the FUNDSTRAT RESEARCH CONTEXT section) as background context instead.

Key instructions:
1. Track THEMES ACROSS DAYS — if a strategist keeps mentioning the same level, catalyst, or risk multiple sessions over the 30-day window, that consistency matters more than a one-off mention. Call it out (e.g. "Newton has flagged 5,200 support across eight sessions in the last month"). Persistent themes carry more weight than recent ones in isolation. Also watch for STANCE EVOLUTION over the longer window — a gradual shift from cautious to constructive over 3 weeks is a meaningful signal that's invisible in a 2-week view.
2. Note SHIFTS in stance — if a strategist changes their view from one day to the next, that transition is significant.
3. Items mentioned one day but NOT the next may still be relevant — do not discard them just because the latest note omits them. Use judgment.
4. PAY ATTENTION TO DATES — if the most recent note is labeled with a past date (not TODAY), it means no report was issued since then. Treat it as still-relevant context but note the age when citing it (e.g. "Newton's most recent note from April 10 flagged…").
5. Attribute insights by name (e.g. "Newton's technical work flags…").
6. Do NOT regurgitate full text — distill the 2-3 most actionable points and weave them into compositeAnalysis, contrarianAnalysis, the three horizon views, hedgingAnalysis, etc. (flowsAnalysis was retired; if a strategist piece flags a flow extreme, fold it into contrarianAnalysis.)
7. If a strategist's view conflicts with the quantitative data, note the tension explicitly.
8. INFORMATION HORIZON — a TODAY line may carry a timing tag ("as of prior close" or "pre-market today"). A "prior close" note does NOT yet reflect any overnight / pre-market move. On a MATERIAL overnight gap (large S&P futures move, a significant overnight headline), down-weight a "prior close" read for the tactical and cash-deployment calls — its technical levels predate the gap — and lean on the fresher "pre-market" read; say so in the reason. When two strategists conflict and one is "pre-market" while the other is "prior close", prefer the newer horizon. On a quiet/gapless morning the tag doesn't matter — treat the notes normally. Untagged notes: no timing assumption.

${blocks.join("\n\n")}`;
})()}

${(() => {
  // ── Fundstrat research context ──
  // Pull in Newton's uptick list, sector views, and Lee's focus areas
  // from the Research tab. The uptick tickers are listed so Claude can
  // cross-reference them with Newton's daily report — if a stock Newton
  // mentions today also appears on his uptick list, it's a double signal.
  const blocks: string[] = [];

  // Newton uptick tickers
  const uptickTickers = (research.newtonUpticks ?? []).map((u) => u.ticker);
  if (uptickTickers.length > 0) {
    blocks.push(
      `Newton's Active Uptick List (${uptickTickers.length} names): ${uptickTickers.join(", ")}\n` +
      `IMPORTANT: When Newton mentions any of these tickers in his daily report above, flag it explicitly — a stock on the uptick list that is also called out in the daily note is a DOUBLE technical signal and should be highlighted in compositeAnalysis or forwardActions.`
    );
  }

  // Newton sector views
  const sectorViews = research.newtonSectors ?? [];
  const ow = sectorViews.filter((s) => s.view === "overweight").map((s) => s.sector);
  const uw = sectorViews.filter((s) => s.view === "underweight").map((s) => s.sector);
  if (ow.length > 0 || uw.length > 0) {
    const parts: string[] = [];
    if (ow.length > 0) parts.push(`Overweight: ${ow.join(", ")}`);
    if (uw.length > 0) parts.push(`Underweight: ${uw.join(", ")}`);
    blocks.push(`Newton's Sector Views: ${parts.join(" | ")}\nUse these to inform sectorRotation analysis — if today's sector ETF performance aligns with Newton's OW/UW views, reinforce the signal; if it contradicts, note the tension.`);
  }

  // Lee sector views — same format as Newton's
  const leeSectorViews = research.leeSectors ?? [];
  const leeOw = leeSectorViews.filter((s) => s.view === "overweight").map((s) => s.sector);
  const leeUw = leeSectorViews.filter((s) => s.view === "underweight").map((s) => s.sector);
  if (leeOw.length > 0 || leeUw.length > 0) {
    const parts: string[] = [];
    if (leeOw.length > 0) parts.push(`Overweight: ${leeOw.join(", ")}`);
    if (leeUw.length > 0) parts.push(`Underweight: ${leeUw.join(", ")}`);
    blocks.push(`Lee's Sector Views: ${parts.join(" | ")}\nUse these alongside Newton's sector views to inform sectorRotation analysis — when both strategists agree on a sector tilt, it's a stronger signal. When they diverge, note the tension.`);
  }

  // Lee focus areas — background context the PM wants Claude to internalize.
  // These don't need to be explicitly mentioned every day, but should inform
  // the analysis when they naturally intersect with today's data.
  const leeAreas = (research.leeFocusAreas ?? []).map((a) => a.label);
  if (leeAreas.length > 0) {
    blocks.push(
      `Tom Lee's Current Focus Areas (background context): ${leeAreas.join(", ")}\n` +
      `These are the themes Lee is currently emphasizing. You do NOT need to mention these every day — only surface them when they naturally intersect with today's data or sector performance. They serve as background lens, not a checklist. Lee rarely publishes written notes, so these focus areas are often the primary signal of his current view.`
    );
  }

  if (blocks.length === 0) return "";
  return `

FUNDSTRAT RESEARCH CONTEXT (from the PM's Research tab — these persist across days and only change when the PM updates them):
${blocks.join("\n\n")}`;
})()}

Current Portfolio Holdings: ${holdingsSummary}${portfolioPositioning}`;

    // JPM Flows section was retired in 2026-05 — flows are inherently
    // backward-looking and contrarianAnalysis already covers
    // sentiment/positioning extremes. The S&P oscillator screenshot
    // path stays since it does feed contrarianAnalysis.
    const allAtts: AttachmentInput[] = attachments || [];
    const oscAtts = allAtts.filter((a) => a.section === "spOscillator");
    const newtonTechAtts = allAtts.filter((a) => a.section === "newtonTechnical");
    const strategistReportAtts = allAtts.filter((a) => a.section === "strategistReports");

    let oscContext = "";
    let newtonTechContext = "";
    let strategistReportsContext = "";

    if (oscAtts.length > 0) {
      const oscHash = hashAttachments(oscAtts);
      const cached = await getCachedOscillatorAnalysis(oscHash);
      if (cached) {
        oscContext = `\n\n--- S&P Oscillator Chart Observations (from attached screenshot, unchanged since last analysis) ---\n${cached}`;
        console.log("Using cached oscillator chart analysis (images unchanged)");
      } else {
        console.log("New oscillator chart detected — running vision analysis...");
        const summary = await analyzeOscillatorScreenshot(oscAtts);
        if (summary && summary.trim().length > 0) {
          await saveCachedOscillatorAnalysis(oscHash, summary.trim());
          oscContext = `\n\n--- S&P Oscillator Chart Observations (freshly analyzed from screenshot) ---\n${summary.trim()}`;
        }
        // Soft-fail: if vision returns nothing, we just skip the context block
        // rather than failing the whole brief — the textual oscillator value
        // and Redis history are still in the prompt.
      }
    }

    // Newton Technical Presentation (monthly/quarterly PDF deck). Hash-gated
    // so Anthropic tokens are only spent when the PM uploads a new copy.
    // Soft prompt-only decay: we tell Claude how old the deck is and instruct
    // it to weight conclusions less heavily as the document ages.
    if (newtonTechAtts.length > 0) {
      const newtonHash = hashAttachments(newtonTechAtts);
      const cached = await getCachedNewtonTechnical(newtonHash);
      let summary: string | null = null;
      let analyzedAtIso: string | null = null;
      if (cached) {
        summary = cached.summary;
        analyzedAtIso = cached.analyzedAt;
        console.log("Using cached Newton Technical analysis (PDF unchanged)");
      } else {
        console.log("New Newton Technical PDF detected — running vision analysis...");
        const fresh = await analyzeNewtonTechnical(newtonTechAtts);
        if (fresh && fresh.trim().length > 0) {
          await saveCachedNewtonTechnical(newtonHash, fresh.trim());
          summary = fresh.trim();
          analyzedAtIso = new Date().toISOString();
        }
      }
      if (summary && analyzedAtIso) {
        const ageDays = Math.max(
          0,
          Math.floor((Date.now() - new Date(analyzedAtIso).getTime()) / (24 * 60 * 60 * 1000))
        );
        // Decay guidance: <14d = fresh, 14-45d = mid, >45d = stale.
        const decayNote =
          ageDays <= 14
            ? "This presentation is fresh — treat its technical setup, levels, and sector calls as current."
            : ageDays <= 45
            ? `This presentation is ${ageDays} days old — directional bias and medium-term setup likely still valid, but treat specific price levels and short-term timing calls as dated. Cross-check against current quantitative data before relying.`
            : `This presentation is ${ageDays} days old — STALE. Use ONLY for high-level directional context (cycle view, structural themes). Do not cite specific price levels or near-term timing calls; they are likely obsolete. Defer to the live oscillator, sentiment, and breadth data for current positioning.`;
        newtonTechContext = `\n\n--- Mark Newton Technical Presentation (analyzed ${ageDays} day(s) ago) ---\n${decayNote}\n\n${summary}`;
      }
    }

    // Generic analyst/strategist reports dropbox. Identical hash-gated +
    // age-decay handling as the Newton deck — parse once, reuse the cached
    // summary across briefs until the file set changes.
    if (strategistReportAtts.length > 0) {
      const srHash = hashAttachments(strategistReportAtts);
      const cached = await getCachedStrategistReports(srHash);
      let summary: string | null = null;
      let analyzedAtIso: string | null = null;
      if (cached) {
        summary = cached.summary;
        analyzedAtIso = cached.analyzedAt;
        console.log("Using cached strategist-reports analysis (files unchanged)");
      } else {
        console.log("New strategist report(s) detected — running vision analysis...");
        const fresh = await analyzeStrategistReports(strategistReportAtts);
        if (fresh && fresh.trim().length > 0) {
          await saveCachedStrategistReports(srHash, fresh.trim());
          summary = fresh.trim();
          analyzedAtIso = new Date().toISOString();
        }
      }
      if (summary && analyzedAtIso) {
        const ageDays = Math.max(
          0,
          Math.floor((Date.now() - new Date(analyzedAtIso).getTime()) / (24 * 60 * 60 * 1000))
        );
        const decayNote =
          ageDays <= 14
            ? "These reports are fresh — treat their views, levels, and calls as current."
            : ageDays <= 45
            ? `These reports are ${ageDays} days old — directional theses likely still valid, but treat specific levels and short-term timing calls as dated. Cross-check against current data.`
            : `These reports are ${ageDays} days old — STALE. Use ONLY for high-level directional/thematic context. Do not cite specific levels or near-term calls; defer to live data for current positioning.`;
        strategistReportsContext = `\n\n--- Analyst / Strategist Reports (analyzed ${ageDays} day(s) ago) ---\n${decayNote}\n\n${summary}`;
      }
    }

    // Append screenshot context BEFORE the main text so it doesn't get
    // recency-bias advantage over the quantitative data. The textContent
    // already ends with portfolio holdings — screenshots are supplementary.
    const contentBlocks: Anthropic.Messages.ContentBlockParam[] = [
      { type: "text", text: oscContext + newtonTechContext + strategistReportsContext + "\n\n" + textContent },
    ];

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      temperature: 0,
      max_tokens: 8192,
      messages: [
        {
          role: "user",
          content: contentBlocks,
        },
      ],
      system: BRIEF_PROMPT,
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text : "";

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json(
        { error: "Failed to parse brief response" },
        { status: 500 }
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      // Attempt to repair truncated JSON by closing open brackets/braces
      let repaired = jsonMatch[0];
      // Remove trailing incomplete string value (e.g., truncated mid-sentence)
      repaired = repaired.replace(/,\s*"[^"]*":\s*"[^"]*$/, "");
      repaired = repaired.replace(/,\s*"[^"]*$/, "");
      // Count and close open brackets/braces
      const openBraces = (repaired.match(/\{/g) || []).length - (repaired.match(/\}/g) || []).length;
      const openBrackets = (repaired.match(/\[/g) || []).length - (repaired.match(/\]/g) || []).length;
      repaired += "]".repeat(Math.max(0, openBrackets));
      repaired += "}".repeat(Math.max(0, openBraces));
      try {
        parsed = JSON.parse(repaired);
        console.log("Repaired truncated JSON response");
      } catch (e2) {
        const msg = e2 instanceof Error ? e2.message : String(e2);
        return NextResponse.json(
          { error: `Failed to parse brief response: ${msg}` },
          { status: 500 }
        );
      }
    }

    // A full brief generation succeeded → the API key has credit. Clear any
    // prior "credits exhausted" flag (transition-only write, e.g. after the
    // PM swapped in a fresh key).
    void markAnthropicHealthy();

    const now = new Date();
    // If Claude's marketRegime came back empty/bogus, fall back to our
    // deterministic pre-classification so downstream consumers always have
    // a consistent regime string.
    const finalRegime =
      parsed.marketRegime &&
      ["Risk-On", "Neutral", "Risk-Off"].includes(parsed.marketRegime)
        ? parsed.marketRegime
        : classification.regime;

    return NextResponse.json({
      date: now.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
      generatedAt: now.toISOString(),
      marketData,
      regimeScore: classification.score,
      regimeSignals: classification.signals,
      forwardLooking: forwardData,
      ...parsed,
      marketRegime: finalRegime,
      // Structured live sector performance for the UI tile grid (not AI-generated).
      sectorPerformance: sectorPerf.sectors,
      // Structured forward event calendar (Phase 01) — the UI renders the
      // event strip from this deterministically; catalystWatch (in ...parsed)
      // is the model's interpretation of it. Null when the build failed.
      catalystCalendar,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Morning brief API error:", message, error);
    // Flag credit/billing exhaustion so the nav surfaces it (the Brief is a
    // daily-run path, so this catches a depleted balance promptly).
    if (isCreditError(error)) await recordAnthropicCreditError(`Brief: ${message}`);
    // The Anthropic SDK / Node web APIs surface malformed base64 as
    // "The string did not match the expected pattern." — translate that
    // into something actionable so the user knows to check attachments.
    const userMessage = /did not match the expected pattern/i.test(message)
      ? "One of the attached screenshots has a malformed image payload. Remove recently added screenshots (Equity Flows / Newton) and re-upload, then try again."
      : `Failed to generate morning brief: ${message}`;
    return NextResponse.json(
      { error: userMessage },
      { status: 500 }
    );
  }
}
