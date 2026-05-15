import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type { Stock } from "@/app/lib/types";
import type {
  PimPerformanceData,
  PimPortfolioPositions,
  PimModelData,
} from "@/app/lib/pim-types";
import type { MarketRegimeData } from "@/app/lib/market-regime";

/**
 * POST /api/chat
 *
 * Streaming chat endpoint backed by Anthropic with web_search tool access
 * and (optionally) the dashboard's full state as cached context.
 *
 * Request body:
 *   {
 *     messages: [{ role: "user" | "assistant", content: string }, ...]
 *     contextEnabled: boolean  // when true, brief/regime/holdings/PIM are loaded
 *     enableWebSearch?: boolean // default true
 *   }
 *
 * Response: text/event-stream. Each event is a single-line JSON object:
 *   { "type": "text", "delta": "..." }                — token of assistant text
 *   { "type": "search_query", "query": "..." }        — model issued a web search
 *   { "type": "citation", "url": "...", "title": "..." } — citation extracted
 *   { "type": "done" }                                 — end of stream
 *   { "type": "error", "error": "..." }                — terminal error
 *
 * Context block is wrapped in a `cache_control: ephemeral` system message so
 * follow-up turns in the same thread (within ~5 min) get a heavy discount on
 * the cached portion. First message in a fresh thread pays full price.
 */

const client = new Anthropic();

const MAX_MESSAGES_IN_HISTORY = 40; // hard cap to keep context manageable
const MODEL = "claude-sonnet-4-6";

type IncomingMessage = { role: "user" | "assistant"; content: string };

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return n.toFixed(digits);
}

/** Hydrate dashboard state from Redis and produce a single text block suitable
 * for use as a cached system message. Designed to be compact-but-complete:
 * the goal is to let the model answer "what's my X exposure" / "summarize
 * today's brief" / "should I trim Y" without further tool calls into the
 * dashboard. */
