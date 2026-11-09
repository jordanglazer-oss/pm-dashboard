import { getRedis } from "./redis";
import { createLogger } from "./logger";
import { holdingBucket, type BucketStock } from "./sleeve-targets";
import { tickersEqual } from "./ticker";
import type { PillarStance, ThesisTheme } from "./kill-conditions";
import type { PimModelData } from "./pim-types";

/**
 * Themes (Phase 2) — the investment themes the book is concentrated in, each
 * with its own pillars and a short list of BELLWETHERS (companies we may not
 * own whose results decide whether the theme holds).
 *
 * Store: `pm:themes` = { themes: { [id]: Theme } }. Written ONLY by
 * `POST /api/themes` (the PM saving / signing one theme — read-merge-write of
 * that one id, every other theme preserved). A theme is never hard-deleted:
 * "remove" sets `archivedAt`. The AI drafts (`/api/themes/draft`) write
 * nothing. BACKED UP.
 *
 * Membership is NOT stored: it is computed at read time from each signed
 * thesis's `themes[]` (pm:position-theses) matched against a theme's name and
 * aliases, so a thesis re-sign moves a holding between themes with no
 * second write. Exposure = the members' share of the PIM model's Alpha +
 * Thematic weight (everything outside Core).
 */

const log = createLogger("Themes");
export const THEMES_KEY = "pm:themes";

export type ThemePillar = {
  id: string;
  title: string;
  claim: string;
  status?: PillarStance;
  statusNote?: string;
  statusSince?: string;
  statusBy?: "ai" | "pm";
};

export type Bellwether = { ticker: string; name?: string; why: string };

export type Theme = {
  id: string;
  name: string;
  /** Other names theses use for the same theme (matched case-insensitively). */
  aliases?: string[];
  summary?: string;
  pillars: ThemePillar[];
  bellwethers: Bellwether[];
  aiDrafted?: boolean;
  signedAt?: string;
  updatedAt: string;
  archivedAt?: string;
  /** Prior signed versions, newest last (≤ 8). */
  history?: Array<{ savedAt: string; summary?: string; pillars: ThemePillar[]; bellwethers: Bellwether[] }>;
};

export type ThemeStore = { themes: Record<string, Theme> };

export const themeSlug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "theme";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function parseThemeStore(raw: string | null): ThemeStore {
  if (!raw) return { themes: {} };
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && v.themes && typeof v.themes === "object" ? (v as ThemeStore) : { themes: {} };
  } catch {
    return { themes: {} };
  }
}

export async function loadThemes(): Promise<ThemeStore> {
  try {
    return parseThemeStore(await (await getRedis()).get(THEMES_KEY));
  } catch (e) {
    log.error("read failed:", e);
    return { themes: {} };
  }
}

/** Every bellwether ticker of every live theme (upper-case). */
export async function bellwetherTickers(): Promise<string[]> {
  const { themes } = await loadThemes();
  const out = new Set<string>();
  for (const t of Object.values(themes)) {
    if (t.archivedAt) continue;
    for (const b of t.bellwethers ?? []) if (b.ticker) out.add(b.ticker.toUpperCase());
  }
  return [...out];
}

/** Does a thesis's theme name belong to this theme? */
export function themeMatches(theme: Pick<Theme, "name" | "aliases">, thesisThemeName: string): boolean {
  const n = norm(thesisThemeName);
  if (!n) return false;
  return [theme.name, ...(theme.aliases ?? [])].some((a) => norm(a) === n);
}

export type ThemeMember = {
  ticker: string;
  bucket: "Portfolio" | "Watchlist" | "other";
  role: string;
  exposure?: string;
  /** Weight in the PIM model's non-Core equity, 0-1 (held names only). */
  alphaShare?: number;
  equityBucket?: "core" | "thematic" | "alpha";
};

export type ThemeView = Theme & { members: ThemeMember[]; alphaShare: number };

export type DetectedTheme = { name: string; tickers: string[] };

type ThesisLite = { themes?: ThesisTheme[] };
type StockLite = BucketStock & { bucket?: string; name?: string };

/**
 * Join themes with the book. Pure given its inputs: returns each live theme
 * with its members and Alpha share, plus thesis theme names no theme claims
 * yet ("detected" — the starting list for a new theme).
 */
