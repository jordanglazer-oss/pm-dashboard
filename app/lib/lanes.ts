/* ─── Lanes: is a watchlist / suggested name ready as a THESIS or a TACTICAL position? ───
 *
 * The two lanes answer different questions and a name may qualify for both:
 *   Thesis-ready    is the CASE proven well enough to hold for years?
 *   Tactical-ready  does the TAPE say now?
 * Thesis wins when both are true — it is bought as a Thesis position, now; the
 * tactical read is only timing. The Tactical lane is for names whose tape is
 * ready BEFORE their case is, so they are held on terms (a plan) instead.
 *
 *   Thesis-ready   analyst reports on file AND a synthesis generated AFTER the
 *                  latest report, fresh, verdict "advance" AND conviction Hold
 *                  or better (Jordan, 2026-09-23: one band below Moderate Buy)
 *   Tactical-ready setup ≥ Constructive AND a live trigger AND no critical
 *                  alert (the entry floor — a conviction minimum — is deferred)
 *   A synthesis verdict of "pass" blocks BOTH lanes.
 *
 * Pure. A synthesis is never generated here — it stays report-driven. */

import { RATING_BANDS } from "./rating-bands";

export type LaneCheck = { key: string; label: string; ok: boolean | null; reading: string };
export type Lane = "thesis-now" | "thesis-wait" | "tactical" | "watch";
export type LaneRead = { lane: Lane; thesisReady: boolean; tacticalReady: boolean; thesis: LaneCheck[]; tactical: LaneCheck[] };

export const LANE_LABEL: Record<Lane, string> = {
  "thesis-now": "Thesis — enter now",
  "thesis-wait": "Thesis — wait for setup",
  tactical: "Tactical",
  watch: "Watch",
};

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

  // ── Thesis ──
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

  // ── Tactical ──
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
  const lane: Lane = thesisReady ? (tacticalReady ? "thesis-now" : "thesis-wait") : tacticalReady ? "tactical" : "watch";
  return { lane, thesisReady, tacticalReady, thesis, tactical };
}