async function buildContextBlock(): Promise<string> {
  const redis = await getRedis();
  const [briefRaw, regimeRaw, stocksRaw, pimModelsRaw, pimPositionsRaw, pimPerfRaw] = await Promise.all([
    redis.get("pm:brief"),
    redis.get("pm:market-regime"),
    redis.get("pm:stocks"),
    redis.get("pm:pim-models"),
    redis.get("pm:pim-positions"),
    redis.get("pm:pim-performance"),
  ]);

  const sections: string[] = [];
  sections.push(`DASHBOARD CONTEXT (generated ${new Date().toISOString()})`);
  sections.push(
    `You are Claude, embedded as a chat assistant in Jordan Glazer's portfolio management dashboard. Jordan is an Investment Advisor at RBC Dominion Securities (Di Iorio Family Wealth). The dashboard tracks PIM (Portfolio Investment Management) models, individual stock holdings, the morning brief, market regime, and hedging analysis. Below is the current state of that dashboard. Reference these numbers when answering. When asked about something not covered here, use the web_search tool to pull fresh data. Always be specific — cite exact figures from the context rather than hedging with "approximately." Today is ${new Date().toISOString().slice(0, 10)}.

FORMATTING RULES (strict):
- Write in clean prose. Use **bold** for tickers and key terms, and simple "- " bullets for short lists.
- DO NOT use Markdown headers (#, ##, ###) — they render as raw "##" symbols in this UI. Use bold sentences instead.
- DO NOT use horizontal rules (---), pipe tables (| col | col |), or HTML.
- DO NOT prefix output with a title line or emoji icon (no "## 📊 Summary Table"). Just answer directly.
- Keep responses tight. Skip throat-clearing ("Great question…"). Get to the answer.

CRITICAL — PORTFOLIO AWARENESS:
- When the user asks for NEW investment ideas, replacements, additions, or "stocks to add/buy", you MUST cross-reference the Portfolio section above first and EXCLUDE any ticker already held. The Portfolio section lists every name currently owned with its weight.
- If a name the user mentions or that comes up in research is already held, explicitly say "you already own X (current weight: Y%)" rather than recommending it as a new buy.
- Treat Canadian (.TO / -T suffix) and US tickers of the same company as the same holding. Example: if TOU.TO is held, don't recommend "Tourmaline Oil" as a new idea.
- Before listing any suggestions, do a mental check: "is this ticker, in any form, already in the Portfolio section?" If yes, exclude or flag it.`,
  );

  // ── Morning Brief ──
  if (briefRaw) {
    try {
      const brief = JSON.parse(briefRaw) as Record<string, unknown> & {
        date?: string;
        marketRegime?: string;
        regimeScore?: number;
        summary?: string;
        posture?: string;
        contrarianAnalysis?: string;
        hedgingAnalysis?: string;
        catalysts?: string;
        riskOnsetters?: string;
      };
      sections.push(
        `[MORNING BRIEF — ${brief.date ?? "undated"}]\n` +
          `Regime: ${brief.marketRegime ?? "n/a"} (score ${fmtNum(brief.regimeScore as number, 1)})\n\n` +
          `**Summary**: ${brief.summary ?? "n/a"}\n\n` +
          `**Posture**: ${brief.posture ?? "n/a"}\n\n` +
          `**Contrarian**: ${brief.contrarianAnalysis ?? "n/a"}\n\n` +
          `**Hedging**: ${brief.hedgingAnalysis ?? "n/a"}\n\n` +
          `**Catalysts**: ${brief.catalysts ?? "n/a"}\n\n` +
          `**Risk drivers**: ${brief.riskOnsetters ?? "n/a"}`,
      );
    } catch {
      sections.push(`[MORNING BRIEF: failed to parse]`);
    }
  } else {
    sections.push(`[MORNING BRIEF: not yet generated today]`);
  }

  // ── Market Regime ──
  if (regimeRaw) {
    try {
      const regime = JSON.parse(regimeRaw) as MarketRegimeData;
      const c = regime.composite;
      const spx = regime.spx10m;
      const breadth = regime.breadth;
      const vix = regime.crossAsset?.vix;
      const signalsList = (c?.signals ?? []).slice(0, 6).map((s) => `- ${s}`).join("\n");
      sections.push(
        `[MARKET REGIME — live, computed ${regime.computedAt ?? "n/a"}]\n` +
          `**Composite**: ${c?.label ?? "n/a"} — score ${fmtNum(c?.score, 1)} / ${c?.total ?? "n/a"}\n` +
          `**SPX vs 10M MA**: ${fmtNum(spx?.distancePct, 2)}% (${spx?.direction ?? "n/a"})\n` +
          `**Breadth (RSP/SPY)**: ${fmtNum(breadth?.ratio, 4)} (${breadth?.direction ?? "n/a"})\n` +
          `**VIX**: ${fmtNum(vix?.price, 2)} (${vix?.direction ?? "n/a"})\n` +
          (signalsList ? `\nKey signals:\n${signalsList}` : ""),
      );
    } catch {
      sections.push(`[MARKET REGIME: failed to parse]`);
    }
  }

  // ── Portfolio + Watchlist ──
  if (stocksRaw) {
    try {
      const parsed = JSON.parse(stocksRaw);
      const stocks: Stock[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.stocks) ? parsed.stocks : [];
      const portfolio = stocks.filter((s) => s.bucket === "Portfolio");
      const watchlist = stocks.filter((s) => s.bucket === "Watchlist");
      // Trim per-stock fields to keep the block compact.
      const fmtStock = (s: Stock) => {
        const designation = s.designation ? ` [${s.designation}]` : "";
        const weight = s.weights?.portfolio != null ? `${fmtNum(s.weights.portfolio, 2)}%` : "n/a";
        return `- **${s.ticker}** (${s.sector ?? "?"}) ${s.name ?? ""}${designation} · weight ${weight}`;
      };
      sections.push(
        `[PORTFOLIO — ${portfolio.length} positions currently held; DO NOT recommend any of these as new buys]\n${portfolio.slice(0, 100).map(fmtStock).join("\n")}`,
      );
      sections.push(
        `[WATCHLIST — ${watchlist.length} names being tracked but not yet held]\n${watchlist.slice(0, 100).map(fmtStock).join("\n")}`,
      );
    } catch {
      sections.push(`[PORTFOLIO: failed to parse]`);
    }
  }

  // ── PIM Models (holdings + weights) ──
  if (pimModelsRaw) {
    try {
      const models = JSON.parse(pimModelsRaw) as PimModelData;
      const lines: string[] = [];
      for (const g of models.groups ?? []) {
        const equityHoldings = (g.holdings ?? []).filter((h) => h.assetClass === "equity");
        lines.push(
          `**${g.name}** (id=${g.id}) — ${equityHoldings.length} equity holdings · CAD split ${fmtNum(g.cadSplit, 2)} · USD split ${fmtNum(g.usdSplit, 2)}`,
        );
        for (const h of equityHoldings.slice(0, 50)) {
          lines.push(`  - ${h.symbol} (${h.currency}) · weightInClass ${fmtNum(h.weightInClass, 4)}`);
        }
      }
      sections.push(`[PIM MODELS]\n${lines.join("\n")}`);
    } catch {
      sections.push(`[PIM MODELS: failed to parse]`);
    }
  }

  // ── PIM Positions ──
  if (pimPositionsRaw) {
    try {
      const blob = JSON.parse(pimPositionsRaw) as { portfolios: PimPortfolioPositions[] };
      const lines: string[] = [];
      for (const p of blob.portfolios ?? []) {
        lines.push(
          `(${p.groupId}, ${p.profile}): ${p.positions.length} positions · cash $${fmtNum(p.cashBalance, 2)}`,
        );
      }
      sections.push(`[PIM POSITIONS]\n${lines.join("\n")}`);
    } catch {
      sections.push(`[PIM POSITIONS: failed to parse]`);
    }
  }

  // ── PIM Performance (compact YTDs only — NOT the daily history) ──
  if (pimPerfRaw) {
    try {
      const perf = JSON.parse(pimPerfRaw) as PimPerformanceData;
      const year = new Date().toISOString().slice(0, 4);
      const lines: string[] = [];
      for (const m of perf.models ?? []) {
        const yearEntries = m.history.filter((e) => e.date.startsWith(year));
        const lastEntry = m.history[m.history.length - 1];
        const yearStart = m.history.find((e) => !e.date.startsWith(year) && m.history.indexOf(e) === m.history.findIndex((x) => x.date >= `${year}-01-01`) - 1)
          ?? m.history.filter((e) => e.date < `${year}-01-01`).pop();
        const baseline = yearStart?.value;
        const ytdPct = baseline && lastEntry ? ((lastEntry.value / baseline) - 1) * 100 : null;
        lines.push(
          `- (${m.groupId}, ${m.profile}): last ${lastEntry?.date} val ${fmtNum(lastEntry?.value, 4)} · YTD ${fmtNum(ytdPct, 2)}% · ${yearEntries.length} ${year} entries`,
        );
      }
      sections.push(`[PIM PERFORMANCE — cumulative-index series]\n${lines.join("\n")}`);
    } catch {
      sections.push(`[PIM PERFORMANCE: failed to parse]`);
    }
  }

  sections.push(
    `[END DASHBOARD CONTEXT]\n\nWhen answering, prioritize the data above. If you need fresher market data (live quotes, news in the last 24h, economic releases), use the web_search tool.`,
  );

  return sections.join("\n\n");
}

