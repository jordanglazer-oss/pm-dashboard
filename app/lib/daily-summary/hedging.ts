/**
 * Hedging + cash section — the brief's structured calls plus the live state
 * of the hedge ledger (marked against CBOE) and the year's cost of insurance.
 *
 * Redis: reads pm:brief, pm:brief-prevday, pm:hedges — READ-ONLY.
 * External: one CBOE fetch to mark active positions (best-effort; null marks
 * when a contract isn't listed — never zero).
 */

import { getRedis } from "@/app/lib/redis";
import { easternToday, daysFromToday } from "@/app/lib/date-eastern";
import { loadHedges, isActiveHedge, describeHedge, realizedPnlUsd, type HedgePosition } from "@/app/lib/hedges";
import { fetchPutQuotes } from "@/app/lib/hedging";
import type { MorningBrief } from "@/app/lib/types";

export type ActiveHedgeRow = {
  id: string;
  label: string;
  expiry: string | null;
  daysToExpiry: number | null;
  strikePrice: number | null;
  strikePctOtm: number | null;
  contracts: number | null;
  premiumUsd: number | null; // paid at entry
  premiumPctOfSpot: number | null;
  markMid: number | null; // current mid per share
  markUsd: number | null; // mid × 100 × contracts
  unrealizedUsd: number | null;
  spotAtEntry: number | null;
  spotNow: number | null;
};

export type HedgingSection = {
  call: NonNullable<MorningBrief["hedgingCall"]> | null;
  priorCall: string | null; // previous-day action, for the "what changed" strip
  refreshedAt: string | null;
  checklist: MorningBrief["hedgeChecklist"] | null;
  detail: {
    spotPrice: number;
    fetchedAt: string;
    anchors: { expiryLabel: string; daysToExpiry: number; otm5PctOfSpot: number | null; otm10PctOfSpot: number | null }[];
    buckets: { bucket: string; otm5Percentile: number | null; otm10Percentile: number | null; skewPercentile: number | null }[];
    sessions: number;
    firstDate: string | null;
    volAnchor: { vix: { level: number; percentile: number; years: number } | null; vix3m: { level: number; percentile: number; years: number } | null } | null;
    vvix: number | null;
  } | null;
  active: ActiveHedgeRow[];
  year: { premiumPaidUsd: number; realizedUsd: number; unrealizedUsd: number | null; closedCount: number; openCount: number };
};

export type CashSection = {
  call: NonNullable<MorningBrief["cashDeploymentCall"]> | null;
  priorAction: string | null;
  priorScore: number | null;
};

export type BriefDigest = {
  date: string | null;
  generatedAt: string | null;
  regime: string | null;
  regimeVerdict: string | null;
  bottomLine: string | null;
  whatChanged: string | null;
  topActions: { text: string; tags?: string[] }[];
  hedging: HedgingSection;
  cash: CashSection;
};

type PriorShape = {
  marketRegime?: string;
  regimeVerdict?: string;
  bottomLine?: string;
  hedgingCall?: { action?: string };
  cashDeploymentCall?: { action?: string; score?: number };
  date?: string;
  dateISO?: string;
  generatedAt?: string;
};

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await (await getRedis()).get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

async function markActive(hedges: HedgePosition[], today: string): Promise<ActiveHedgeRow[]> {
  const active = hedges.filter((h) => isActiveHedge(h, today));
  const wanted = active
    .filter((h) => h.expiry && typeof h.strikePrice === "number")
    .map((h) => ({ expiry: h.expiry as string, strike: h.strikePrice as number }));
  let quotes: Awaited<ReturnType<typeof fetchPutQuotes>> | null = null;
  if (wanted.length > 0) {
    try {
      quotes = await fetchPutQuotes(wanted);
    } catch {
      quotes = null;
    }
  }
  return active.map((h) => {
    const q = h.expiry && typeof h.strikePrice === "number" ? quotes?.get(`${h.expiry}|${h.strikePrice}`) : undefined;
    const mid = q?.mid ?? null;
    const contracts = typeof h.contracts === "number" ? h.contracts : null;
    const markUsd = mid != null && contracts != null ? mid * 100 * contracts : null;
    const paid = typeof h.premiumUsd === "number" ? h.premiumUsd : null;
    return {
      id: h.id,
      label: describeHedge(h),
      expiry: h.expiry ?? null,
      daysToExpiry: h.expiry ? daysFromToday(h.expiry.slice(0, 10), today) : null,
      strikePrice: typeof h.strikePrice === "number" ? h.strikePrice : null,
      strikePctOtm: typeof h.strikePctOtm === "number" ? h.strikePctOtm : null,
      contracts,
      premiumUsd: paid,
      premiumPctOfSpot: typeof h.premiumPctOfSpot === "number" ? h.premiumPctOfSpot : null,
      markMid: mid,
      markUsd: markUsd == null ? null : Math.round(markUsd),
      unrealizedUsd: markUsd != null && paid != null ? Math.round(markUsd - paid) : null,
      spotAtEntry: typeof h.spotAtEntry === "number" ? h.spotAtEntry : null,
      spotNow: q?.spot ?? null,
    };
  });
}

