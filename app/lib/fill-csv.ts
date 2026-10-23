/* ─── Fill-price CSV → { planSymbol: price } ───
 *
 * For the staged rebalance's "Average fill price" column. Tolerant of what a
 * desk export looks like: comma / semicolon / tab, quoted cells, "$" and
 * thousands separators, a header row or none. Symbols match across listing
 * forms (CNR-T = CNR.TO = "CNR CN", QQC.F-T = QQC-F.TO, QQQX.U = QQQX-U.TO).
 * Pure; nothing is written anywhere. */

export type FillCsvResult = {
  prices: Record<string, number>;
  unmatched: string[];
  ambiguous: string[];
};

export function symbolKey(raw: string): string {
  let s = raw.toUpperCase().replace(/\s+(CN|CT|US|UN|UW|UQ|EQUITY)\b.*$/, "").trim();
  s = s.replace(/\s+/g, "");
  s = s.replace(/(\.TO|-T|\.TSX|:CA)$/, "").replace(/^TSX:/, "");
  return s.replace(/-/g, ".");
}

function splitRow(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === delim && !q) { out.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

const num = (v: string) => {
  const n = parseFloat((v ?? "").replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1"));
  return isFinite(n) ? n : NaN;
};

export function parseFillCsv(text: string, planSymbols: string[]): FillCsvResult {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { prices: {}, unmatched: [], ambiguous: [] };
  const delim = [",", ";", "\t"].map((d) => [d, lines[0].split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows = lines.map((l) => splitRow(l, delim));

  // Header? → pick the symbol + price columns by name.
  const head = rows[0].map((h) => h.toLowerCase());
  const hasHeader = head.some((h) => /symbol|ticker|security|code/.test(h)) && rows[0].every((c) => isNaN(num(c)) || c === "");
  let symCol = 0, pxCol = -1;
  if (hasHeader) {
    symCol = Math.max(0, head.findIndex((h) => /symbol|ticker/.test(h)));
    if (symCol === 0 && !/symbol|ticker/.test(head[0])) symCol = Math.max(0, head.findIndex((h) => /security|code/.test(h)));
    const pref = [/avg|average/, /fill/, /price/, /cost/];
    for (const re of pref) { const i = head.findIndex((h, j) => j !== symCol && re.test(h)); if (i >= 0) { pxCol = i; break; } }
  }
  const body = hasHeader ? rows.slice(1) : rows;
  if (pxCol < 0) {
    // No usable header: the first numeric column after the symbol.
    const sample = body[0] ?? [];
    pxCol = sample.findIndex((c, j) => j !== symCol && num(c) > 0);
  }

  const byKey = new Map<string, string[]>();
  for (const s of planSymbols) byKey.set(symbolKey(s), [...(byKey.get(symbolKey(s)) ?? []), s]);

  const prices: Record<string, number> = {};
  const unmatched: string[] = [], ambiguous: string[] = [];
  for (const r of body) {
    const sym = r[symCol] ?? "";
    const p = num(r[pxCol] ?? "");
    if (!sym || !(p > 0)) continue;
    const hits = byKey.get(symbolKey(sym)) ?? [];
    if (hits.length === 1) prices[hits[0]] = p;
    else if (hits.length > 1) ambiguous.push(sym);
    else unmatched.push(sym);
  }
  return { prices, unmatched, ambiguous };
}