export function buildThemeViews(
  store: ThemeStore,
  theses: Record<string, ThesisLite>,
  stocks: StockLite[],
  models: PimModelData | null,
): { themes: ThemeView[]; detected: DetectedTheme[]; alphaTotal: number } {
  const pim = models?.groups?.find((g) => g.id === "pim");
  const equity = (pim?.holdings ?? []).filter((h) => h.assetClass === "equity");
  const nonCore = equity.filter((h) => holdingBucket(h, stocks) !== "core");
  const alphaTotal = nonCore.reduce((s, h) => s + (h.weightInClass || 0), 0);
  const weightOf = (tk: string) => {
    const h = nonCore.find((x) => tickersEqual(x.symbol, tk));
    return h && alphaTotal > 0 ? { share: (h.weightInClass || 0) / alphaTotal, bucket: holdingBucket(h, stocks) } : null;
  };
  const bucketOf = (tk: string): ThemeMember["bucket"] => {
    const s = stocks.find((x) => x.ticker && tickersEqual(x.ticker, tk));
    return s?.bucket === "Portfolio" ? "Portfolio" : s?.bucket === "Watchlist" ? "Watchlist" : "other";
  };

  const live = Object.values(store.themes).filter((t) => !t.archivedAt);
  const claimed = new Set<string>();
  const views: ThemeView[] = live.map((t) => {
    const members: ThemeMember[] = [];
    for (const [tk, th] of Object.entries(theses)) {
      for (const tt of th?.themes ?? []) {
        if (!tt?.name || !themeMatches(t, tt.name)) continue;
        claimed.add(norm(tt.name));
        const w = weightOf(tk);
        members.push({
          ticker: tk,
          bucket: bucketOf(tk),
          role: tt.role,
          ...(tt.exposure ? { exposure: tt.exposure } : {}),
          ...(w ? { alphaShare: w.share, equityBucket: w.bucket } : {}),
        });
        break;
      }
    }
    members.sort((a, b) => (b.alphaShare ?? -1) - (a.alphaShare ?? -1) || a.ticker.localeCompare(b.ticker));
    return { ...t, members, alphaShare: members.reduce((s, m) => s + (m.alphaShare ?? 0), 0) };
  });
  views.sort((a, b) => b.alphaShare - a.alphaShare || a.name.localeCompare(b.name));

  const detectedMap = new Map<string, DetectedTheme>();
  for (const [tk, th] of Object.entries(theses)) {
    for (const tt of th?.themes ?? []) {
      if (!tt?.name || claimed.has(norm(tt.name))) continue;
      const k = norm(tt.name);
      const d = detectedMap.get(k) ?? { name: tt.name, tickers: [] };
      if (!d.tickers.includes(tk)) d.tickers.push(tk);
      detectedMap.set(k, d);
    }
  }
  const detected = [...detectedMap.values()].sort((a, b) => b.tickers.length - a.tickers.length || a.name.localeCompare(b.name));
  return { themes: views, detected, alphaTotal };
}

/** Read everything buildThemeViews needs, once. */
export async function loadThemeViews() {
  const redis = await getRedis();
  const [store, thesesRaw, stocksRaw, modelsRaw] = await Promise.all([
    loadThemes(),
    redis.get("pm:position-theses"),
    redis.get("pm:stocks"),
    redis.get("pm:pim-models"),
  ]);
  const parse = <T,>(raw: string | null, fallback: T): T => {
    try {
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  const theses = parse<Record<string, ThesisLite>>(thesesRaw, {});
  const stocks = parse<StockLite[]>(stocksRaw, []);
  const models = parse<PimModelData | null>(modelsRaw, null);
  return buildThemeViews(store, theses, Array.isArray(stocks) ? stocks : [], models);
}

// ── Bellwether evidence ─────────────────────────────────────────────────────
//
// FactSet alerts for BELLWETHER names (not in the book) are kept as theme
// evidence in their OWN key, `pm:theme-evidence` = { [TICKER]: StreetTakeaway[] }
// (newest first, ≤ MAX_EVIDENCE_PER_TICKER, ≤ EVIDENCE_MAX_AGE_DAYS) — never in
// pm:street-takeaways, whose readers (scoring, synthesis, thesis evidence,
// the Inbox) treat every key as a book name. Written only by the email
// ingest (read-merge-write of one ticker). Regenerable from new alerts;
// BACKED UP.

export const THEME_EVIDENCE_KEY = "pm:theme-evidence";
const MAX_EVIDENCE_PER_TICKER = 8;
const EVIDENCE_MAX_AGE_DAYS = 200;

type EvidenceEntry = { id: string; ticker: string; date: string; kind?: string; event?: string; headline?: string; [k: string]: unknown };

export async function loadThemeEvidence(): Promise<Record<string, EvidenceEntry[]>> {
  try {
    const raw = await (await getRedis()).get(THEME_EVIDENCE_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export async function appendThemeEvidence(entry: EvidenceEntry): Promise<{ added: boolean; count: number }> {
  const redis = await getRedis();
  const raw = await redis.get(THEME_EVIDENCE_KEY);
  let store: Record<string, EvidenceEntry[]> = {};
  try {
    const v = raw ? JSON.parse(raw) : {};
    store = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return { added: false, count: 0 }; // unreadable blob: never overwrite it
  }
  const key = entry.ticker.toUpperCase();
  const same = (e: EvidenceEntry) => e.date === entry.date && (e.kind ?? "") === (entry.kind ?? "") && (e.event ?? e.headline ?? "") === (entry.event ?? entry.headline ?? "");
  const cutoff = new Date(Date.now() - EVIDENCE_MAX_AGE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const list = [entry, ...(store[key] ?? []).filter((e) => !same(e))]
    .filter((e) => e.date >= cutoff)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_EVIDENCE_PER_TICKER);
  await redis.set(THEME_EVIDENCE_KEY, JSON.stringify({ ...store, [key]: list }));
  return { added: true, count: list.length };
}
