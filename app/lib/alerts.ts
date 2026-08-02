/**
 * Proactive Alerts — Phase 07 of the forward-looking roadmap.
 *
 * Aggregates the highest-signal items already computed elsewhere into ONE
 * "what needs your attention" digest, so the PM doesn't have to go looking:
 *   - Thesis health: broken (high) / eroding (medium) holdings.
 *   - Regime transition: Elevated/High risk of a regime flip.
 *   - Risk alerts: holdings flagged CRITICAL by the technical risk engine.
 *
 * Pure — the route/cron hand in the already-stored signals. Ruthless
 * signal-to-noise: only genuinely actionable items become alerts.
 */

import { regimeValence } from "@/app/lib/regime-transition";

export type AlertPriority = "high" | "medium";
export type AlertCategory = "thesis" | "regime" | "technical";

export type Alert = {
  id: string;
  priority: AlertPriority;
  category: AlertCategory;
  ticker?: string;
  title: string;
  detail: string;
  /** Company name, when we know it — so the email doesn't read as bare tickers. */
  name?: string;
  /** Supporting data points behind the alert (composite + its trend, estimate
   *  revisions, price, sector...). Rendered as sub-lines in the tile and the
   *  email so the alert isn't a black box. */
  metrics?: string[];
  /** The so-what: one concrete next step. */
  action?: string;
};

/** Per-ticker supporting context used to enrich alerts (built by loadAlertInputs). */
export type StockContext = {
  name?: string;
  sector?: string;
  bucket?: string;
  price?: number | null;
  /** Latest composite from pm:score-history. */
  composite?: number | null;
  /** Composite change over ~45 days. */
  scoreDelta?: number | null;
  netRevisions?: number | null;
  revUp?: number | null;
  revDown?: number | null;
  riskLevel?: string | null;
  /** Next earnings date (YYYY-MM-DD) when known. */
  earningsDate?: string | null;
  /** "stock" | "etf" | "mutual-fund"; undefined means stock (see isScoreable).
   *  Consumed by the /thesis coverage count — funds and ETFs are not
   *  underwritable, so they must not pad the "not underwritten" list. */
  instrumentType?: string | null;
};

/** Days until the given YYYY-MM-DD (0 = today); null when absent/past/unparseable
 *  or beyond the window we care about. */
export function daysToEarnings(earningsDate: string | null | undefined, windowDays = 7): number | null {
  if (!earningsDate) return null;
  const t = Date.parse(`${earningsDate}T00:00:00Z`);
  if (isNaN(t)) return null;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const days = Math.round((t - todayUtc) / 86_400_000);
  return days >= 0 && days <= windowDays ? days : null;
}

function fmtEarnings(earningsDate: string, days: number): string {
  const d = new Date(`${earningsDate}T00:00:00Z`);
  const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return days === 0 ? `Reports TODAY (${label})` : days === 1 ? `Reports TOMORROW (${label})` : `Reports ${label} (in ${days}d)`;
}

/** Build the supporting-metric lines for a ticker. Only includes what we have. */
function metricsFor(ctx: StockContext | undefined): string[] {
  if (!ctx) return [];
  const out: string[] = [];
  // Imminent earnings lead the metrics — it's the item that changes what you
  // do about the alert this week.
  const dte = daysToEarnings(ctx.earningsDate);
  if (dte != null && ctx.earningsDate) out.unshift(fmtEarnings(ctx.earningsDate, dte));
  if (typeof ctx.composite === "number") {
    const d = ctx.scoreDelta;
    out.push(
      typeof d === "number" && d !== 0
        ? `Composite ${ctx.composite.toFixed(1)} (${d > 0 ? "+" : ""}${d.toFixed(1)} over ~45d)`
        : `Composite ${ctx.composite.toFixed(1)}`
    );
  }
  if (typeof ctx.netRevisions === "number") {
    const up = ctx.revUp ?? 0;
    const down = ctx.revDown ?? 0;
    out.push(
      `FY+1 estimate revisions ${ctx.netRevisions > 0 ? "+" : ""}${ctx.netRevisions} net (${up}↑ / ${down}↓)`
    );
  }
  if (typeof ctx.price === "number") out.push(`Price $${ctx.price.toFixed(2)}`);
  if (ctx.sector) out.push(`Sector: ${ctx.sector}`);
  return out;
}

