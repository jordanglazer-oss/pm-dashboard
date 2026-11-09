import Anthropic from "@anthropic-ai/sdk";
import { SONNET_MODEL, THINKING_OFF } from "@/app/lib/claude-model";

/**
 * One research call with the web-search server tool, run to its end (MAIN
 * key — used by Draft with AI for theses and themes, which are PM tools, not
 * watchers). A long research turn can stop with `pause_turn`; it is resumed
 * by sending the partial assistant turn back. Returns the final text and the
 * URLs the answer cited.
 */
export async function webResearch(
  prompt: string,
  opts: { maxSearches?: number; maxTokens?: number } = {},
): Promise<{ text: string; sources: Array<{ url: string; title?: string }> }> {
  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  const sources = new Map<string, string | undefined>();
  let text = "";
  for (let turn = 0; turn < 4; turn++) {
    const resp = await client.messages.create({
      model: SONNET_MODEL,
      thinking: THINKING_OFF,
      max_tokens: opts.maxTokens ?? 4000,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: opts.maxSearches ?? 6 }],
      messages,
    });
    text = "";
    for (const b of resp.content) {
      if (b.type !== "text") continue;
      text += b.text;
      for (const c of b.citations ?? []) {
        const cc = c as { url?: string; title?: string };
        if (cc.url && !sources.has(cc.url)) sources.set(cc.url, cc.title);
      }
    }
    if (resp.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: resp.content });
  }
  return { text, sources: [...sources.entries()].slice(0, 12).map(([url, title]) => ({ url, title })) };
}
