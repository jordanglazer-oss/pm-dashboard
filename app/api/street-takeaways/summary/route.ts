import { NextResponse } from "next/server";
import { loadStreetTakeaways } from "@/app/lib/street-takeaways";
import { factsetKindLabel } from "@/app/lib/street-takeaways-shared";

/**
 * GET /api/street-takeaways/summary — one LINE per ticker for the Inbox
 * coverage table: the newest alert's date, which report it was, and its event.
 *
 * Exists purely to cut Fast Origin Transfer. The table needs three short
 * strings per name, but /api/street-takeaways returns the ENTIRE store — up to
 * 6 entries per ticker, each carrying full firm-by-firm commentary, reported
 * results, guidance lines and management outlook. That is orders of magnitude
 * more bytes than the table renders, re-sent on every page load (the page
 * fetches no-store), and every one of those bytes is billed origin transfer.
 *
 * Read-only; degrades to an empty map rather than erroring the page.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const store = await loadStreetTakeaways();
    const out: Record<string, { date: string; label: string; event: string | null }> = {};
    for (const [ticker, entries] of Object.entries(store)) {
      if (!Array.isArray(entries) || entries.length === 0) continue;
      // Stored newest-first, but sort defensively rather than trust order.
      const latest = [...entries].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0];
      if (!latest?.date) continue;
      out[ticker.toUpperCase()] = {
        date: latest.date,
        label: factsetKindLabel(latest),
        event: latest.event ?? null,
      };
    }
    return NextResponse.json({ summary: out });
  } catch (e) {
    console.error("street-takeaways summary failed:", e);
    return NextResponse.json({ summary: {} });
  }
}
