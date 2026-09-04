/**
 * Diagnose whether a PDF carries a real text layer.
 *
 * The strategist-note ingest (Newton / Lee Fundstrat dailies) reads the text
 * layer locally with pdf.js — free, no Anthropic call. That only works if the
 * publisher embedded text rather than rendering pages as images. This prints a
 * per-page character count and a verdict so the question is answered in one
 * command instead of by sending a test email and reading the inbox log.
 *
 * Exists as a script because macOS TCC blocks the agent's shell from reading
 * ~/Library/Containers/com.apple.mail, so this has to be runnable by hand from
 * a Terminal that does have access.
 *
 *   node scripts/check-pdf-text.mjs "/path/to/Newton - 2026-09-03.pdf"
 */
import { readFileSync } from "node:fs";
import { extractText, getDocumentProxy } from "unpdf";

const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/check-pdf-text.mjs "/path/to/file.pdf"');
  process.exit(2);
}

// Same two constants the ingest uses, so this reports what WOULD be stored.
const DISCLOSURE_PAGES = 2;
const MIN_CHARS = 100;

let bytes;
try {
  bytes = new Uint8Array(readFileSync(path));
} catch (e) {
  console.error(`Could not read the file: ${e.message}`);
  if (e.code === "EPERM") {
    console.error(
      "\nmacOS is blocking access. Either copy the PDF somewhere unprotected\n" +
      "(e.g. the repo's sia-samples/ folder) or grant this Terminal Full Disk\n" +
      "Access in System Settings > Privacy & Security.",
    );
  }
  process.exit(1);
}

const doc = await getDocumentProxy(bytes);
const { text } = await extractText(doc, { mergePages: false });
const pages = Array.isArray(text) ? text : [String(text ?? "")];

console.log(`\n${path.split("/").pop()} — ${pages.length} pages\n`);
pages.forEach((p, i) => {
  const n = p.trim().length;
  const kept = i < pages.length - DISCLOSURE_PAGES;
  console.log(
    `  p${String(i + 1).padStart(2)} ${kept ? "keep " : "DROP "} ${String(n).padStart(6)} chars  ${p.trim().slice(0, 60).replace(/\s+/g, " ")}`,
  );
});

const kept = pages.slice(0, Math.max(0, pages.length - DISCLOSURE_PAGES));
const body = kept.map((p) => p.trim()).filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
const words = body ? body.split(/\s+/).length : 0;

console.log(`\n  kept ${kept.length}/${pages.length} pages -> ${body.length} chars, ~${words} words`);
console.log(
  body.length >= MIN_CHARS
    ? "  VERDICT: text layer present — free extraction works.\n"
    : `  VERDICT: NO usable text layer (under ${MIN_CHARS} chars). Image-only PDF;\n` +
      "           the ingest would refuse this and a paid vision pass is needed.\n",
);

console.log("--- first 600 chars of what would be stored ---");
console.log(body.slice(0, 600) || "(nothing)");
