/**
 * Computed cash-deployment score — the arithmetic half of the Brief's cash call.
 *
 * The rubric blends six inputs into 0–100. Five of them are numbers the app
 * already holds, so the app scores those (60 points); the sixth, Mark Newton's
 * note (40 points), is text, so the MODEL classifies it into one of five named
 * states and the app converts that state to points. The weights are the
 * rubric's own (Newton 40 · oscillator 25 · breadth 15 · VIX 10 · sentiment 6 ·
 * momentum 4) — nothing here changes what the call is built from, only who
 * does the adding up, so the same inputs always give the same number.
 *
 * SHADOW MODE: for now this runs beside the model's own score and is returned
 * as `cashScoreComputed` for comparison. The live action still follows the
 * model's score until the two have been compared over real briefs.
 *
 * Pure module — no I/O.
 */

export const NEWTON_STATES = {
  "fresh-constructive-flip": { points: 40, label: "Fresh constructive flip (after 2+ weeks cautious)" },
  "persistent-constructive": { points: 32, label: "Persistent constructive, tone holding" },
  "neutral-or-stale": { points: 20, label: "Neutral, mixed, or a bullish call 2+ weeks stale" },
  "persistent-cautious": { points: 8, label: "Persistent cautious" },
  "fresh-cautious-flip": { points: 0, label: "Fresh cautious flip (after a constructive run)" },
} as const;
export type NewtonState = keyof typeof NEWTON_STATES;
export const isNewtonState = (s: unknown): s is NewtonState => typeof s === "string" && s in NEWTON_STATES;

export type CashInputs = {
  oscillator: number | null;          // S&P Oscillator, %
  sp500Above50: number | null;        // % of S&P 500 above 50-DMA
  broadAbove50: number | null;        // % of the broad market above 50-DMA
  newLows: number | null;             // NYSE new lows
  upVolumePct: number | null;         // NYSE up-volume as % of total
  vix: number | null;
  vixWeekPct: number | null;          // VIX week-over-week % change
  fearGreed: number | null;
  aaiiBullBear: number | null;
  spx5dPct: number | null;            // S&P 500 ~5-session return, %
};

export type CashComponent = { key: string; label: string; weight: number; reading: string; band: string; lean: number; points: number };

