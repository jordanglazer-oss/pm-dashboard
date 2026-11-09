import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { parseModelJson } from "@/app/lib/json-repair";
import { webResearch } from "@/app/lib/web-research";
import { POLICY_TEXT } from "@/app/lib/agents/policy";
import { abbreviationRule } from "@/app/lib/prose-style";
import { loadThemeViews, themeSlug, type ThemePillar, type Bellwether } from "@/app/lib/themes";
import type { ThesisPillar } from "@/app/lib/kill-conditions";

/**
 * POST /api/themes/draft { name, id? } — AI-drafted THEME (Phase 2): a
 * summary, 3-5 theme pillars (the durable drivers the whole theme rests on,
 * e.g. hyperscaler capex, AI-chip demand, power availability) each with a
 * proposed status + evidence, 5-8 bellwethers, and which thesis theme names
 * are the same theme (aliases). Main key, Sonnet + up to 6 web searches
 * (~15¢). WRITES NOTHING — the Themes page fills an editor and the PM signs.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const log = createLogger("Theme-draft");
const STANCES = new Set(["intact", "watch", "broken"]);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 60) : "";
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
    const id = typeof body?.id === "string" && body.id ? body.id : themeSlug(name);

    const [views, thesesRaw] = await Promise.all([loadThemeViews(), (await getRedis()).get("pm:position-theses")]);
    const existing = views.themes.find((t) => t.id === id);
    let theses: Record<string, { pillars?: ThesisPillar[] }> = {};
    try { theses = thesesRaw ? JSON.parse(thesesRaw) : {}; } catch { theses = {}; }

    // Candidate members: the existing theme's members, or the detected names that match closely.
    const candidates = existing
      ? existing.members.map((m) => ({ ticker: m.ticker, role: m.role, exposure: m.exposure }))
      : views.detected.filter((d) => d.name.toLowerCase() === name.toLowerCase()).flatMap((d) => d.tickers.map((tk) => ({ ticker: tk, role: "", exposure: undefined })));
    const memberLines = candidates
      .map((m) => {
        const ps = (theses[m.ticker]?.pillars ?? []).map((p) => p.title).join("; ");
        return `- ${m.ticker}${m.role ? `: ${m.role}` : ""}${m.exposure ? ` (${m.exposure})` : ""}${ps ? ` · thesis pillars: ${ps}` : ""}`;
      })
      .join("\n");
    const otherNames = views.detected.map((d) => `- "${d.name}" (${d.tickers.join(", ")})`).join("\n");

    const prompt = `You are drafting an INVESTMENT THEME for a portfolio manager's book. Today is ${new Date().toISOString().slice(0, 10)}. The PM will read and sign it.

${POLICY_TEXT}

THEME: ${name}
${existing ? `\nCURRENT SIGNED VERSION (being redrafted — keep what still holds):\nSummary: ${existing.summary ?? ""}\nPillars:\n${existing.pillars.map((p) => `- ${p.title}: ${p.claim}${p.status ? ` [${p.status}]` : ""}`).join("\n")}\nBellwethers: ${existing.bellwethers.map((b) => b.ticker).join(", ")}\n` : ""}
HOLDINGS IN THIS THEME (from their signed theses):
${memberLines || "(none matched yet)"}

THEME NAMES OTHER THESES USE THAT NO THEME CLAIMS YET (list in "aliases" only those that are the SAME theme):
${otherNames || "(none)"}

RESEARCH (web search, up to 6): the theme's current state — the spending, demand and supply figures that drive it, the latest guidance from the largest participants, and the main risks. Cite sources.

When the research is done, answer with ONE JSON object and nothing else:
{
  "summary": "2-3 sentences: what the theme is, why the book owns it, where it stands now",
  "aliases": ["exact names from the list above that are this theme"],
  "pillars": [ { "title": "2-5 words", "claim": "one falsifiable long-term sentence with the figure it rests on", "status": "intact" | "watch" | "broken", "statusNote": "the evidence for that status, with figures, dates and sources" } ],
  "bellwethers": [ { "ticker": "Yahoo-style ticker, e.g. MSFT or SHOP.TO", "name": "company", "why": "what its results tell us about the theme, one line" } ]
}

Rules:
- 3 to 5 pillars: the DURABLE drivers the whole theme rests on (for an AI buildout: hyperscaler capital spending, demand for AI chips, power availability), not one company's story.
- status on multi-quarter evidence; a share-price fall is never evidence; "broken" only on a structural break.
- 5 to 8 bellwethers: the companies whose guidance and results decide whether the pillars hold — usually the biggest spenders and the key suppliers. Prefer names NOT in the holdings list; a held name may appear only if it is truly a bellwether.
- No invented figures. Every figure has a source.
- ${abbreviationRule("the summary, pillars and bellwether lines")}`;

    const { text, sources } = await webResearch(prompt, { maxSearches: 6 });
    const parsed = parseModelJson<Record<string, unknown>>(text);
    if (!parsed.ok) {
      log.warn(`${name} unparseable: ${parsed.error}`);
      return NextResponse.json({ error: `draft failed — unparseable response: ${parsed.error}` }, { status: 502 });
    }
    const o = parsed.value;
    const pillars: ThemePillar[] = [];
    for (const p of Array.isArray(o.pillars) ? o.pillars : []) {
      const pp = p as Record<string, unknown>;
      const title = typeof pp.title === "string" ? pp.title.trim().slice(0, 50) : "";
      const claim = typeof pp.claim === "string" ? pp.claim.trim().slice(0, 300) : "";
      if (!title || !claim) continue;
      const status = typeof pp.status === "string" && STANCES.has(pp.status) ? (pp.status as ThemePillar["status"]) : undefined;
      const prevId = existing?.pillars.find((x) => x.title.toLowerCase() === title.toLowerCase())?.id;
      pillars.push({
        id: prevId ?? `${themeSlug(title)}-${pillars.length + 1}`,
        title,
        claim,
        ...(status ? { status, statusBy: "ai" as const } : {}),
        ...(status && typeof pp.statusNote === "string" && pp.statusNote.trim() ? { statusNote: pp.statusNote.trim().slice(0, 300) } : {}),
      });
      if (pillars.length >= 5) break;
    }
    if (pillars.length === 0) return NextResponse.json({ error: "draft failed — no usable pillars" }, { status: 502 });
    const bellwethers: Bellwether[] = [];
    for (const b of Array.isArray(o.bellwethers) ? o.bellwethers : []) {
      const bb = b as Record<string, unknown>;
      const ticker = typeof bb.ticker === "string" ? bb.ticker.trim().toUpperCase() : "";
      if (!/^[A-Z0-9.\-]{1,16}$/.test(ticker) || bellwethers.some((x) => x.ticker === ticker)) continue;
      bellwethers.push({ ticker, name: typeof bb.name === "string" ? bb.name.slice(0, 80) : undefined, why: typeof bb.why === "string" ? bb.why.slice(0, 200) : "" });
      if (bellwethers.length >= 8) break;
    }
    const detectedNames = new Set(views.detected.map((d) => d.name.toLowerCase()));
    const aliases = (Array.isArray(o.aliases) ? o.aliases : [])
      .filter((a): a is string => typeof a === "string" && detectedNames.has(a.toLowerCase()) && a.toLowerCase() !== name.toLowerCase());
    return NextResponse.json({
      draft: {
        id,
        name,
        aliases: [...new Set([...(existing?.aliases ?? []), ...aliases])],
        summary: typeof o.summary === "string" ? o.summary.trim().slice(0, 600) : "",
        pillars,
        bellwethers,
        aiDrafted: true,
      },
      sources,
    });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: "draft failed" }, { status: 500 });
  }
}
