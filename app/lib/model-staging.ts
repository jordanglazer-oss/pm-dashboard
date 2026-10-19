/* ─── Model staging: edit every model in one pass, trade later ───
 *
 * A screenshot of the target model (the desk's Excel sheet) is parsed into
 * rows, turned into a proposed holdings list for the model it describes
 * (usually PIM), and PROPAGATED to every other model group. Each proposal is
 * reviewable and editable per model. Nothing touches pm:pim-models until the
 * PM applies the draft — and performance is computed from model targets, so
 * that is deliberately the day the trades go in.
 *
 *   pm:model-drafts   { active: ModelDraft | null, history: ModelDraft[] }
 *
 * Proposals are ABSOLUTE holdings lists, not deltas: the diff shown is always
 * recomputed against the live model, and apply refuses if the live model's
 * revision moved since the PM last reviewed it.
 *
 * Propagation rule (other model G, PIM before P0 → PIM after P1):
 *   - a name P1 dropped leaves G;
 *   - a non-Core name G holds takes P1's weight when PIM's weight changed;
 *   - a non-Core name new to PIM joins G only when eligible
 *     (stock.modelEligibility[G] !== false, and never a US-situs name in
 *     No US Situs); otherwise it is listed as a note;
 *   - Core (index) ETFs absorb the residual. When G's Core sleeve is drawn from
 *     the same ETFs as PIM's, it adopts PIM's NEW Core mix (so a new index ETF
 *     flows through); a model with its own index sleeve (PC USA's ITOT/VTWO)
 *     keeps its mix and is only rescaled.
 *
 * Weights are weightInClass (fraction of the asset class), never pre-scaled. */

import type { EquityBucket, PimAssetClass, PimHolding, PimModelGroup, PimProfileType } from "./pim-types";
import { canonicalTicker } from "./ticker";

export const MODEL_DRAFTS_KEY = "pm:model-drafts";
/** The per-stock rule weight (StockContext.rebalanceStockWeights). A staged
 *  stock at any other weight is PINNED on apply so a later trade's rebalance
 *  does not snap it back. */
export const REF_PER_STOCK = 0.018182;
const LEGACY_LOCKED = new Set(["FID5982", "FID5982-T", "GRNJ"]);
const NO_US_SITUS = "no-us-situs";
/** The one model with a real currency split: its CAD sleeve is CAD STOCKS
 *  only, so its CAD weight is a pure function of the CAD stocks it holds.
 *  Every other model is built 50% CAD / 50% USD. */
const PC_USA = "pc-usa";

export type ParsedKind = "stock" | "etf" | "fund";

/** One row read off the screenshot. Percentages as shown (1.67 = 1.67%). */
export type ParsedRow = {
  name: string;
  symbol: string;
  currency: "CAD" | "USD";
  assetClass: PimAssetClass;
  kind: ParsedKind;
  classPct: number | null;
  portfolioPct: number | null;
  /** Three-bucket model: read off the row's colour band (or set by hand in
   *  the staging window). Overrides the pm:stocks designation for staging,
   *  and is written to pm:stocks after an apply. */
  bucket?: EquityBucket;
};

export type StagedModel = {
  holdings: PimHolding[];
  /** "source" = built from the screenshot, "propagated" = derived from the
   *  source model, "edited" = the PM changed it by hand (no longer follows
   *  the source automatically). */
  origin: "source" | "propagated" | "edited";
  notes: string[];
};

export type ModelDraft = {
  id: string;
  name: string;
  /** The model group the screenshot describes. */
  sourceGroupId: string;
  parsed: ParsedRow[];
  models: Record<string, StagedModel>;
  status: "draft" | "applied";
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  versionId?: string;
  /** Bucket targets the apply wrote (three-bucket drafts only). */
  sleeveTargets?: { core: number; thematic: number; alpha: number };
  /** Per group: symbols the apply removed. Positioning's Rebalance sells these
   *  to zero (only these — never any other position the model lacks). */
  exits?: Record<string, string[]>;
};

export type ModelDraftStore = { active: ModelDraft | null; history: ModelDraft[] };

/** The bits of a pm:stocks record staging reads. */
export type StagingStock = {
  ticker: string;
  name?: string;
  bucket?: string;
  instrumentType?: string;
  designation?: "core" | "alpha" | "thematic";
  modelEligibility?: Record<string, boolean>;
};

