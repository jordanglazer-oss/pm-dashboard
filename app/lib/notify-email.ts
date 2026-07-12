import { createLogger } from "@/app/lib/logger";

/**
 * Email delivery for proactive alerts (Phase 07) — abstracted behind a
 * config flip. It is a NO-OP until three env vars are set on Vercel:
 *   RESEND_API_KEY, ALERT_EMAIL_TO, ALERT_EMAIL_FROM
 * so nothing is ever sent by accident. Setting them is the "turn email on"
 * switch — no code change. Uses Resend's HTTP API (no npm dependency).
 */

const log = createLogger("Email");

export function emailConfigured(): boolean {
  return !!(process.env.RESEND_API_KEY && process.env.ALERT_EMAIL_TO && process.env.ALERT_EMAIL_FROM);
}

export async function sendAlertEmail(subject: string, html: string): Promise<{ sent: boolean; error?: string }> {
  if (!emailConfigured()) return { sent: false };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.ALERT_EMAIL_FROM,
        to: process.env.ALERT_EMAIL_TO,
        subject,
        html,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      log.warn("send failed:", res.status);
      return { sent: false, error: `HTTP ${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    log.warn("send error:", e instanceof Error ? e.message : e);
    return { sent: false, error: "exception" };
  }
}
