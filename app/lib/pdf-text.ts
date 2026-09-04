/**
 * PDF text-layer extraction, per page.
 *
 * Used by the strategist-note inbox flow (Fundstrat daily PDFs forwarded from
 * the PM's work email) so the report can be ingested WITHOUT a copy-paste and
 * WITHOUT spending Anthropic tokens: these notes carry a real text layer, so
 * pdf.js reads them for free. Charts are deliberately NOT interpreted — only
 * the text is stored, which is exactly what the manual paste produced.
 *
 * Per-PAGE extraction (rather than one merged string) is what makes "always
 * drop the last 2 pages" exact: the Fundstrat notes end with two fixed
 * disclosure pages that must never reach the Morning Brief prompt.
 *
 * unpdf is a serverless-targeted build of pdf.js — no native deps, no
 * filesystem, works in the Vercel Node runtime.
 */

const PDF_DATA_URL_RE = /^data:application\/pdf;base64,(.+)$/;

export type PdfTextResult = {
  /** Text of the pages we kept, joined with blank lines. */
  text: string;
  /** Pages in the source document. */
  totalPages: number;
  /** Pages actually used (totalPages minus the dropped trailing pages). */
  usedPages: number;
  /** Trailing pages dropped (0 when the doc was too short to trim). */
  droppedPages: number;
};

/**
 * Strip the running page furniture that pdf.js emits at the END of each page:
 * the page number, the "see Page N" disclosures pointer, and the repeated
 * running header (e.g. "Daily Technical Strategy September 3, 2026").
 *
 * The header is DETECTED as the longest common suffix shared by two or more
 * pages rather than hard-coded, so it keeps working if the publisher changes
 * its wording or moves offices — and so this helper stays useful for any
 * other report PDF. Only trailing text is touched: furniture always sorts
 * last in the text layer, and anchoring to the end is what makes it safe to
 * remove without risking real prose.
 */
function stripPageFurniture(pages: string[]): string[] {
  const dropTrailers = (t: string) =>
    t
      .replace(/\s*Page\s*\d+\s*$/i, "")
      .replace(/\s*For important disclosures,?\s*see\s*Page\s*\d+\s*$/i, "")
      .trimEnd();

  const stage1 = pages.map(dropTrailers);

  // Find the repeated header as the suffix shared by the MOST pages.
  //
  // The longest common suffix of any single PAIR is not it: two pages whose
  // prose happens to end on the same letter ("…sessions" / "…stocks") share
  // that letter too, yielding a candidate that then matches only those two.
  // So take that candidate and walk it left-to-right, scoring each suffix by
  // how many pages actually end with it — coverage first, length as the
  // tie-break. The real header wins because every page carries it.
  const MAX_HEADER = 120;
  let candidate = "";
  for (let i = 0; i < stage1.length; i++) {
    for (let j = i + 1; j < stage1.length; j++) {
      const a = stage1[i], b = stage1[j];
      let k = 0;
      while (k < a.length && k < b.length && k < MAX_HEADER && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
      if (k > candidate.length) candidate = a.slice(a.length - k);
    }
  }

  let header = "";
  let coverage = 0;
  for (let start = 0; start < candidate.length; start++) {
    const cand = candidate.slice(start);
    if (cand.trim().length < 8) break; // too short to be anything but coincidence
    const hits = stage1.filter((t) => t.endsWith(cand)).length;
    if (hits > coverage) { header = cand; coverage = hits; }
  }
  // Needs to repeat to be furniture at all.
  if (coverage < 2) return stage1.map((t) => t.trim());
  return stage1.map((t) => dropTrailers(t.endsWith(header) ? t.slice(0, -header.length) : t).trim());
}

/** Extract each page's text layer. Returns one string per page, in order.
 *  A page with no text layer (a scanned/image page) yields "". */
export async function extractPdfPageTexts(dataUrl: string): Promise<string[]> {
  const m = dataUrl.match(PDF_DATA_URL_RE);
  if (!m) throw new Error("Not a base64 PDF data URL");
  const bytes = new Uint8Array(Buffer.from(m[1], "base64"));
  // Imported lazily so the pdf.js bundle is only pulled into routes that
  // actually parse a PDF.
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(bytes);
  const { text } = await extractText(doc, { mergePages: false });
  return Array.isArray(text) ? text : [String(text ?? "")];
}

/**
 * Extract a PDF's text with the last `dropTrailingPages` pages removed.
 *
 * Guard: if the document has no more pages than we'd drop, NOTHING is dropped
 * and `droppedPages` is 0 — trimming a 2-page document by 2 would leave an
 * empty note, and silently storing "" is worse than storing the disclosures.
 * The caller's length check then decides what to do.
 */
export async function extractPdfText(
  dataUrl: string,
  dropTrailingPages = 0,
): Promise<PdfTextResult> {
  const pages = await extractPdfPageTexts(dataUrl);
  const totalPages = pages.length;
  const canDrop = dropTrailingPages > 0 && totalPages > dropTrailingPages;
  const kept = stripPageFurniture(canDrop ? pages.slice(0, totalPages - dropTrailingPages) : pages);
  const text = kept
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n")
    // pdf.js emits a lot of incidental whitespace; collapse runs of blank
    // lines and trailing spaces so the stored note reads like the paste did.
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    text,
    totalPages,
    usedPages: kept.length,
    droppedPages: canDrop ? dropTrailingPages : 0,
  };
}
