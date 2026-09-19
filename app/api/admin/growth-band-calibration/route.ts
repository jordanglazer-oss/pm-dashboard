import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { getRedis } from "@/app/lib/redis";
import { crossSectional, factsetConfigured, relayRetry, type FactsetValue } from "@/app/lib/factset";
import { resolveFactsetId } from "@/app/lib/factset-symbols";
import { normalizeFactsetSector } from "@/app/lib/factset-fundamentals";
import { universeTickers, LIST_VERSION } from "@/app/lib/factor-constituents";
import { pickPlaybook } from "@/app/lib/sector-playbook";
import {
  deriveGrowthInputs, winsorSort, quantile, GROWTH_CUTS, GROWTH_WEIGHTS, MIN_GROUP_SIZE, TOP_MARK_FLOOR_PCT,
  GROUP_METRIC_RULES, GROWTH_BANDS_KEY, type GrowthBands, type GrowthGroup, type GrowthMetricKey, type RawGrowthRow,
} from "@/app/lib/growth-score";

/**
 * GET /api/admin/growth-band-calibration            → DRY RUN (default)
 * GET /api/admin/growth-band-calibration?confirm=YES → store the bands
 * GET /api/admin/growth-band-calibration?view=1      → show the stored bands
 *
 * Builds the peer-group growth distributions the computed growth score ranks
 * against: forward sales growth, forward EPS growth, the 3–5y growth estimate
 * and delivered 3-year growth, for every S&P 500 + TSX 60 constituent, grouped
 * by sector playbook (and by GICS sector, the fold-in target for small groups).
 *
 * The DRY RUN is the audit: it lists every constituent with its four values,
 * every exclusion with its reason, and each group's cut points, so any name
 * can be checked against a FactSet terminal before anything is stored.
 *
 * REDIS — one key, pm:growth-bands (a regenerable cache: nuke it and the
 * growth category simply falls back to DATA GAP until this route is re-run).
 * It is written ONLY with ?confirm=YES, and the previous value is stashed at
 * pm:growth-bands.pre-<ts> first so a bad calibration can be rolled back.
 * No other key is read or written.
 */

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const log = createLogger("Growth-calibration");

const F = {
  salesNtm: "FE_ESTIMATE(SALES,MEAN,NTMA,0,NOW,'')",
  salesLtm: "FF_SALES(LTM,0)",
  salesLtmA: "FE_ESTIMATE(SALES,MEAN,LTMA,0,NOW,'')",
  epsNtm: "FE_ESTIMATE(EPS,MEAN,NTMA,0,NOW,'')",
  epsLtmA: "FE_ESTIMATE(EPS,MEAN,LTMA,0,NOW,'')",
  ltg: "FE_ESTIMATE(LTG,MEAN,ANN_ROLL,0,NOW,'')",
  salesAnn0: "FF_SALES(ANN,0)",
  salesAnn3: "FF_SALES(ANN,-3)",
  bpsAnn0: "FF_BPS(ANN,0)",
  bpsAnn3: "FF_BPS(ANN,-3)",
  sector: "FG_GICS_SECTOR",
  industry: "FG_GICS_INDUSTRY",
} as const;
const CHUNK = 40;
const PARALLEL = 3;
const METRICS: GrowthMetricKey[] = ["fwdSales", "fwdEps", "ltg", "delivered"];

/** The four peer groups rubric revision 7 adds (staged on branch rubric-rev7).
 *  Mirrored here so bands calibrated from main already carry those groups;
 *  the labels must match the rev-7 playbook labels exactly. Removed when rev 7
 *  merges (its pickPlaybook routes these itself). */
