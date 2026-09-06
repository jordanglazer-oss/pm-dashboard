/**
 * Action queue — ONE list merging every deterministic "do something" source
 * with the brief's AI top actions, each with a stable id the PM can mark
 * done / snoozed (pm:action-state).
 *
 * Sources (all read-only over their caches):
 *   kill      — tripped kill conditions (loadAlertInputs().killWatch)
 *   alert     — computeAlerts() high/medium (thesis / regime / technical)
 *   entry     — Watchlist/Suggested names whose entry scorecard just went ready
 *   coverage  — Portfolio stocks with no underwritten thesis
 *   change    — change-monitor events with severity down / warn
 *   earnings  — Portfolio prints inside 3 sessions
 *   ai        — brief.topActionsToday (date-scoped ids)
 */

import { getRedis } from "@/app/lib/redis";
import { easternToday, daysFromToday } from "@/app/lib/date-eastern";
import { loadAlertInputs } from "@/app/lib/alert-inputs";
import { computeAlerts, entryAlerts, type Alert } from "@/app/lib/alerts";
import { getEntryScan, newlyReady } from "@/app/lib/entry-scan";
import { loadChangeEvents } from "@/app/lib/change-monitor-load";
import type { ChangeEvent } from "@/app/lib/change-monitor";
import type { ActionState } from "@/app/api/kv/action-state/route";
import type { MorningBrief } from "@/app/lib/types";

export type ActionSource = "kill" | "alert" | "entry" | "coverage" | "change" | "earnings" | "ai";
export type ActionPriority = "high" | "medium" | "low";

export type ActionItem = {
  id: string;
  source: ActionSource;
  priority: ActionPriority;
  ticker?: string;
  name?: string;
  title: string;
  detail?: string;
  tags?: string[];
  href?: string;
  at?: string; // ISO — when the source event happened, if known
  state?: { status: "done" | "snoozed"; at: string; until?: string };
};

export type ActionsSection = {
  items: ActionItem[]; // open items, priority-sorted
  dismissed: ActionItem[]; // done / snoozed (still returned so the UI can show "N cleared")
  counts: { high: number; medium: number; low: number; open: number; cleared: number };
  thesis: {
    tripped: { ticker: string; conditions: { note: string; reading: string; trippedAt: string | null }[] }[];
    coverageMissing: { ticker: string; name?: string; hasProse: boolean }[];
    portfolioCount: number;
    underwritten: number;
  };
};

const PRIORITY_RANK: Record<ActionPriority, number> = { high: 0, medium: 1, low: 2 };

function alertToAction(a: Alert): ActionItem {
  return {
    id: `alert:${a.id}`,
    source: "alert",
    priority: a.priority,
    ticker: a.ticker,
    name: a.name,
    title: a.title,
    detail: a.action ? `${a.detail} — ${a.action}` : a.detail,
    tags: [a.category, ...(a.metrics ?? []).slice(0, 2)],
    href: a.ticker ? `/stock/${encodeURIComponent(a.ticker)}` : undefined,
  };
}

function changeToAction(e: ChangeEvent): ActionItem | null {
  if (e.severity !== "down" && e.severity !== "warn") return null;
  return {
    id: `change:${e.id}`,
    source: "change",
    priority: e.severity === "down" && e.bucket === "Portfolio" ? "medium" : "low",
    ticker: e.ticker,
    name: e.name,
    title: e.headline,
    detail: e.detail,
    tags: [e.type, e.delta ?? ""].filter(Boolean),
    href: `/stock/${encodeURIComponent(e.ticker)}`,
    at: e.at,
  };
}

async function readActionState(): Promise<ActionState> {
  try {
    const raw = await (await getRedis()).get("pm:action-state");
    return raw ? (JSON.parse(raw) as ActionState) : {};
  } catch {
    return {};
  }
}