/** canonicalTicker, plus FUNDSERV codes compared without their -T suffix —
 *  the stored blob holds both FID5982 and FID5982-T forms (CLAUDE.md). */
const canon = (s: string) => {
  const c = canonicalTicker(s);
  const m = c.match(/^([A-Z]{2,4}\d{2,5})\.TO$/);
  return m ? m[1] : c;
};
export const sameSymbol = (a: string, b: string) => canon(a) === canon(b);
const round6 = (v: number) => parseFloat(v.toFixed(6));

/* ── Classification ───────────────────────────────────────────────── */

export type HoldingRole = "stock" | "fund" | "core";

/** Same three pools rebalanceStockWeights uses: individual stocks, Alpha
 *  (pass-through) funds, Core (residual-absorbing) ETFs.
 *  - pm:stocks record → its instrument type + designation (default Alpha).
 *  - NEW name from the screenshot (no record) → a stock is a stock; a fund
 *    whose name says INDEX is Core (QQC.F, QQQX.U), anything else is Alpha
 *    (GRNY) — which is what it becomes once added to the book untagged.
 *  - neither → the legacy lock list, else Core (rebalanceStockWeights' rule). */
export function roleOf(symbol: string, stocks: StagingStock[], parsedRow?: Pick<ParsedRow, "kind" | "name" | "bucket">): HoldingRole {
  // A bucket from the screenshot (or set in the staging window) is the new truth.
  if (parsedRow?.bucket) return parsedRow.bucket === "alpha" ? "stock" : parsedRow.bucket === "core" ? "core" : "fund";
  const rec = stocks.find((s) => sameSymbol(s.ticker, symbol));
  if (rec) {
    if (!rec.instrumentType || rec.instrumentType === "stock") return "stock";
    return rec.designation === "core" ? "core" : "fund";
  }
  if (parsedRow) {
    if (parsedRow.kind === "stock") return "stock";
    return /\bINDEX\b/i.test(parsedRow.name) ? "core" : "fund";
  }
  if (LEGACY_LOCKED.has(symbol.toUpperCase())) return "fund";
  return "core";
}

/** Core membership exactly as the Models tab's CAD/USD columns read it
 *  (designation === "core" on the pm:stocks record); a brand-new screenshot
 *  name with no record uses roleOf's heuristic. */
export function isCoreForDisplay(symbol: string, stocks: StagingStock[], parsed: ParsedRow[]): boolean {
  const bucket = parsed.find((r) => sameSymbol(r.symbol, symbol))?.bucket;
  if (bucket) return bucket === "core";
  const rec = stocks.find((s) => sameSymbol(s.ticker, symbol));
  if (rec) return rec.designation === "core";
  const row = parsed.find((r) => sameSymbol(r.symbol, symbol));
  return row ? roleOf(symbol, stocks, row) === "core" : false;
}

function isFundserv(t: string): boolean {
  return /^[A-Z]{2,4}\d{2,5}(-T)?$/i.test(t);
}

/** Mirrors PimPortfolio's isUsSitusTicker: US-listed = USD, no Canadian suffix,
 *  not a FUNDSERV code. */
export function isUsSitus(symbol: string, currency?: string): boolean {
  const t = (symbol || "").trim().toUpperCase();
  if (!t) return false;
  if (/\.TO$/.test(t) || /-T$/.test(t) || /\.NE$/.test(t) || /\.U$/.test(t)) return false;
  if (isFundserv(t)) return false;
  return currency ? currency.toUpperCase() === "USD" : true;
}

/* ── Per-model substitutes ────────────────────────────────────────── */

/** A model that holds a DIFFERENT security in place of a source holding.
 *  Non-Res holds Fidelity Global Innovators as the ETF (FINN) instead of the
 *  mutual fund (FID5982): whatever the source does to FID5982 — weight change,
 *  bucket, removal — happens to FINN there. `local` lists the forms the
 *  stored model may use (FINN moved from TSX:FINN-T to NEO:FINN.NE). */
export const MODEL_SUBSTITUTES: Record<string, { source: string; local: string[]; name: string; currency: "CAD" | "USD" }[]> = {
  "non-res": [{ source: "FID5982-T", local: ["FINN.NE", "FINN-T"], name: "FIDELITY GLOBAL INNOVATORS ETF", currency: "CAD" }],
};

