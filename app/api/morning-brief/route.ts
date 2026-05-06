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
import type { MarketRegimeData } from "@/app/lib/market-regime";

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

async function fetchSectorPerformance(): Promise<string> {
  try {
    const entries = Object.entries(SECTOR_ETFS);
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
          const pct = prevClose ? (((price - prevClose) / prevClose) * 100).toFixed(2) : "N/A";
          return `- ${sector} (${etf}): ${pct}% today, price $${price?.toFixed(2) ?? "N/A"}`;
        } catch {
          return null;
        }
      })
    );
    const lines = results.filter(Boolean) as string[];
    return lines.length > 0 ? lines.join("\n") : "Sector data unavailable";
  } catch (e) {
    console.error("Sector ETF fetch error:", e);
    return "Sector data unavailable";
  }
}

const ATTACHMENT_CACHE_KEY = "pm:attachment-analysis";
const OSCILLATOR_ATTACHMENT_CACHE_KEY = "pm:oscillator-screenshot-analysis";

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
- tacticalView (1-3M, 50% weight): What the PM should DO this month. Driven by VIX, breadth, momentum-vs-defensive leadership. Concrete: lean in / take chips / hedge.
- cyclicalView (3-6M, 30% weight): Sector rotation and business-cycle pulse. Driven by ISM PMI 50-line, XLY/XLP, XLK/XLU. Concrete: which sectors are accelerating / decelerating, what to rotate into.
- structuralView (6-12M, 20% weight): Long-term trend overlay. Driven by SPX 10-month MA and ISM PMI direction. Concrete: are we in a bull cycle that allows risk-taking, or a topping process that vetoes tactical aggression?

Each horizon view must be 2-3 sentences, reference at least one of its driving signals by name (from the Multi-Horizon Rollup block), and be concrete enough that a PM can act on it. If a horizon's signals contradict an adjacent one, NAME the disagreement — that's actionable information. If the horizon has "no signals available", lean qualitative for that horizon rather than fabricating a quantitative read.

The legacy "forwardView" field should be a 2-3 sentence SYNTHESIS that ties the three horizons together for the bottom-of-page summary readers.

