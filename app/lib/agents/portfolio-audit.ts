import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { bucketTests, type BucketStock } from "@/app/lib/sleeve-targets";
import { sameSymbol } from "@/app/lib/model-staging";
import type { EquityBucket, PimModelData, PimPortfolioPositions } from "@/app/lib/pim-types";
import type { KillCondition, ThesisPillar } from "@/app/lib/kill-conditions";
import { fetchLivePriceSnapshot } from "@/app/lib/live-prices";
import { ANALYST_HISTORY_KEY, type AnalystHistory } from "@/app/lib/analyst-history";
import { listFlags, raiseFlag, type AgentFlag } from "./flags";
import { readAgentSettings, isWatcherOn } from "./settings";
import { AUDIT_RULES, MAIN_PROFILES, analystFindings, constructionFindings, driftFindings, driftRows, type AuditFinding, type SectorStock } from "./portfolio-audit-rules";

/**
 * Portfolio audit (Nov 2026) — plain rules, no model call, $0. The first of
 * the "unbiased auditor" checks: is every individual stock we hold backed by
 * a signed, current thesis, and has anything we marked as a problem been
 * left sitting?
 *
 * Deliberately built on RAW facts (thesis dates, pillar statuses, tripped
 * breakers) — not the composite score, which the team is not relying on.
 *
 * Also (app/lib/agents/portfolio-audit-rules.ts): position drift vs the
 * model (live prices), how the stock sleeve is constructed, and the
 * sell-side trend from the nightly consensus log.
 *
 * Held stocks = the PIM model's equity holdings outside Core and Managed
 * Alpha. Reads pm:pim-models, pm:stocks, pm:position-theses,
 * pm:pim-positions and pm:analyst-history READ-ONLY.
 * Writes only flags (through raiseFlag) and its own last-run record
 * pm:agent-state:portfolio-audit (overwritten each run; safe to nuke).
 *
 * A finding is raised ONCE: if a flag with the same dedupeKey exists in any
 * state (open, acted or dismissed) it is left alone, so a dismissed finding
 * does not come back until its key changes (a new month for the list
 * findings; a new date for a broken pillar or a tripped breaker).
 */

const log = createLogger("Portfolio-audit");
const STATE_KEY = "pm:agent-state:portfolio-audit";
export const WATCHER = "portfolio-audit";

// Thresholds and the finding shape live with the pure rules.
export { AUDIT_RULES, type AuditFinding };
export type AuditResult = { ok: boolean; skipped?: string; error?: string; date: string; held: string[]; findings: AuditFinding[]; raised: string[]; alreadyOnFile: string[] };

type Thesis = { why?: string; pillars?: ThesisPillar[]; killConditions?: KillCondition[]; underwrittenAt?: string };

