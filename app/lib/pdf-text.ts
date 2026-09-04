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
  const kept = canDrop ? pages.slice(0, totalPages - dropTrailingPages) : pages;
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
