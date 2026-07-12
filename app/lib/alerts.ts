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

export type AlertPriority = "high" | "medium";
export type AlertCategory = "thesis" | "regime" | "technical";

export type Alert = {
  id: string;
  priority: AlertPriority;
  category: AlertCategory;
  ticker?: string;
  title: string;
  detail: string;
};

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
}): Alert[] {
  const alerts: Alert[] = [];

  // ── Thesis health — name the SPECIFIC deteriorating signals ──
  for (const h of input.thesis?.holdings ?? []) {
    const tk = (h.ticker || "").toUpperCase();
    if (!tk || (h.verdict !== "broken" && h.verdict !== "eroding")) continue;
    const negDrivers = (h.drivers ?? []).filter((d) => d.direction === "negative");
    // e.g. "composite −8.2 over ~45d · net FY+1 EPS revisions −3 · WARNING risk alert"
    const detail = negDrivers.length ? negDrivers.map((d) => d.detail).join(" · ") : h.summary || "A tracked signal is deteriorating.";
    alerts.push({
      id: `thesis-${tk}`,
      priority: h.verdict === "broken" ? "high" : "medium",
      category: "thesis",
      ticker: tk,
      title: `${tk} — thesis ${h.verdict}`,
      detail,
    });
  }

  // ── Regime transition — name the SPECIFIC signals + their readings ──
  const t = input.transition;
  if (t && (t.likelihood === "High" || t.likelihood === "Elevated")) {
    const tellStrs = (t.tells ?? []).map((x) => (x.detail ? `${x.name} (${x.detail})` : x.name)).filter(Boolean);
    alerts.push({
      id: "regime-transition",
      priority: t.likelihood === "High" ? "high" : "medium",
      category: "regime",
      title: `Regime ${t.leaning ?? "shift"} — ${(t.likelihood ?? "").toLowerCase()} transition risk`,
      detail: tellStrs.length ? `Driven by: ${tellStrs.join(" · ")}` : `From ${t.basedOnRegime ?? "current"}.`,
    });
  }

  // ── Technical breakdown (Portfolio names) — a SEPARATE dimension from the
  // fundamental thesis, deliberately labelled as such. "in the midst of"
  // breaking down = critical (high); "about to" = warning (medium). A name can
  // legitimately appear as BOTH a thesis alert and a technical one. ──
  for (const r of input.risk ?? []) {
    if (r.bucket !== "Portfolio") continue;
    const tk = (r.ticker || "").toUpperCase();
    if (!tk) continue;
    const specifics = (r.dangerSignals ?? []).filter(Boolean);
    const detail = specifics.length ? `Breaking down: ${specifics.join(", ")}.` : r.riskSummary || "Technical risk engine flagged this holding.";
    if (r.riskLevel === "critical") {
      alerts.push({ id: `tech-${tk}`, priority: "high", category: "technical", ticker: tk, title: `${tk} — breaking down technically`, detail });
    } else if (r.riskLevel === "warning") {
      alerts.push({ id: `tech-${tk}`, priority: "medium", category: "technical", ticker: tk, title: `${tk} — technical warning (early)`, detail });
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
};

export function computeOpportunities(input: {
  watchlist?: Array<{ ticker: string; netRevisions?: number | null; scoreDelta?: number | null; riskLevel?: string }>;
}): Opportunity[] {
  const out: Opportunity[] = [];
  for (const w of input.watchlist ?? []) {
    const tk = (w.ticker || "").toUpperCase();
    if (!tk) continue;
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
      out.push({ id: `opp-${tk}`, ticker: tk, strength: strong || signals.length >= 2 ? "strong" : "building", signals });
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
