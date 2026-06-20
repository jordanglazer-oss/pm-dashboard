/**
 * Tab/comma-tolerant CSV row splitter that respects double-quoted fields.
 * Shared by every CSV importer in the app (MarketEdge ChartScout, SIA, etc.)
 * so they all behave identically — same separator auto-detection, same
 * handling of quoted commas/tabs and escaped double-quotes.
 */
export function splitCsvRow(line: string): string[] {
  // Auto-detect tab vs comma per file. Most CSV exports we ingest are
  // comma-separated; copy-pasted ranges from Numbers / Excel come through
  // as tab-separated.
  const sep = line.includes("\t") && !line.includes(",") ? "\t" : ",";
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === sep && !inQuotes) {
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
