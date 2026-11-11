import Anthropic from "@anthropic-ai/sdk";
import { SONNET_MODEL, THINKING_OFF } from "./claude-model";
import { webResearch } from "./web-research";
import { PM_MONTHLY_EXAMPLES_EN, PM_MONTHLY_EXAMPLES_FR } from "./pm-monthly-style";
import type { MonthFacts } from "./pm-monthly-shared";

/**
 * Drafting + translation for the PM Monthly (MAIN key — a PM tool, like
 * Draft with AI). English is written from the month's facts, the PM's notes
 * and a short web check of the month's market backdrop, in the house style;
 * French is translated from the (edited) English in the house French style.
 * Nothing here writes to Redis.
 */

/** A return in WORDS only — the drafting model never sees a figure, so it can't quote one. */
function moveWord(v: number | null | undefined): string {
  if (v == null) return "unknown";
  if (v >= 8) return "rose strongly";
  if (v >= 2) return "rose";
  if (v > -2) return "was little changed";
  if (v > -8) return "fell";
  return "fell sharply";
}

function monthName(month: string, lang: "en" | "fr"): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleString(lang === "en" ? "en-CA" : "fr-CA", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function factsBlock(f: MonthFacts): string {
  const t = f.activity.trades;
  const label = (k: string) => ({ bought: "ADDED (new holding)", "sold out": "SOLD (removed)", "raised target": "weight raised", "cut target": "weight trimmed" } as Record<string, string>)[k] ?? k;
  const named = (m: { name?: string; symbol: string }) => `${m.name ?? m.symbol} (${m.symbol})`;
  const helped = f.areas.filter((a) => a.contributionPts > 0);
  const hurt = [...f.areas].reverse().filter((a) => a.contributionPts < 0);
  const areaLine = (list: typeof f.areas, kind: string) => list.filter((a) => a.kind === kind).slice(0, 3).map((a) => `${a.label} (${a.names.slice(0, 3).join(", ")})`).join("; ") || "none";
  const sleeves = f.modelReturns.filter((m) => m.profile === "core" || m.profile === "thematic" || m.profile === "alpha").sort((a, b) => b.returnPct - a.returnPct);
  const sleeveName: Record<string, string> = { core: "Core index ETFs", thematic: "Thematic funds", alpha: "the Alpha sleeve (individual stocks and Thematic funds)" };
  return [
    `Month: ${monthName(f.month, "en")}${f.partialMonth ? ` (in progress, data through ${f.through})` : ""}`,
    `Markets this month (direction only): ${f.indexReturns.map((i) => `${i.label} ${moveWord(i.returnPct)}`).join("; ")}`,
    sleeves.length ? `Parts of our portfolio, best to worst this month: ${sleeves.map((m) => `${sleeveName[m.profile]} ${moveWord(m.returnPct)}`).join("; ")}` : "",
    `Sectors that helped most: ${areaLine(helped, "sector")}. Sectors that held back: ${areaLine(hurt, "sector")}.`,
    `Themes that helped most: ${areaLine(helped, "theme")}. Themes that held back: ${areaLine(hurt, "theme")}.`,
    `Holdings that helped most: ${f.contributors.map((m) => `${named(m)} ${moveWord(m.returnPct)}`).join("; ") || "none"}`,
    `Holdings that held back most: ${f.detractors.map((m) => `${named(m)} ${moveWord(m.returnPct)}`).join("; ") || "none"}`,
    `Portfolio decisions this month: ${t.length ? t.map((x) => `${x.date} ${label(x.kind)}: ${named(x)}${x.notes ? ` — ${x.notes}` : ""}`).join("; ") : "none"}`,
    f.activity.rebalanceDays.length ? `The models were rebalanced on: ${f.activity.rebalanceDays.join(", ")}` : "No rebalance this month.",
    f.activity.modelChanges.length ? `Model changes: ${f.activity.modelChanges.map((c) => `${c.date} ${c.note}`).join("; ")}` : "",
    f.context.addedWhy.length ? `Why we bought (our theses):\n${f.context.addedWhy.map((a) => `  ${named(a)}: ${a.why || "(no thesis on file)"}`).join("\n")}` : "",
    f.context.soldWhy.length ? `Why we sold:\n${f.context.soldWhy.map((a) => `  ${named(a)}: ${a.why || "(no reason on file)"}`).join("\n")}` : "",
    f.activity.journal.length ? `Decision journal: ${f.activity.journal.map((j) => `${j.date} ${j.ticker ?? ""} ${j.action}: ${j.rationale}`).join(" | ")}` : "",
    f.context.actedFlags.length ? `Watcher alerts we acted on: ${f.context.actedFlags.map((x) => `${x.date} ${x.title}${x.note ? ` (PM: ${x.note})` : ""}`).join("; ")}` : "",
    f.context.memoHeadlines.length ? `Our weekly memos this month: ${f.context.memoHeadlines.map((m) => `${m.date}: ${m.headline} [${m.items.join("; ")}]`).join(" | ")}` : "",
    `Our current read (internal brief${f.outlook.briefDate ? ` ${f.outlook.briefDate}` : ""}): regime ${f.outlook.regime ?? "?"}. ${f.outlook.bottomLine ?? ""} Tactical: ${f.outlook.tactical ?? "?"} Cyclical: ${f.outlook.cyclical ?? "?"}`,
  ].filter(Boolean).join("\n").replace(/[-+−]?\d+(?:[.,]\d+)?\s?%/g, "[figure removed]");
}

const RULES = `House rules:
- Follow the EXAMPLES' structure, tone and length exactly: two short opening paragraphs on the month's market backdrop with one or two specific, verifiable facts; "## <Month> Portfolio Activity"; a short "## What Drove Performance" paragraph; "## Market Outlook" (2-3 paragraphs); "Thank you for your continued trust."; sign-off "Di Iorio Family Wealth".
- Portfolio Activity: if names were ADDED or SOLD, open with the line "The activity below applies to our discretionary managed accounts and may not apply to accounts with different mandates or portfolio exceptions.", then "### Portfolio Additions" / "### Portfolio Subtractions" with one paragraph per company in the form "Company Name (TICKER): what the business does and why we own it / why we sold it" — plain language a client understands. Weight changes and rebalances are described in general terms, as in the October example, never as percentages. If nothing changed, say so in one sentence. Mention the "Core and Explore" framework once.
- What Drove Performance: 2-4 sentences on the AREAS that drove the month (which parts of the portfolio, sectors and themes helped and which held back), naming a few companies as examples, with the business reason where the research shows one. Describe direction only ("led", "helped", "held back") — never magnitude.
- NO RETURN FIGURES ANYWHERE: never write a percentage or number for any return, gain, loss or price move — not ours, not a model's, not an index's, not a company's (no "rose 12%", no "+3.4%", no "the S&P 500 gained 2%", no historical average returns). Other statistics that are not returns (e.g. the share of companies beating earnings estimates, an election date) are fine when the research supports them.
- Outlook: constructive and long-term; ground it in earnings and the themes we own; acknowledge risks; when citing history, describe it in words ("has historically been a favourable period") without return figures, and add that it does not guarantee future returns. No forecasts of index levels, no promises.
- Never invent a fact or figure. Market facts must come from the research you did; portfolio facts only from the FACTS block and the PM's notes. The PM's notes override anything else.
- Format: plain text. "## " for section headings, "### " for sub-headings, a blank line between paragraphs. No bold, no bullets, no markdown other than the headings.`;

export async function draftEnglish(f: MonthFacts, notes: string): Promise<{ text: string; sources: { url: string; title?: string }[] }> {
  const month = monthName(f.month, "en");
  const prompt = `You write the "PM Monthly", the monthly client update from Di Iorio Family Wealth (RBC Dominion Securities) for clients in its discretionary managed portfolios.

First research the month's market backdrop on the web (at most 5 searches): what moved the S&P 500 and the S&P/TSX in ${month}, earnings season, inflation and rates, notable events; and, briefly, the business behind any company we ADDED or SOLD and the main reason behind the largest contributors and detractors. Then write the update. Everything about our portfolio comes from the FACTS block — it is drawn from our dashboard; the PM's notes, when given, add to or override it.

${RULES}

=== FACTS (from our dashboard) ===
${factsBlock(f)}

=== PM'S NOTES FOR THE MONTH (authoritative) ===
${notes.trim() || "(none — rely on the FACTS block)"}

=== STYLE EXAMPLES (copy the style, never the facts) ===
${PM_MONTHLY_EXAMPLES_EN}

Write the update for ${month} between the markers <<<UPDATE>>> and <<<END>>>, starting with the first paragraph (no title line). Nothing you write outside the markers is used.`;
  const r = await webResearch(prompt, { maxSearches: 5, maxTokens: 4000 });
  const m = r.text.match(/<<<UPDATE>>>([\s\S]*?)(?:<<<END>>>|$)/);
  return { text: (m ? m[1] : r.text).trim(), sources: r.sources };
}

export async function translateToFrench(en: string, month: string): Promise<string> {
  const client = new Anthropic();
  const resp = await client.messages.create({
    model: SONNET_MODEL,
    thinking: THINKING_OFF,
    max_tokens: 4000,
    messages: [
      {
        role: "user",
        content: `Translate this client update from Di Iorio Family Wealth into Canadian French, matching the house French style in the examples: natural Québec financial French (not a word-for-word translation), « » quotation marks, "FNB" for ETFs, a space before % ("83 %"), headings translated as in the examples ("## Activité du portefeuille en ${monthName(month, "fr").split(" ")[0]}", "## Perspectives du marché", "### Ajouts au portefeuille", "### Retraits du portefeuille", "## Facteurs de rendement" for What Drove Performance), sign-off "Gestion de patrimoine familial Di Iorio". Keep company names and tickers as they are. Keep exactly the same sections, paragraphs and facts — add nothing, drop nothing, and add no return figures. Keep the "## " / "### " heading markers and blank lines between paragraphs.

=== FRENCH STYLE EXAMPLES ===
${PM_MONTHLY_EXAMPLES_FR}

=== ENGLISH TO TRANSLATE ===
${en}

Return ONLY the French text.`,
      },
    ],
  });
  return resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
}
