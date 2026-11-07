import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "@/app/lib/logger";
import { AGENT_MODEL_IDS, watcherDef, type AgentModelTier } from "./registry";
import { readAgentSettings, modelFor } from "./settings";
import { STOP_USD, costOfUsage, monthSpend, recordSpend, worstCaseCost } from "./spend";

/**
 * The ONLY door to the agents key.
 *
 * Two keys, kept apart on purpose:
 *   - ANTHROPIC_API_KEY        every existing dashboard feature (scoring, the
 *                              brief, Draft with AI, …) via `new Anthropic()`.
 *   - ANTHROPIC_AGENTS_API_KEY the watchers only, through this file. Its
 *                              workspace has a $100/month limit.
 * Guards: the agents key is read nowhere else (an ESLint rule (eslint.config.mjs) flags it as an error
 * if any other file touches it); a missing agents key never falls back to the
 * main key; the two keys being identical is refused (the agents' spend would
 * land on the main account); the monthly stop line, the pause switch and an
 * unknown watcher id all refuse BEFORE any tokens are spent.
 */

const log = createLogger("Agent-gateway");

export class AgentGatewayError extends Error {
  constructor(
    public code: "no-key" | "same-key" | "paused" | "budget" | "unknown-watcher",
    message: string
  ) {
    super(message);
    this.name = "AgentGatewayError";
  }
}

function agentsKey(): string {
  const key = process.env.ANTHROPIC_AGENTS_API_KEY?.trim();
  if (!key) throw new AgentGatewayError("no-key", "ANTHROPIC_AGENTS_API_KEY is not set — watchers are off");
  if (key === process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new AgentGatewayError("same-key", "The agents key equals the main key — refusing so watcher spend stays separate");
  }
  return key;
}

/** True when the agents key is present and distinct — for status displays.
 *  Never returns or logs the key itself. */
export function agentsKeyState(): "ok" | "missing" | "same-as-main" {
  try {
    agentsKey();
    return "ok";
  } catch (e) {
    return e instanceof AgentGatewayError && e.code === "same-key" ? "same-as-main" : "missing";
  }
}

let cached: { key: string; client: Anthropic } | null = null;
function client(): Anthropic {
  const key = agentsKey();
  if (!cached || cached.key !== key) cached = { key, client: new Anthropic({ apiKey: key, maxRetries: 2 }) };
  return cached.client;
}

export type AgentCallParams = Omit<Anthropic.MessageCreateParamsNonStreaming, "model" | "stream"> & {
  /** Force a tier (e.g. the shadow run); otherwise the watcher's setting. */
  tier?: AgentModelTier;
  /** Short context for the call log ("AAPL recap vs preview"). */
  note?: string;
};

export type AgentCallResult = {
  message: Anthropic.Message;
  text: string;
  model: string;
  usd: number;
};

function promptChars(p: AgentCallParams): number {
  return JSON.stringify(p.system ?? "").length + JSON.stringify(p.messages).length + JSON.stringify(p.tools ?? []).length;
}

function maxSearches(p: AgentCallParams): number {
  for (const t of p.tools ?? []) {
    const tool = t as { type?: string; max_uses?: number };
    if (tool.type?.startsWith("web_search")) return tool.max_uses ?? 5;
  }
  return 0;
}

/** One Messages call on the agents key, budget-checked and recorded. */
export async function agentCall(watcher: string, params: AgentCallParams): Promise<AgentCallResult> {
  if (!watcherDef(watcher)) throw new AgentGatewayError("unknown-watcher", `Unknown watcher "${watcher}"`);
  const settings = await readAgentSettings();
  if (settings.paused) throw new AgentGatewayError("paused", "Watchers are paused");

  const tier = params.tier ?? modelFor(watcher, settings);
  const model = AGENT_MODEL_IDS[tier];
  const { tier: _tier, note, ...body } = params;
  void _tier;

  const spent = await monthSpend();
  const worst = worstCaseCost(model, promptChars(params), body.max_tokens, maxSearches(params));
  if (spent + worst > STOP_USD) {
    throw new AgentGatewayError(
      "budget",
      `Monthly agents budget reached: $${spent.toFixed(2)} spent, this call could cost up to $${worst.toFixed(2)}, stop line $${STOP_USD}`
    );
  }

  const c = client();
  const message = await c.messages.create({ ...body, model, stream: false });
  const usd = costOfUsage(model, message.usage);
  await recordSpend({
    at: new Date().toISOString(),
    watcher,
    model,
    usd,
    inputTokens: (message.usage.input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0),
    outputTokens: message.usage.output_tokens ?? 0,
    searches: message.usage.server_tool_use?.web_search_requests ?? 0,
    note,
  });
  if (message.stop_reason === "refusal") log.warn(watcher, "refusal from", model);
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return { message, text, model, usd };
}
