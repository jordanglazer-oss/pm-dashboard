import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { computeAlerts, alertCounts, type Alert } from "@/app/lib/alerts";
import { computeRegimeTransition } from "@/app/lib/regime-transition";
import type { MarketRegimeData } from "@/app/lib/market-regime";
import { sendAlertEmail, emailConfigured } from "@/app/lib/notify-email";

/**
 * Daily alert digest (Phase 07) — the "when you're not looking" half. Run from
 * the daily cron: compute today's alerts from cached signals, append a snapshot
 * to the append-only pm:alert-log (one per date, never overwritten, 60-day
 * retention), and email it IF email is configured AND there are high-priority
 * alerts (ruthless signal-to-noise). Best-effort; never throws.
 */

const log = createLogger("AlertDigest");
const LOG_KEY = "pm:alert-log";

type LoggedDigest = { generatedAt: string; counts: ReturnType<typeof alertCounts>; alerts: Alert[] };

function renderEmail(alerts: Alert[], counts: ReturnType<typeof alertCounts>, date: string): string {
  const items = alerts
    .map(
      (a) =>
        `<li style="margin:6px 0"><b>[${a.priority.toUpperCase()}] ${a.title}</b> — ${a.detail}</li>`
    )
    .join("");
  return `<div style="font-family:system-ui,sans-serif"><h2 style="margin:0 0 4px">Needs your attention — ${date}</h2><p style="color:#555;margin:0 0 12px">${counts.high} high · ${counts.medium} to watch</p><ul style="padding-left:18px">${items}</ul></div>`;
}

export async function runAlertDigest(): Promise<{ ran: boolean; total: number; emailed: boolean; error?: string }> {
  try {
    const redis = await getRedis();
    const [thesisRaw, regimeRaw, stocksRaw] = await Promise.all([
      redis.get("pm:thesis-health"),
      redis.get("pm:market-regime"),
      redis.get("pm:stocks"),
    ]);

    const thesis = (() => {
      try {
        return thesisRaw ? JSON.parse(thesisRaw) : null;
      } catch {
        return null;
      }
    })();
    let transition = null;
    try {
      if (regimeRaw) {
        const r = JSON.parse(regimeRaw) as MarketRegimeData;
        if (r?.composite) transition = computeRegimeTransition(r);
      }
    } catch {
      /* skip */
    }
    const risk = (() => {
      try {
        const p = stocksRaw ? JSON.parse(stocksRaw) : [];
        if (!Array.isArray(p)) return null;
        return (
          p as Array<{
            ticker?: string;
            bucket?: string;
            riskAlert?: { level?: string; summary?: string; signals?: Array<{ name: string; status: string }> };
          }>
        ).map((s) => ({
          ticker: s.ticker ?? "",
          bucket: s.bucket,
          riskLevel: s.riskAlert?.level,
          riskSummary: s.riskAlert?.summary,
          dangerSignals: (s.riskAlert?.signals ?? []).filter((sig) => sig.status === "danger").map((sig) => sig.name),
        }));
      } catch {
        return null;
      }
    })();

    const alerts = computeAlerts({ thesis, transition, risk });
    const counts = alertCounts(alerts);
    const today = new Date().toISOString().slice(0, 10);

    // Append-only log — never overwrite an existing date; 60-day retention.
    let store: Record<string, LoggedDigest> = {};
    try {
      const raw = await redis.get(LOG_KEY);
      if (raw) store = JSON.parse(raw) as Record<string, LoggedDigest>;
    } catch {
      /* start fresh on parse error */
    }
    if (!store[today]) {
      store[today] = { generatedAt: new Date().toISOString(), counts, alerts };
      const dates = Object.keys(store).sort();
      while (dates.length > 60) {
        const drop = dates.shift();
        if (drop) delete store[drop];
      }
      await redis.set(LOG_KEY, JSON.stringify(store));
    }

    // Email only when there's something HIGH (and email is configured).
    let emailed = false;
    if (counts.high > 0 && emailConfigured()) {
      const r = await sendAlertEmail(`PM alerts — ${counts.high} need attention (${today})`, renderEmail(alerts, counts, today));
      emailed = r.sent;
    }
    return { ran: true, total: counts.total, emailed };
  } catch (e) {
    log.error("failed:", e);
    return { ran: false, total: 0, emailed: false, error: e instanceof Error ? e.message : "error" };
  }
}
