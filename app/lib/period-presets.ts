/**
 * Period presets shared by the read-only performance panels (the same set
 * and the same date maths as the Sleeves vs Core panel).
 */

export type PeriodPreset = "mtd" | "qtd" | "ytd" | "1y" | "all" | "custom";
export const PERIOD_PRESETS: { key: PeriodPreset; label: string }[] = [
  { key: "mtd", label: "MTD" },
  { key: "qtd", label: "QTD" },
  { key: "ytd", label: "YTD" },
  { key: "1y", label: "1 year" },
  { key: "all", label: "Since start" },
  { key: "custom", label: "Custom" },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** `from: null` = from the start of whatever series is being read. */
export function periodRange(p: PeriodPreset, custom: { from: string; to: string }, now: Date = new Date()): { from: string | null; to: string } {
  const today = iso(now);
  if (p === "custom") return { from: custom.from || null, to: custom.to || today };
  if (p === "all") return { from: null, to: today };
  if (p === "mtd") return { from: `${today.slice(0, 7)}-01`, to: today };
  if (p === "ytd") return { from: `${now.getFullYear()}-01-01`, to: today };
  if (p === "qtd") {
    const q = Math.floor(now.getMonth() / 3) * 3;
    return { from: iso(new Date(Date.UTC(now.getFullYear(), q, 1))), to: today };
  }
  const y = new Date(now);
  y.setFullYear(y.getFullYear() - 1);
  return { from: iso(y), to: today };
}
