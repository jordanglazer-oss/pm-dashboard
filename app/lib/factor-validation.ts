import { getRedis } from "./redis";
import { FACTOR_HISTORY_KEY, type FactorHistoryRow } from "./factor-scores";

/**
 * Phase C — four-way IC validation, computed entirely from pm:factor-history.
 *
 * For each lens (41-pt score, quant percentile, judgment overlay, and the two
 * blend candidates) and each horizon (1M/3M/6M), compute the mean Spearman
 * rank information coefficient between the lens's cross-section on a date and
 * the realized forward returns from that date. This is the evidence layer:
 * blend weights are EARNED here, not assumed — no integration (Phase D)
 * happens until these numbers support it.
 *
 * Read-only: reads pm:factor-history, writes nothing. Forward returns come
 * from the prices captured in the history rows themselves (price-only, no
 * dividends — consistent across all lenses, so the *comparison* is fair even
 * though absolute ICs are slightly conservative for yield names).
 */

export const LENSES = ["s41", "quant", "overlay", "blend70", "blendMod"] as const;
export type Lens = (typeof LENSES)[number];

export const LENS_LABEL: Record<Lens, string> = {
  s41: "41-pt score",
  quant: "Quant %ile",
  overlay: "Judgment overlay",
  blend70: "Blend 70/30",
  blendMod: "Blend ±15 mod",
};

/** Horizons in calendar days (≈ 1M / 3M / 6M). */
export const HORIZONS = [
  { key: "1M", days: 21 },
  { key: "3M", days: 63 },
  { key: "6M", days: 126 },
] as const;

/** A forward-return match may land up to this many days late (weekends,
 *  missed nightly runs) and still count for the horizon. */
const MATCH_TOLERANCE_DAYS = 10;
/** Minimum cross-section size for a date to produce an IC observation. */
const MIN_NAMES = 10;
/** Minimum IC observations before we show a mean at all. */
const MIN_OBS = 4;

export type HorizonResult = {
  horizon: string;
  /** Per-lens stats; a lens absent when it never had enough data. */
  lenses: Partial<Record<Lens, { meanIC: number; icStd: number; nDates: number; avgNames: number; tStat: number | null }>>;
};

export type ValidationResult = {
  ok: true;
  firstDate: string | null;
  lastDate: string | null;
  dataDays: number;        // distinct history dates
  tickers: number;
  horizons: HorizonResult[];
  /** Human-readable readiness note (e.g. "collecting — no 1M matches yet"). */
  note: string;
};

const dayMs = 86_400_000;
const toMs = (d: string) => new Date(`${d}T00:00:00Z`).getTime();

/** Average-rank (ties-aware) ranks of an array. */
function ranks(vals: number[]): number[] {
  const idx = vals.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(vals.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = avg;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation (Pearson on average ranks). Null if degenerate. */
export function spearman(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;
  const ra = ranks(a), rb = ranks(b);
  const n = a.length;
  const ma = ra.reduce((x, y) => x + y, 0) / n;
  const mb = rb.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = ra[i] - ma, xb = rb[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

type Panel = Map<string, Map<string, FactorHistoryRow>>; // ticker → date → row

export function computeValidation(hist: Record<string, FactorHistoryRow[]>): ValidationResult {
  // Build the panel + the sorted date spine.
  const panel: Panel = new Map();
  const dateSet = new Set<string>();
  for (const [tk, rows] of Object.entries(hist)) {
    const m = new Map<string, FactorHistoryRow>();
    for (const r of rows) {
      if (!r?.date) continue;
      m.set(r.date, r);
      dateSet.add(r.date);
    }
    if (m.size) panel.set(tk, m);
  }
  const dates = [...dateSet].sort();
  const base = {
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    dataDays: dates.length,
    tickers: panel.size,
  };

  const horizons: HorizonResult[] = [];
  let anyIC = false;

  for (const h of HORIZONS) {
    const perLens: HorizonResult["lenses"] = {};
    for (const lens of LENSES) {
      const ics: number[] = [];
      let namesSum = 0;
      for (const d of dates) {
        const dMs = toMs(d);
        const lensVals: number[] = [];
        const fwdRets: number[] = [];
        for (const [, byDate] of panel) {
          const row = byDate.get(d);
          const v = row?.[lens];
          const p0 = row?.price;
          if (typeof v !== "number" || typeof p0 !== "number" || p0 <= 0) continue;
          // First future row inside [d+h, d+h+tolerance] with a price.
          let p1: number | undefined;
          for (const [fd, fr] of byDate) {
            const dd = (toMs(fd) - dMs) / dayMs;
            if (dd >= h.days && dd <= h.days + MATCH_TOLERANCE_DAYS && typeof fr.price === "number" && fr.price > 0) {
              p1 = fr.price;
              break;
            }
          }
          if (p1 == null) continue;
          lensVals.push(v);
          fwdRets.push(p1 / p0 - 1);
        }
        if (lensVals.length < MIN_NAMES) continue;
        const ic = spearman(lensVals, fwdRets);
        if (ic == null) continue;
        ics.push(ic);
        namesSum += lensVals.length;
      }
      if (ics.length < MIN_OBS) continue;
      const mean = ics.reduce((a, b) => a + b, 0) / ics.length;
      const std = Math.sqrt(ics.reduce((a, b) => a + (b - mean) ** 2, 0) / ics.length);
      perLens[lens] = {
        meanIC: Math.round(mean * 1000) / 1000,
        icStd: Math.round(std * 1000) / 1000,
        nDates: ics.length,
        avgNames: Math.round(namesSum / ics.length),
        tStat: std > 0 ? Math.round((mean / (std / Math.sqrt(ics.length))) * 100) / 100 : null,
      };
      anyIC = true;
    }
    horizons.push({ horizon: h.key, lenses: perLens });
  }

  const note = !base.dataDays
    ? "No history yet — the nightly shadow job hasn't logged any rows."
    : !anyIC
      ? `Collecting — ${base.dataDays} day(s) of history since ${base.firstDate}. The shortest horizon (1M) needs ~${HORIZONS[0].days} days before the first IC observation exists; a readable verdict needs months. This is expected — the log is doing its job.`
      : "ICs are live. Treat small nDates with caution — the verdict firms up as observations accumulate.";

  return { ok: true, ...base, horizons, note };
}

export async function runValidation(): Promise<ValidationResult> {
  const redis = await getRedis();
  const raw = await redis.get(FACTOR_HISTORY_KEY);
  let hist: Record<string, FactorHistoryRow[]> = {};
  if (raw) {
    try { hist = JSON.parse(raw) as Record<string, FactorHistoryRow[]>; } catch { /* empty */ }
  }
  return computeValidation(hist);
}
