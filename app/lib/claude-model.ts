import type Anthropic from "@anthropic-ai/sdk";

/** The Sonnet every app route calls. One place to bump on the next release. */
export const SONNET_MODEL = "claude-sonnet-5-5";

/**
 * Thinking OFF on Claude Sonnet 5.5. `{ type: "disabled" }` is a 400 on this
 * model; `between_tools` is its lowest setting (no extended thinking). Rules:
 * effort `high` or below only, no other field inside `thinking`, and it is
 * accepted by Sonnet 5.5 ONLY — drop it from any body re-sent to another model.
 * Cast because SDK 0.80's ThinkingConfigParam predates the value.
 */
export const THINKING_OFF = { type: "between_tools" } as unknown as Anthropic.ThinkingConfigParam;
