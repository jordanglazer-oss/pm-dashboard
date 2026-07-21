import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getRedis } from "@/app/lib/redis";
import { buildHedgingCostsBlock, buildHedgeChecklistBlock } from "@/app/lib/hedging";
import { computeRegimeTransition } from "@/app/lib/regime-transition";
import type { MarketRegimeData } from "@/app/lib/market-regime";

/**
 * Standalone hedging refresh — re-runs ONLY the hedging read (live CBOE
 * premiums + percentile context + entry checklist + one small focused
 * Anthropic call) without regenerating the whole brief. Premiums move
 * intraday; the rest of the brief doesn't need to be re-paid to re-check
 * whether protection got cheap.
 *
 * Server-side this is READ-ONLY vs pm:brief — it returns fresh
 * { hedgingAnalysis, hedgingCall } and the CLIENT merges them into the brief
 * through the normal StockContext persist path (components → context →
 * /api/kv/brief), same as every other brief mutation. Uses the SAME
 * buildHedgeChecklistBlock as the morning brief so both always score
 * identically.
 */

export const maxDuration = 60;

const client = new Anthropic();

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export async function POST() {
  try {
    const redis = await getRedis();
    const [hedgingCosts, marketRegimeRaw, marketRaw, briefRaw] = await Promise.all([
      buildHedgingCostsBlock(),
      redis.get("pm:market-regime"),
      redis.get("pm:market"),
      redis.get("pm:brief"),
    ]);
    if (!hedgingCosts.text) {
      return NextResponse.json({ ok: false, error: "Live hedging costs unavailable (CBOE fetch failed) — try again in a minute." });
    }

    const marketRegime = parse<MarketRegimeData>(marketRegimeRaw);
    const market = parse<{ fearGreed?: number; spOscillator?: number; termStructure?: string; riskRegime?: string }>(marketRaw) ?? {};
    const brief = parse<{
      marketRegime?: string;
      tacticalView?: string; cyclicalView?: string; structuralView?: string;
      hedgingCall?: { action?: string; strike?: string; tenor?: string };
    }>(briefRaw);

    const consolidatedRegime = marketRegime?.composite?.label ?? market.riskRegime ?? "Neutral";
    const regimeTransition = marketRegime ? computeRegimeTransition(marketRegime) : null;
    const vix = marketRegime?.crossAsset?.vix?.price ?? null;

    const checklist = buildHedgeChecklistBlock({
      consolidatedRegime,
      transitionLeaning: regimeTransition?.leaning ?? null,
      transitionLikelihood: regimeTransition?.likelihood ?? null,
      riskOffSignalCount:
        marketRegime?.composite?.signals?.filter((s) => s.direction === "risk-off").length ?? null,
      ctx: hedgingCosts.ctx,
      fearGreed: typeof market.fearGreed === "number" ? market.fearGreed : null,
      oscillator: typeof market.spOscillator === "number" ? market.spOscillator : null,
      vix,
      termStructure: market.termStructure ?? "",
    });

    const horizonContext = brief
      ? `\nCONTEXT FROM TODAY'S BRIEF (for tenor selection — do NOT re-litigate these views, just hedge against them):\n- Regime label: ${brief.marketRegime ?? consolidatedRegime}\n- Tactical (1-3M): ${brief.tacticalView ?? "n/a"}\n- Cyclical (3-6M): ${brief.cyclicalView ?? "n/a"}\n- Structural (6-12M): ${brief.structuralView ?? "n/a"}\n- Current hedging call on the books: ${brief.hedgingCall?.action ?? "none"}${brief.hedgingCall?.strike ? ` (${brief.hedgingCall.tenor ?? ""} ${brief.hedgingCall.strike})` : ""}`
      : "";

    const prompt = `You are the hedging analyst for a PM dashboard. Produce ONLY a refreshed hedging read from the live data below — the rest of the day's brief stays as-is.

HEDGING PHILOSOPHY: tail-risk INSURANCE, not a directional bet. Hedging is NOT a default — only when the cost is reasonable AND the broader picture warrants it. SKIP is a first-class recommendation. PROTECTIVE SPY PUTS ONLY; strikes 5–10% OTM (ATM only for acute ≤30d tail risk with an explicit trigger); tenor strictly 2–9 months (tactical Risk-Off → 2–3M; cyclical → 3–6M; structural → 6–9M; never LEAPS, never weeklies).

'Cheap' and 'rich' are DEFINED by the computed premium percentiles below — never assert them from VIX or intuition; if the ledger is too thin to rank, say so. Cite at least one specific 5–10% OTM premium AND its percentile. Ground the call in the checklist's ✓/✗ lines; you may override a line with judgment but name it and why.

${hedgingCosts.text}${checklist}
${vix != null ? `\nVIX: ${vix}` : ""}${market.termStructure ? ` | Term structure: ${market.termStructure}` : ""}${typeof market.fearGreed === "number" ? ` | Fear & Greed: ${market.fearGreed}` : ""}${typeof market.spOscillator === "number" ? ` | S&P Oscillator: ${market.spOscillator}%` : ""}
${horizonContext}

Return ONLY this JSON (no markdown fences):
{
  "hedgingAnalysis": "3-4 sentences. The refreshed hedging read: cite the specific premium + percentile, the checklist lines driving the call, and the clear directional recommendation.",
  "hedgingCall": { "action": "ADD | HOLD | SKIP", "strike": "e.g. 7% OTM (omit unless ADD)", "tenor": "e.g. 3 months (omit unless ADD)", "reason": "ONE short sentence — the why." }
}`;

    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd <= jsonStart) {
      return NextResponse.json({ ok: false, error: "Model returned no parseable JSON." });
    }
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as {
      hedgingAnalysis?: string;
      hedgingCall?: { action?: string; strike?: string; tenor?: string; reason?: string };
    };
    if (!parsed.hedgingAnalysis || !parsed.hedgingCall?.action) {
      return NextResponse.json({ ok: false, error: "Model response missing hedgingAnalysis/hedgingCall." });
    }

    return NextResponse.json({
      ok: true,
      hedgingAnalysis: parsed.hedgingAnalysis,
      hedgingCall: parsed.hedgingCall,
      hedgingRefreshedAt: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