/** If `symbol` stands in for a source holding in some model, that source symbol. */
export function substituteSource(symbol: string): string | null {
  for (const list of Object.values(MODEL_SUBSTITUTES)) {
    for (const s of list) if (s.local.some((l) => sameSymbol(l, symbol))) return s.source;
  }
  return null;
}

/* ── Screenshot rows → the source model's proposal ────────────────── */

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Convert parsed rows of ONE asset class into weightInClass. The portfolio
 *  column is printed to 2dp of the WHOLE portfolio and is the more precise of
 *  the two (1.10% vs 1.67%), so when it lines up with one of the group's
 *  profile allocations it is used: weightInClass = portfolioPct / alloc. The
 *  result is normalised to sum to exactly 1 when within 1% of it. */
export function classWeights(
  rows: ParsedRow[],
  group: PimModelGroup | undefined,
  assetClass: PimAssetClass,
): { weights: number[]; notes: string[] } {
  const notes: string[] = [];
  const key = assetClass === "fixedIncome" ? "fixedIncome" : assetClass === "equity" ? "equity" : "alternatives";
  let weights: number[] | null = null;

  const port = rows.map((r) => r.portfolioPct);
  if (port.every((v) => v != null && v >= 0) && group) {
    const total = sum(port as number[]) / 100;
    const profiles = Object.entries(group.profiles) as [PimProfileType, { equity: number; fixedIncome: number; alternatives: number }][];
    const hit = profiles.find(([, p]) => p[key] > 0 && Math.abs(total - p[key]) < 0.005);
    if (hit) {
      weights = (port as number[]).map((v) => v / 100 / hit[1][key]);
      notes.push(`Weights read from the portfolio column (${hit[0]} profile, ${(hit[1][key] * 100).toFixed(0)}% ${assetClass === "fixedIncome" ? "fixed income" : assetClass}).`);
    }
  }
  if (!weights) {
    if (rows.some((r) => r.classPct == null)) {
      notes.push("Some rows had no asset-class weight — they were set to 0%; edit them before applying.");
    }
    weights = rows.map((r) => (r.classPct ?? 0) / 100);
  }

  const total = sum(weights);
  if (total > 0 && Math.abs(total - 1) < 0.01) {
    if (Math.abs(total - 1) > 0.00002) notes.push(`Screenshot summed to ${(total * 100).toFixed(2)}% (rounding) — normalised to 100%.`);
    weights = weights.map((w) => w / total);
  } else if (total > 0) {
    notes.push(`Screenshot sums to ${(total * 100).toFixed(2)}% of the class — check the rows before applying.`);
  }
  weights = weights.map(round6);
  return { weights, notes };
}

/** The proposal for the model the screenshot describes. Every asset class that
 *  appears in the screenshot is replaced outright; a class it does not show is
 *  kept exactly as live. Existing holdings keep their stored symbol / name /
 *  currency form (the -T vs .TO trap) and any unknown fields. */
export function buildSourceModel(parsed: ParsedRow[], live: PimModelGroup | undefined): StagedModel {
  const notes: string[] = [];
  const liveHoldings = live?.holdings ?? [];
  const classes = [...new Set(parsed.map((r) => r.assetClass))];
  const out: PimHolding[] = liveHoldings.filter((h) => !classes.includes(h.assetClass));
  for (const ac of classes) {
    const rows = parsed.filter((r) => r.assetClass === ac);
    const { weights, notes: n } = classWeights(rows, live, ac);
    notes.push(...n);
    rows.forEach((r, i) => {
      const existing = liveHoldings.find((h) => sameSymbol(h.symbol, r.symbol));
      out.push(
        existing
          ? { ...existing, assetClass: ac, weightInClass: weights[i] }
          : { name: r.name.toUpperCase(), symbol: r.symbol, currency: r.currency, assetClass: ac, weightInClass: weights[i] },
      );
    });
  }
  return { holdings: out, origin: "source", notes };
}

/* ── Propagation to the other models ──────────────────────────────── */

