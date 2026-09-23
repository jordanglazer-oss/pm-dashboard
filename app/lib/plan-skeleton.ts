"use client";

import { nextFirstMonday } from "./tactical-plan";

/**
 * Pre-fill a Tactical plan the moment a position becomes Tactical — on the
 * Buy that opens it (trade price + date) or on the Tactical tag (today's
 * price) — so entry terms are captured when they are known, not typed later.
 * NON-BLOCKING and fire-and-forget: nothing waits on it, and it never touches
 * a plan that already exists. The banner keeps asking for why-now / target /
 * stop until the plan is complete.
 */
export async function ensurePlanSkeleton(ticker: string, entryPrice: number | null | undefined, entryDate?: string): Promise<void> {
  try {
    const tk = ticker.toUpperCase();
    const cur = await fetch("/api/kv/position-theses", { cache: "no-store" }).then((r) => r.json());
    if (cur?.theses?.[tk]?.tacticalPlan) return;
    await fetch("/api/kv/position-theses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticker: tk,
        tacticalPlan: {
          catalyst: "",
          entryDate: entryDate ?? new Date().toISOString().slice(0, 10),
          entryPrice: typeof entryPrice === "number" && entryPrice > 0 ? entryPrice : null,
          reviewBy: nextFirstMonday(),
        },
      }),
    });
  } catch {
    /* best effort — the plan tile still works by hand */
  }
}