export async function buildBriefDigest(): Promise<BriefDigest> {
  const today = easternToday();
  const [brief, prior, hedges] = await Promise.all([
    readJson<MorningBrief>("pm:brief"),
    readJson<PriorShape>("pm:brief-prevday"),
    loadHedges().catch(() => [] as HedgePosition[]),
  ]);

  const active = await markActive(hedges, today);
  const year = today.slice(0, 4);
  const thisYear = hedges.filter((h) => (h.implementedAt ?? "").slice(0, 4) === year);
  const premiumPaidUsd = thisYear.reduce((s, h) => s + (typeof h.premiumUsd === "number" ? h.premiumUsd : 0), 0);
  const closed = thisYear.filter((h) => h.status === "closed");
  const realizedUsd = closed.reduce((s, h) => s + (realizedPnlUsd(h) ?? 0), 0);
  const unrealizedRows = active.filter((r) => r.unrealizedUsd != null);
  const unrealizedUsd = unrealizedRows.length ? unrealizedRows.reduce((s, r) => s + (r.unrealizedUsd as number), 0) : null;

  const d = brief?.hedgingDetail ?? null;
  const detail: HedgingSection["detail"] = d
    ? {
        spotPrice: d.spotPrice,
        fetchedAt: d.fetchedAt,
        anchors: (d.anchors ?? []).map((a) => ({ expiryLabel: a.expiryLabel, daysToExpiry: a.daysToExpiry, otm5PctOfSpot: a.otm5PctOfSpot, otm10PctOfSpot: a.otm10PctOfSpot })),
        buckets: (d.buckets ?? []).map((b) => ({ bucket: b.bucket, otm5Percentile: b.otm5Percentile, otm10Percentile: b.otm10Percentile, skewPercentile: b.skewPercentile })),
        sessions: d.sessions,
        firstDate: d.firstDate ?? null,
        volAnchor: d.volAnchor ? { vix: d.volAnchor.vix, vix3m: d.volAnchor.vix3m } : null,
        vvix: d.vvix ?? null,
      }
    : null;

  // The prior-day digest is only written when a NEW day's brief is generated;
  // when it's missing (or is the same day) fall back to nothing rather than
  // comparing the brief to itself.
  const priorIsPrevDay = prior && (prior.dateISO ?? prior.generatedAt ?? prior.date ?? "").slice(0, 10) < today;

  return {
    date: brief?.date ?? null,
    generatedAt: brief?.generatedAt ?? null,
    regime: brief?.marketRegime ?? null,
    regimeVerdict: brief?.regimeVerdict ?? null,
    bottomLine: brief?.bottomLine ?? null,
    whatChanged: brief?.whatChanged ?? null,
    topActions: brief?.topActionsDetail?.length
      ? brief.topActionsDetail
      : (brief?.topActionsToday ?? []).map((text) => ({ text })),
    hedging: {
      call: brief?.hedgingCall ?? null,
      priorCall: priorIsPrevDay ? prior?.hedgingCall?.action ?? null : null,
      refreshedAt: brief?.hedgingRefreshedAt ?? null,
      checklist: brief?.hedgeChecklist ?? null,
      detail,
      active,
      year: { premiumPaidUsd: Math.round(premiumPaidUsd), realizedUsd: Math.round(realizedUsd), unrealizedUsd, closedCount: closed.length, openCount: active.length },
    },
    cash: {
      call: brief?.cashDeploymentCall ?? null,
      priorAction: priorIsPrevDay ? prior?.cashDeploymentCall?.action ?? null : null,
      priorScore: priorIsPrevDay && typeof prior?.cashDeploymentCall?.score === "number" ? prior.cashDeploymentCall.score : null,
    },
  };
}