function sseEvent(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const incoming: IncomingMessage[] = Array.isArray(body?.messages) ? body.messages : [];
  const contextEnabled: boolean = body?.contextEnabled !== false; // default ON
  const enableWebSearch: boolean = body?.enableWebSearch !== false; // default ON

  // Trim history to the most recent N messages.
  const messages = incoming
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.length > 0)
    .slice(-MAX_MESSAGES_IN_HISTORY);

  if (messages.length === 0) {
    return new Response(sseEvent({ type: "error", error: "no messages provided" }), {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  // Build system message. Cache-control marker tells Anthropic to cache the
  // heavy context block — subsequent turns in the same session get up to a
  // ~90% discount on input tokens for the cached portion.
  type SystemBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };
  const systemBlocks: SystemBlock[] = [];
  if (contextEnabled) {
    const ctx = await buildContextBlock();
    systemBlocks.push({ type: "text", text: ctx, cache_control: { type: "ephemeral" } });
  } else {
    systemBlocks.push({
      type: "text",
      text: `You are Claude, embedded as a chat assistant in Jordan Glazer's portfolio management dashboard at RBC Dominion Securities. Dashboard context is currently disabled by the user — answer general portfolio/markets questions or use web_search for fresh data. Today is ${new Date().toISOString().slice(0, 10)}.`,
    });
  }

  // Build tools array. The Anthropic SDK's web_search tool is server-side —
  // Claude issues queries, results come back inline as tool_result blocks
  // with citations baked into the subsequent text blocks.
  type WebSearchTool = { type: "web_search_20250305"; name: "web_search"; max_uses?: number };
  const tools: WebSearchTool[] = enableWebSearch
    ? [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]
    : [];

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (obj: unknown) => controller.enqueue(encoder.encode(sseEvent(obj)));

      try {
        // The web_search tool occasionally takes the model on a multi-step
        // turn (search → think → answer). The SDK exposes this via streaming
        // events that include content_block_start/delta/stop for each block,
        // including server_tool_use and web_search_tool_result blocks.
        const messageStream = client.messages.stream({
          model: MODEL,
          max_tokens: 4096,
          system: systemBlocks,
          tools: tools as unknown as Anthropic.Messages.Tool[],
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        });

        // We listen at the per-event level so we can surface search queries
        // and citations as they happen, rather than waiting for the full
        // response.
        for await (const event of messageStream) {
          if (event.type === "content_block_start") {
            const block = event.content_block as unknown as {
              type: string;
              name?: string;
              input?: { query?: string };
              content?: Array<{ type: string; url?: string; title?: string }>;
            };
            if (block.type === "server_tool_use" && block.name === "web_search") {
              const query = block.input?.query;
              if (typeof query === "string" && query.length > 0) {
                send({ type: "search_query", query });
              }
            } else if (block.type === "web_search_tool_result") {
              const items = Array.isArray(block.content) ? block.content : [];
              for (const item of items) {
                if (item?.type === "web_search_result" && typeof item.url === "string") {
                  send({ type: "citation", url: item.url, title: item.title ?? null });
                }
              }
            }
          } else if (event.type === "content_block_delta") {
            const delta = event.delta as unknown as { type: string; text?: string };
            if (delta.type === "text_delta" && typeof delta.text === "string") {
              send({ type: "text", delta: delta.text });
            }
          } else if (event.type === "message_stop") {
            send({ type: "done" });
          }
        }
        controller.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("chat stream error:", e);
        try {
          send({ type: "error", error: msg });
        } catch {
          // controller may already be closed
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