Respond ONLY with valid JSON matching this exact structure (fields are intentionally ordered so Bottom Line → Tactical/Cyclical/Structural Views → Composite → Risk Scan flows naturally in the UI):
{
  "marketRegime": "Risk-On or Neutral or Risk-Off — match the Pre-classified Regime unless clearly contradicted.",
  "bottomLine": "2-4 sentence executive summary of the regime and what it means for portfolio positioning across the three horizons. Reference the weighted overall composite from the Multi-Horizon Rollup if present. Be bold and direct.",
  "tacticalView": "2-3 sentences for the 1-3M tactical horizon. What the PM should DO this month. Cite at least one tactical-bucket signal by name (VIX Level, Breadth (RSP/SPY), MTUM/USMV). Concrete posture call: lean in, take chips, hedge, or hold. Reference live SPY hedging premiums if attached. This pairs with hedgingAnalysis.",
  "cyclicalView": "2-3 sentences for the 3-6M cyclical horizon. Sector rotation + business cycle. Cite at least one cyclical-bucket signal by name (XLY/XLP, XLK/XLU, ISM PMI 50-line). Concrete: which sectors are accelerating, which to rotate into, whether the cycle is mid or late. Call out an ISM PMI 50-line CROSSOVER explicitly if one is flagged.",
  "structuralView": "2-3 sentences for the 6-12M structural horizon. Long-term trend + macro direction. Cite at least one structural-bucket signal by name (SPX 10-Month Trend, ISM PMI Trend). Concrete: is the trend overlay supportive or vetoing? If structural disagrees with tactical, name the disagreement — the PM trades tactically but should know when the long window is pulling against them.",
  "forwardView": "2-3 sentence SYNTHESIS that ties the three horizons together — leans heaviest on tactical (it's weighted 50%) but explicitly notes when cyclical or structural is in disagreement. This is the legacy single-paragraph view used by older read-only consumers; keep it tight.",
  "compositeAnalysis": "2-3 sentences on the overall market signal, what's driving it, and what PMs should focus on in the coming weeks.",
  "creditAnalysis": "2-3 sentences on credit spread LEVELS and WEEK-OVER-WEEK TREND, what they signal about risk appetite, and implications for equity portfolios.",
  "volatilityAnalysis": "2-3 sentences on the volatility regime, term structure, VIX week-over-week direction, and what it means for hedging and position sizing.",
  "breadthAnalysis": "2-3 sentences on market breadth and participation: S&P 500 and Nasdaq DMA participation rates, NYSE A/D line direction, and new highs vs new lows. Focus on market structure health — is the rally/selloff broad-based or narrow?",
  "contrarianAnalysis": "2-3 sentences providing the contrarian take. ALL four indicators (S&P Oscillator, Put/Call ratio, Fear & Greed, AAII survey) are interpreted INVERSELY: oversold/fearful = BULLISH opportunity, overbought/greedy = BEARISH warning. Provide an overall contrarian assessment and what it means for positioning.",
  "hedgingAnalysis": "3-4 sentences on whether current conditions favor adding SPY put protection (we are restricted to PROTECTIVE PUTS only — no speculative positions, no weeklies, no LEAPS). Tenor band is strictly 2–9 months: tactical (Risk-Off in the 1-3M bucket) → 2–3 month monthly contracts; cyclical (Risk-Off in the 3-6M bucket) → 3–6 month quarterly contracts; structural (Risk-Off in the 6-12M bucket while tactical holds up) → 6–9 month contracts as a strategic overlay (capped at 9M — never recommend LEAPS). Strikes ATM to 10% OTM only. When a 'Live SPY Hedging Costs' block is present in the data payload, you MUST cite at least one specific premium (e.g. '3-month ATM SPY put is X% of spot at $Y') and reference the week-over-week or month-over-month direction of those premiums when provided. Integrate VIX, term structure, and sentiment as the qualitative lens on top of the actual option prices. Give a clear directional recommendation — add, hold, OR skip — grounded in the dollar cost of protection relative to the portfolio. SKIP IS A FIRST-CLASS RECOMMENDATION: if all three horizons read Risk-On (or weighted overall is Risk-On), VIX is contained, term structure is in normal contango, AND premiums are normal-to-rich, the correct call is 'skip — protection is wasted premium when breadth, vol, and trend are all constructive'. Do not hedge for the sake of hedging; an explicit skip in a constructive regime is more valuable than a wishy-washy 'hold and reassess'.",
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
  ]
}

