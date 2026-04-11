import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getRedis } from "@/app/lib/redis";
import {
  fetchForwardLookingData,
  classifyRegime,
  type ForwardLookingData,
  type ForwardPoint,
} from "@/app/lib/forward-looking";

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

const BRIEF_PROMPT = `You are a senior portfolio strategist generating a daily morning brief for a portfolio management team. Your audience is professional portfolio managers who need actionable, institutional-quality market intelligence.

Given current market data indicators, a pre-classified regime, forward-looking data (yield curve, forward P/E, SPX YTD, credit and vol week-over-week deltas), portfolio holdings, and any attached research screenshots, generate a comprehensive morning brief. When screenshots are provided, analyze them carefully and incorporate their insights — especially fund flow data, positioning data, and liquidity metrics — directly into your analysis. Be specific about what the screenshots show.

Be direct, opinionated, and specific. Avoid generic platitudes. Write like a seasoned PM talking to their team.

CRITICAL — DATE ANCHORING & NO HISTORICAL HALLUCINATION:
The user payload contains an explicit "Today's Date" line. That is the authoritative date for this brief. You MUST obey these rules:
1. Do NOT reference macro events, tariff announcements, policy decisions, or Fed actions that are more than 30 days before Today's Date, even if you "remember" them from training data or see them mentioned in attached screenshots. Old events like "Liberation Day" (April 2025 tariff announcement), specific past CPI prints, past FOMC meetings, prior earnings seasons, or any dated historical reference that predates the last 30 days are OFF LIMITS as current narrative.
2. If an attached screenshot references an older event as historical context, do NOT treat it as a current driver. A JPM flows report citing "the Liberation Day spike" means the spike happened in the past — do not describe it as a recent move or frame current credit levels as "unwinding" it unless the numerical week-over-week data in the payload clearly shows such an unwind.
3. Every specific catalyst or "recent move" you reference MUST be supported by either (a) a week-over-week delta in the forward-looking data block, (b) a YTD number in the data block, or (c) a number explicitly visible in an attached screenshot dated within the last 30 days. If you can't cite it from the payload, don't say it.
4. If you genuinely don't know what catalysts are on deck in the next 2 weeks (CPI, FOMC, earnings, etc.) because no attached screenshot or data field tells you, say "the next scheduled data releases and earnings" generically — do NOT invent specific dates or events.
5. Absolutely NO phrases like "coming off the Liberation Day spike", "post-Liberation Day unwind", "following the April tariff shock" unless Today's Date is within 30 days of April 2025.

CRITICAL — TONE ADAPTATION:
The user input contains a deterministic "Pre-classified Regime" line. Your marketRegime output MUST match it unless a data point in the payload contradicts it clearly (if so, explain briefly in bottomLine). Adapt tone accordingly:
- Risk-On → Lean constructive. Highlight what's working, where to add exposure, which defensive names to rotate out of. Do NOT manufacture bearish warnings when breadth, credit, and trend are healthy.
- Neutral → Balanced. Identify the swing variable and what would tip it either direction.
- Risk-Off → Defensive. Emphasize protection, quality, what to avoid.

CRITICAL — FORWARD-LOOKING ORIENTATION:
The brief should focus on the NEXT 2 WEEKS, not recap yesterday. Use the week-over-week deltas and YTD framing to describe direction of travel. The "forwardView" field is where you explicitly project forward; other analysis fields should still interpret current data with a forward lens ("heading into the next two weeks, ...").

Respond ONLY with valid JSON matching this exact structure (fields are intentionally ordered so Bottom Line → Forward View → Composite → Risk Scan flows naturally in the UI):
{
  "marketRegime": "Risk-On or Neutral or Risk-Off — match the Pre-classified Regime unless clearly contradicted.",
  "bottomLine": "2-4 sentence executive summary of the regime and what it means for portfolio positioning over the NEXT 2 WEEKS. Reference the direction of travel (e.g., 'S&P +X% YTD with VIX dropping', 'credit widening week-over-week'). Be bold and direct.",
  "forwardView": "3-5 sentences titled 'Forward View — Next 2 Weeks'. Cover: (a) what the yield curve, forward P/E, and credit trend imply about risk appetite in the coming weeks; (b) the 1-2 specific catalysts or data releases to watch; (c) the asymmetry the PM should lean into. This is forward-looking ONLY — do not recap what already happened.",
  "compositeAnalysis": "2-3 sentences on the overall market signal, what's driving it, and what PMs should focus on in the coming weeks.",
  "creditAnalysis": "2-3 sentences on credit spread LEVELS and WEEK-OVER-WEEK TREND, what they signal about risk appetite, and implications for equity portfolios.",
  "volatilityAnalysis": "2-3 sentences on the volatility regime, term structure, VIX week-over-week direction, and what it means for hedging and position sizing.",
  "breadthAnalysis": "2-3 sentences on market breadth and participation: S&P 500 and Nasdaq DMA participation rates, NYSE A/D line direction, and new highs vs new lows. Focus on market structure health — is the rally/selloff broad-based or narrow?",
  "contrarianAnalysis": "2-3 sentences providing the contrarian take. ALL four indicators (S&P Oscillator, Put/Call ratio, Fear & Greed, AAII survey) are interpreted INVERSELY: oversold/fearful = BULLISH opportunity, overbought/greedy = BEARISH warning. Provide an overall contrarian assessment and what it means for positioning.",
  "flowsAnalysis": "2-3 sentences on fund flows, positioning, and whether the market is washed out or still has room to deteriorate. If JPM Flows & Liquidity screenshots are attached, reference specific data points from them.",
  "hedgingAnalysis": "2-3 sentences on whether current conditions favor adding hedges (focused on cost efficiency: hedge when VIX is low and puts are cheap, not when expensive). Consider put cost environment, VIX context, and whether sentiment suggests complacency (cheap protection) or fear (expensive protection).",
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
- riskScan should list portfolio holdings ordered from highest risk to lowest, with priority: "High", "Medium-High", "Medium", or "Low-Medium". Focus on the weakest/most at-risk names. Include 4-7 entries. USE the [RISK: ...] annotations on each holding — holdings tagged CRITICAL or WARNING should be prioritized highest. Incorporate specific risk signals (trend, momentum, MACD, volume, Ichimoku, short interest, valuation) into your summaries and actions.
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

  for (const [section, atts] of Object.entries(bySection)) {
    blocks.push({
      type: "text",
      text: `\n--- Attached screenshots for ${section} (${atts.length} image${atts.length > 1 ? "s" : ""}) ---\nAnalyze these carefully and incorporate findings into your brief:`,
    });

    for (const att of atts) {
      // Extract media type and base64 data from data URL
      const match = att.dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (!match) continue;

      const rawMediaType = match[1];
      // Ensure media type is one that Anthropic accepts
      const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
      const mediaType = (allowedTypes.includes(rawMediaType) ? rawMediaType : "image/png") as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
      // Strip any whitespace/newlines from base64 data
      const data = match[2].replace(/\s/g, "");

      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data,
        },
      });

      blocks.push({
        type: "text",
        text: `(Image: ${att.label})`,
      });
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
    const { marketData, holdings, attachments } = await request.json();

    if (!marketData) {
      return NextResponse.json(
        { error: "Market data is required" },
        { status: 400 }
      );
    }

    type HoldingInput = {
      ticker: string;
      bucket: string;
      sector: string;
      scores?: Record<string, number>;
      weights: { portfolio: number };
      riskAlert?: { level: string; summary: string; dangerCount: number; cautionCount: number; signals?: { name: string; status: string; detail: string }[] };
    };

    const holdingsSummary = holdings
      ? (holdings as HoldingInput[])
          .map((h) => {
              const rawScore = h.scores ? Object.values(h.scores).reduce((a: number, b: number) => a + b, 0) : 0;
              let line = `${h.ticker} (${h.bucket}, ${h.sector}, ${h.weights.portfolio}% weight, score ${rawScore}/40)`;
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

    // Fetch live sector ETF data and forward-looking data in parallel.
    // fetchForwardLookingData() is wrapped in try/catch so a transient Yahoo
    // outage never blocks the brief — we just mark forward data as unavailable.
    const [sectorPerformance, forwardData] = await Promise.all([
      fetchSectorPerformance(),
      fetchForwardLookingData().catch((e) => {
        console.error("Forward-looking fetch failed:", e);
        return null as ForwardLookingData | null;
      }),
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
    const classification = classifyRegime({
      vix: marketData.vix ?? 20,
      vixWeekDeltaPct: vixWeekPctObj.value,
      hyOas: marketData.hyOas ?? 350,
      hyOasWeekDeltaBps: hyOasDeltaBps,
      spxYtd:
        forwardData && typeof forwardData.spxYtd.value === "number"
          ? forwardData.spxYtd.value
          : null,
      spxWeek:
        forwardData && typeof forwardData.spxWeek.value === "number"
          ? forwardData.spxWeek.value
          : null,
      breadth: marketData.breadth ?? 50,
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
IMPORTANT: Your marketRegime output MUST equal "${classification.regime}" unless the data below clearly contradicts it (in which case briefly note the contradiction in bottomLine).${forwardBlock}

Volatility:
- VIX: ${marketData.vix}
- MOVE Index: ${marketData.move}
- VIX Term Structure: ${marketData.termStructure}

Credit Spreads:
- HY OAS: ${marketData.hyOas} bps
- IG OAS: ${marketData.igOas} bps

Breadth & Market Structure:
- S&P 500 % Above 200 DMA: ${marketData.breadth}%
- Nasdaq % Above 200 DMA: ${marketData.nasdaqBreadth}%
- S&P 500 % Above 50 DMA: ${marketData.sp50dma}%
- NYSE A/D Line: ${marketData.nyseAdLine}
- New Highs - New Lows: ${marketData.newHighsLows}

Contrarian Indicators (ALL interpreted INVERSELY — oversold/fearful = BULLISH, overbought/greedy = BEARISH):
- S&P Oscillator: ${marketData.spOscillator} — negative = oversold = BULLISH, positive = overbought = BEARISH
- Put/Call Ratio (Total): ${marketData.putCall} — >1.0 = excessive fear = BULLISH, <0.7 = complacency = BEARISH
- Fear & Greed Index: ${marketData.fearGreed}/100 — <25 = extreme fear = BULLISH, >75 = extreme greed = BEARISH
- AAII Bull-Bear Spread: ${marketData.aaiiBullBear} — <-20 = excessive bearishness = BULLISH, >+30 = excessive bullishness = BEARISH

Equity Flows: ${marketData.equityFlows}

Hedge Timing Score: ${computeHedgeScore(marketData.vix ?? 20, marketData.termStructure ?? "Contango", marketData.fearGreed ?? 50)}/100 (dynamically computed from VIX, term structure, and sentiment)

Live Sector ETF Performance (from Yahoo Finance — use this for sector rotation analysis):
${sectorPerformance}

Current Portfolio Holdings: ${holdingsSummary}`;

    // Check if we can reuse cached screenshot analysis instead of re-sending images
    const atts: AttachmentInput[] = attachments || [];
    const attHash = hashAttachments(atts);
    let flowsContext = "";
    let autoEquityFlows: string | undefined;

    if (atts.length > 0) {
      const cached = await getCachedAnalysis(attHash);
      if (cached) {
        // Images haven't changed — use cached summary (saves vision tokens)
        flowsContext = `\n\n--- JPM Flows & Liquidity Report Summary (from attached screenshots, unchanged since last analysis) ---\n${cached.summary}`;
        autoEquityFlows = cached.equityFlowsSignal;
        console.log("Using cached attachment analysis (images unchanged)");
      } else {
        // New images — analyze them separately and cache the result
        console.log("New attachments detected — running vision analysis...");
        const summary = await analyzeAttachments(atts);
        if (!summary || summary.trim().length === 0) {
          return NextResponse.json(
            { error: "JPM Flows screenshot analysis returned empty — the images may be unreadable. Try re-uploading clearer screenshots." },
            { status: 500 }
          );
        }
        const flowsSignal = parseEquityFlowsSignal(summary);
        const cleanSummary = summary.replace(/^EQUITY_FLOWS_SIGNAL:.*\n?/m, "").trim();
        await saveCachedAnalysis(attHash, cleanSummary, flowsSignal);
        autoEquityFlows = flowsSignal;
        flowsContext = `\n\n--- JPM Flows & Liquidity Report Summary (freshly analyzed from screenshots) ---\n${cleanSummary}`;
      }
    }

    const contentBlocks: Anthropic.Messages.ContentBlockParam[] = [
      { type: "text", text: textContent + flowsContext },
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
      ...(autoEquityFlows ? { autoEquityFlows } : {}),
      ...parsed,
      marketRegime: finalRegime,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Morning brief API error:", message, error);
    return NextResponse.json(
      { error: `Failed to generate morning brief: ${message}` },
      { status: 500 }
    );
  }
}
