/* ─── Lanes: is a watchlist / suggested name ready to buy? ───
 *
 * Two independent reads, kept apart because they answer different questions:
 *   Case  is the CASE proven well enough to hold for years?
 *         analyst reports on file AND a synthesis generated AFTER the latest
 *         report, fresh, verdict "advance" AND conviction Hold or better
 *   Tape  does the TAPE say now?
 *         setup ≥ Constructive AND a live trigger AND no critical alert
 *   A synthesis verdict of "pass" blocks both.
 *
 * Lanes (since the Thesis/Tactical tags retired — the old "Tactical" lane, a
 * tape-ready name whose case wasn't proven yet, folds into Ready):
 *   ready  the tape says now (case proven or not)
 *   wait   case proven, tape not yet
 *   watch  neither
 * The stored read keeps its field names (`thesis` = case checks, `tactical` =
 * tape checks) so cached pm:entry-scan rows stay readable; normalizeLane maps
 * the retired lane values a cached row may still carry.
 *
 * Pure. A synthesis is never generated here — it stays report-driven. */

import { RATING_BANDS } from "./rating-bands";

export type LaneCheck = { key: string; label: string; ok: boolean | null; reading: string };
export type Lane = "ready" | "wait" | "watch";
/** Retired lane values a cached entry-scan row may still carry. */
type LegacyLane = "thesis-now" | "thesis-wait" | "tactical";
export type LaneRead = { lane: Lane | LegacyLane; thesisReady: boolean; tacticalReady: boolean; thesis: LaneCheck[]; tactical: LaneCheck[] };

export const LANE_LABEL: Record<Lane, string> = {
  ready: "Ready",
  wait: "Wait — case proven, tape not yet",
  watch: "Watch",
};

export function normalizeLane(l: Lane | LegacyLane): Lane {
  return l === "thesis-now" || l === "tactical" ? "ready" : l === "thesis-wait" ? "wait" : l;
}

export type LaneInputs = {
  /** ISO of the newest analyst report (RBC / JPM / Morningstar) on file, or null. */
  latestReportAt: string | null;
  synthesis: { verdict: string; generatedAt: string; earningsDateAtGeneration?: string | null } | null;
  /** Composite (adjusted) on the 33-pt scale, or null when unscored. */
  conviction: number | null;
  setupGrade: string | null;
  riskLevel: string | null | undefined;
  siaDrift: number | null;
  marketEdgeOpinion: string | null;
  netRevisions: number | null;
  catalystDate: string | null;
  today: string;
};

const SYNTH_MAX_AGE_DAYS = 45;
const TRIGGER_CATALYST_DAYS = 45;
const SIA_JUMP = 15;

export function computeLane(i: LaneInputs): LaneRead {
  const thesis: LaneCheck[] = [];
  const tactical: LaneCheck[] = [];
  const pass = i.synthesis?.verdict === "pass";

  // ── Case (stored as `thesis` for cached rows) ──
  thesis.push({ key: "reports", label: "Analyst reports on file", ok: Boolean(i.latestReportAt), reading: i.latestReportAt ? `latest ${i.latestReportAt.slice(0, 10)}` : "none — send the reports in" });
  if (!i.synthesis) thesis.push({ key: "synthesis", label: "Synthesis after the reports: Advance", ok: false, reading: i.latestReportAt ? "not generated yet" : "needs the reports first" });
  else {
    const gen = i.synthesis.generatedAt;
    const afterReports = !i.latestReportAt || gen >= i.latestReportAt;
    const ageDays = Math.round((Date.parse(i.today) - Date.parse(gen)) / 86_400_000);
    const ed = i.synthesis.earningsDateAtGeneration?.slice(0, 10);
    const earningsPassed = Boolean(ed && ed >= gen.slice(0, 10) && ed < i.today);
    const fresh = afterReports && ageDays <= SYNTH_MAX_AGE_DAYS && !earningsPassed;
    const ok = i.synthesis.verdict === "advance" && fresh;
    thesis.push({
      key: "synthesis",
      label: "Synthesis after the reports: Advance",
      ok,
      reading: !afterReports ? `generated ${gen.slice(0, 10)}, before the latest report — regenerate` : earningsPassed ? "earnings passed since — regenerate" : ageDays > SYNTH_MAX_AGE_DAYS ? `${ageDays}d old — regenerate` : `${i.synthesis.verdict} · ${gen.slice(0, 10)}`,
    });
  }
  thesis.push({ key: "conviction", label: "Conviction Hold or better", ok: i.conviction == null ? null : i.conviction >= RATING_BANDS.hold, reading: i.conviction == null ? "not scored" : `${i.conviction.toFixed(1)} / 33` });

  // ── Tape (stored as `tactical` for cached rows) ──
  const setupOk = i.setupGrade === "Strong" || i.setupGrade === "Constructive";
  tactical.push({ key: "setup", label: "Setup Constructive or better", ok: i.setupGrade ? setupOk : null, reading: i.setupGrade ?? "not enough feeds" });
  const triggers: string[] = [];
  if (i.siaDrift != null && i.siaDrift >= SIA_JUMP) triggers.push(`SIA +${Math.round(i.siaDrift)} pts`);
  if (i.marketEdgeOpinion === "long") triggers.push("MarketEdge Long");
  if (i.netRevisions != null && i.netRevisions > 0) triggers.push(`revisions +${i.netRevisions}`);
  if (i.catalystDate && /^\d{4}-\d{2}-\d{2}/.test(i.catalystDate)) {
    const days = Math.round((Date.parse(`${i.catalystDate.slice(0, 10)}T00:00:00Z`) - Date.parse(`${i.today}T00:00:00Z`)) / 86_400_000);
    if (days >= 0 && days <= TRIGGER_CATALYST_DAYS) triggers.push(`catalyst ${i.catalystDate.slice(0, 10)}`);
  }
  tactical.push({ key: "trigger", label: "A live trigger", ok: triggers.length > 0, reading: triggers.length ? triggers.join(" · ") : "none (SIA jump, MarketEdge Long, revisions up, catalyst ≤45d)" });
  tactical.push({ key: "risk", label: "No critical alert", ok: i.riskLevel === undefined ? null : (i.riskLevel || "").toUpperCase() !== "CRITICAL", reading: i.riskLevel === undefined ? "no technical read" : i.riskLevel ? `alert ${i.riskLevel}` : "clear" });

  if (pass) {
    const blocker: LaneCheck = { key: "pass", label: "Synthesis: Pass", ok: false, reading: "the case does not support more time now" };
    thesis.push(blocker);
    tactical.push(blocker);
  }

  const thesisReady = thesis.every((c) => c.ok === true);
  const tacticalReady = tactical.every((c) => c.ok === true);
  const lane: Lane = tacticalReady ? "ready" : thesisReady ? "wait" : "watch";
  return { lane, thesisReady, tacticalReady, thesis, tactical };
}
