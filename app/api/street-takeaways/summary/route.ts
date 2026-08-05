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
    // Newest entry PER KIND. The formats carry different information —
    // per-firm reaction vs reported results vs the call/guidance summary — so
    // the Inbox shows a column each rather than collapsing to "most recent".
    const out: Record<string, Record<string, { date: string; label: string; event: string | null }>> = {};
    for (const [ticker, entries] of Object.entries(store)) {
      if (!Array.isArray(entries) || entries.length === 0) continue;
      const byKind: Record<string, { date: string; label: string; event: string | null }> = {};
      for (const e of [...entries].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))) {
        if (!e?.date) continue;
        const k = e.kind ?? "takeaways";
        if (byKind[k]) continue; // first seen is newest
        byKind[k] = { date: e.date, label: factsetKindLabel(e), event: e.event ?? null };
      }
      if (Object.keys(byKind).length) out[ticker.toUpperCase()] = byKind;
    }
    return NextResponse.json({ summary: out });
  } catch (e) {
    console.error("street-takeaways summary failed:", e);
    return NextResponse.json({ summary: {} });
  }
}