type ThesisInput = {
  holdings?: Array<{
    ticker: string;
    verdict: string;
    summary?: string;
    drivers?: Array<{ signal: string; direction: string; detail: string }>;
  }>;
} | null;

type TransitionInput = {
  basedOnRegime?: string;
  leaning?: string;
  likelihood?: string;
  boundaryGap?: number;
  tells?: Array<{ name: string; detail?: string }>;
} | null;

type RiskInput = Array<{
  ticker: string;
  riskLevel?: string;
  bucket?: string;
  dangerSignals?: string[]; // names of the technical signals in "danger"
  riskSummary?: string;
}> | null;

export function computeAlerts(input: {
  thesis?: ThesisInput;
  transition?: TransitionInput;
  risk?: RiskInput;
  /** Per-ticker supporting context, keyed by UPPER ticker. */
  context?: Record<string, StockContext>;
  /** Kill-condition sweep from alert-inputs — YOUR pre-registered exit
   *  criteria, so a trip outranks generic signal deterioration. */
  killWatch?: Array<{
    ticker: string;
    tripped: number;
    auto: number;
    checks: Array<{ status: string; reading: string; condition: { kind: string; note?: string; threshold?: number; trippedAt?: string | null } }>;
    /** YYYY-MM-DD the quarterly re-underwrite is due (90d from underwrite). */
    reUnderwriteBy?: string;
  }>;
}): Alert[] {
  const alerts: Alert[] = [];
  const ctxFor = (tk: string) => input.context?.[tk];

  // ── Kill conditions — pre-registered exits, checked deterministically ──
  // These lead the list: unlike thesis-health (generic deterioration), a trip
  // here violates a rule YOU wrote when you underwrote the position.
  for (const kw of input.killWatch ?? []) {
    if (kw.tripped === 0) continue;
    const trippedChecks = kw.checks.filter((c) => c.status === "tripped");
    const ctx = ctxFor(kw.ticker);
    alerts.push({
      id: `kill-${kw.ticker}`,
      priority: "high",
      category: "thesis",
      ticker: kw.ticker,
      name: ctx?.name,
      title: `${kw.ticker} — ${kw.tripped} of ${kw.auto} kill condition${kw.auto === 1 ? "" : "s"} tripped`,
      detail: trippedChecks
        .map((c) => `${c.condition.kind.replace(/_/g, " ")}: ${c.reading}${c.condition.trippedAt ? ` (since ${c.condition.trippedAt})` : ""}`)
        .join(" · "),
      metrics: [
        ctx?.composite != null ? `composite ${ctx.composite}` : null,
        ctx?.netRevisions != null ? `revisions net ${ctx.netRevisions >= 0 ? "+" : ""}${ctx.netRevisions}` : null,
        ctx?.price != null ? `price ${ctx.price}` : null,
      ].filter((m): m is string => m != null),
      action:
        "This is a condition you pre-registered as 'I am wrong if…'. Open the stock page and respond — Acknowledge-hold or Flag trim/exit; either way it's logged to the journal.",
    });
  }

  // ── Re-underwrite overdue — the discipline half of the thesis system ──
  // A thesis that is never re-examined quietly becomes a position you hold
  // out of habit, so the 90-day clock gets its own alert. Deliberately
  // MEDIUM while it's freshly due: the email only fires on HIGH, so a
  // just-overdue review rides along in other emails instead of generating a
  // daily nag. Past ~30 days overdue it escalates to HIGH — at that point
  // the reminder has been ignored long enough that interrupting is correct,
  // and one re-underwrite silences it.
  const OVERDUE_ESCALATE_DAYS = 30;
  for (const kw of input.killWatch ?? []) {
    if (!kw.reUnderwriteBy) continue;
    const dueMs = Date.parse(`${kw.reUnderwriteBy}T00:00:00Z`);
    if (!isFinite(dueMs)) continue;
    const daysOver = Math.floor((Date.now() - dueMs) / 86400_000);
    if (daysOver < 0) continue; // not due yet
    const ctx = ctxFor(kw.ticker);
    alerts.push({
      id: `reunderwrite-${kw.ticker}`,
      priority: daysOver >= OVERDUE_ESCALATE_DAYS ? "high" : "medium",
      category: "thesis",
      ticker: kw.ticker,
      name: ctx?.name,
      title: `${kw.ticker} — re-underwrite ${daysOver === 0 ? "due today" : `${daysOver}d overdue`}`,
      detail: `The thesis was last signed for a 90-day window that ended ${kw.reUnderwriteBy}. Its ${kw.auto} condition${kw.auto === 1 ? "" : "s"} ${kw.tripped > 0 ? `include ${kw.tripped} tripped` : "are all holding"}, but the thesis itself has not been re-examined.`,
      metrics: [
        ctx?.composite != null ? `composite ${ctx.composite}` : null,
        ctx?.scoreDelta != null ? `Δ45d ${ctx.scoreDelta >= 0 ? "+" : ""}${ctx.scoreDelta}` : null,
      ].filter((m): m is string => m != null),
      action:
        "Open the stock page and re-underwrite: redraft the thesis against today's facts and confirm the exit conditions still describe being wrong. Comparing it to what you signed a quarter ago is the point.",
    });
  }

  // ── Thesis health — name the SPECIFIC deteriorating signals ──
  for (const h of input.thesis?.holdings ?? []) {
    const tk = (h.ticker || "").toUpperCase();
    if (!tk || (h.verdict !== "broken" && h.verdict !== "eroding")) continue;
    const ctx = ctxFor(tk);
    const negDrivers = (h.drivers ?? []).filter((d) => d.direction === "negative");
    // e.g. "composite −8.2 over ~45d · net FY+1 EPS revisions −3 · WARNING risk alert"
    const detail = negDrivers.length ? negDrivers.map((d) => d.detail).join(" · ") : h.summary || "A tracked signal is deteriorating.";
    // Catalyst escalation: a deteriorating name REPORTING within 5 days is a
    // this-week decision, not a watch item — an eroding thesis into a print is
    // exactly when you want to have already decided.
    const dte = daysToEarnings(ctx?.earningsDate, 5);
    const baseAction =
      h.verdict === "broken"
        ? "Review the position — the reason you own it is no longer supported by the tracked signals. Decide: re-underwrite, trim, or exit."
        : "Watch closely. If another driver turns (estimates, technicals, score), this becomes a broken thesis — pre-decide your trim level now.";
    alerts.push({
      id: `thesis-${tk}`,
      priority: h.verdict === "broken" || dte != null ? "high" : "medium",
      category: "thesis",
      ticker: tk,
      name: ctx?.name,
      title: `${tk} — thesis ${h.verdict}${dte != null ? ` · reports in ${dte}d` : ""}`,
      detail,
      metrics: metricsFor(ctx),
      action:
        dte != null
          ? `Earnings in ${dte} day${dte === 1 ? "" : "s"} with a ${h.verdict} thesis — decide BEFORE the print (hold through, trim into it, or hedge), not after. ${baseAction}`
          : baseAction,
    });
  }

  // ── Regime transition — the DEFENSIVE directions belong in "needs attention" ──
  // A slide toward Risk-Off is a genuine risk (high/medium by likelihood). A
  // Risk-On regime easing toward Neutral is a de-risk worth noting — surfaced as
  // a medium caution, never high. The warming directions (toward Risk-On, or a
  // Risk-Off thaw toward Neutral) are positives, routed via computeRegimeTailwind.
  const t = input.transition;
  if (t && (t.likelihood === "High" || t.likelihood === "Elevated")) {
    const val = regimeValence(t.basedOnRegime ?? "", t.leaning ?? "");
    const tellStrs = (t.tells ?? []).map((x) => (x.detail ? `${x.name} (${x.detail})` : x.name)).filter(Boolean);
    const detail = tellStrs.length ? `Driven by: ${tellStrs.join(" · ")}` : `From ${t.basedOnRegime ?? "current"}.`;
    const regimeMetrics: string[] = [];
    if (t.basedOnRegime) regimeMetrics.push(`Current regime: ${t.basedOnRegime}`);
    if (typeof t.boundaryGap === "number") {
      regimeMetrics.push(
        `${t.boundaryGap} signal${t.boundaryGap === 1 ? "" : "s"} from the label changing`
      );
    }
    if (tellStrs.length) regimeMetrics.push(`${tellStrs.length} signal${tellStrs.length === 1 ? "" : "s"} pushing toward the flip`);
    if (val === "cooling-hard") {
      alerts.push({
        id: "regime-transition",
        priority: t.likelihood === "High" ? "high" : "medium",
        category: "regime",
        title: `Regime ${t.leaning} — ${(t.likelihood ?? "").toLowerCase()} transition risk`,
        detail,
        metrics: regimeMetrics,
        action:
          "Position AHEAD of the flip, not after it: take chips off high-beta winners, favour quality/defensives, and consider tail protection while it's still cheap.",
      });
    } else if (val === "cooling-soft") {
      alerts.push({
        id: "regime-transition",
        priority: "medium",
        category: "regime",
        title: `Regime cooling from ${t.basedOnRegime} toward Neutral — ${(t.likelihood ?? "").toLowerCase()} de-risk`,
        detail,
        metrics: regimeMetrics,
        action:
          "A de-risk, not a defensive flip: stop adding beta, let winners run with tighter stops, and hold new deployments until the tells stabilise.",
      });
    }
  }

  // ── Technical breakdown (Portfolio names) — a SEPARATE dimension from the
  // fundamental thesis, deliberately labelled as such. "in the midst of"
  // breaking down = critical (high); "about to" = warning (medium). A name can
  // legitimately appear as BOTH a thesis alert and a technical one. ──
  for (const r of input.risk ?? []) {
    if (r.bucket !== "Portfolio") continue;
    const tk = (r.ticker || "").toUpperCase();
    if (!tk) continue;
    const ctx = ctxFor(tk);
    const specifics = (r.dangerSignals ?? []).filter(Boolean);
    const detail = specifics.length ? `Breaking down: ${specifics.join(", ")}.` : r.riskSummary || "Technical risk engine flagged this holding.";
    // The technical lane is deliberately separate from the fundamental thesis —
    // say so in the metrics, and note when the thesis DISAGREES (still intact),
    // because that distinction drives whether you act or ride it out.
    const techMetrics = [
      `Risk level: ${(r.riskLevel ?? "").toUpperCase()}`,
      ...(specifics.length ? [`Signals in danger: ${specifics.length}`] : []),
      ...metricsFor(ctx),
    ];
    // Catalyst escalation mirrors the thesis lane: a technical warning INTO a
    // print is a this-week decision (weak chart + event risk compound).
    const dteT = daysToEarnings(ctx?.earningsDate, 5);
    if (r.riskLevel === "critical") {
      alerts.push({
        id: `tech-${tk}`,
        priority: "high",
        category: "technical",
        ticker: tk,
        name: ctx?.name,
        title: `${tk} — breaking down technically${dteT != null ? ` · reports in ${dteT}d` : ""}`,
        detail,
        metrics: techMetrics,
        action:
          (dteT != null ? `Earnings in ${dteT} day${dteT === 1 ? "" : "s"} on a broken chart — size the event risk before the print. ` : "") +
          "This is a TECHNICAL break, not a thesis call — check the chart and your stop. If the fundamentals are still intact, decide whether you ride it out or reduce; if the thesis is also eroding, treat it as a sell signal.",
      });
    } else if (r.riskLevel === "warning") {
      alerts.push({
        id: `tech-${tk}`,
        priority: dteT != null ? "high" : "medium",
        category: "technical",
        ticker: tk,
        name: ctx?.name,
        title: `${tk} — technical warning (early)${dteT != null ? ` · reports in ${dteT}d` : ""}`,
        detail,
        metrics: techMetrics,
        action:
          dteT != null
            ? `Earnings in ${dteT} day${dteT === 1 ? "" : "s"} on a weakening chart — decide your exposure to the print now (hold, trim, or hedge); the warning alone wouldn't be actionable, the date makes it so.`
            : "Early warning only — no action required yet. Monitor; it becomes actionable if it escalates to critical or the thesis turns.",
      });
    }
  }

  // High priority first, then by category for stable ordering.
  alerts.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority === "high" ? -1 : 1;
    return a.category.localeCompare(b.category) || (a.ticker ?? "").localeCompare(b.ticker ?? "");
  });
  return alerts;
}

