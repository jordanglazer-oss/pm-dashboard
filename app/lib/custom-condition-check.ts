import Anthropic from "@anthropic-ai/sdk";
import { getRedis } from "./redis";
import type { KillCondition } from "./kill-conditions";
import { buildTickerEvidence, latestEvidenceAt } from "./thesis-evidence";
import { parseModelJson } from "./json-repair";

/**
 * AI verification of CUSTOM kill conditions — the automation for the one
 * condition kind the deterministic watchers can't measure (e.g. "GCP quarterly
 * backlog must not decline sequentially").
 *
 * Token philosophy preserved: the model is NOT a watcher on a timer. A custom
 * condition is re-verified only when something could have changed its answer:
 *   - it has never been verified, or
 *   - NEW EVIDENCE has been ingested for the name since the last verification
 *     (an analyst report or a FactSet alert), or
 *   - the last verification is older than STALE_DAYS, as a backstop, or
 *   - the PM explicitly asks (force — the tile's "verify now" button).
 *
 * The evidence trigger replaced an earnings-DATE trigger. A date passing only
 * means the company was scheduled to report; the figures a condition asserts
 * against are not in the app until the report or alert is forwarded, so the
 * old trigger fired early and burned a web-search call that usually came back
 * "unclear". Ingest is the event that can actually change the answer.
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
/**
 * Re-verify an unchanged condition this often. 30 rather than 7 because these
 * assert things about REPORTED figures, which only move when a company
 * reports — the post-earnings trigger below is the one that matters, and a
 * weekly re-check mostly re-bought the same answer. At two customs per name
 * across the book, 7 days saturated the nightly cap with no headroom for
 * earnings bursts or the initial never-checked backlog.
 */
const STALE_DAYS = 30;
/** Bound the nightly sweep. Raised alongside the two-customs-per-thesis
 *  requirement so a batch of fresh underwrites clears in a couple of nights
 *  instead of trickling; still a runaway guard, not a budget. */
const MAX_CHECKS_PER_RUN = 10;
/** Clip a reading at a WORD boundary. A hard slice cut real Uber readings
 *  mid-number ("as of Q1 2026 (May 6, 2"), which reads like corrupted data on
 *  the card and hides the very fact the reading exists to convey. */
