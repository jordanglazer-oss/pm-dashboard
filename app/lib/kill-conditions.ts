/**
 * Kill conditions — pre-registered, machine-checkable exit criteria per
 * holding. The structured half of the thesis-discipline build (preview-only).
 *
 * Design rules:
 *   - Conditions are chosen from a fixed template set so every one of them is
 *     DETERMINISTICALLY checkable from data the app already stores. No LLM in
 *     the loop; zero tokens until a trip needs a written thesis check.
 *   - Evaluation is pure and read-only: signals in, statuses out. Persistence
 *     of trip timestamps happens in the caller (read-merge-write on
 *     pm:position-theses), never here.
 *   - A condition the data can't currently answer reports "unknown", never a
 *     silent OK — an unwatchable kill condition is a false sense of safety.
 *   - `custom` conditions are prose; once an AI web-search verification has
 *     run (app/lib/custom-condition-check — post-earnings / weekly / on
 *     demand) they report that persisted verdict and join the automated trip
 *     counts. Unverified customs remain "manual" reminders.
 *
 * Related stores (all pre-existing):
 *   pm:position-theses  — extended with { killConditions, underwrittenAt, ... }
 *   pm:score-history    — feeds score_floor / score_decay
 *   pm:analyst-snapshots — feeds revisions
 *   pm:stocks            — feeds risk_alert / ma200 (riskAlert, price,
 *                          twoHundredDayAvg via technicals)
 */

export type KillConditionKind =
  | "score_floor" // composite score must stay ≥ threshold
  | "score_decay" // composite must not fall by ≥ threshold points over ~45d
  | "revisions" // net FY+1 revisions (revUp − revDown) must stay > threshold
  | "risk_alert" // no CRITICAL technical risk alert on the name
  | "ma200" // price must hold above the 200-day average
  | "custom"; // prose-only, manually judged

export type KillCondition = {
  id: string;
  kind: KillConditionKind;
  /** Numeric threshold where the kind takes one (score_floor: min score;
   *  score_decay: max drop in points; revisions: min net revisions, usually 0
   *  or a negative floor like -3). Ignored for risk_alert / ma200 / custom. */
  threshold?: number;
  /** Prose for custom conditions; optional annotation on the others. */
  note?: string;
  /** Which leg of the thesis this condition guards, in 2-4 words (e.g.
   *  "Cloud growth", "Search resilience", "Capex → profit"). Set on custom
   *  conditions so a card shows WHAT each breaker is protecting, not just the
   *  metric — a list of raw metrics reads as trivia detached from the thesis. */
  theme?: string;
  /** ISO date this condition was registered — pre-registration timestamp. */
  addedAt: string;
  /** Set by the caller when a check transitions OK → TRIPPED; cleared when it
   *  recovers. Persisted so "TRIPPED Jul 24" survives reloads. */
  trippedAt?: string | null;
  /** Latest AI verification of a CUSTOM condition (web-search-backed Sonnet
   *  call — app/lib/custom-condition-check). Written by the nightly chain
   *  (post-earnings / weekly staleness) and the tile's "verify now" button.
   *  When present, the custom condition reports this verdict instead of
   *  "manual", so trips flow into alerts/digest like any template kind. */
  aiCheck?: {
    status: "ok" | "tripped" | "unclear";
    /** Short current-fact reading, e.g. "Q2 RPO $470B, up QoQ (reported Jul 29)". */
    reading: string;
    checkedAt: string; // ISO timestamp
    /** One-line source note, e.g. "Alphabet Q2 2026 10-Q". */
    evidence?: string;
    /** True when "unclear" is because the company does NOT DISCLOSE the metric
     *  at that granularity — a permanently unverifiable condition, as opposed
     *  to a quarter that simply has not been reported yet. */
    undisclosed?: boolean;
    /** A checkable replacement written against a metric the company DOES
     *  report. Proposed only — applying it is a deliberate click, because a
     *  silently rewritten condition is no longer the one the PM signed. */
    suggestedNote?: string;
  };
  /** Set when a suggestion was applied: the wording this condition replaced.
   *  Keeps the pre-registration audit trail honest about what changed. */
  rewrittenFrom?: string;
  /** ISO date the rewrite was accepted. */
  rewrittenAt?: string;
};

export type KillStatus = "ok" | "tripped" | "unknown" | "manual";

export type KillCheck = {
  condition: KillCondition;
  status: KillStatus;
  /** Human-readable current reading, e.g. "now 62" or "▼ net −6 (8 down / 2 up)". */
  reading: string;
};

/** Everything the evaluator may consult. All optional — missing data yields
 *  "unknown" for the conditions that need it, never a fabricated OK. */
export type KillSignals = {
  /** Latest adjusted composite (the ~41-pt scale, e.g. 22.4/40). */
  score?: number | null;
  /** Composite change over the thesis-health lookback (~45d). */
  scoreDelta45d?: number | null;
  /** revUp − revDown from the latest analyst snapshot. */
  netRevisions?: number | null;
  /** Counts behind netRevisions, for the reading string. */
  revUp?: number | null;
  revDown?: number | null;
  /** Current risk alert level string (e.g. "CRITICAL", "WARNING"). */
  riskLevel?: string | null;
  /** Latest price and 200-day average. */
  price?: number | null;
  ma200?: number | null;
};