export function propagate(
  srcBefore: PimModelGroup,
  srcAfter: PimHolding[],
  other: PimModelGroup,
  stocks: StagingStock[],
  parsed: ParsedRow[],
): StagedModel {
  const notes: string[] = [];
  // Substitutes: rewrite the source's holdings into this model's own securities
  // (FID5982 → FINN in Non-Res) so every rule below applies to the local one.
  // Skipped when the model also holds the source security itself.
  const subs = (MODEL_SUBSTITUTES[other.id] ?? []).filter((x) => !other.holdings.some((h) => sameSymbol(h.symbol, x.source)));
  const toLocal = (h: PimHolding): PimHolding => {
    const x = subs.find((s) => sameSymbol(s.source, h.symbol));
    if (!x) return h;
    const held = other.holdings.find((o) => x.local.some((l) => sameSymbol(l, o.symbol)));
    return { ...h, symbol: held?.symbol ?? x.local[0], name: held?.name ?? x.name, currency: held?.currency ?? x.currency };
  };
  if (subs.length) {
    srcBefore = { ...srcBefore, holdings: srcBefore.holdings.map(toLocal) };
    srcAfter = srcAfter.map(toLocal);
  }
  const origin = (sym: string) => subs.find((x) => x.local.some((l) => sameSymbol(l, sym)))?.source ?? sym;
  // A substitute takes the role (and bucket) of the security it stands in for.
  const role = (sym: string) => roleOf(origin(sym), stocks, parsed.find((r) => sameSymbol(r.symbol, origin(sym))));
  const classes = [...new Set(srcAfter.map((h) => h.assetClass))].filter((ac) =>
    parsed.some((r) => r.assetClass === ac),
  );
  // Only classes the screenshot covered can change; the rest pass through.
  let holdings = [...other.holdings];

  for (const ac of classes) {
    const before = srcBefore.holdings.filter((h) => h.assetClass === ac);
    const after = srcAfter.filter((h) => h.assetClass === ac);
    const beforeW = (sym: string) => before.find((h) => sameSymbol(h.symbol, sym))?.weightInClass;
    const inAfter = (sym: string) => after.find((h) => sameSymbol(h.symbol, sym));

    const mine = holdings.filter((h) => h.assetClass === ac);
    const rest = holdings.filter((h) => h.assetClass !== ac);
    if (mine.length === 0 && ac !== "equity") continue; // model has no such sleeve

    // 1. Names the source dropped leave; non-Core names follow the source's change.
    const removed: string[] = [];
    const next: PimHolding[] = [];
    for (const h of mine) {
      const a = inAfter(h.symbol);
      const wasInSource = beforeW(h.symbol) != null;
      if (!a && wasInSource) { removed.push(h.symbol); continue; }
      if (a && role(h.symbol) !== "core") {
        const b = beforeW(h.symbol);
        if (b == null || Math.abs(a.weightInClass - b) > 1e-6) {
          if (b != null && Math.abs(h.weightInClass - b) > 1e-4) {
            notes.push(`${h.symbol} was ${(h.weightInClass * 100).toFixed(2)}% here vs ${(b * 100).toFixed(2)}% in the source — now ${(a.weightInClass * 100).toFixed(2)}%.`);
          }
          next.push({ ...h, weightInClass: a.weightInClass });
          continue;
        }
      }
      next.push(h);
    }
    if (removed.length) notes.push(`Removed: ${removed.join(", ")}.`);

    // 2. Non-Core names new to the source join where eligible.
    const added: string[] = [];
    const skipped: string[] = [];
    for (const a of after) {
      if (beforeW(a.symbol) != null) continue; // not new to the source
      if (role(a.symbol) === "core") continue; // handled by the Core mix below
      if (next.some((h) => sameSymbol(h.symbol, a.symbol))) continue;
      const rec = stocks.find((s) => sameSymbol(s.ticker, a.symbol));
      const ineligible = rec?.modelEligibility?.[other.id] === false;
      const situs = other.id === NO_US_SITUS && isUsSitus(a.symbol, a.currency);
      const cadFund = other.id === PC_USA && a.currency === "CAD" && role(a.symbol) !== "stock";
      if (ineligible || situs || cadFund) { skipped.push(`${a.symbol}${situs ? " (US situs)" : cadFund ? " (PC USA's CAD sleeve is CAD stocks only)" : ""}`); continue; }
      next.push({ name: a.name, symbol: a.symbol, currency: a.currency, assetClass: ac, weightInClass: a.weightInClass });
      added.push(a.symbol);
    }
    if (added.length) notes.push(`Added: ${added.join(", ")}.`);
    if (skipped.length) notes.push(`Not added (ineligible here): ${skipped.join(", ")}.`);

    // 3. Core absorbs the residual.
    const coreHere = next.filter((h) => role(h.symbol) === "core");
    const nonCore = next.filter((h) => role(h.symbol) !== "core");
    const residual = 1 - sum(nonCore.map((h) => h.weightInClass));
    const srcCoreBefore = before.filter((h) => role(h.symbol) === "core");
    const srcCoreAfter = after.filter((h) => role(h.symbol) === "core");
    const mirrors =
      coreHere.length > 0 &&
      srcCoreAfter.length > 0 &&
      coreHere.every((h) => srcCoreBefore.some((s) => sameSymbol(s.symbol, h.symbol)));

    // The Core pool this model will hold, and the ratios it is filled by.
    let pool: { h: PimHolding; ratio: number }[];
    if (mirrors) {
      // Same index ETFs as the source → take the source's new Core mix,
      // dropping any ETF this model may not hold.
      const eligible = srcCoreAfter.filter((s) =>
        !(other.id === NO_US_SITUS && isUsSitus(s.symbol, s.currency)) && !(other.id === PC_USA && s.currency === "CAD"),
      );
      pool = eligible.map((s) => {
        const existing = coreHere.find((h) => sameSymbol(h.symbol, s.symbol));
        return { h: existing ?? { name: s.name, symbol: s.symbol, currency: s.currency, assetClass: ac, weightInClass: 0 }, ratio: s.weightInClass };
      });
      const joined = pool.filter((c) => !coreHere.some((h) => sameSymbol(h.symbol, c.h.symbol))).map((c) => c.h.symbol);
      const left = coreHere.filter((h) => !pool.some((c) => sameSymbol(c.h.symbol, h.symbol))).map((h) => h.symbol);
      if (joined.length) notes.push(`Core follows the source's index mix — joins: ${joined.join(", ")}.`);
      if (left.length) notes.push(`Core follows the source's index mix — leaves: ${left.join(", ")}.`);
    } else {
      pool = coreHere.map((h) => ({ h, ratio: h.weightInClass }));
      if (coreHere.length) notes.push("Own Core sleeve kept — resized to absorb the residual.");
    }
    const spread = (items: { h: PimHolding; ratio: number }[], total: number) => {
      const tot = sum(items.map((c) => c.ratio));
      return items.map((c) => ({ ...c.h, weightInClass: tot > 0 ? (c.ratio / tot) * total : total / Math.max(1, items.length) }));
    };
    // Equity in every model but PC USA is built 50% CAD / 50% USD, so each
    // currency's Core fills ITS half: 0.5 − that currency's non-Core names.
    // Falls back to one shared residual when a currency has no Core ETF or is
    // already over its half (noted, so the PM can see why the split moved).
    let core: PimHolding[];
    const half = (ccy: "CAD" | "USD") => 0.5 - sum(nonCore.filter((h) => h.currency === ccy).map((h) => h.weightInClass));
    const byCcy = ac === "equity" && other.id !== PC_USA;
    const cadPool = pool.filter((c) => c.h.currency === "CAD");
    const usdPool = pool.filter((c) => c.h.currency === "USD");
    // An index ETF NEW to this model (joining from the source's mix) keeps the
    // source's share of its CURRENCY model — QQQX.U at 10% of PIM's USD model
    // is 10% of every model's USD model. The index ETFs the model already held
    // absorb the rest of that currency's half (in the source's ratios). Sizing
    // a newcomer off the leftover room instead made it grow in any model with
    // fewer US stocks (QQQX.U 16.67% of No US Situs's USD model).
    const srcCcyTotal = (ccy: "CAD" | "USD") => sum(after.filter((h) => h.currency === ccy).map((h) => h.weightInClass));
    const fillCcy = (items: { h: PimHolding; ratio: number }[], ccy: "CAD" | "USD", target: number): PimHolding[] => {
      const joiners = mirrors ? items.filter((c) => !coreHere.some((h) => sameSymbol(h.symbol, c.h.symbol))) : [];
      const absorbers = items.filter((c) => !joiners.includes(c));
      const srcTot = srcCcyTotal(ccy);
      const fixed = joiners.map((c) => ({ ...c.h, weightInClass: srcTot > 0 ? (c.ratio / srcTot) * 0.5 : 0 }));
      const left = target - sum(fixed.map((h) => h.weightInClass));
      if (absorbers.length === 0 || left < 0) {
        if (joiners.length) notes.push(`${ccy}: no index ETF already held here can absorb the rest — ${ccy} Core sized as one pool.`);
        return spread(items, target);
      }
      return [...fixed, ...spread(absorbers, left)];
    };
    if (byCcy && cadPool.length && usdPool.length && half("CAD") >= 0 && half("USD") >= 0) {
      core = [...fillCcy(cadPool, "CAD", half("CAD")), ...fillCcy(usdPool, "USD", half("USD"))];
    } else {
      if (byCcy && pool.length) notes.push("Could not hold 50% CAD / 50% USD (a currency has no Core ETF or its names exceed 50%) — Core resized as one pool.");
      core = spread(pool, residual);
    }
    if (residual < -1e-6) notes.push(`Non-Core names sum to ${((1 - residual) * 100).toFixed(2)}% — over 100%, Core is zero. Trim something before applying.`);
    if (core.length === 0 && Math.abs(residual) > 1e-4) notes.push(`No Core ETF here to absorb ${(residual * 100).toFixed(2)}% — edit before applying.`);

    // Rounded to 6dp; any sub-0.001% rounding remainder is left alone (the
    // stored models carry the same kind of remainder today).
    const merged = [...nonCore, ...core.map((h) => ({ ...h, weightInClass: Math.max(0, h.weightInClass) }))].map((h) => ({ ...h, weightInClass: round6(h.weightInClass) }));
    // Keep the model's existing row order; new names at the end.
    const ordered = [
      ...mine.map((h) => merged.find((m) => sameSymbol(m.symbol, h.symbol))).filter((h): h is PimHolding => !!h),
      ...merged.filter((m) => !mine.some((h) => sameSymbol(h.symbol, m.symbol))),
    ];
    holdings = [...rest, ...ordered];
  }

  // Preserve the original class order of the group.
  const order: PimAssetClass[] = ["fixedIncome", "equity", "alternative"];
  holdings.sort((a, b) => order.indexOf(a.assetClass) - order.indexOf(b.assetClass));
  return { holdings, origin: "propagated", notes };
}