const n = (v: number | null | undefined): v is number => typeof v === "number" && isFinite(v);
const sign = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}`;

/** `lean` runs 0 (strong WAIT) … 0.5 (no edge) … 1 (strong DEPLOY). points = weight × lean. */
export function scoreCashInputs(i: CashInputs): CashComponent[] {
  const out: CashComponent[] = [];
  const add = (key: string, label: string, weight: number, reading: string, band: string, lean: number) =>
    out.push({ key, label, weight, reading, band, lean, points: Math.round(weight * lean * 10) / 10 });

  // Oscillator (25) — the rubric's own bands.
  if (!n(i.oscillator)) add("oscillator", "S&P Oscillator", 25, "not entered", "no reading — treated as no edge", 0.5);
  else {
    const o = i.oscillator;
    const [band, lean] =
      o <= -5 ? ["panic / capitulation low", 1.0]
      : o <= -2.5 ? ["sharp pullback", 0.9]
      : o <= -1.5 ? ["meaningful pullback", 0.8]
      : o <= -1 ? ["mild pullback", 0.6]
      : o < 1.5 ? ["normal drift — no edge", 0.5]
      : o < 2.5 ? ["stretched", 0.35]
      : ["overbought", 0.15];
    add("oscillator", "S&P Oscillator", 25, `${sign(o)}%`, band as string, lean as number);
  }

  // Breadth (15) — the rubric's decision tree.
  if (!n(i.sp500Above50)) add("breadth", "Breadth", 15, "not entered", "no reading — treated as no edge", 0.5);
  else {
    const sp = i.sp500Above50, br = i.broadAbove50;
    let band = "mid-range — no edge", lean = 0.5;
    if (n(br) && sp < 30 && br < 30) { band = n(i.newLows) && i.newLows > 150 ? "capitulation: both under 30% with new lows spiking" : "both deeply oversold"; lean = n(i.newLows) && i.newLows > 150 ? 1.0 : 0.85; }
    else if (n(br) && sp >= 50 && sp - br >= 10) { band = `narrowing leadership (${(sp - br).toFixed(0)}pp gap)`; lean = 0.3; }
    else if (n(br) && sp > 70 && br > 70) { band = "healthy thrust"; lean = 0.6; }
    let reading = `S&P ${sp.toFixed(0)}%${n(br) ? ` · broad ${br.toFixed(0)}%` : " · broad not entered"}`;
    if (n(i.upVolumePct)) {
      reading += ` · up-volume ${i.upVolumePct.toFixed(0)}%`;
      if (i.upVolumePct >= 85) { band += " + breadth-thrust day"; lean = Math.min(1, lean + 0.2); }
      else if (i.upVolumePct <= 15) { band += " + capitulation volume"; lean = Math.min(1, lean + 0.15); }
    }
    add("breadth", "Breadth", 15, reading, band, lean);
  }

  // VIX (10).
  if (!n(i.vix)) add("vix", "VIX", 10, "unavailable", "no reading — treated as no edge", 0.5);
  else {
    const v = i.vix, d = i.vixWeekPct;
    const [band, lean] =
      v > 28 && n(d) && d > 0 ? ["above 28 and still climbing — peak fear not in", 0.2]
      : v >= 20 && n(d) && d <= 0 ? ["spike stalling or reversing", 0.8]
      : v >= 20 ? ["elevated", 0.55]
      : ["no edge", 0.5];
    add("vix", "VIX", 10, `${v.toFixed(1)}${n(d) ? ` (${sign(d)}% wk/wk)` : ""}`, band as string, lean as number);
  }

  // Sentiment (6).
  if (!n(i.fearGreed) && !n(i.aaiiBullBear)) add("sentiment", "Sentiment", 6, "unavailable", "no reading — treated as no edge", 0.5);
  else {
    const fg = i.fearGreed, aa = i.aaiiBullBear;
    const fearful = (n(fg) && fg < 30) || (n(aa) && aa < -10);
    const greedy = (n(fg) && fg > 75) || (n(aa) && aa > 30);
    add("sentiment", "Sentiment", 6, `${n(fg) ? `F&G ${fg.toFixed(0)}` : ""}${n(fg) && n(aa) ? " · " : ""}${n(aa) ? `AAII ${sign(aa, 0)}` : ""}`,
      fearful ? "fear / capitulation" : greedy ? "greed" : "no edge", fearful ? 0.85 : greedy ? 0.3 : 0.5);
  }

  // Momentum (4).
  if (!n(i.spx5dPct)) add("momentum", "5-day S&P move", 4, "unavailable", "no reading — treated as no edge", 0.5);
  else {
    const r = i.spx5dPct;
    const [band, lean] = r <= -7 ? ["possible regime break — wait for a low", 0.3] : r <= -2 ? ["clean pullback", 0.8] : r >= 3 ? ["extended", 0.4] : ["no edge", 0.5];
    add("momentum", "5-day S&P move", 4, `${sign(r)}%`, band as string, lean as number);
  }
  return out;
}

export type ComputedCashScore = {
  components: CashComponent[];
  quantPoints: number;
  newton: { state: NewtonState; label: string; points: number } | null;
  /** null when Newton's state is missing (no notes, or the model did not classify). */
  score: number | null;
  action: "DEPLOY" | "DEPLOY_PARTIAL" | "WAIT" | null;
};

export const actionForScore = (score: number): "DEPLOY" | "DEPLOY_PARTIAL" | "WAIT" => (score >= 70 ? "DEPLOY" : score >= 55 ? "DEPLOY_PARTIAL" : "WAIT");

export function computeCashScore(inputs: CashInputs, newtonState: unknown): ComputedCashScore {
  const components = scoreCashInputs(inputs);
  const quantPoints = Math.round(components.reduce((s, c) => s + c.points, 0) * 10) / 10;
  if (!isNewtonState(newtonState)) return { components, quantPoints, newton: null, score: null, action: null };
  const nw = NEWTON_STATES[newtonState];
  const score = Math.round(quantPoints + nw.points);
  return { components, quantPoints, newton: { state: newtonState, label: nw.label, points: nw.points }, score, action: actionForScore(score) };
}