/**
 * Regime tailwind — the POSITIVE counterpart to the toward-Risk-Off alert.
 * When the transition gauge leans toward Risk-On with real conviction, that's a
 * market-level tailwind for a long book, not a "risk." Surfaced green alongside
 * the (ticker-level) Opportunities rather than as a red attention alert.
 */
export type RegimeTailwind = {
  leaning: string; // "toward Risk-On"
  likelihood: string; // "Elevated" | "High"
  basedOnRegime?: string;
  detail: string; // "Driven by: XLY/XLP (...) · ..."
};

export function computeRegimeTailwind(input: TransitionInput): RegimeTailwind | null {
  const t = input;
  if (!t) return null;
  if (t.likelihood !== "High" && t.likelihood !== "Elevated") return null;
  // Both warming directions count: a full lean toward Risk-On, or a Risk-Off
  // regime thawing toward Neutral (improving, even if not yet a flip).
  const val = regimeValence(t.basedOnRegime ?? "", t.leaning ?? "");
  if (val !== "warming-hard" && val !== "warming-soft") return null;
  const tellStrs = (t.tells ?? []).map((x) => (x.detail ? `${x.name} (${x.detail})` : x.name)).filter(Boolean);
  return {
    leaning: t.leaning ?? "",
    likelihood: t.likelihood,
    basedOnRegime: t.basedOnRegime,
    detail: tellStrs.length ? `Driven by: ${tellStrs.join(" · ")}` : `From ${t.basedOnRegime ?? "current"}.`,
  };
}

