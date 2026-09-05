/**
 * Shaping strategist notes for the MORNING BRIEF PROMPT.
 *
 * Storage is deliberately untouched by any of this: pm:strategist-history
 * keeps each note's FULL text, so nothing is lost and the trimming can be
 * changed or removed later without re-ingesting anything. These helpers only
 * decide how much of that text is worth spending prompt space on.
 *
 * Two reductions, for two different reasons:
 *
 *  1. stripReportAppendices — Fundstrat's notes end with fixed appendices:
 *     the Large-cap / SMID "Core Ideas" ticker lists and the macro data
 *     tables. In Tom Lee's 2026-09-04 FLASH those were 37% of the extracted
 *     text. Dropping them is a CORRECTNESS fix, not only a saving:
 *       - the Core Ideas lists are ingested separately into the Research tab
 *         and are deliberately NOT part of the brief prompt, so smuggling a
 *         stale snapshot of them in through the note text is accidental;
 *       - the "Key Incoming Data" calendar is a SECOND list of dated events
 *         competing with the brief's own CATALYST CALENDAR block, which the
 *         prompt explicitly instructs the model to treat as the only source
 *         for catalystWatch.
 *
 *  2. taperOlderNote — the brief injects the whole 30-day window verbatim.
 *     Recent sessions stay in full; older ones keep just their opening, which
 *     is where these publishers put the title and Key Takeaways. That
 *     preserves the long-arc theme tracking the prompt asks for at a fraction
 *     of the tokens.
 */

/** Where the report stops being analysis and becomes a standing appendix.
 *  Anchored on section headings the publisher repeats verbatim; matching the
 *  EARLIEST one means a reordered report still cuts in the right place. */
const APPENDIX_MARKERS: RegExp[] = [
  /\bPart\s+I{1,3}:\s/,                          // "Part I: 46 Large-cap Core Ideas:"
  /\bThe Current (?:Large-cap|SMID) Core List\b/i,
  /\bKey Incoming Data\b/i,
  /\bEconomic Data Performance Tracker\b/i,
];

/** Below this, a "cut" is more likely a false positive than an appendix, so
 *  nothing is removed. Fail-open: keeping boilerplate is a cheap mistake,
 *  silently truncating a strategist's actual view is not. */
const MIN_KEPT_CHARS = 500;

export function stripReportAppendices(text: string): { text: string; removed: number } {
  let cut = text.length;
  for (const re of APPENDIX_MARKERS) {
    const m = text.match(re);
    if (m?.index !== undefined && m.index < cut) cut = m.index;
  }
  if (cut === text.length || cut < MIN_KEPT_CHARS) return { text, removed: 0 };
  const kept = text.slice(0, cut).trimEnd();
  return { text: kept, removed: text.length - kept.length };
}

/** Sessions kept at full length. Older notes are tapered to their opening. */
export const FULL_TEXT_SESSIONS = 5;
/** Enough for the title plus the Key Takeaways block in both publishers'
 *  layouts, which is where the thesis lives. */
export const TAPER_CHARS = 800;

export function taperOlderNote(text: string): { text: string; tapered: boolean } {
  if (text.length <= TAPER_CHARS) return { text, tapered: false };
  // Prefer a paragraph break near the limit so the excerpt ends on a whole
  // thought rather than mid-sentence.
  const window = text.slice(0, TAPER_CHARS + 200);
  const brk = window.lastIndexOf("\n\n");
  const end = brk >= TAPER_CHARS * 0.6 ? brk : TAPER_CHARS;
  return { text: text.slice(0, end).trimEnd() + "\n[…note truncated — full text retained in history]", tapered: true };
}

/**
 * Shape one strategist's 30-day history for the prompt. `entries` must be
 * oldest → newest; the last FULL_TEXT_SESSIONS keep their (appendix-stripped)
 * full text and everything older is tapered.
 */
export function shapeNotesForPrompt(
  entries: { date: string; text: string }[],
): { entries: { date: string; text: string }[]; removedChars: number; taperedCount: number } {
  let removedChars = 0;
  let taperedCount = 0;
  const firstFullIdx = Math.max(0, entries.length - FULL_TEXT_SESSIONS);
  const shaped = entries.map((e, i) => {
    const stripped = stripReportAppendices(e.text);
    removedChars += stripped.removed;
    if (i >= firstFullIdx) return { date: e.date, text: stripped.text };
    const t = taperOlderNote(stripped.text);
    if (t.tapered) taperedCount += 1;
    removedChars += stripped.text.length - t.text.length;
    return { date: e.date, text: t.text };
  });
  return { entries: shaped, removedChars, taperedCount };
}
