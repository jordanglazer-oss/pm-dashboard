/**
 * "Why we own it" — 4 to 5 short, plain-language points per holding (Nov 26
 * 2026 team session). Pure types + helpers; the store is read and written
 * only by /api/why-we-own.
 *
 * Redis: pm:why-we-own
 *   { entries: { [SYMBOL]: { points, status: "draft" | "approved", source,
 *     approvedBy?, approvedAt?, updatedAt, history: prior versions (≤ 8) } } }
 * A draft is marked "draft: needs review" until a person approves it. Saving
 * ONE symbol is a read-merge-write; a prior version is kept in `history`, so
 * the page can show how the reasons changed. Nothing is deleted when a
 * position is sold: the entry stays as the record for closed positions.
 * ADDS data only — pm:position-theses and pm:fund-one-pagers are read, never
 * changed. BACKED UP (not in the backup exclude list).
 */

export const WHY_KEY = "pm:why-we-own";
export const MAX_POINTS = 5;
export const MAX_HISTORY = 8;

export type WhySource = "from thesis" | "from one-pager" | "written by hand";
export type WhyVersion = { points: string[]; status: "draft" | "approved"; source: WhySource; approvedBy?: string; approvedAt?: string; updatedAt: string };
export type WhyEntry = WhyVersion & { history?: WhyVersion[] };
export type WhyStore = { entries: Record<string, WhyEntry>; updatedAt?: string };

export const whyKey = (symbol: string) => symbol.trim().toUpperCase().replace(/\.TO$/, "-T");

/** Trim, drop blanks, cap the count and each point's length. */
export function cleanPoints(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => (typeof p === "string" ? p.replace(/\s+/g, " ").trim() : ""))
    .filter(Boolean)
    .map((p) => (p.length > 320 ? p.slice(0, 317).trimEnd() + "…" : p))
    .slice(0, MAX_POINTS);
}

/** A first draft from what is already on file: thesis pillars (stocks) or the one-pager's reasons (funds). No model call. */
export function draftFromOnFile(thesis: { why?: string; pillars?: unknown[] } | null | undefined, pager: { whyWeOwn?: string[]; headline?: string } | null | undefined): { points: string[]; source: WhySource } | null {
  const pillars = (thesis?.pillars ?? []).filter((p): p is { title?: string; claim?: string } => Boolean(p) && typeof p === "object");
  const fromPillars = cleanPoints(pillars.map((p) => [p.title, p.claim].filter(Boolean).join(": ")));
  if (fromPillars.length) return { points: fromPillars, source: "from thesis" };
  const fromPager = cleanPoints(pager?.whyWeOwn ?? []);
  if (fromPager.length) return { points: fromPager, source: "from one-pager" };
  const why = (thesis?.why ?? "").trim();
  if (why) {
    const sentences = cleanPoints(why.split(/(?<=[.!?])\s+|\n+/));
    if (sentences.length) return { points: sentences, source: "from thesis" };
  }
  return null;
}

/** Merge one saved entry into the store, keeping the prior version in history. */
export function mergeWhy(store: WhyStore, symbol: string, next: WhyVersion): WhyStore {
  const k = whyKey(symbol);
  const prior = store.entries?.[k];
  const history = prior ? [...(prior.history ?? []), { points: prior.points, status: prior.status, source: prior.source, approvedBy: prior.approvedBy, approvedAt: prior.approvedAt, updatedAt: prior.updatedAt }].slice(-MAX_HISTORY) : [];
  return { ...store, entries: { ...(store.entries ?? {}), [k]: { ...prior, ...next, history } }, updatedAt: next.updatedAt };
}
