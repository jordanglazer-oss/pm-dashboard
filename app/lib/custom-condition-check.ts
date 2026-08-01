import Anthropic from "@anthropic-ai/sdk";
import { getRedis } from "./redis";
import type { KillCondition } from "./kill-conditions";

/**
 * AI verification of CUSTOM kill conditions — the automation for the one
 * condition kind the deterministic watchers can't measure (e.g. "GCP quarterly
 * backlog must not decline sequentially").
 *
 * Token philosophy preserved: the model is NOT a watcher on a timer. A custom
 * condition is re-verified only when something could have changed its answer:
 *   - it has never been verified, or
 *   - the name reported earnings since the last verification, or
 *   - the last verification is older than STALE_DAYS (facts drift), or
 *   - the PM explicitly asks (force — the tile's "verify now" button).
 *
 * Each verification is one Sonnet call WITH the web-search tool (max 3
 * searches), so the model checks the condition against the actual world —
 * filings, earnings reports, IR pages — not against its training data. The
 * verdict is persisted onto the condition (aiCheck) via read-merge-write on
 * pm:position-theses; from there app/lib/kill-conditions reports it instead of
 * "manual", which means a tripped custom condition flows into the alerts tile,
 * the morning digest, and Thesis Watch exactly like a template condition.
 *
 * "unclear" is a first-class verdict (renders NO DATA, never OK): if the web
 * can't answer the condition yet — e.g. the relevant quarter isn't reported —
 * saying so honestly beats a fabricated pass.
 */

const client = new Anthropic();

const KEY = "pm:position-theses";
const STALE_DAYS = 7;
/** Bound the nightly sweep — customs are few; this is a runaway guard. */
const MAX_CHECKS_PER_RUN = 6;

type ThesisEntry = {
  why?: string;
  killConditions?: KillCondition[];
  [k: string]: unknown;
};

export type CustomCheckResult = {
  checked: { ticker: string; conditionId: string; status: string }[];
  skipped: number;
};

function needsCheck(c: KillCondition, earningsDate: string | null, force: boolean): boolean {
  if (c.kind !== "custom") return false;
  if (force) return true;
  if (!c.aiCheck) return true;
  const checkedDay = c.aiCheck.checkedAt.slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  // Earnings landed between the last check and today → the answer may have changed.
  if (earningsDate && earningsDate > checkedDay && earningsDate <= today) return true;
  const ageMs = Date.now() - Date.parse(c.aiCheck.checkedAt);
  return isFinite(ageMs) && ageMs > STALE_DAYS * 86400_000;
}

