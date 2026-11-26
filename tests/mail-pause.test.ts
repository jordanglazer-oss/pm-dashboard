import { describe, expect, it } from "vitest";
import { EMAILS_PAUSED, isMailPaused } from "@/app/lib/mail-outbox";

describe("Email pause", () => {
  it("is on", () => expect(EMAILS_PAUSED).toBe(true));
  it("still sends intraday price alerts, backup alarms and PM-sent requests", () => {
    for (const id of ["intraday-2026-11-26-600", "backup-failed-2026-11-26", "backup-stale-2026-11-26", "provider-sia-123"]) expect(isMailPaused(id)).toBe(false);
  });
  it("holds every other email", () => {
    for (const id of ["digest-2026-11-26", "flag-abc", "audit-eod-2026-11-26", "sunday-memo-2026-11-29", "health-report-2026-11-30", "wl-AVGO", "devils-advocate-2026-12", "something-new"]) expect(isMailPaused(id)).toBe(true);
  });
});