/** Build every model's proposal from a set of parsed rows. */
export function buildDraftModels(
  parsed: ParsedRow[],
  sourceGroupId: string,
  groups: PimModelGroup[],
  stocks: StagingStock[],
  keep?: Record<string, StagedModel>,
): Record<string, StagedModel> {
  const src = groups.find((g) => g.id === sourceGroupId);
  const out: Record<string, StagedModel> = {};
  const source = buildSourceModel(parsed, src);
  out[sourceGroupId] = source;
  if (!src) return out;
  for (const g of groups) {
    if (g.id === sourceGroupId) continue;
    // A model the PM edited by hand stays as they left it.
    if (keep?.[g.id]?.origin === "edited") { out[g.id] = keep[g.id]; continue; }
    out[g.id] = propagate(src, source.holdings, g, stocks, parsed);
  }
  return out;
}

/* ── Diff + validation ────────────────────────────────────────────── */

export type DiffRow = {
  symbol: string;
  name: string;
  assetClass: PimAssetClass;
  currency: "CAD" | "USD";
  before: number | null;
  after: number | null;
  kind: "add" | "remove" | "change" | "same";
};

export function diffHoldings(before: PimHolding[], after: PimHolding[]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const a of after) {
    const b = before.find((h) => sameSymbol(h.symbol, a.symbol));
    const kind = !b ? "add" : Math.abs(b.weightInClass - a.weightInClass) > 2e-6 ? "change" : "same";
    rows.push({ symbol: a.symbol, name: a.name, assetClass: a.assetClass, currency: a.currency, before: b ? b.weightInClass : null, after: a.weightInClass, kind });
  }
  for (const b of before) {
    if (!after.some((h) => sameSymbol(h.symbol, b.symbol))) {
      rows.push({ symbol: b.symbol, name: b.name, assetClass: b.assetClass, currency: b.currency, before: b.weightInClass, after: null, kind: "remove" });
    }
  }
  return rows;
}