/**
 * Opportunities — the OFFENSIVE twin: watchlist (non-held) names where positive
 * signals are developing, for idea generation. Same data we track for the book
 * (FactSet estimate revisions cover Portfolio + Watchlist; watchlist names are
 * scored, with technicals). Kept SEPARATE from the risk alerts.
 */
export type Opportunity = {
  id: string;
  ticker: string;
  strength: "strong" | "building";
  signals: string[];
  name?: string;
  sector?: string;
  /** Latest composite, for a like-for-like read against the book. */
  composite?: number | null;
};

export function computeOpportunities(input: {
  watchlist?: Array<{ ticker: string; netRevisions?: number | null; scoreDelta?: number | null; riskLevel?: string }>;
  context?: Record<string, StockContext>;
}): Opportunity[] {
  const out: Opportunity[] = [];
  for (const w of input.watchlist ?? []) {
    const tk = (w.ticker || "").toUpperCase();
    if (!tk) continue;
    const ctx = input.context?.[tk];
    const signals: string[] = [];
    let strong = false;
    if (typeof w.netRevisions === "number" && w.netRevisions > 0) {
      signals.push(`estimates rising (+${w.netRevisions} net FY+1 revisions)`);
      if (w.netRevisions >= 3) strong = true;
    }
    if (typeof w.scoreDelta === "number" && w.scoreDelta >= 3) {
      signals.push(`score improving (+${w.scoreDelta.toFixed(1)} over ~45d)`);
      if (w.scoreDelta >= 6) strong = true;
    }
    if (signals.length && w.riskLevel === "clear") signals.push("technically clear");
    if (signals.length) {
      out.push({
        id: `opp-${tk}`,
        ticker: tk,
        strength: strong || signals.length >= 2 ? "strong" : "building",
        signals,
        name: ctx?.name,
        sector: ctx?.sector,
        composite: ctx?.composite ?? null,
      });
    }
  }
  out.sort((a, b) => (a.strength === b.strength ? a.ticker.localeCompare(b.ticker) : a.strength === "strong" ? -1 : 1));
  return out;
}

export function alertCounts(alerts: Alert[]): { high: number; medium: number; total: number } {
  return {
    high: alerts.filter((a) => a.priority === "high").length,
    medium: alerts.filter((a) => a.priority === "medium").length,
    total: alerts.length,
  };
}
