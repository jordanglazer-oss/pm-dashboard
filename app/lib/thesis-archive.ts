/**
 * pm:position-theses-archive — theses removed from the Thesis desk (sold
 * names), kept so a removal can be undone. `{ [TICKER]: ArchivedThesis[] }`,
 * newest last, capped per ticker. Written by DELETE /api/kv/position-theses
 * (archive-then-remove) and POST /api/kv/position-theses/archive (restore).
 * BACKED UP (not in the backup exclude list).
 */
export const THESIS_ARCHIVE_KEY = "pm:position-theses-archive";
export const MAX_ARCHIVED_PER_TICKER = 5;
export type ArchivedThesis = Record<string, unknown> & { removedAt: string; underwrittenAt?: string };