async function verifyOne(
  ticker: string,
  name: string,
  why: string,
  c: KillCondition,
): Promise<KillCondition["aiCheck"] | null> {
  const prompt = `You are verifying a portfolio manager's pre-registered exit condition ("kill condition") for a holding, using web search to find the CURRENT facts. Today is ${new Date().toISOString().slice(0, 10)}.

TICKER: ${ticker}${name ? ` — ${name}` : ""}
THESIS (context only): ${why || "(none)"}
CONDITION TO VERIFY: ${c.note || "(no prose)"}
${c.trippedAt ? `Previously marked tripped ${c.trippedAt}.` : ""}

Search for the most recent reported figures relevant to this condition (latest quarterly filing, earnings release, or company disclosure). Then answer in JSON only:
{
  "status": "ok" | "tripped" | "unclear",
  "reading": "one short line with the CURRENT figure(s) and their as-of date, e.g. 'Q2 RPO $470B, +8% QoQ (reported Jul 29)'",
  "evidence": "one short line naming the source, e.g. 'Alphabet Q2 2026 earnings release'"
}

Rules:
- "tripped" only when a reported fact violates the condition as written.
- "unclear" when the data needed is not yet reported or you cannot find a reliable figure — NEVER guess "ok" without a found fact.
- The reading must contain a real figure/date you found, not a restatement of the condition.`;

  const resp = await client.messages.create({
    model: "claude-sonnet-5",
    thinking: { type: "disabled" },
    max_tokens: 1200,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    messages: [{ role: "user", content: prompt }],
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const o = JSON.parse(match[0]) as { status?: string; reading?: string; evidence?: string };
    if (o.status !== "ok" && o.status !== "tripped" && o.status !== "unclear") return null;
    if (typeof o.reading !== "string" || !o.reading.trim()) return null;
    return {
      status: o.status,
      reading: o.reading.trim().slice(0, 200),
      checkedAt: new Date().toISOString(),
      evidence: typeof o.evidence === "string" ? o.evidence.trim().slice(0, 160) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Verify due custom conditions. `ticker` restricts to one name (UI button);
 * omitted = the nightly sweep over every underwritten holding.
 */
export async function runCustomConditionChecks(opts: {
  ticker?: string;
  force?: boolean;
}): Promise<CustomCheckResult> {
  const redis = await getRedis();
  const [thesesRaw, stocksRaw] = await Promise.all([redis.get(KEY), redis.get("pm:stocks")]);
  const theses: Record<string, ThesisEntry> = thesesRaw ? JSON.parse(thesesRaw) : {};
  type StoredStock = { ticker?: string; name?: string; earningsDate?: string };
  const stocks: StoredStock[] = stocksRaw ? JSON.parse(stocksRaw) : [];
  const stockFor = (tk: string) => stocks.find((s) => (s.ticker || "").toUpperCase() === tk);

  const only = opts.ticker?.trim().toUpperCase();
  const checked: CustomCheckResult["checked"] = [];
  let skipped = 0;

  for (const [rawTk, entry] of Object.entries(theses)) {
    const tk = rawTk.toUpperCase();
    if (only && tk !== only) continue;
    const conds = Array.isArray(entry?.killConditions) ? entry.killConditions : [];
    if (!conds.some((c) => c.kind === "custom")) continue;
    const st = stockFor(tk);
    const earnings = typeof st?.earningsDate === "string" ? st.earningsDate.slice(0, 10) : null;

    let mutated = false;
    for (const c of conds) {
      if (c.kind !== "custom") continue;
      if (!needsCheck(c, earnings, opts.force === true)) {
        skipped++;
        continue;
      }
      if (checked.length >= MAX_CHECKS_PER_RUN) {
        skipped++;
        continue;
      }
      const verdict = await verifyOne(tk, st?.name || "", entry?.why || "", c);
      if (!verdict) continue; // model gave nothing usable — leave prior state
      c.aiCheck = verdict;
      // Trip stamping, same semantics the tile uses for template conditions.
      if (verdict.status === "tripped" && !c.trippedAt) c.trippedAt = new Date().toISOString().slice(0, 10);
      if (verdict.status === "ok" && c.trippedAt) c.trippedAt = null;
      mutated = true;
      checked.push({ ticker: tk, conditionId: c.id, status: verdict.status });
    }

    if (mutated) {
      // Read-merge-write per ticker: re-read so a concurrent save of another
      // ticker (or of this ticker's prose) is never clobbered.
      const freshRaw = await redis.get(KEY);
      const fresh: Record<string, ThesisEntry> = freshRaw ? JSON.parse(freshRaw) : {};
      const cur = fresh[rawTk] ?? fresh[tk];
      if (cur && Array.isArray(cur.killConditions)) {
        for (const c of conds) {
          if (c.kind !== "custom" || !c.aiCheck) continue;
          const target = (cur.killConditions as KillCondition[]).find((x) => x.id === c.id);
          if (target) {
            target.aiCheck = c.aiCheck;
            target.trippedAt = c.trippedAt;
          }
        }
        fresh[rawTk in fresh ? rawTk : tk] = cur;
        await redis.set(KEY, JSON.stringify(fresh));
      }
    }
  }

  return { checked, skipped };
}