const REV7_PAYMENTS = new Set(["V", "MA", "PYPL", "FI", "FIS", "GPN", "CPAY", "JKHY", "XYZ", "ICE", "CME", "NDAQ", "CBOE", "SPGI", "MCO", "MSCI", "FDS", "X.TO", "X-T"]);
function rev7Group(industry: string | null, ticker: string): string | null {
  const ind = (industry || "").toLowerCase();
  if (REV7_PAYMENTS.has(ticker.toUpperCase()) || /transaction|payment processing|financial exchanges/.test(ind)) return "Payments, Exchanges & Financial Data";
  if (/automobile|auto components|automotive/.test(ind)) return "Autos & Components";
  if (/health care providers|health care services|managed health|health care facilities|health care distributors/.test(ind)) return "Managed Care / Health Care Services";
  if (/\bground transportation\b|\broad\b|\brail|air freight|airlines|\bmarine\b|transportation infrastructure/.test(ind)) return "Transportation & Logistics";
  return null;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const redis = await getRedis();

  if (url.searchParams.get("view") === "1") {
    const raw = await redis.get(GROWTH_BANDS_KEY);
    return NextResponse.json(raw ? { stored: true, bands: JSON.parse(raw) } : { stored: false });
  }
  if (!factsetConfigured()) return NextResponse.json({ error: "FactSet relay is not configured in this environment." }, { status: 503 });
  const confirm = url.searchParams.get("confirm") === "YES";

  // ── Pull ────────────────────────────────────────────────────────────────
  const idToTicker = new Map<string, string>();
  for (const t of universeTickers()) {
    const r = resolveFactsetId(t);
    if (r.source === "factset") idToTicker.set(r.id, t);
  }
  const ids = [...idToTicker.keys()];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  const formulas = Object.values(F) as string[];
  const rows: Record<string, Record<string, FactsetValue>> = {};
  const failedChunks: number[] = [];
  for (let i = 0; i < chunks.length; i += PARALLEL) {
    await Promise.all(chunks.slice(i, i + PARALLEL).map(async (c, j) => {
      try { Object.assign(rows, await relayRetry(() => crossSectional(c, formulas, 60_000))); }
      catch (e) { failedChunks.push(i + j); log.warn(`chunk ${i + j} failed:`, e instanceof Error ? e.message : e); }
    }));
  }

  // ── Derive + group ──────────────────────────────────────────────────────
  type Constituent = { ticker: string; sector: string | null; industry: string | null; group: string; values: Partial<Record<GrowthMetricKey, number>>; excluded: { metric: string; reason: string }[] };
  const constituents: Constituent[] = [];
  const byGroup = new Map<string, Constituent[]>();
  const bySector = new Map<string, Constituent[]>();
  const unclassified: string[] = [];
  let salesBasisFallback = 0;
  for (const [id, ticker] of idToTicker) {
    const row = rows[id];
    if (!row) continue;
    const n = (k: keyof typeof F): number | null => { const v = row[F[k]]; return typeof v === "number" && isFinite(v) ? v : null; };
    const str = (k: keyof typeof F): string | null => { const v = row[F[k]]; return typeof v === "string" && v.trim() ? v.trim() : null; };
    const gicsSector = str("sector"), industry = str("industry");
    // No GICS sector = FactSet no longer covers the name (acquired / taken
    // private but still on the constituent list). Keep it out of the bands.
    if (!gicsSector) { unclassified.push(ticker); continue; }
    if (n("salesLtmA") == null && n("salesNtm") != null) salesBasisFallback++;
    const sector = normalizeFactsetSector(gicsSector) ?? gicsSector;
    const group = rev7Group(industry, ticker) ?? pickPlaybook(gicsSector, industry)?.label ?? `${sector ?? "Unclassified"} (no playbook)`;
    const raw: RawGrowthRow = { salesNtm: n("salesNtm"), salesLtm: n("salesLtm"), salesLtmA: n("salesLtmA"), epsNtm: n("epsNtm"), epsLtmA: n("epsLtmA"), ltg: n("ltg"), salesAnn0: n("salesAnn0"), salesAnn3: n("salesAnn3"), bpsAnn0: n("bpsAnn0"), bpsAnn3: n("bpsAnn3") };
    const { inputs, excluded } = deriveGrowthInputs(raw, group);
    const round = (v: number) => Math.round(v * 10) / 10;
    const c: Constituent = { ticker, sector, industry, group, values: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, round(v as number)])), excluded };
    constituents.push(c);
    byGroup.set(group, [...(byGroup.get(group) ?? []), c]);
    if (sector) bySector.set(sector, [...(bySector.get(sector) ?? []), c]);
  }
  const build = (name: string, cs: Constituent[]): GrowthGroup => {
    const metrics: GrowthGroup["metrics"] = {};
    for (const m of METRICS) {
      const vals = cs.map((c) => c.values[m]).filter((v): v is number => typeof v === "number");
      if (vals.length) metrics[m] = winsorSort(vals);
    }
    return { group: name, n: cs.length, metrics };
  };
  const bands: GrowthBands = {
    calibratedAt: new Date().toISOString(),
    universeSize: constituents.length,
    listVersion: LIST_VERSION,
    groups: Object.fromEntries([...byGroup].map(([g, cs]) => [g, build(g, cs)])),
    sectors: Object.fromEntries([...bySector].map(([g, cs]) => [g, build(g, cs)])),
  };

  // ── Readable summary ────────────────────────────────────────────────────
  const cuts = (g: GrowthGroup) => Object.fromEntries(METRICS.map((m) => {
    const s = g.metrics[m];
    return [m, s && s.length ? { n: s.length, p20: quantile(s, GROWTH_CUTS.one), median: quantile(s, 50), p85: quantile(s, GROWTH_CUTS.three), min: s[0], max: s[s.length - 1] } : null];
  }));
  const groupTable = Object.values(bands.groups).sort((a, b) => b.n - a.n).map((g) => ({
    group: g.group, names: g.n,
    rankedIn: g.n >= MIN_GROUP_SIZE ? "its own group" : "folded into its GICS sector (under " + MIN_GROUP_SIZE + " names)",
    metricRule: GROUP_METRIC_RULES[g.group]?.note ?? "all four metrics",
    cutPoints: cuts(g),
  }));
  const sectorTable = Object.values(bands.sectors).sort((a, b) => b.n - a.n).map((g) => ({ sector: g.group, names: g.n, cutPoints: cuts(g) }));

  let stored = false, stashedTo: string | null = null;
  if (confirm) {
    if (constituents.length < 300 || failedChunks.length > 0) {
      return NextResponse.json({ error: `Refusing to store: only ${constituents.length} constituents priced and ${failedChunks.length} chunk(s) failed. Re-run when the relay is healthy.` }, { status: 409 });
    }
    const prev = await redis.get(GROWTH_BANDS_KEY);
    if (prev) { stashedTo = `${GROWTH_BANDS_KEY}.pre-${Date.now()}`; await redis.set(stashedTo, prev); }
    await redis.set(GROWTH_BANDS_KEY, JSON.stringify(bands));
    stored = true;
    log.info(`stored growth bands: ${constituents.length} names, ${Object.keys(bands.groups).length} groups${stashedTo ? `, prior stashed at ${stashedTo}` : ""}`);
  }

  return NextResponse.json({
    mode: confirm ? "STORED" : "DRY RUN — nothing written. Add ?confirm=YES to store these bands.",
    stored, stashedTo,
    calibratedAt: bands.calibratedAt,
    universe: { requested: ids.length, priced: constituents.length, failedChunks, listVersion: LIST_VERSION, droppedNoSector: unclassified, salesOnAsReportedBasis: salesBasisFallback },
    method: { weights: GROWTH_WEIGHTS, blendedPercentileCuts: GROWTH_CUTS, topMarkFloorPct: TOP_MARK_FLOOR_PCT, minGroupSize: MIN_GROUP_SIZE, winsorised: "2nd / 98th percentile within each group" },
    groups: groupTable,
    sectors: sectorTable,
    constituents: constituents.sort((a, b) => a.group.localeCompare(b.group) || a.ticker.localeCompare(b.ticker)),
  });
}