const etDay = (d: Date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const daysSince = (iso: string | undefined | null, today: string) => (iso && !Number.isNaN(Date.parse(iso)) ? Math.floor((Date.parse(today) - Date.parse(iso.slice(0, 10))) / 86_400_000) : null);
const parse = <T,>(raw: string | null, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** The rules. Pure — no I/O. */
export function auditFindings(models: PimModelData | null, stocks: BucketStock[], theses: Record<string, Thesis>, today: string): { held: string[]; findings: AuditFinding[] } {
  const pim = models?.groups?.find((g) => g.id === "pim");
  if (!pim || !models) return { held: [], findings: [] };
  const tests = bucketTests(stocks, models);
  const held = pim.holdings.filter((h) => h.assetClass === "equity" && h.weightInClass > 0 && !tests.isCore(h.symbol) && !tests.isThematic(h.symbol)).map((h) => h.symbol.toUpperCase());
  const thesisFor = (sym: string) => Object.entries(theses).find(([k]) => sameSymbol(k, sym))?.[1];
  const month = today.slice(0, 7);
  const out: AuditFinding[] = [];

  const unsigned: string[] = [];
  const stale: string[] = [];
  const unassessed: string[] = [];
  const onWatch: string[] = [];

  for (const sym of held) {
    const t = thesisFor(sym);
    if (!t || !t.underwrittenAt || !(t.pillars?.length || t.why)) {
      unsigned.push(sym);
      continue;
    }
    const age = daysSince(t.underwrittenAt, today);
    if (age != null && age > AUDIT_RULES.thesisStaleDays) stale.push(`${sym} (signed ${t.underwrittenAt.slice(0, 10)})`);
    const pillars = t.pillars ?? [];
    if (pillars.length && pillars.every((p) => !p.status)) unassessed.push(sym);

    for (const p of pillars) {
      const d = daysSince(p.statusSince, today);
      if (p.status === "broken" && d != null && d >= AUDIT_RULES.brokenPillarDays)
        out.push({
          rule: "broken-pillar-held", priority: "medium", ticker: sym,
          title: `"${p.title}" has been marked broken since ${p.statusSince} and the stock is still held`,
          detail: `The pillar "${p.title}" on the ${sym} thesis was marked broken on ${p.statusSince}${p.statusNote ? ` (${p.statusNote.slice(0, 240)})` : ""}. The stock is still in the PIM model and no decision is recorded against it.`,
          suggestion: "Decide and record it: sell, cut, or re-sign the thesis saying why it still stands without this pillar.",
          dedupeKey: `audit-broken-${sym}-${p.id}-${p.statusSince}`,
        });
    }
    const longWatch = pillars.filter((p) => p.status === "watch" && (daysSince(p.statusSince, today) ?? 0) >= AUDIT_RULES.watchPillarDays);
    if (longWatch.length >= 2) onWatch.push(`${sym} (${longWatch.map((p) => p.title).join(", ")})`);

    for (const c of t.killConditions ?? []) {
      const d = daysSince(c.trippedAt, today);
      if (c.trippedAt && d != null && d >= AUDIT_RULES.trippedDays && (c.kind === "metric" || c.kind === "custom"))
        out.push({
          rule: "tripped-breaker-held", priority: "medium", ticker: sym,
          title: `A thesis breaker tripped on ${c.trippedAt.slice(0, 10)} and the stock is still held`,
          detail: `${c.theme ? `${c.theme}: ` : ""}${c.note ?? c.metric?.label ?? "a thesis breaker"} tripped on ${c.trippedAt.slice(0, 10)}${c.aiCheck?.reading ? ` (${c.aiCheck.reading.slice(0, 200)})` : ""}. The stock is still in the PIM model.`,
          suggestion: "Decide and record it: act on the breaker, or re-sign the thesis explaining why the breaker no longer applies.",
          dedupeKey: `audit-tripped-${sym}-${c.id}-${c.trippedAt.slice(0, 10)}`,
        });
    }
  }

  const list = (rule: string, priority: AuditFinding["priority"], names: string[], title: string, detail: string, suggestion: string) => {
    if (names.length) out.push({ rule, priority, title, detail: `${detail} ${names.join(", ")}.`, suggestion, dedupeKey: `audit-${rule}-${month}`, names });
  };
  list("no-signed-thesis", "medium", unsigned, `${unsigned.length} held stock${unsigned.length === 1 ? " has" : "s have"} no signed thesis`, `We own these with no signed thesis on file, so nothing states why we hold them or what would make us sell:`, "Underwrite each one on the Thesis desk (Draft with AI, then sign), or decide it should not be held.");
  list("stale-thesis", "low", stale, `${stale.length} thes${stale.length === 1 ? "is has" : "es have"} not been re-signed in over ${AUDIT_RULES.thesisStaleDays} days`, `These theses were last signed more than ${AUDIT_RULES.thesisStaleDays} days ago:`, "Re-read and re-sign each at the next monthly review.");
  list("pillars-unassessed", "low", unassessed, `${unassessed.length} thes${unassessed.length === 1 ? "is has" : "es have"} pillars with no status`, `No pillar on these theses has been marked intact, watch or broken:`, "Set a status on each pillar so a change can be tracked.");
  list("pillars-long-watch", "low", onWatch, `${onWatch.length} stock${onWatch.length === 1 ? " has" : "s have"} two or more pillars on watch for over ${AUDIT_RULES.watchPillarDays} days`, `These have had at least two pillars on "watch" for more than ${AUDIT_RULES.watchPillarDays} days without resolving either way:`, "Resolve each watch: back to intact with the evidence, or broken.");

  return { held, findings: out };
}

async function load() {
  const redis = await getRedis();
  const [modelsRaw, stocksRaw, thesesRaw, positionsRaw, analystRaw] = await Promise.all([redis.get("pm:pim-models"), redis.get("pm:stocks"), redis.get("pm:position-theses"), redis.get("pm:pim-positions"), redis.get(ANALYST_HISTORY_KEY)]);
  const stocksParsed = parse<unknown>(stocksRaw, []);
  const stocks = (Array.isArray(stocksParsed) ? stocksParsed : ((stocksParsed as { stocks?: unknown[] })?.stocks ?? [])) as (BucketStock & SectorStock)[];
  const books = parse<{ portfolios?: PimPortfolioPositions[] } | null>(positionsRaw, null)?.portfolios;
  const analyst = parse<AnalystHistory | null>(analystRaw, null);
  return {
    models: parse<PimModelData | null>(modelsRaw, null),
    stocks,
    theses: parse<Record<string, Thesis>>(thesesRaw, {}),
    books: Array.isArray(books) ? books : [],
    analyst: analyst && typeof analyst === "object" && !Array.isArray(analyst) ? analyst : {},
    ok: !!modelsRaw && !!thesesRaw,
  };
}

const ccyOf = (symbol: string): "CAD" | "USD" => {
  const t = symbol.toUpperCase();
  if (t.endsWith(".U")) return "USD";
  return t.endsWith("-T") || t.endsWith(".TO") || t.endsWith(".NE") || /^[A-Z]{2,4}\d{2,5}$/.test(t) ? "CAD" : "USD";
};

/**
 * The rules beyond the thesis store: construction, the analyst trend and
 * drift. Drift needs live prices — the same snapshot helper the daily-value
 * job uses (Yahoo incl. class shares, FUNDSERV NAVs, USD→CAD). Read-only.
 * A price that cannot be fetched leaves its book out; a failed fetch leaves
 * drift out altogether — missing data never becomes a finding.
 */
async function extraFindings(models: PimModelData | null, stocks: (BucketStock & SectorStock)[], books: PimPortfolioPositions[], analyst: AnalystHistory, held: string[], today: string): Promise<AuditFinding[]> {
  const pim = models?.groups?.find((g) => g.id === "pim");
  if (!pim || !models) return [];
  const tests = bucketTests(stocks, models);
  const bucket = (sym: string): EquityBucket => (tests.isCore(sym) ? "core" : tests.isThematic(sym) ? "thematic" : "alpha");
  const out: AuditFinding[] = [...constructionFindings(pim, bucket, stocks, today), ...analystFindings(held, analyst, today)];
  try {
    const main = books.filter((b) => b.groupId === "pim" && MAIN_PROFILES.includes(b.profile));
    const symbols = [...new Set(main.flatMap((b) => (b.positions ?? []).filter((p) => p.units > 0).map((p) => p.symbol)))];
    if (symbols.length) {
      const prices: Record<string, number | null> = {};
      const all = [...symbols, "USDCAD=X"];
      for (let i = 0; i < all.length; i += 50) Object.assign(prices, (await fetchLivePriceSnapshot(all.slice(i, i + 50))).prices);
      const fx = prices["USDCAD=X"];
      const currency = (sym: string) => pim.holdings.find((h) => sameSymbol(h.symbol, sym))?.currency ?? ccyOf(sym);
      const priceCad = (sym: string) => {
        const p = prices[sym];
        if (p == null || !(p > 0)) return null;
        if (currency(sym) !== "USD") return p;
        return fx != null && fx > 0 ? p * fx : null;
      };
      out.push(...driftFindings(driftRows(pim, bucket, main, priceCad), today));
    }
  } catch (e) {
    log.warn("drift check skipped (prices):", e);
  }
  return out;
}

/** What the audit finds right now. Read-only — raises nothing. */
export async function previewPortfolioAudit(): Promise<AuditResult> {
  const today = etDay();
  const { models, stocks, theses, books, analyst } = await load();
  const first = auditFindings(models, stocks, theses, today);
  const held = first.held;
  const findings = [...first.findings, ...(await extraFindings(models, stocks, books, analyst, held, today))];
  const flags = await listFlags();
  const onFile = (f: AuditFinding) => flags.some((x: AgentFlag) => x.dedupeKey === f.dedupeKey);
  return { ok: true, date: today, held, findings, raised: [], alreadyOnFile: findings.filter(onFile).map((f) => f.dedupeKey) };
}

/** Run the audit and raise each NEW finding as a flag. Never throws. */
export async function runPortfolioAudit(): Promise<AuditResult> {
  const today = etDay();
  const base: AuditResult = { ok: false, date: today, held: [], findings: [], raised: [], alreadyOnFile: [] };
  try {
    if (!isWatcherOn(WATCHER, await readAgentSettings())) return { ...base, ok: true, skipped: "switched off" };
    const { models, stocks, theses, books, analyst, ok } = await load();
    // A missing model or thesis store is a read problem, not "nothing is underwritten".
    if (!ok) return { ...base, ok: true, skipped: "pm:pim-models or pm:position-theses could not be read — nothing flagged" };
    const first = auditFindings(models, stocks, theses, today);
    const held = first.held;
    const findings = [...first.findings, ...(await extraFindings(models, stocks, books, analyst, held, today))];
    const flags = await listFlags();
    const raised: string[] = [];
    const alreadyOnFile: string[] = [];
    for (const f of findings) {
      if (flags.some((x) => x.dedupeKey === f.dedupeKey)) {
        alreadyOnFile.push(f.dedupeKey);
        continue;
      }
      const flag = await raiseFlag({ watcher: WATCHER, priority: f.priority, ...(f.ticker ? { ticker: f.ticker } : {}), title: f.title, detail: f.detail, suggestion: f.suggestion, dedupeKey: f.dedupeKey, evidence: [{ label: `Rule: ${f.rule}` }] });
      raised.push(flag.id);
    }
    const result: AuditResult = { ok: true, date: today, held, findings, raised, alreadyOnFile };
    await (await getRedis()).set(STATE_KEY, JSON.stringify({ at: new Date().toISOString(), date: today, held: held.length, findings: findings.map((f) => ({ rule: f.rule, ticker: f.ticker, title: f.title })), raised }));
    return result;
  } catch (e) {
    log.error("failed:", e);
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}
