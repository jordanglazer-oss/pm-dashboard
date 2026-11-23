import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { generateMorningNote, listNoteDates, readNote } from "@/app/lib/morning-note";
import { easternDay, isDay, noteToText } from "@/app/lib/morning-note-shared";

/**
 * GET  /api/morning-note[?date=YYYY-MM-DD][&q=text]
 *      READ-ONLY. Returns the note for `date` (default: the newest on file)
 *      and the list of dates in the archive. `q` searches the archive (a
 *      ticker or any word) and returns the matching dates. Returns
 *      `{ note: null, dates: [] }` on a missing key or a read error — never
 *      seeds, never spends.
 * POST /api/morning-note
 *      Generate (or regenerate) TODAY's note: one Sonnet call with capped web
 *      search. Writes only `pm:morning-note:<today>`; past days are never
 *      rewritten. See app/lib/morning-note.ts.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const log = createLogger("Morning-note");

export async function GET(req: NextRequest) {
  try {
    const q = new URL(req.url).searchParams;
    const today = easternDay();
    const dates = await listNoteDates(today);
    const query = q.get("q")?.trim().toLowerCase();
    if (query) {
      const matches: string[] = [];
      for (const d of dates) {
        const n = await readNote(d);
        if (n && noteToText(n).toLowerCase().includes(query)) matches.push(d);
      }
      return NextResponse.json({ query, matches, dates, today });
    }
    const want = q.get("date");
    const date = isDay(want) ? want : dates[0];
    return NextResponse.json({ note: date ? await readNote(date) : null, dates, today });
  } catch (e) {
    log.error("read failed:", e);
    return NextResponse.json({ note: null, dates: [], today: easternDay() });
  }
}

export async function POST() {
  const res = await generateMorningNote();
  const dates = await listNoteDates();
  return NextResponse.json({ ...res, dates, today: easternDay() }, { status: res.ok || res.skipped || res.note ? 200 : 500 });
}