Notes:
- sectorRotation.leading and .lagging should each have 2-3 entries with sector name, approximate MTD performance, and a brief reason.
- riskScan MUST ONLY include holdings tagged "(Portfolio, ...)" — NEVER include Watchlist names (those are candidates, not owned positions). Order from highest risk to lowest, with priority: "High", "Medium-High", "Medium", or "Low-Medium". Focus on the weakest/most at-risk Portfolio names. Include 4-7 entries drawn exclusively from the Portfolio bucket. USE the [RISK: ...] annotations on each holding — holdings tagged CRITICAL or WARNING should be prioritized highest. Incorporate specific risk signals (trend, momentum, MACD, volume, Ichimoku, valuation) into your summaries and actions. Do NOT reference short interest as a risk driver — it is informational only.
- forwardActions should contain 4-6 specific, actionable recommendations ordered by priority. Use "High", "Medium", or "Low" for priority. Actions should be forward-looking (what to do THIS week or next), not reactive to yesterday.
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
              const dataUrl = await redis.get(`pm:attachment:${ref.id}`);
              if (!dataUrl || typeof dataUrl !== "string") return null;
              return { section: ref.section, label: ref.label, dataUrl } as AttachmentInput;
            } catch {
              return null;
            }
          })
        );
        attachments = fetched.filter((x): x is AttachmentInput => x !== null);
      } catch (e) {
        console.error("Failed to hydrate attachmentRefs from Redis:", e);
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
              return line;
            }
          )
          .join("\n")
      : "No holdings provided";

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

    const [sectorPerformance, forwardData, strategistHistory, research, hedgingCostsBlock, marketRegime] =
      await Promise.all([
        fetchSectorPerformance(),
        fetchForwardLookingData().catch((e) => {
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

    // Build content blocks: text prompt + any image attachments
    const textContent = `Generate the morning brief for today.

TODAY'S DATE: ${todayLong} (${todayIso}). This is the authoritative date for this brief. Do NOT reference macro events older than 30 days before this date — including "Liberation Day" (April 2025), older FOMC meetings, or past CPI prints — even if they appear in attached screenshots or you remember them from training data. Every "recent move" you cite must come from the numerical data below.

Here are the current market indicators:

Composite Signal: ${marketData.compositeSignal}
Conviction: ${marketData.conviction}

Pre-classified Regime: ${classification.regime} (score ${classification.score})
Regime drivers: ${classification.signals.length > 0 ? classification.signals.join("; ") : "mixed / no dominant signal"}
IMPORTANT: Your marketRegime output MUST equal "${classification.regime}" unless the data below clearly contradicts it (in which case briefly note the contradiction in bottomLine).${forwardBlock}${regimeBlock}

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
${hedgingCostsBlock ? `\n${hedgingCostsBlock}\n\nWhen writing hedgingAnalysis, cite at least one specific premium from the table above (e.g. "the 3-month ATM SPY put costs X% of spot") and reference the week-over-week or month-over-month direction when available. Anchor claims like "puts are cheap" or "protection is expensive" to these actual dollar/percent figures rather than generalizing from VIX alone.` : ""}

Live Sector ETF Performance (from Yahoo Finance — use this for sector rotation analysis):
${sectorPerformance}
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
    title: string
  ): string | null => {
    if (entries.length === 0) return null;
    const today = new Date().toISOString().slice(0, 10);
    const lines = entries.map((e) => {
      const label = e.date === today ? "TODAY" : e.date;
      return `[${label}] ${e.text}`;
    });
    return `--- ${name} (${title}) — trailing ${entries.length} day${entries.length > 1 ? "s" : ""} ---\n${lines.join("\n\n")}`;
  };
  const blocks: string[] = [];
  const nb = formatEntries(
    strategistHistory.newton,
    "Mark Newton",
    "Fundstrat Technical Strategy"
  );
  const lb = formatEntries(
    strategistHistory.lee,
    "Tom Lee",
    "Fundstrat Head of Research"
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
6. Do NOT regurgitate full text — distill the 2-3 most actionable points and weave them into compositeAnalysis, contrarianAnalysis, forwardView, hedgingAnalysis, etc. (flowsAnalysis was retired; if a strategist piece flags a flow extreme, fold it into contrarianAnalysis.)
7. If a strategist's view conflicts with the quantitative data, note the tension explicitly.

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

Current Portfolio Holdings: ${holdingsSummary}`;

    // JPM Flows section was retired in 2026-05 — flows are inherently
    // backward-looking and contrarianAnalysis already covers
    // sentiment/positioning extremes. The S&P oscillator screenshot
    // path stays since it does feed contrarianAnalysis.
    const allAtts: AttachmentInput[] = attachments || [];
    const oscAtts = allAtts.filter((a) => a.section === "spOscillator");

    let oscContext = "";

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

    // Append screenshot context BEFORE the main text so it doesn't get
    // recency-bias advantage over the quantitative data. The textContent
    // already ends with portfolio holdings — screenshots are supplementary.
    const contentBlocks: Anthropic.Messages.ContentBlockParam[] = [
      { type: "text", text: oscContext + "\n\n" + textContent },
    ];

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
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
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Morning brief API error:", message, error);
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