/** Problems that block an apply. Each class present must sum to 100%. */
export function validateHoldings(holdings: PimHolding[]): string[] {
  const errs: string[] = [];
  for (const ac of ["fixedIncome", "equity", "alternative"] as PimAssetClass[]) {
    const rows = holdings.filter((h) => h.assetClass === ac);
    if (rows.length === 0) continue;
    const t = sum(rows.map((h) => h.weightInClass));
    if (Math.abs(t - 1) > 0.002) errs.push(`${ac === "fixedIncome" ? "Fixed income" : ac === "equity" ? "Equity" : "Alternatives"} sums to ${(t * 100).toFixed(2)}%`);
    if (rows.some((h) => !Number.isFinite(h.weightInClass) || h.weightInClass < 0)) errs.push(`${ac}: negative or invalid weight`);
  }
  const seen = new Set<string>();
  for (const h of holdings) {
    const k = canon(h.symbol);
    if (seen.has(k)) errs.push(`${h.symbol} appears twice`);
    seen.add(k);
  }
  return errs;
}

/** On apply: a stock staged off the per-stock rule weight is PINNED so a later
 *  trade's rebalance keeps it; one staged back at the rule weight is unpinned.
 *  Funds never carry a pin. */
export function withPins(holdings: PimHolding[], stocks: StagingStock[], month: string, at: string, parsed: ParsedRow[]): PimHolding[] {
  // Three-bucket drafts: the Alpha bucket re-splits on its own (sleeve-targets),
  // so a pin would only stop a stock following it — every staged stock is
  // left unpinned, at exactly the weight the draft gives it.
  const buckets = draftHasBuckets(parsed);
  return holdings.map((h) => {
    if (h.assetClass !== "equity") return h;
    if (roleOf(h.symbol, stocks, parsed.find((r) => sameSymbol(r.symbol, h.symbol))) !== "stock") return h;
    if (buckets) {
      if (!h.pinned) return h;
      const { pinned: _p, ...rest } = h;
      void _p;
      return rest;
    }
    if (Math.abs(h.weightInClass - REF_PER_STOCK) < 1e-6) {
      if (!h.pinned) return h;
      const { pinned: _drop, ...rest } = h;
      void _drop;
      return rest;
    }
    return { ...h, pinned: { weightInClass: h.weightInClass, month, at } };
  });
}

