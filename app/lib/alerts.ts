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
export type AlertCategory = "thesis" | "regime" | "risk";

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

type RiskInput = Array<{ ticker: string; riskLevel?: string; bucket?: string }> | null;

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

  // ── Critical technical risk (Portfolio names only) ──
  for (const r of input.risk ?? []) {
    if (r.bucket !== "Portfolio") continue;
    if (r.riskLevel !== "critical") continue;
    const tk = (r.ticker || "").toUpperCase();
    if (!tk) continue;
    // Avoid a duplicate line if the thesis already flagged this name as broken.
    if (alerts.some((a) => a.ticker === tk && a.priority === "high")) continue;
    alerts.push({
      id: `risk-${tk}`,
      priority: "high",
      category: "risk",
      ticker: tk,
      title: `${tk} — critical risk alert`,
      detail: "Technical risk engine flagged this holding CRITICAL.",
    });
  }

  // High priority first, then by category for stable ordering.
  alerts.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority === "high" ? -1 : 1;
    return a.category.localeCompare(b.category) || (a.ticker ?? "").localeCompare(b.ticker ?? "");
  });
  return alerts;
}

export function alertCounts(alerts: Alert[]): { high: number; medium: number; total: number } {
  return {
    high: alerts.filter((a) => a.priority === "high").length,
    medium: alerts.filter((a) => a.priority === "medium").length,
    total: alerts.length,
  };
}