export const KILL_TEMPLATES: {
  kind: KillConditionKind;
  label: string;
  /** Default threshold offered by the editor. */
  defaultThreshold?: number;
  describe: (threshold?: number) => string;
}[] = [
  { kind: "score_floor", label: "Score floor", defaultThreshold: 22, describe: (t) => `Composite stays ≥ ${t ?? 22}` },
  { kind: "score_decay", label: "Score decay", defaultThreshold: 5, describe: (t) => `Composite does not drop ≥ ${t ?? 5} pts over ~45d` },
  { kind: "revisions", label: "Estimate revisions", defaultThreshold: 0, describe: (t) => `Net FY+1 revisions stay ${(t ?? 0) === 0 ? "non-negative" : `> ${t}`}` },
  { kind: "risk_alert", label: "Risk alert", describe: () => "No CRITICAL technical alert" },
  { kind: "ma200", label: "200-day average", describe: () => "Price holds above the 200DMA" },
  { kind: "custom", label: "Custom (AI-checked)", describe: () => "Verified by AI web check after each earnings report" },
];

export function describeCondition(c: KillCondition): string {
  if (c.kind === "custom") return c.note || "Custom condition";
  const t = KILL_TEMPLATES.find((x) => x.kind === c.kind);
  return t ? t.describe(c.threshold) : c.kind;
}

const fmt = (n: number | null | undefined, dp = 0): string =>
  n == null || !isFinite(n) ? "—" : n.toFixed(dp);

/** Pure check of one condition against the current signals. */
export function checkCondition(c: KillCondition, s: KillSignals): KillCheck {
  switch (c.kind) {
    case "score_floor": {
      const th = c.threshold ?? 22;
      if (s.score == null) return { condition: c, status: "unknown", reading: "score unavailable" };
      return {
        condition: c,
        status: s.score >= th ? "ok" : "tripped",
        reading: `now ${fmt(s.score, 1)}`,
      };
    }
    case "score_decay": {
      const th = c.threshold ?? 5;
      if (s.scoreDelta45d == null) return { condition: c, status: "unknown", reading: "no score history yet" };
      return {
        condition: c,
        status: s.scoreDelta45d <= -th ? "tripped" : "ok",
        reading: `${s.scoreDelta45d >= 0 ? "+" : ""}${fmt(s.scoreDelta45d, 1)} pts over ~45d`,
      };
    }
    case "revisions": {
      const th = c.threshold ?? 0;
      if (s.netRevisions == null) return { condition: c, status: "unknown", reading: "no estimate snapshot" };
      const detail = s.revUp != null || s.revDown != null ? ` (${s.revUp ?? 0}▲ / ${s.revDown ?? 0}▼)` : "";
      return {
        condition: c,
        status: s.netRevisions >= th ? "ok" : "tripped",
        reading: `net ${s.netRevisions >= 0 ? "+" : ""}${s.netRevisions}${detail}`,
      };
    }
    case "risk_alert": {
      if (s.riskLevel === undefined) return { condition: c, status: "unknown", reading: "no technical read" };
      const critical = (s.riskLevel || "").toUpperCase() === "CRITICAL";
      return {
        condition: c,
        status: critical ? "tripped" : "ok",
        reading: s.riskLevel ? `now ${s.riskLevel}` : "no alert",
      };
    }
    case "ma200": {
      if (s.price == null || s.ma200 == null || s.ma200 <= 0)
        return { condition: c, status: "unknown", reading: "200DMA unavailable" };
      const pct = ((s.price - s.ma200) / s.ma200) * 100;
      return {
        condition: c,
        status: s.price >= s.ma200 ? "ok" : "tripped",
        reading: `${pct >= 0 ? "+" : ""}${fmt(pct, 1)}% vs 200DMA`,
      };
    }
    case "custom": {
      // AI-verified custom: report the persisted verdict (unclear → unknown so
      // it can never silently pass as OK). Falls back to manual when unchecked.
      if (c.aiCheck) {
        const when = c.aiCheck.checkedAt.slice(0, 10);
        return {
          condition: c,
          status: c.aiCheck.status === "unclear" ? "unknown" : c.aiCheck.status,
          reading: `${c.aiCheck.reading} · AI-checked ${when}`,
        };
      }
      return { condition: c, status: "manual", reading: "manual check" };
    }
  }
}

export function checkAll(conditions: KillCondition[], s: KillSignals): KillCheck[] {
  return conditions.map((c) => checkCondition(c, s));
}

/** Tripped count over auto-checkable conditions only (manual excluded). */
export function trippedCount(checks: KillCheck[]): { tripped: number; auto: number } {
  const auto = checks.filter((k) => k.status !== "manual");
  return { tripped: auto.filter((k) => k.status === "tripped").length, auto: auto.length };
}