/* ── CAD / USD model columns (display only) ───────────────────────── */

export type CurrencyWeights = {
  /** Per holding symbol: weight in the CAD / USD model (null = not that currency). */
  rows: Record<string, { cad: number | null; usd: number | null }>;
  /** Each currency sub-account as a share of the whole portfolio. */
  account: { CAD: number; USD: number };
};

/** The Models tab's "CAD model wt" / "USD model wt" columns, for any holdings
 *  list (live or staged). MIRRORS PimModel.tsx `computedHoldings` for the
 *  non-virtual profiles — keep the two in step:
 *   - PC USA (the only real split): weight inside that currency's account =
 *     weightInClass × classAlloc / accountTotal, across every class. Its CAD
 *     account is its CAD stocks, so it moves linearly with them.
 *   - every other model, equity: built 50/50 — a non-Core name shows at 2× its
 *     class weight and the same-currency Core ETFs fill the residual; a
 *     currency with no Core normalises to 100% at the All-Equity allocation.
 *   - FI / alternatives: share of that currency's sleeve × class allocation.
 *  Never feeds a stored weight. */
export function currencyModelWeights(
  holdingsIn: PimHolding[],
  group: PimModelGroup,
  profile: PimProfileType,
  isCore: (symbol: string) => boolean,
): CurrencyWeights {
  const pw = group.profiles[profile];
  const out: CurrencyWeights = { rows: {}, account: { CAD: 0, USD: 0 } };
  if (!pw) return out;
  // Non-PIM groups: equity normalised to 1 as a safety net (as the Models tab does).
  let holdings = holdingsIn;
  if (group.id !== "pim") {
    const eqTot = sum(holdingsIn.filter((h) => h.assetClass === "equity").map((h) => h.weightInClass));
    if (eqTot > 0) holdings = holdingsIn.map((h) => (h.assetClass === "equity" ? { ...h, weightInClass: h.weightInClass / eqTot } : h));
  }
  const allocFor = (ac: PimAssetClass) => (ac === "fixedIncome" ? pw.fixedIncome : ac === "equity" ? pw.equity : pw.alternatives);
  const cadT: Record<string, number> = {};
  const usdT: Record<string, number> = {};
  for (const h of holdings) {
    if (h.currency === "CAD") cadT[h.assetClass] = (cadT[h.assetClass] || 0) + h.weightInClass;
    else if (h.currency === "USD") usdT[h.assetClass] = (usdT[h.assetClass] || 0) + h.weightInClass;
  }
  for (const ac of ["equity", "fixedIncome", "alternative"] as const) {
    out.account.CAD += allocFor(ac) * (cadT[ac] || 0);
    out.account.USD += allocFor(ac) * (usdT[ac] || 0);
  }
  const allEquityAlloc = group.profiles.allEquity?.equity ?? 1;
  const eqInfo = (ccy: "CAD" | "USD") => {
    const eq = holdings.filter((h) => h.assetClass === "equity" && h.currency === ccy);
    const core = eq.filter((h) => isCore(h.symbol));
    const nonCoreSum = sum(eq.filter((h) => !isCore(h.symbol)).map((h) => h.weightInClass));
    return {
      hasCore: core.length > 0,
      residualClass: Math.max(0, 1 - nonCoreSum * 2),
      coreStoredTotal: sum(core.map((h) => h.weightInClass)),
      coreCount: core.length,
      classTotal: sum(eq.map((h) => h.weightInClass)),
    };
  };
  const info = { CAD: eqInfo("CAD"), USD: eqInfo("USD") };
  for (const h of holdings) {
    const alloc = allocFor(h.assetClass);
    let cad: number | null = null;
    let usd: number | null = null;
    if (group.id === PC_USA) {
      const total = out.account[h.currency];
      const w = total > 0 ? (h.weightInClass * alloc) / total : null;
      if (h.currency === "CAD") cad = w; else usd = w;
    } else if (h.assetClass === "equity") {
      const i = info[h.currency];
      let w: number | null;
      if (i.hasCore) {
        if (isCore(h.symbol)) {
          const ratio = i.coreStoredTotal > 0 ? h.weightInClass / i.coreStoredTotal : i.coreCount > 0 ? 1 / i.coreCount : 0;
          w = i.residualClass * ratio * alloc;
        } else {
          w = h.weightInClass * 2 * alloc;
        }
      } else {
        w = i.classTotal > 0 ? (h.weightInClass / i.classTotal) * allEquityAlloc : null;
      }
      if (h.currency === "CAD") cad = w; else usd = w;
    } else {
      cad = h.currency === "CAD" && (cadT[h.assetClass] || 0) > 0 ? (h.weightInClass / cadT[h.assetClass]) * alloc : null;
      usd = h.currency === "USD" && (usdT[h.assetClass] || 0) > 0 ? (h.weightInClass / usdT[h.assetClass]) * alloc : null;
    }
    out.rows[h.symbol] = { cad, usd };
  }
  return out;
}

