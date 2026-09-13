/**
 * Entry conditions — the "promotion case" for Watchlist and Suggested names.
 * The mirror image of kill conditions: a standard scorecard of signals that
 * says a name is looking MORE favourable. No authoring needed per name; every
 * Watchlist and Suggested name is scored the same way.
 *
 * Rubric v3 unification (Sep 2026): the tape is judged ONCE, by the setup
 * grade (app/lib/setup-grade.ts — SIA + BoostedAI + MarketEdge, plus the PM's
 * charting once scored). It replaced five separate technical signals here
 * (above 200-day, 50 over 200, SIA level, SIA rising, MarketEdge Long). With
 * READY_MIN at 5 and exactly five technical signals, a name could read "Ready
 * to buy" on the tape alone with no fundamental, revision, catalyst or
 * research support — the blended-score problem, in the funnel.
 *
 * A name is READY when (1) the setup grade is Constructive or better,
 * (2) no CRITICAL technical alert is on, and (3) at least CASE_MIN of the six
 * non-technical signals are met (no critical alert counts as one of them, so
 * in practice two of: Equate, revisions, synthesis, catalyst, confluence).
 * The flip INTO ready is what pushes: an alert in the digest / Attention
 * panel and a row on the Funnel's "Ready to buy" list (see entry-scan.ts).
 *
 * Pure: signals in, statuses out. The server assembler lives in entry-scan.ts.
 */

export type EntrySignalKey =
  | "setup" // setup grade Constructive or better (the ONE technical signal)
  | "risk" // no CRITICAL technical alert
  | "equate" // in the RBC Equate top-decile list
  | "revisions" // net FY+1 estimate revisions positive
  | "synthesis" // latest synthesis verdict Advance (and not stale)
  | "catalyst" // a dated catalyst / earnings inside 30 days
  | "lists" // on 3+ research lists, or gained a list since last refresh
  // Legacy keys — only produced by evaluateEntryLegacy (kept for the
  // unification diff route; remove with it).
  | "ma200" | "dma" | "sia" | "sia_rising" | "marketedge";

export type EntryStatus = "met" | "unmet" | "unknown";

export type EntrySignal = { key: EntrySignalKey; label: string; status: EntryStatus; reading: string };

export type EntrySetupInput = {
  grade: "Strong" | "Constructive" | "Neutral" | "Weak" | "Broken" | null;
  rawPoints: number;
  availableMax: number;
  notches: number;
};

export type EntryInputs = {
  /** The setup grade for this name (computeSetup). undefined = not computed; grade null = not enough feeds. */
  setup?: EntrySetupInput | null;
  price?: number | null;
  ma200?: number | null;
  dmaSignal?: string | null;
  riskLevel?: string | null;
  siaPercentile?: number | null;
  siaSmax?: number | null;
  /** Percentile change over the SIA drift window (positive = improving). */
  siaDrift?: number | null;
  /** undefined = no Equate sheet on file; null = sheet exists, name not in the list. */
  equateRank?: number | null;
  marketEdgeOpinion?: "long" | "neutral" | "avoid" | null;
  marketEdgePower?: number | null;
  netRevisions?: number | null;
  synthesisVerdict?: string | null;
  synthesisStale?: boolean;
  /** YYYY-MM-DD next earnings, or the nearest dated catalyst. */
  catalystDate?: string | null;
  listCount?: number | null;
  listDelta?: number | null;
};

/** Legacy threshold (evaluateEntryLegacy only). */
export const READY_MIN = 5;
/** Of the six non-technical signals (risk, equate, revisions, synthesis, catalyst, lists). */
export const CASE_MIN = 3;
export const SIA_STRONG_PCT = 70;
export const SIA_RISING_PTS = 5;
export const MARKETEDGE_POWER_MIN = 60;
export const CATALYST_WINDOW_DAYS = 30;

const fmt = (n: number, dp = 1) => (Number.isFinite(n) ? n.toFixed(dp) : "—");

export type EntryEvaluation = {
  signals: EntrySignal[];
  met: number;
  known: number;
  ready: boolean;
  strength: "ready" | "building" | "early";
};

