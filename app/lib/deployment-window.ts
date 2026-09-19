/**
 * The monthly cash-deployment window (1st → 20th) and its calendar backstop.
 *
 * Since the cash call's no-edge band reads WAIT (not DEPLOY), a quiet month
 * could read WAIT every session and carry the installment past the 20th. The
 * backstop is deterministic and applied AFTER the model answers — same
 * pattern as the HOLD→SKIP hedge guard — so the prompt states the rule and
 * the app enforces it:
 *   ≤ 5 trading days left → a WAIT becomes DEPLOY_PARTIAL
 *   ≤ 2 trading days left → the action is DEPLOY
 *
 * Pure module: no I/O, no Redis.
 */

export const WINDOW_LAST_DAY = 20;
export const BACKSTOP_PARTIAL_DAYS = 5;
export const BACKSTOP_DEPLOY_DAYS = 2;

/** NYSE full-day closures. Years outside this table fall back to a plain
 *  weekday count (at worst one day generous around a holiday). */
const NYSE_HOLIDAYS = new Set<string>([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19", "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25",
]);

function isTradingDay(iso: string): boolean {
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && !NYSE_HOLIDAYS.has(iso);
}

export type DeploymentWindow = {
  todayIso: string;
  /** True from the 1st through the 20th inclusive. */
  inWindow: boolean;
  /** Trading days from today through the 20th, today included. null outside the window. */
  tradingDaysLeft: number | null;
  /** ISO date of the window's last day this month. */
  closesOn: string;
};

/** `todayIso` is the US-Eastern calendar date (YYYY-MM-DD). */
export function deploymentWindow(todayIso: string): DeploymentWindow {
  const [y, m, d] = todayIso.split("-").map(Number);
  const closesOn = `${y}-${String(m).padStart(2, "0")}-${String(WINDOW_LAST_DAY).padStart(2, "0")}`;
  if (!y || !m || !d || d > WINDOW_LAST_DAY) return { todayIso, inWindow: false, tradingDaysLeft: null, closesOn };
  let left = 0;
  for (let day = d; day <= WINDOW_LAST_DAY; day++) {
    if (isTradingDay(`${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`)) left++;
  }
  return { todayIso, inWindow: true, tradingDaysLeft: left, closesOn };
}

/** One line for the brief payload. */
export function deploymentWindowLine(w: DeploymentWindow): string {
  if (!w.inWindow || w.tradingDaysLeft == null) {
    return `DEPLOYMENT WINDOW: closed for this month (it runs the 1st through the ${WINDOW_LAST_DAY}th). No backstop applies; make the call on the inputs alone.`;
  }
  const k = w.tradingDaysLeft;
  const rule =
    k <= BACKSTOP_DEPLOY_DAYS ? ` — ${BACKSTOP_DEPLOY_DAYS} or fewer left: the action is DEPLOY ("window closing").`
    : k <= BACKSTOP_PARTIAL_DAYS ? ` — ${BACKSTOP_PARTIAL_DAYS} or fewer left: a WAIT becomes DEPLOY_PARTIAL.`
    : " — no backstop yet.";
  return `DEPLOYMENT WINDOW: ${k} trading day${k === 1 ? "" : "s"} left before the window closes on ${w.closesOn} (today included)${rule}`;
}

type CashCall = { action?: string; score?: number; window?: string; reason?: string; [k: string]: unknown };

/** Deterministic backstop. Never touches the model's score — only the action,
 *  window and reason — so the score stays an honest read of the inputs. */
export function applyWindowBackstop<T extends CashCall>(call: T | undefined | null, w: DeploymentWindow): { call: T | undefined | null; changedFrom: string | null } {
  if (!call || !w.inWindow || w.tradingDaysLeft == null) return { call, changedFrom: null };
  const k = w.tradingDaysLeft;
  const was = typeof call.action === "string" ? call.action : "";
  const orig = call.reason ? ` (model read: ${call.reason})` : "";
  if (k <= BACKSTOP_DEPLOY_DAYS && was !== "DEPLOY") {
    return {
      call: { ...call, action: "DEPLOY", window: "Deploy now", reason: `Window closing — ${k} trading day${k === 1 ? "" : "s"} left before the ${WINDOW_LAST_DAY}th.${orig}` },
      changedFrom: was || "unset",
    };
  }
  if (k <= BACKSTOP_PARTIAL_DAYS && was === "WAIT") {
    return {
      call: { ...call, action: "DEPLOY_PARTIAL", window: "Deploy half now", reason: `${k} trading days left before the ${WINDOW_LAST_DAY}th — a WAIT becomes a half deployment.${orig}` },
      changedFrom: was,
    };
  }
  return { call, changedFrom: null };
}
