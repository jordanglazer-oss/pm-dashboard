/**
 * Detect the delimiter from the HEADER line. Column headers never contain
 * stray commas, so this is reliable even when data rows have commas inside
 * values (e.g. "Amazon.com, Inc." in a TAB-separated export). Prefer this +
 * the explicit `sep` arg of splitCsvRow over per-line auto-detection.
 */
export function detectCsvSeparator(headerLine: string): "\t" | "," {
  return headerLine.includes("\t") ? "\t" : ",";
}

/**
 * Tab/comma-tolerant CSV row splitter that respects double-quoted fields.
 * Shared by every CSV importer in the app (MarketEdge ChartScout, SIA,
 * BoostedAI). Pass `sep` (from detectCsvSeparator on the header) to make the
 * delimiter deterministic for the whole file; omit it to fall back to
 * per-line auto-detection (which can misfire on TAB files whose values
 * contain commas).
 */
export function splitCsvRow(line: string, sep?: string): string[] {
  const separator = sep ?? (line.includes("\t") && !line.includes(",") ? "\t" : ",");
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === separator && !inQuotes) {
      out.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Read a base64 data URL as a UTF-8 string (used to decode emailed CSVs). */
export function decodeBase64DataUrl(dataUrl: string): string {
  const m = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
  if (!m) return "";
  return Buffer.from(m[1], "base64").toString("utf8");
}