const MAX_READING = 260;
function clipReading(t: string): string {
  if (t.length <= MAX_READING) return t;
  const cut = t.slice(0, MAX_READING);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > MAX_READING * 0.6 ? cut.slice(0, lastSpace) : cut;
  return body.replace(/[\s(\[,;:—-]+$/, "") + "…";
}

type ThesisEntry = {
  why?: string;
  killConditions?: KillCondition[];
  [k: string]: unknown;
};

export type CustomCheckResult = {
  checked: { ticker: string; conditionId: string; status: string }[];
  skipped: number;
  /** Conditions whose verification ran but produced nothing usable. Surfaced
   *  so a failed "verify now" click reports something instead of appearing to
   *  do nothing at all. */
  failed: number;
};

function needsCheck(c: KillCondition, evidenceAt: string | null, force: boolean): boolean {
  if (c.kind !== "custom") return false;
  if (force) return true;
  if (!c.aiCheck) return true;
  // Fresh evidence ingested since the last verification → re-check.
  if (evidenceAt && evidenceAt > c.aiCheck.checkedAt) return true;
  const ageMs = Date.now() - Date.parse(c.aiCheck.checkedAt);
  return isFinite(ageMs) && ageMs > STALE_DAYS * 86400_000;
}

async function verifyOne(
  ticker: string,
  name: string,
  why: string,
  c: KillCondition,
  evidence: string,
): Promise<KillCondition["aiCheck"] | null> {
  const prompt = `You are verifying a portfolio manager's pre-registered exit condition ("kill condition") for a holding against the CURRENT reported facts. Today is ${new Date().toISOString().slice(0, 10)}.

TICKER: ${ticker}${name ? ` — ${name}` : ""}
THESIS (context only): ${why || "(none)"}
CONDITION TO VERIFY: ${c.note || "(no prose)"}
${c.trippedAt ? `Previously marked tripped ${c.trippedAt}.` : ""}
${evidence ? `\nINGESTED EVIDENCE (the PM's own analyst reports + FactSet earnings alerts, with dates — check these FIRST; they are trusted, attributable sources):\n${evidence}\n` : ""}
Procedure: if the ingested evidence above already answers the condition with a dated reported figure, use it and cite that source. Use web search only to fill gaps — when the evidence is silent, older than the latest expected report, or ambiguous. Then answer in JSON only:
{
  "status": "ok" | "tripped" | "unclear",
  "reading": "one short line. For ok/tripped: the CURRENT figure(s) and their as-of date, e.g. 'Q2 RPO $470B, +8% QoQ (reported Jul 29)'. For unclear: state WHAT IS NOT DISCLOSED and name the closest metric the company DOES report, e.g. 'Alphabet does not break out GCP backlog; it reports total RPO ($514B Q2) — rewrite the condition against RPO'",
  "evidence": "one short line naming the actual source used, e.g. 'FactSet Q2 Metrics Recap 2026-07-29' or 'Alphabet Q2 2026 earnings release (web)'",
  "undisclosed": true when status is "unclear" for a STRUCTURAL reason — the metric is not broken out at that granularity, OR is disclosed only occasionally (a milestone, an investor day, an annual figure) rather than every quarter, OR exists only outside standard reporting. Omit it ONLY when the sole reason is that the current quarter has not been reported yet,
  "suggestedRewrite": "REQUIRED when undisclosed is true: the same intent rewritten against a metric the company DOES report, in the same style as the original — name the metric, the comparison and the current reference figure. e.g. 'Google Cloud RPO must not decline sequentially from $514B (Q2 2026)'. Omit unless undisclosed."
}

Rules:
- "tripped" only when a reported fact violates the condition as written.
- "unclear" when the data needed is not yet reported or you cannot find a reliable figure — NEVER guess "ok" without a found fact.
- Classify an "unclear" into exactly ONE of three cases, and say which in the reading:
  (a) NOT BROKEN OUT — the company never reports it at that granularity. Structural. undisclosed=true, suggest a rewrite.
  (b) NOT ON A QUARTERLY CADENCE — it exists but only appears at milestones, investor days or annually, so most quarters cannot answer the condition. THIS IS ALSO STRUCTURAL: a condition that can only be checked when the company feels like announcing it is not a watchable condition. undisclosed=true, suggest a rewrite against a line item reported EVERY quarter. (Example: a subscription MEMBER COUNT is usually a milestone disclosure; the revenue or bookings line it drives is quarterly.)
  (c) QUARTER NOT REPORTED YET — the figure is a normal quarterly line and this period simply has not been published. Temporary. Omit undisclosed and suggest nothing; the next report answers it.
- The distinction that matters is CADENCE, not existence: if the metric was last disclosed one or more quarters ago and the latest report did not repeat it, that is case (b), not (c).
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
  const res = parseModelJson<{
    status?: string;
    reading?: string;
    evidence?: string;
    undisclosed?: boolean;
    suggestedRewrite?: string;
  }>(text);
  if (!res.ok) {
    console.error(
      `[custom-condition-check] ${ticker} JSON parse failed:`,
      res.error,
      res.excerpt ? `\n…${res.excerpt}…` : ""
    );
    return null;
  }
  try {
    const o = res.value;
    if (o.status !== "ok" && o.status !== "tripped" && o.status !== "unclear") return null;
    if (typeof o.reading !== "string" || !o.reading.trim()) return null;
    // A rewrite is only meaningful for the not-disclosed case; ignore one
    // offered for a quarter that simply has not been reported yet.
    const undisclosed = o.status === "unclear" && o.undisclosed === true;
    const suggestedNote =
      undisclosed && typeof o.suggestedRewrite === "string" && o.suggestedRewrite.trim()
        ? o.suggestedRewrite.trim().slice(0, 300)
        : undefined;
    return {
      status: o.status,
      reading: clipReading(o.reading.trim()),
      checkedAt: new Date().toISOString(),
      evidence: typeof o.evidence === "string" ? o.evidence.trim().slice(0, 160) : undefined,
      ...(undisclosed ? { undisclosed: true } : {}),
      ...(suggestedNote ? { suggestedNote } : {}),
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
  /** Epoch ms after which no NEW check is started. The nightly cron runs on a
   *  60s function budget shared with the backup and the email; without a wall
   *  clock this sweep could consume all of it and the digest — which sits
   *  after it — would never run. Stopping cleanly beats being killed. */
  deadlineAt?: number;
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
  let failed = 0;

  // Ingested report/FactSet evidence, memoized per ticker — built lazily so
  // a sweep where every condition is skipped costs zero extra reads.
  const evidenceCache = new Map<string, string>();
  const evidenceFor = async (tk: string): Promise<string> => {
    if (!evidenceCache.has(tk)) evidenceCache.set(tk, await buildTickerEvidence(tk).catch(() => ""));
    return evidenceCache.get(tk) ?? "";
  };

  for (const [rawTk, entry] of Object.entries(theses)) {
    const tk = rawTk.toUpperCase();
    if (only && tk !== only) continue;
    const conds = Array.isArray(entry?.killConditions) ? entry.killConditions : [];
    if (!conds.some((c) => c.kind === "custom")) continue;
    const st = stockFor(tk);
    const evidenceAt = await latestEvidenceAt(tk).catch(() => null);

    let mutated = false;
    for (const c of conds) {
      if (c.kind !== "custom") continue;
      if (!needsCheck(c, evidenceAt, opts.force === true)) {
        skipped++;
        continue;
      }
      if (checked.length >= MAX_CHECKS_PER_RUN) {
        skipped++;
        continue;
      }
      if (opts.deadlineAt != null && Date.now() >= opts.deadlineAt) {
        // Out of budget — the rest stay due and are picked up next run.
        skipped++;
        continue;
      }
      const verdict = await verifyOne(tk, st?.name || "", entry?.why || "", c, await evidenceFor(tk));
      if (!verdict) {
        failed++; // model gave nothing usable — leave the prior state intact
        continue;
      }
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

  return { checked, skipped, failed };
}