/** The six non-technical ("case") signals, shared by both evaluators. */
function pushCaseSignals(i: EntryInputs, todayIso: string, push: (key: EntrySignalKey, label: string, status: EntryStatus, reading: string) => void) {
  if (i.riskLevel === undefined) push("risk", "No critical alert", "unknown", "no technical read");
  else {
    const lvl = (i.riskLevel || "").toUpperCase();
    push("risk", "No critical alert", lvl === "CRITICAL" ? "unmet" : "met", i.riskLevel ? `alert ${i.riskLevel}` : "clear");
  }

  if (i.equateRank === undefined) push("equate", "Equate top decile", "unknown", "no Equate sheet");
  else if (i.equateRank === null) push("equate", "Equate top decile", "unmet", "not in the top-decile list");
  else push("equate", "Equate top decile", "met", `Equate rank ${i.equateRank}`);

  if (i.netRevisions != null) push("revisions", "Revisions positive", i.netRevisions > 0 ? "met" : "unmet", `net ${i.netRevisions >= 0 ? "+" : ""}${i.netRevisions}`);
  else push("revisions", "Revisions positive", "unknown", "no estimate snapshot");

  if (i.synthesisVerdict) {
    const ok = i.synthesisVerdict === "advance" && !i.synthesisStale;
    push("synthesis", "Synthesis: Advance", ok ? "met" : "unmet", `${i.synthesisVerdict}${i.synthesisStale ? " (stale)" : ""}`);
  } else push("synthesis", "Synthesis: Advance", "unknown", "no synthesis yet");

  if (i.catalystDate && /^\d{4}-\d{2}-\d{2}/.test(i.catalystDate)) {
    const days = Math.round((Date.parse(`${i.catalystDate.slice(0, 10)}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86_400_000);
    if (days < 0) push("catalyst", "Catalyst ≤ 30d", "unmet", `last ${i.catalystDate.slice(0, 10)}`);
    else push("catalyst", "Catalyst ≤ 30d", days <= CATALYST_WINDOW_DAYS ? "met" : "unmet", `${i.catalystDate.slice(0, 10)} (${days}d)`);
  } else push("catalyst", "Catalyst ≤ 30d", "unknown", "no date");

  if (i.listCount != null) {
    const ok = i.listCount >= 3 || (i.listDelta ?? 0) > 0;
    push("lists", "Research confluence", ok ? "met" : "unmet", `${i.listCount} list${i.listCount === 1 ? "" : "s"}${(i.listDelta ?? 0) > 0 ? ` (+${i.listDelta})` : ""}`);
  } else push("lists", "Research confluence", "unknown", "not on the ranked list");
}

/**
 * Rubric v3 scorecard: ONE technical signal (the setup grade) that is
 * mandatory, plus the six case signals.
 */
export function evaluateEntry(i: EntryInputs, todayIso = new Date().toISOString().slice(0, 10)): EntryEvaluation {
  const s: EntrySignal[] = [];
  const push = (key: EntrySignalKey, label: string, status: EntryStatus, reading: string) => s.push({ key, label, status, reading });

  const su = i.setup;
  if (su === undefined || su === null || su.grade == null) {
    push("setup", "Setup ≥ Constructive", "unknown", su === undefined ? "no setup read" : "not enough feeds (need 2 of SIA / BoostedAI / MarketEdge)");
  } else {
    const ok = su.grade === "Strong" || su.grade === "Constructive";
    push("setup", "Setup ≥ Constructive", ok ? "met" : "unmet", `${su.grade} ${su.rawPoints}/${su.availableMax}${su.notches ? ` ▼${su.notches}` : ""}`);
  }

  pushCaseSignals(i, todayIso, push);

  const known = s.filter((x) => x.status !== "unknown").length;
  const met = s.filter((x) => x.status === "met").length;
  const setupMet = s.find((x) => x.key === "setup")?.status === "met";
  const critical = s.find((x) => x.key === "risk")?.status === "unmet";
  const caseMet = s.filter((x) => x.key !== "setup" && x.status === "met").length;
  const ready = setupMet && !critical && caseMet >= CASE_MIN;
  const building = !ready && !critical && (setupMet || caseMet >= CASE_MIN);
  return { signals: s, met, known, ready, strength: ready ? "ready" : building ? "building" : "early" };
}

/**
 * @deprecated Pre-unification scorecard (five separate technical signals,
 * READY at ≥ READY_MIN of 11). Kept ONLY so /api/admin/entry-unification-diff
 * can show which names change status; delete both together after sign-off.
 */
export function evaluateEntryLegacy(i: EntryInputs, todayIso = new Date().toISOString().slice(0, 10)): EntryEvaluation {
  const s: EntrySignal[] = [];
  const push = (key: EntrySignalKey, label: string, status: EntryStatus, reading: string) => s.push({ key, label, status, reading });

  if (i.price != null && i.ma200 != null && i.ma200 > 0) {
    const pct = ((i.price - i.ma200) / i.ma200) * 100;
    push("ma200", "Above 200-day", i.price >= i.ma200 ? "met" : "unmet", `${pct >= 0 ? "+" : ""}${fmt(pct)}% vs 200DMA`);
  } else push("ma200", "Above 200-day", "unknown", "no 200DMA");

  if (i.dmaSignal) {
    const good = i.dmaSignal === "golden_cross" || i.dmaSignal === "above_both";
    push("dma", "50 over 200", good ? "met" : "unmet", i.dmaSignal.replace(/_/g, " "));
  } else push("dma", "50 over 200", "unknown", "no technical read");

  if (i.riskLevel === undefined) push("risk", "No critical alert", "unknown", "no technical read");
  else {
    const lvl = (i.riskLevel || "").toUpperCase();
    push("risk", "No critical alert", lvl === "CRITICAL" ? "unmet" : "met", i.riskLevel ? `alert ${i.riskLevel}` : "clear");
  }

  if (i.siaPercentile != null) push("sia", `SIA ≥ ${SIA_STRONG_PCT}th pct`, i.siaPercentile >= SIA_STRONG_PCT ? "met" : "unmet", `SIA ${i.siaPercentile}th percentile`);
  else if (i.siaSmax != null) push("sia", "SIA SMAX ≥ 8", i.siaSmax >= 8 ? "met" : "unmet", `SMAX ${i.siaSmax}`);
  else push("sia", `SIA ≥ ${SIA_STRONG_PCT}th pct`, "unknown", "no SIA read");

  if (i.siaDrift != null) push("sia_rising", "SIA rising", i.siaDrift >= SIA_RISING_PTS ? "met" : "unmet", `${i.siaDrift >= 0 ? "+" : ""}${i.siaDrift} pts over ~2w`);
  else push("sia_rising", "SIA rising", "unknown", "not enough SIA history");

  if (i.equateRank === undefined) push("equate", "Equate top decile", "unknown", "no Equate sheet");
  else if (i.equateRank === null) push("equate", "Equate top decile", "unmet", "not in the top-decile list");
  else push("equate", "Equate top decile", "met", `Equate rank ${i.equateRank}`);

  if (i.marketEdgeOpinion) {
    const ok = i.marketEdgeOpinion === "long" && (i.marketEdgePower == null || i.marketEdgePower >= MARKETEDGE_POWER_MIN);
    push("marketedge", "MarketEdge Long", ok ? "met" : "unmet", `${i.marketEdgeOpinion.toUpperCase()}${i.marketEdgePower != null ? ` · power ${i.marketEdgePower}` : ""}`);
  } else push("marketedge", "MarketEdge Long", "unknown", "no MarketEdge read");

  if (i.netRevisions != null) push("revisions", "Revisions positive", i.netRevisions > 0 ? "met" : "unmet", `net ${i.netRevisions >= 0 ? "+" : ""}${i.netRevisions}`);
  else push("revisions", "Revisions positive", "unknown", "no estimate snapshot");

  if (i.synthesisVerdict) {
    const ok = i.synthesisVerdict === "advance" && !i.synthesisStale;
    push("synthesis", "Synthesis: Advance", ok ? "met" : "unmet", `${i.synthesisVerdict}${i.synthesisStale ? " (stale)" : ""}`);
  } else push("synthesis", "Synthesis: Advance", "unknown", "no synthesis yet");

  if (i.catalystDate && /^\d{4}-\d{2}-\d{2}/.test(i.catalystDate)) {
    const days = Math.round((Date.parse(`${i.catalystDate.slice(0, 10)}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86_400_000);
    if (days < 0) push("catalyst", "Catalyst ≤ 30d", "unmet", `last ${i.catalystDate.slice(0, 10)}`);
    else push("catalyst", "Catalyst ≤ 30d", days <= CATALYST_WINDOW_DAYS ? "met" : "unmet", `${i.catalystDate.slice(0, 10)} (${days}d)`);
  } else push("catalyst", "Catalyst ≤ 30d", "unknown", "no date");

  if (i.listCount != null) {
    const ok = i.listCount >= 3 || (i.listDelta ?? 0) > 0;
    push("lists", "Research confluence", ok ? "met" : "unmet", `${i.listCount} list${i.listCount === 1 ? "" : "s"}${(i.listDelta ?? 0) > 0 ? ` (+${i.listDelta})` : ""}`);
  } else push("lists", "Research confluence", "unknown", "not on the ranked list");

  const known = s.filter((x) => x.status !== "unknown").length;
  const met = s.filter((x) => x.status === "met").length;
  const critical = s.find((x) => x.key === "risk")?.status === "unmet";
  const ready = met >= READY_MIN && !critical;
  return { signals: s, met, known, ready, strength: ready ? "ready" : met >= 3 ? "building" : "early" };
}