export async function buildActionsSection(brief: MorningBrief | null): Promise<ActionsSection> {
  const today = easternToday();
  const [inputs, scan, changes, state, thesesRaw] = await Promise.all([
    loadAlertInputs(),
    getEntryScan().catch(() => null),
    loadChangeEvents(7).catch(() => [] as ChangeEvent[]),
    readActionState(),
    (async () => {
      try {
        const raw = await (await getRedis()).get("pm:position-theses");
        return raw ? (JSON.parse(raw) as Record<string, { why?: string; killConditions?: unknown[] }>) : {};
      } catch {
        return {};
      }
    })(),
  ]);

  const items: ActionItem[] = [];

  // Kill-condition trips.
  const tripped: ActionsSection["thesis"]["tripped"] = [];
  for (const k of inputs.killWatch) {
    const trips = k.checks.filter((c) => c.status === "tripped");
    if (trips.length === 0) continue;
    tripped.push({
      ticker: k.ticker,
      conditions: trips.map((c) => ({ note: c.condition.note ?? c.condition.kind, reading: c.reading, trippedAt: c.condition.trippedAt ?? null })),
    });
    for (const c of trips) {
      items.push({
        id: `kill:${k.ticker}:${c.condition.id}`,
        source: "kill",
        priority: "high",
        ticker: k.ticker,
        name: inputs.context[k.ticker]?.name,
        title: `${k.ticker} kill condition tripped`,
        detail: `${c.condition.note ?? c.condition.kind} — ${c.reading}`,
        tags: ["thesis"],
        href: `/stock/${encodeURIComponent(k.ticker)}`,
        at: c.condition.trippedAt ?? undefined,
      });
    }
  }

  // Alerts (thesis / regime / technical) + entry-ready pushes.
  const fresh = scan ? newlyReady(scan) : [];
  const alerts = [...computeAlerts({ thesis: inputs.thesis, transition: inputs.transition, risk: inputs.risk, context: inputs.context, killWatch: inputs.killWatch }), ...entryAlerts(fresh)];
  for (const a of alerts) {
    // Kill trips are already listed above with a finer id.
    if (a.category === "thesis" && /kill/i.test(a.title)) continue;
    const item = alertToAction(a);
    if (a.category === "entry") {
      item.id = `entry:${a.ticker}:${scan?.readySince?.[a.ticker ?? ""] ?? today}`;
      item.source = "entry";
    }
    items.push(item);
  }

  // Coverage gap — Portfolio stocks without an underwritten thesis.
  const coverageMissing: ActionsSection["thesis"]["coverageMissing"] = [];
  let portfolioCount = 0;
  const thesisFor = (tk: string) => thesesRaw[tk] ?? thesesRaw[tk.toUpperCase()];
  for (const [tk, c] of Object.entries(inputs.context)) {
    if (c.bucket !== "Portfolio") continue;
    if (c.instrumentType && c.instrumentType !== "stock") continue;
    portfolioCount++;
    const t = thesisFor(tk);
    const conds = Array.isArray(t?.killConditions) ? t.killConditions : [];
    if (conds.length) continue;
    coverageMissing.push({ ticker: tk, name: c.name, hasProse: Boolean(t?.why?.trim()) });
  }
  if (coverageMissing.length > 0) {
    items.push({
      id: `coverage:${coverageMissing.map((m) => m.ticker).sort().join(",")}`,
      source: "coverage",
      priority: "medium",
      title: `${coverageMissing.length} holding${coverageMissing.length === 1 ? "" : "s"} without an underwritten thesis`,
      detail: coverageMissing.map((m) => m.ticker).join(", "),
      tags: ["thesis"],
      href: "/thesis",
    });
  }

  // Change-monitor downgrades.
  for (const e of changes) {
    const item = changeToAction(e);
    if (item) items.push(item);
  }

  // Portfolio earnings inside 3 sessions.
  for (const [tk, c] of Object.entries(inputs.context)) {
    if (c.bucket !== "Portfolio" || !c.earningsDate) continue;
    const d = daysFromToday(c.earningsDate, today);
    if (!isFinite(d) || d < 0 || d > 3) continue;
    items.push({
      id: `earnings:${tk}:${c.earningsDate}`,
      source: "earnings",
      priority: d <= 1 ? "high" : "medium",
      ticker: tk,
      name: c.name,
      title: `${tk} reports ${d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`}`,
      detail: "Re-read the thesis and kill conditions before the print.",
      tags: ["earnings"],
      href: `/stock/${encodeURIComponent(tk)}`,
    });
  }

  // AI top actions from today's brief.
  const briefDay = (brief?.generatedAt ?? brief?.date ?? "").slice(0, 10);
  const aiList: { text: string; tags?: string[] }[] = brief?.topActionsDetail?.length
    ? brief.topActionsDetail
    : (brief?.topActionsToday ?? []).map((text) => ({ text }));
  aiList.forEach((a, i) => {
    items.push({
      id: `ai:${briefDay || today}:${i}`,
      source: "ai",
      priority: i === 0 ? "high" : "medium",
      title: a.text,
      tags: a.tags,
    });
  });

  // Apply done / snoozed marks (snoozes expire).
  const now = Date.now();
  const open: ActionItem[] = [];
  const dismissed: ActionItem[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    const mark = state[it.id];
    const snoozeLive = mark?.status === "snoozed" && (!mark.until || Date.parse(mark.until) > now);
    if (mark && (mark.status === "done" || snoozeLive)) {
      dismissed.push({ ...it, state: mark });
    } else open.push(it);
  }
  open.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.ticker ?? "").localeCompare(b.ticker ?? ""));

  return {
    items: open,
    dismissed,
    counts: {
      high: open.filter((i) => i.priority === "high").length,
      medium: open.filter((i) => i.priority === "medium").length,
      low: open.filter((i) => i.priority === "low").length,
      open: open.length,
      cleared: dismissed.length,
    },
    thesis: { tripped, coverageMissing, portfolioCount, underwritten: portfolioCount - coverageMissing.length },
  };
}
