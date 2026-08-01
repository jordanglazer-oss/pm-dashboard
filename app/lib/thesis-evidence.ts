import { getRedis } from "./redis";
import { getReportsForTicker, type AnalystReports, type ExtractedReport } from "./analyst-snapshots";
import { loadStreetTakeawaysFor, type StreetTakeaway } from "./street-takeaways";

/**
 * Shared evidence assembler for the thesis-discipline AI calls (thesis-draft,
 * custom-condition-check): formats the DATED, ATTRIBUTABLE material already
 * ingested for a ticker — the extracted RBC/JPM/Morningstar report bullets and
 * the FactSet Street Takeaways / Metrics Recap alerts — into one prompt block.
 *
 * Why this exists: both routes were leaning on web search / generated prose
 * alone. The ingested material is strictly better sourcing (the PM chose it,
 * it carries as-of dates and firm names) — so it goes into the prompt FIRST,
 * with web search demoted to gap-filling. Read-only; caps keep the block
 * bounded (~60 lines worst case) so it never bloats a call.
 */

const cap = <T,>(arr: T[] | undefined, n: number): T[] => (Array.isArray(arr) ? arr.slice(0, n) : []);

function reportLines(label: string, r: ExtractedReport | undefined): string[] {
  if (!r) return [];
  const head = [
    `${label}${r.asOf ? ` (as of ${r.asOf})` : ""}:`,
    r.rating ? `rating ${r.rating}` : null,
    r.target != null ? `target ${r.target}${r.targetCurrency ? ` ${r.targetCurrency}` : ""}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const out = [head];
  for (const t of cap(r.thesis, 4)) out.push(`  • thesis: ${t}`);
  for (const t of cap(r.risks, 4)) out.push(`  • risk: ${t}`);
  return out;
}

function takeawayLines(t: StreetTakeaway): string[] {
  const out: string[] = [
    `FactSet ${t.kind === "metrics" ? "Metrics Recap" : "Street Takeaways"} — ${t.date}${t.event ? ` (${t.event})` : ""}:`,
  ];
  if (t.overview) out.push(`  overview: ${t.overview}`);
  if (t.guidance) out.push(`  guidance: ${t.guidance}`);
  for (const r of cap(t.results, 6)) {
    out.push(
      `  • ${r.label}: ${r.actual ?? "—"}${r.consensus ? ` vs consensus ${r.consensus}` : ""}${r.yoy ? ` (${r.yoy} YoY)` : ""}`,
    );
  }
  for (const g of cap(t.guidanceLines, 4)) {
    out.push(
      `  • guide ${g.period} ${g.metric}: ${g.value}${g.priorGuidance ? ` (prior ${g.priorGuidance})` : ""}${g.direction ? ` — ${g.direction}` : ""}`,
    );
  }
  if (t.managementOutlook) out.push(`  management outlook: ${t.managementOutlook}`);
  for (const f of cap(t.firms, 3)) {
    const pts = cap(f.points, 2).join("; ");
    out.push(
      `  • ${f.firm}${f.rating ? ` (${f.rating}${f.target != null ? `, PT ${f.target}` : ""})` : ""}${pts ? `: ${pts}` : ""}`,
    );
  }
  return out;
}

/** Formatted evidence block for a ticker, or "" when nothing is ingested.
 *  Every line carries its source and date so downstream prompts can require
 *  inline attribution. */
export async function buildTickerEvidence(ticker: string): Promise<string> {
  const tk = ticker.toUpperCase();
  const [reportsRaw, takeaways] = await Promise.all([
    getRedis()
      .then((r) => r.get("pm:analyst-reports"))
      .catch(() => null),
    loadStreetTakeawaysFor(tk).catch(() => [] as StreetTakeaway[]),
  ]);
  const reports: AnalystReports = reportsRaw ? JSON.parse(reportsRaw) : {};
  const tr = getReportsForTicker(reports, tk);

  const lines: string[] = [
    ...reportLines("RBC report", tr?.rbc?.extracted),
    ...reportLines("JPM report", tr?.jpm?.extracted),
    ...reportLines("Morningstar report", tr?.morningstar?.extracted),
  ];
  const recent = (takeaways || [])
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 2);
  for (const t of recent) lines.push(...takeawayLines(t));

  return lines.join("\n");
}
