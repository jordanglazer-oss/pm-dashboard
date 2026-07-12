/**
 * Thesis Health — Phase 03 of the forward-looking roadmap
 * (docs/forward-looking-roadmap.md).
 *
 * The automated half of the Living Thesis Tracker: for each holding, roll the
 * signals we already track into a single verdict — intact / eroding / broken —
 * so a name whose story is quietly deteriorating surfaces before it costs you.
 *
 * Pure, read-only, no I/O. The route hands in three already-stored signals:
 *   1. SCORE TREND   — composite score change over ~45d (pm:score-history).
 *   2. ESTIMATES     — net FY+1 EPS revisions, up minus down (pm:analyst-snapshots).
 *   3. RISK ALERT    — the technical risk level on the name (pm:stocks).
 *
 * This is the "automate to the floor" layer — fully functional with zero human
 * input. The optional human "why" seed (pm:position-theses) is a separate,
 * separately-persisted concern (two-writer rule) layered on top later.
 */

export type ThesisVerdict = "intact" | "eroding" | "broken";

export type ThesisDriver = {
  signal: "score" | "estimates" | "risk";
  direction: "positive" | "negative";
  detail: string;
};

export type ThesisHealth = {
  ticker: string;
  verdict: ThesisVerdict;
  drivers: ThesisDriver[];
  scoreDelta: number | null; // composite change over the lookback window
  netRevisions: number | null; // revUp − revDown
  riskLevel: string | null;
  summary: string;
};

const LOOKBACK_DAYS = 45;
const SCORE_MILD = -3; // composite points
const SCORE_STRONG = -8;
const REVISION_STRONG = -3; // net FY+1 EPS revisions (analysts cutting hard)

/** YYYY-MM-DD `days` before an ISO date string. */
function daysBefore(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return isoDate;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

export function computeThesisHealth(input: {
  ticker: string;
  scoreHistory?: { date: string; total: number }[];
  netRevisions?: number | null;
  riskLevel?: string | null;
}): ThesisHealth {
  const drivers: ThesisDriver[] = [];
  let points = 0;

  // ── Score trend ──
  let scoreDelta: number | null = null;
  const hist = (input.scoreHistory ?? [])
    .filter((e) => e && typeof e.total === "number" && typeof e.date === "string")
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (hist.length >= 2) {
    const latest = hist[hist.length - 1];
    const cutoff = daysBefore(latest.date, LOOKBACK_DAYS);
    let baseline = hist[0].total; // earliest, if nothing older than cutoff
    for (const e of hist) if (e.date <= cutoff) baseline = e.total;
    scoreDelta = latest.total - baseline;
    if (scoreDelta <= SCORE_STRONG) {
      points += 2;
      drivers.push({ signal: "score", direction: "negative", detail: `composite ${scoreDelta.toFixed(1)} over ~${LOOKBACK_DAYS}d` });
    } else if (scoreDelta <= SCORE_MILD) {
      points += 1;
      drivers.push({ signal: "score", direction: "negative", detail: `composite ${scoreDelta.toFixed(1)} over ~${LOOKBACK_DAYS}d` });
    } else if (scoreDelta >= -SCORE_MILD) {
      drivers.push({ signal: "score", direction: "positive", detail: `composite +${scoreDelta.toFixed(1)} over ~${LOOKBACK_DAYS}d` });
    }
  }

  // ── Estimate revisions (the cleanest FORWARD-FUNDAMENTAL thesis signal) ──
  // Analysts cutting future earnings is a direct thesis threat, so it's the
  // most heavily weighted input: a strong net cut can reach "eroding" on its own.
  const net = typeof input.netRevisions === "number" ? input.netRevisions : null;
  if (net != null) {
    if (net <= REVISION_STRONG) {
      points += 2;
      drivers.push({ signal: "estimates", direction: "negative", detail: `net FY+1 EPS revisions ${net} (analysts cutting)` });
    } else if (net < 0) {
      points += 1;
      drivers.push({ signal: "estimates", direction: "negative", detail: `net FY+1 EPS revisions ${net}` });
    } else if (net > 0) {
      drivers.push({ signal: "estimates", direction: "positive", detail: `net FY+1 EPS revisions +${net}` });
    }
  }

  // ── Technical risk (a TIMING signal, deliberately de-weighted) ──
  // Weak technicals are not a broken thesis — often the opposite (a buying
  // opportunity in a fundamentally-good name). So a CRITICAL alert only NUDGES
  // (1 pt, can't break a thesis alone), and a WARNING is context-only (0 pts,
  // shown elsewhere as the technical risk flag, not a thesis driver here).
  const risk = input.riskLevel ?? null;
  if (risk === "critical") {
    points += 1;
    drivers.push({ signal: "risk", direction: "negative", detail: "CRITICAL technical risk (timing signal)" });
  }

  const verdict: ThesisVerdict = points >= 3 ? "broken" : points >= 1 ? "eroding" : "intact";
  const negs = drivers.filter((d) => d.direction === "negative");
  const summary =
    verdict === "intact"
      ? "No deterioration in the signals we track."
      : `${negs.length} signal${negs.length === 1 ? "" : "s"} deteriorating: ${negs.map((d) => d.signal).join(", ")}.`;

  return { ticker: input.ticker, verdict, drivers, scoreDelta, netRevisions: net, riskLevel: risk, summary };
}

/** Severity rank for sorting (broken first). */
export function verdictRank(v: ThesisVerdict): number {
  return v === "broken" ? 0 : v === "eroding" ? 1 : 2;
}
