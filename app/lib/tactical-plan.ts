/* ─── Tactical plan: the pre-registered terms of a Tactical-sleeve position ───
 *
 * A Thesis name is held until its thesis breaks. A Tactical position is a
 * trade with terms — why now, where it is wrong, where it is done, and when it
 * gets looked at again. The plan is stored on the SAME record as the thesis
 * (pm:position-theses → `tacticalPlan`), so a name held in both sleeves carries
 * its long-run thesis and the plan for its tactical overweight side by side.
 *
 * Pure, client- and server-safe. `checkTacticalPlan` is the single evaluator
 * used by the stock-page tile and the fleet-wide alert sweep. */

export type TacticalPlan = {
  /** Why now — the short-term view this position expresses. */
  catalyst: string;
  /** Intended holding period, free text ("1–3 months", "into Q4 print"). */
  horizon?: string;
  entryDate?: string; // YYYY-MM-DD
  entryPrice?: number | null;
  /** Price at which the trade has done its job. */
  target?: number | null;
  /** Price at which the trade is wrong. */
  stop?: number | null;
  /** YYYY-MM-DD the position is next reviewed — defaults to the next first Monday. */
  reviewBy?: string;
  updatedAt: string;
};

export type PlanFlagKind = "stop" | "target" | "review" | "setup" | "earnings";
export type PlanFlag = { kind: PlanFlagKind; severity: "high" | "medium" | "info"; text: string };

export type PlanSignals = {
  price?: number | null;
  /** Setup grade label from app/lib/setup-grade ("Strong" … "Broken"). */
  setupGrade?: string | null;
  /** Next earnings date (YYYY-MM-DD). */
  earningsDate?: string | null;
  /** YYYY-MM-DD; defaults to today (UTC). */
  today?: string;
};

const isoToday = () => new Date().toISOString().slice(0, 10);

/** First Monday of the month containing `from`, or of the next month when that
 *  day has already passed (the monthly portfolio meeting). */
export function nextFirstMonday(from: string = isoToday()): string {
  const firstMondayOf = (y: number, m: number): string => {
    const d = new Date(Date.UTC(y, m, 1));
    const offset = (8 - d.getUTCDay()) % 7; // Sun=0 → 1, Mon=1 → 0, Tue=2 → 6 …
    d.setUTCDate(1 + offset);
    return d.toISOString().slice(0, 10);
  };
  const base = new Date(`${from}T00:00:00Z`);
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  const thisMonth = firstMondayOf(y, m);
  return thisMonth > from ? thisMonth : firstMondayOf(m === 11 ? y + 1 : y, (m + 1) % 12);
}

export function sanitizePlan(raw: unknown): TacticalPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const date = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  const catalyst = str(r.catalyst, 1200) ?? "";
  const plan: TacticalPlan = {
    catalyst,
    horizon: str(r.horizon, 80),
    entryDate: date(r.entryDate),
    entryPrice: num(r.entryPrice),
    target: num(r.target),
    stop: num(r.stop),
    reviewBy: date(r.reviewBy),
    updatedAt: new Date().toISOString(),
  };
  const empty = !plan.catalyst && !plan.horizon && !plan.entryDate && plan.entryPrice == null && plan.target == null && plan.stop == null && !plan.reviewBy;
  return empty ? null : plan;
}

/** A plan is complete once it says why, where it is done, where it is wrong
 *  and when it is next looked at. A pre-filled skeleton (entry only) is not. */
export function isPlanComplete(plan: TacticalPlan | null | undefined): boolean {
  return Boolean(plan && plan.catalyst.trim() && plan.target != null && plan.stop != null && plan.reviewBy);
}

/** Return since entry, as a fraction; null when entry or price is missing. */
export function planReturn(plan: TacticalPlan, price: number | null | undefined): number | null {
  if (!plan.entryPrice || price == null || !(price > 0)) return null;
  return price / plan.entryPrice - 1;
}

export function checkTacticalPlan(plan: TacticalPlan, s: PlanSignals): PlanFlag[] {
  const flags: PlanFlag[] = [];
  const today = s.today ?? isoToday();
  const px = typeof s.price === "number" && s.price > 0 ? s.price : null;
  if (px != null && plan.stop != null && px <= plan.stop) {
    flags.push({ kind: "stop", severity: "high", text: `At or below the stop — ${px.toFixed(2)} vs stop ${plan.stop.toFixed(2)}` });
  }
  if (px != null && plan.target != null && px >= plan.target) {
    flags.push({ kind: "target", severity: "high", text: `Target reached — ${px.toFixed(2)} vs target ${plan.target.toFixed(2)}` });
  }
  if (plan.reviewBy && plan.reviewBy <= today) {
    flags.push({ kind: "review", severity: "medium", text: plan.reviewBy === today ? "Review is due today" : `Review was due ${plan.reviewBy}` });
  }
  if (s.setupGrade === "Weak" || s.setupGrade === "Broken") {
    flags.push({ kind: "setup", severity: s.setupGrade === "Broken" ? "high" : "medium", text: `Setup grade is ${s.setupGrade}` });
  }
  if (s.earningsDate && s.earningsDate >= today && plan.reviewBy && s.earningsDate <= plan.reviewBy) {
    flags.push({ kind: "earnings", severity: "info", text: `Earnings ${s.earningsDate} fall before the next review` });
  }
  return flags;
}

/* ─── Tactical verdict: the one-word read of a Tactical leg ───
 *
 * Deterministic — no model call. A tactical trade is judged against the terms
 * the PM wrote for it, so the verdict is a function of the plan's own flags:
 *
 *   exit         at/below the stop, the setup is Broken, or the synthesis has
 *                the name on exit-watch (fundamentals are a floor, not a driver)
 *   take-profit  the target has been reached
 *   hold-trade   within plan
 *
 * Exit outranks take-profit: a position cannot be both, and if a stale plan
 * says both, the conservative read wins. */

export type TacticalVerdict = "hold-trade" | "take-profit" | "exit";

export const TACTICAL_VERDICT_LABEL: Record<TacticalVerdict, string> = {
  "hold-trade": "Hold trade",
  "take-profit": "Take profit",
  exit: "Exit",
};

export function tacticalVerdictOf(input: { flags: PlanFlag[]; synthesisVerdict?: string | null }): { verdict: TacticalVerdict; reasons: string[] } {
  const by = (k: PlanFlagKind) => input.flags.find((f) => f.kind === k);
  const exitReasons: string[] = [];
  const stop = by("stop");
  if (stop) exitReasons.push(stop.text);
  // checkTacticalPlan raises the setup flag as "high" only for a Broken grade.
  const setup = by("setup");
  if (setup?.severity === "high") exitReasons.push(setup.text);
  if (input.synthesisVerdict === "exit-watch") exitReasons.push("Synthesis has the name on exit-watch");
  if (exitReasons.length) return { verdict: "exit", reasons: exitReasons };
  const target = by("target");
  if (target) return { verdict: "take-profit", reasons: [target.text] };
  const notes = input.flags.filter((f) => f.kind === "review" || f.kind === "setup").map((f) => f.text);
  return { verdict: "hold-trade", reasons: notes };
}
