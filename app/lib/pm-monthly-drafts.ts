import { getRedis } from "./redis";
import type { MonthlyDraft } from "./pm-monthly-shared";

/**
 * `pm:pm-monthly-drafts` = { months: { "YYYY-MM": MonthlyDraft } } — the PM
 * Monthly drafts in English and French, as edited by the PM. Written ONLY by
 * POST /api/pm-monthly (save ONE month — read-merge-write of that month; the
 * previous text goes into its `history`, ≤ 5). The AI routes (draft,
 * translate) write nothing. BACKED UP.
 */

export const PM_MONTHLY_KEY = "pm:pm-monthly-drafts";
const MAX_HISTORY = 5;

type Store = { months: Record<string, MonthlyDraft>; [k: string]: unknown };

async function read(): Promise<Store> {
  const raw = await (await getRedis()).get(PM_MONTHLY_KEY);
  if (!raw) return { months: {} };
  const v = JSON.parse(raw); // throws on a corrupt blob → callers never overwrite it
  return v && typeof v === "object" && v.months ? v : { ...v, months: {} };
}

export async function loadMonthlyDraft(month: string): Promise<MonthlyDraft | null> {
  try {
    return (await read()).months[month] ?? null;
  } catch {
    return null;
  }
}

export async function saveMonthlyDraft(month: string, patch: { en?: string; fr?: string; notes?: string; aiDrafted?: boolean; sources?: { url: string; title?: string }[] }): Promise<MonthlyDraft> {
  const store = await read();
  const prev = store.months[month];
  const now = new Date().toISOString();
  const clip = (s: unknown) => (typeof s === "string" ? s.slice(0, 20000) : undefined);
  const next: MonthlyDraft = {
    month,
    en: clip(patch.en) ?? prev?.en ?? "",
    fr: clip(patch.fr) ?? prev?.fr ?? "",
    notes: clip(patch.notes) ?? prev?.notes ?? "",
    aiDrafted: patch.aiDrafted ?? prev?.aiDrafted ?? false,
    sources: patch.sources ?? prev?.sources ?? [],
    updatedAt: now,
    history: prev && (prev.en || prev.fr) ? [...(prev.history ?? []), { savedAt: prev.updatedAt, en: prev.en, fr: prev.fr }].slice(-MAX_HISTORY) : prev?.history ?? [],
  };
  await (await getRedis()).set(PM_MONTHLY_KEY, JSON.stringify({ ...store, months: { ...store.months, [month]: next } }));
  return next;
}
