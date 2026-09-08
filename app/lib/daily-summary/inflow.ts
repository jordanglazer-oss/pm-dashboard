/**
 * Inflow — what arrived since the last session: analyst reports, FactSet
 * alerts, rescored names. READ-ONLY over pm:analyst-reports,
 * pm:street-takeaways, pm:score-history.
 */

import { getRedis } from "@/app/lib/redis";
import { loadStreetTakeaways, type StreetTakeaway } from "@/app/lib/street-takeaways";
import type { AnalystReports } from "@/app/lib/analyst-snapshots";
import type { ScoreHistoryStore } from "@/app/api/kv/score-history/route";

export type InflowSection = {
  sinceIso: string;
  reports: { ticker: string; source: string; at: string; label?: string }[];
  alerts: { ticker: string; kind: StreetTakeaway["kind"]; at: string; headline: string; date: string }[];
  rescored: { ticker: string; at: string; total: number; delta: number | null }[];
};

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await (await getRedis()).get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function buildInflowSection(hours = 30): Promise<InflowSection> {
  const sinceMs = Date.now() - hours * 60 * 60 * 1000;
  const sinceIso = new Date(sinceMs).toISOString();
  const [reports, takeaways, scores] = await Promise.all([
    readJson<AnalystReports>("pm:analyst-reports"),
    loadStreetTakeaways().catch(() => ({} as Record<string, StreetTakeaway[]>)),
    readJson<ScoreHistoryStore>("pm:score-history"),
  ]);

  const outReports: InflowSection["reports"] = [];
  for (const [tk, byWhom] of Object.entries(reports ?? {})) {
    for (const [source, meta] of Object.entries(byWhom ?? {})) {
      if (!meta?.uploadedAt) continue;
      if (Date.parse(meta.uploadedAt) >= sinceMs) outReports.push({ ticker: tk.toUpperCase(), source, at: meta.uploadedAt, label: meta.label });
    }
  }
  outReports.sort((a, b) => b.at.localeCompare(a.at));

  const outAlerts: InflowSection["alerts"] = [];
  for (const [tk, list] of Object.entries(takeaways)) {
    for (const t of list) {
      if (!t.ingestedAt || Date.parse(t.ingestedAt) < sinceMs) continue;
      outAlerts.push({
        ticker: tk.toUpperCase(),
        kind: t.kind,
        at: t.ingestedAt,
        date: t.date,
        headline: t.headline ?? t.event ?? t.subject ?? (t.kind === "metrics" ? "Metrics recap" : t.kind === "takeaways" ? "Street takeaways" : t.kind),
      });
    }
  }
  outAlerts.sort((a, b) => b.at.localeCompare(a.at));

  const outScores: InflowSection["rescored"] = [];
  for (const [tk, entries] of Object.entries(scores ?? {})) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const sorted = entries.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const last = sorted[sorted.length - 1];
    if (!last?.timestamp || Date.parse(last.timestamp) < sinceMs) continue;
    const prev = sorted.length > 1 ? sorted[sorted.length - 2] : null;
    outScores.push({ ticker: tk.toUpperCase(), at: last.timestamp, total: last.total, delta: prev ? parseFloat((last.total - prev.total).toFixed(1)) : null });
  }
  outScores.sort((a, b) => b.at.localeCompare(a.at));

  return { sinceIso, reports: outReports.slice(0, 20), alerts: outAlerts.slice(0, 20), rescored: outScores.slice(0, 20) };
}
