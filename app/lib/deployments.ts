/**
 * Deployment log — the days the monthly client-cash installment ACTUALLY went
 * in (pm:deployments). Two jobs:
 *
 *  1. Once a month's installment is fully logged, the morning brief stops
 *     producing a cash-deployment call until the 1st (saves the rubric's
 *     tokens and stops the brief re-litigating a decision already made).
 *  2. A timing record: each entry snapshots what the brief called that day, so
 *     deployment timing can later be graded against the window it sat in.
 *
 * User-owned ledger. Entries are added or VOIDED, never hard-deleted, and the
 * API merges one entry at a time (no whole-array overwrite), so a stale tab
 * can never roll the log back.
 */
import { getRedis } from "./redis";

export const DEPLOYMENTS_KEY = "pm:deployments";

export type DeploymentPortion = "full" | "half";

export type Deployment = {
  id: string;
  /** US-Eastern calendar date the cash went in (YYYY-MM-DD). */
  date: string;
  /** The installment month it belongs to (YYYY-MM) — always date's own month. */
  month: string;
  portion: DeploymentPortion;
  note?: string;
  loggedAt: string;
  voided?: boolean;
  voidedAt?: string;
  /** What the brief said on `date`, captured at log time so the record stands alone. */
  brief: { action: string; score: number | null } | null;
};

export async function loadDeployments(): Promise<Deployment[]> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(DEPLOYMENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.deployments) ? (parsed.deployments as Deployment[]) : [];
  } catch {
    return [];
  }
}

export const live = (ds: Deployment[]): Deployment[] => ds.filter((d) => !d.voided);

/** Fraction of `month`'s installment logged so far (1 = done). */
export function deployedFraction(ds: Deployment[], month: string): number {
  return Math.min(1, live(ds).filter((d) => d.month === month).reduce((s, d) => s + (d.portion === "full" ? 1 : 0.5), 0));
}

export type MonthDeploymentState = {
  month: string;
  fraction: number;
  /** "none" | "half" | "full" */
  status: "none" | "half" | "full";
  entries: Deployment[];
};

export function monthState(ds: Deployment[], todayIso: string): MonthDeploymentState {
  const month = todayIso.slice(0, 7);
  const fraction = deployedFraction(ds, month);
  return {
    month,
    fraction,
    status: fraction >= 1 ? "full" : fraction > 0 ? "half" : "none",
    entries: live(ds).filter((d) => d.month === month).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** One payload line for the brief. */
export function deploymentStateLine(s: MonthDeploymentState): string {
  if (s.status === "none") return "";
  const days = s.entries.map((e) => `${e.date} (${e.portion})`).join(", ");
  return s.status === "full"
    ? `CASH DEPLOYMENT: this month's installment is already fully deployed — logged ${days}. Do NOT produce a cashDeploymentCall; the field has been removed from the output shape.`
    : `CASH DEPLOYMENT: HALF of this month's installment is already in — logged ${days}. The cashDeploymentCall now concerns only the remaining half; say so in its reason.`;
}

// ── Timing scorecard (computed on read; nothing stored) ────────────────────

export type DailyClose = { date: string; close: number };

export type TimingRow = {
  month: string;
  date: string;
  portion: DeploymentPortion;
  close: number | null;
  /** Average SPY close across that month's 1st–20th window: what spreading the cash evenly would have paid. */
  windowAvg: number | null;
  /** % better (+) or worse (−) than the window average. Positive = bought cheaper. */
  advantagePct: number | null;
  /** 1 = cheapest day of the window. */
  rank: number | null;
  windowDays: number;
  brief: Deployment["brief"];
  followedBrief: boolean | null;
};

export function timingScorecard(ds: Deployment[], closes: DailyClose[], windowLastDay = 20): { rows: TimingRow[]; monthsBeaten: number; monthsGraded: number; avgAdvantagePct: number | null } {
  const byDate = new Map(closes.map((c) => [c.date, c.close]));
  const rows: TimingRow[] = live(ds)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => {
      const win = closes.filter((c) => c.date.slice(0, 7) === d.month && Number(c.date.slice(8, 10)) <= windowLastDay);
      // Entry price: that day's close, else the next trading day's (weekend/holiday log).
      const close = byDate.get(d.date) ?? closes.find((c) => c.date > d.date && c.date.slice(0, 7) === d.month)?.close ?? null;
      const windowAvg = win.length ? win.reduce((s, c) => s + c.close, 0) / win.length : null;
      const advantagePct = close != null && windowAvg != null ? ((windowAvg - close) / windowAvg) * 100 : null;
      const rank = close != null && win.length ? win.filter((c) => c.close < close).length + 1 : null;
      const act = d.brief?.action ?? null;
      return {
        month: d.month, date: d.date, portion: d.portion, close, windowAvg, advantagePct, rank, windowDays: win.length,
        brief: d.brief,
        followedBrief: act == null ? null : act === "DEPLOY" || (act === "DEPLOY_PARTIAL" && d.portion === "half"),
      };
    });
  // One grade per month: the portion-weighted average advantage.
  const months = new Map<string, { w: number; a: number }>();
  for (const r of rows) {
    if (r.advantagePct == null) continue;
    const w = r.portion === "full" ? 1 : 0.5;
    const m = months.get(r.month) ?? { w: 0, a: 0 };
    months.set(r.month, { w: m.w + w, a: m.a + r.advantagePct * w });
  }
  const graded = [...months.values()].map((m) => m.a / m.w);
  return {
    rows,
    monthsBeaten: graded.filter((a) => a > 0).length,
    monthsGraded: graded.length,
    avgAdvantagePct: graded.length ? graded.reduce((s, a) => s + a, 0) / graded.length : null,
  };
}
