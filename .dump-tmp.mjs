import { readFileSync } from "node:fs";
import { extractPdfText } from "./app/lib/pdf-text.ts";
const r = await extractPdfText("data:application/pdf;base64," + readFileSync("sia-samples/Lee - 2026-09-04.pdf").toString("base64"), 2);
console.log(`total=${r.totalPages} used=${r.usedPages} dropped=${r.droppedPages} chars=${r.text.length} words=${r.text.split(/\s+/).length}`);
console.log("has 'Disclosures':", /Disclosures/i.test(r.text), "| has 'Page N':", /Page \d/.test(r.text), "| 'FLASH Sep' count:", (r.text.match(/FLASH September/g)||[]).length);
console.log("\n--- chars 600-2200 ---\n" + r.text.slice(600, 2200));
