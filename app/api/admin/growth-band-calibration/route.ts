import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { getRedis } from "@/app/lib/redis";
import { crossSectional, factsetConfigured, relayRetry, type FactsetValue } from "@/app/lib/factset";
import { resolveFactsetId } from "@/app/lib/factset-symbols";
import { normalizeFactsetSector } from "@/app/lib/factset-fundamentals";
import { universeTickers, LIST_VERSION, TSX60 } from "@/app/lib/factor-constituents";
import { runCalibrationChecks } from "@/app/lib/score-input-validation";
import { pickPlaybook } from "@/app/lib/sector-playbook";
import {
  deriveGrowthInputs, buildGrowthBands, quantile, GROWTH_CUTS, GROWTH_WEIGHTS, MIN_GROUP_SIZE, TOP_MARK_FLOOR_PCT, GROWTH_PLAUSIBLE, GROWTH_EXPECTATIONS, GROWTH_PEER_UNIVERSE,
  GROUP_METRIC_RULES, GROWTH_BANDS_KEY, GROWTH_DETAIL_KEY, GROWTH_SOURCE_FIELDS, type GrowthDetail, type GrowthGroup, type GrowthMetricKey, type RawGrowthRow,
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
 * REDIS — two keys written together: pm:growth-bands-detail (the per-company
 * inputs, for audit) and pm:growth-bands (a regenerable cache: nuke it and the
 * growth category simply falls back to DATA GAP until this route is re-run).
 * It is written ONLY with ?confirm=YES, and the previous value is stashed at
 * pm:growth-bands.pre-<ts> first so a bad calibration can be rolled back.
 * No other key is read or written.
 *
 * SELF-CHECKS (Nov 2026 audit, app/lib/score-input-validation.ts): every run
 * — dry run and confirm — checks the pull before anything is stored: enough
 * companies and no failed batch, no duplicate, each metric present for enough
 * of the universe, and each metric's universe median and spread consistent
 * with its unit (a percent column that is really a ratio fails here). The
 * result is returned as `selfChecks` / `checks` and stored ON the bands.
 * ?confirm=YES REFUSES to store when a hard check fails and says which.
 */

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const log = createLogger("Growth-calibration");

// The raw fields come from ONE list (growth-score.ts) so the pull, the data
// page and the stock-page working can never describe different formulas.
const F = {
  ...(Object.fromEntries(GROWTH_SOURCE_FIELDS.map((f) => [f.key, f.formula])) as Record<(typeof GROWTH_SOURCE_FIELDS)[number]["key"], string>),
  sector: "FG_GICS_SECTOR",
  industry: "FG_GICS_INDUSTRY",
  mktVal: "FG_MKT_VALUE",
} as const;
const CANADIAN = new Set(TSX60.map((t) => t.toUpperCase()));
const CHUNK = 40;
const PARALLEL = 3;
const METRICS: GrowthMetricKey[] = ["fwdSales", "fwdEps", "ltg", "delivered"];

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
  type Constituent = { ticker: string; sector: string | null; industry: string | null; group: string; country: "CA" | "US"; marketCap: number | null; salesBasis: "estimates" | "as-reported" | null; raw: RawGrowthRow; values: Partial<Record<GrowthMetricKey, number>>; excluded: { metric: string; reason: string }[] };
  const constituents: Constituent[] = [];
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
    const group = pickPlaybook(gicsSector, industry, ticker)?.label ?? `${sector ?? "Unclassified"} (no playbook)`;
    const raw: RawGrowthRow = { salesNtm: n("salesNtm"), salesLtm: n("salesLtm"), salesLtmA: n("salesLtmA"), epsNtm: n("epsNtm"), epsLtmA: n("epsLtmA"), ltg: n("ltg"), salesAnn0: n("salesAnn0"), salesAnn3: n("salesAnn3"), bpsAnn0: n("bpsAnn0"), bpsAnn3: n("bpsAnn3") };
    const { inputs, excluded, salesBasis } = deriveGrowthInputs(raw, group);
    const round = (v: number) => Math.round(v * 10) / 10;
    constituents.push({ ticker, sector, industry, group, country: CANADIAN.has(ticker.toUpperCase()) ? "CA" : "US", marketCap: n("mktVal"), salesBasis, raw, values: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, round(v as number)])), excluded });
  }

  // ── Self-checks (run on EVERY call; a hard failure blocks the store) ─────
  const report = runCalibrationChecks({ rows: constituents, expectations: GROWTH_EXPECTATIONS, requested: ids.length, failedChunks: failedChunks.length, unmatched: unclassified });
  const outOfRange = constituents.flatMap((c) => c.excluded.filter((e) => /believable range/.test(e.reason)).map((e) => ({ ticker: c.ticker, metric: e.metric, reason: e.reason })));
  const bands = buildGrowthBands(constituents, { calibratedAt: new Date().toISOString(), listVersion: LIST_VERSION, selfChecks: report.selfChecks });

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
    if (!report.selfChecks.passed) {
      return NextResponse.json({
        error: `Refusing to store: ${report.selfChecks.hardFailures.length} check(s) failed. Nothing was written; the bands on file are unchanged.`,
        failed: report.selfChecks.hardFailures,
        warnings: report.selfChecks.warnings,
        checks: report.checks,
      }, { status: 409 });
    }
    const prev = await redis.get(GROWTH_BANDS_KEY);
    if (prev) { stashedTo = `${GROWTH_BANDS_KEY}.pre-${Date.now()}`; await redis.set(stashedTo, prev); }
    await redis.set(GROWTH_BANDS_KEY, JSON.stringify(bands));
    // The per-company inputs behind those bands — the audit trail the
    // Methodology data page reads. Same lifecycle as the bands: regenerable,
    // prior value stashed, written only on confirm.
    const prevDetail = await redis.get(GROWTH_DETAIL_KEY);
    if (prevDetail) await redis.set(`${GROWTH_DETAIL_KEY}.pre-${Date.now()}`, prevDetail);
    const detail: GrowthDetail = { calibratedAt: bands.calibratedAt, rows: constituents, droppedNoSector: unclassified };
    await redis.set(GROWTH_DETAIL_KEY, JSON.stringify(detail));
    stored = true;
    log.info(`stored growth bands: ${constituents.length} names, ${Object.keys(bands.groups).length} groups${stashedTo ? `, prior stashed at ${stashedTo}` : ""}`);
  }

  return NextResponse.json({
    mode: confirm ? "STORED" : "DRY RUN — nothing written. Add ?confirm=YES to store these bands.",
    stored, stashedTo,
    calibratedAt: bands.calibratedAt,
    selfChecks: report.selfChecks,
    checks: report.checks,
    readThisFirst: [
      report.selfChecks.passed ? "All hard checks passed. Warnings (if any) are listed under selfChecks.warnings — read them before storing." : "ONE OR MORE HARD CHECKS FAILED — ?confirm=YES will refuse to store these bands. See selfChecks.hardFailures.",
      `The peer universe is the ${GROWTH_PEER_UNIVERSE}. A small or mid cap in the book is ranked against large-cap peers; smaller companies usually grow faster, so they tend to rank HIGHER on growth than they would against companies their own size. The stock page flags any name smaller than 90% of its group.`,
      "The checks prove the numbers are internally consistent. They CANNOT prove a FactSet formula returns what its name says — spot-check the names under /methodology/growth-data against a FactSet terminal and record the result there.",
    ],
    universe: {
      requested: ids.length, priced: constituents.length, failedChunks, listVersion: LIST_VERSION, droppedNoSector: unclassified,
      us: constituents.filter((c) => c.country === "US").length, canada: constituents.filter((c) => c.country === "CA").length,
      // Forward sales measured from AS-REPORTED trailing sales because the estimates-basis figure was missing.
      // The two can be on different bases (net vs gross revenue, or a different currency) — look at these names.
      salesOnAsReportedBasis: salesBasisFallback,
      salesOnAsReportedBasisNames: constituents.filter((c) => c.salesBasis === "as-reported").map((c) => c.ticker),
      valuesOutsideBelievableRange: outOfRange,
    },
    metricSummary: report.metrics,
    groupMakeUp: report.groups,
    method: { weights: GROWTH_WEIGHTS, blendedPercentileCuts: GROWTH_CUTS, topMarkFloorPct: TOP_MARK_FLOOR_PCT, minGroupSize: MIN_GROUP_SIZE, believableRanges: GROWTH_PLAUSIBLE, winsorised: "2nd / 98th percentile within each group", sectorDelivered: "sector distributions leave out the delivered growth of banks and insurers (book value per share, not sales)" },
    groups: groupTable,
    sectors: sectorTable,
    constituents: constituents.sort((a, b) => a.group.localeCompare(b.group) || a.ticker.localeCompare(b.ticker)),
  });
}
