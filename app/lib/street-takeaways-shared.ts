import type { StreetTakeaway } from "./street-takeaways";

/**
 * Client-safe half of the street-takeaways module — pure functions only, no
 * Redis import. Same split (and same reason) as brief-progress-shared:
 * app/lib/street-takeaways.ts imports the redis client, so a "use client"
 * component that imports a VALUE from it drags the node redis package into
 * the browser bundle and the Turbopack build fails. The type import above is
 * erased at compile time, so it costs nothing at runtime.
 *
 * street-takeaways.ts re-exports everything here, so server-side callers can
 * keep importing from the module they already use.
 */

/**
 * Human label for which FactSet report an entry came from.
 *
 * Read from the SUBJECT first, because the stored `kind` is only a two-way
 * split (takeaways vs metrics) used to pick the extraction schema —
 * detectTakeawayKind folds "Transcript Intelligence" into one of those two,
 * so `kind` alone cannot tell you which report you actually received. The
 * subject is kept verbatim for provenance and does distinguish them, and it
 * survives Re:/Fwd: prefixes because the match is unanchored.
 */
export function factsetKindLabel(entry: Pick<StreetTakeaway, "subject" | "kind">): string {
  const s = entry.subject ?? "";
  if (/transcript\s+intelligence/i.test(s)) return "Transcript Intelligence";
  if (/metrics\s+recap/i.test(s)) return "Metrics Recap";
  if (/street\s+takeaways/i.test(s)) return "Street Takeaways";
  return KIND_LABEL[entry.kind] ?? "FactSet alert";
}

/** Stable short labels per stored kind, used for the Inbox columns. */
export const KIND_LABEL: Record<string, string> = {
  takeaways: "Street Takeaways",
  metrics: "Metrics Recap",
  transcript: "Transcript Intelligence",
  other: "FactSet alert",
};

/** Column order for the Inbox — the two Jordan reads most, then the rest. */
export const FACTSET_KINDS = ["takeaways", "metrics", "transcript"] as const;