/* ── Three-bucket helpers ─────────────────────────────────────────── */

/** Bucket of a staged holding: the draft's row bucket, else the role the
 *  staging rules give it (stock → Alpha, Core → Core, other fund → Thematic). */
export function stagedBucket(symbol: string, stocks: StagingStock[], parsed: ParsedRow[]): EquityBucket {
  const src = substituteSource(symbol);
  if (src) return stagedBucket(src, stocks, parsed);
  const row = parsed.find((r) => sameSymbol(r.symbol, symbol));
  if (row?.bucket) return row.bucket;
  const r = roleOf(symbol, stocks, row);
  return r === "stock" ? "alpha" : r === "core" ? "core" : "thematic";
}

export const draftHasBuckets = (parsed: ParsedRow[]) => parsed.some((r) => r.bucket);

/** Scale each bucket's equity members proportionally to its target share of
 *  the class. Members keep their ratios (11 equal stocks stay equal). A bucket
 *  with no members can't take a target — reported, not invented. */
export function rescaleBuckets(
  holdings: PimHolding[],
  bucket: (symbol: string) => EquityBucket,
  targets: Record<EquityBucket, number>,
): { holdings: PimHolding[]; problems: string[] } {
  const problems: string[] = [];
  const cur: Record<EquityBucket, number> = { core: 0, thematic: 0, alpha: 0 };
  for (const h of holdings) if (h.assetClass === "equity") cur[bucket(h.symbol)] += h.weightInClass;
  for (const k of ["core", "thematic", "alpha"] as EquityBucket[]) {
    if (targets[k] > 0 && cur[k] <= 0) problems.push(`${k} has no holdings to size`);
  }
  const next = holdings.map((h) => {
    if (h.assetClass !== "equity") return h;
    const k = bucket(h.symbol);
    if (cur[k] <= 0) return h;
    return { ...h, weightInClass: round6((h.weightInClass / cur[k]) * targets[k]) };
  });
  return { holdings: next, problems };
}
