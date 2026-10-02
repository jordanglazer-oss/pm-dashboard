/**
 * Positioning snapshot → PNG.
 *
 * Draws the Positioning tab's holdings (every position, its live weight and
 * its model weight, grouped by asset class under coloured headers) onto a
 * canvas and returns a PNG blob, so the PM can save or paste a clean image
 * for a review without screenshotting the page. Pure client-side rendering:
 * it reads only the numbers handed to it and writes nothing anywhere.
 *
 * Weights are FRACTIONS (0.0182 = 1.82%) and should be the same apportioned
 * display values the table shows, so the image and the page never disagree.
 */
import { fmtPct2 } from "./display-weights";

export type SnapshotClassKey = "fixedIncome" | "equity" | "alternative";

export type SnapshotRow = {
  ticker: string;
  name: string;
  currency: "CAD" | "USD";
  live: number | null;
  model: number | null;
};

export type SnapshotClass = {
  key: SnapshotClassKey;
  label: string;
  rows: SnapshotRow[];
};

export type PositioningSnapshot = {
  title: string;
  subtitle: string;
  asOf: Date;
  classes: SnapshotClass[];
  cash: { live: number | null; model: number } | null;
  footnote?: string;
};

/** Same hues as the Models / Positioning class headers (globals.css tokens). */
const CLASS_COLORS: Record<SnapshotClassKey, { ink: string; soft: string }> = {
  fixedIncome: { ink: "#2d5bd0", soft: "#eef3ff" },
  equity: { ink: "#12805c", soft: "#ecf7f1" },
  alternative: { ink: "#b0741c", soft: "#fbf5e8" },
};

const INK = "#111827";
const INK_2 = "#374151";
const INK_3 = "#6b7280";
const FAINT = "#9ca3af";
const LINE = "#e5e7eb";
const LINE_SOFT = "#f0f1f4";
const WARN = "#b0741c";
/** Same 0.5pp "outside tolerance" line the Positioning table colours at. */
const DRIFT_TOLERANCE = 0.005;

const W = 960;
const PAD = 32;
const ROW_H = 28;
const CLASS_H = 32;
const HEAD_H = 30;
const SCALE = 2;

// Column right edges (numeric columns are right-aligned).
const COL_MODEL = W - PAD - 220;
const COL_LIVE = W - PAD - 110;
const COL_DRIFT = W - PAD;

function resolveFont(cssVar: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const probe = document.createElement("span");
  probe.style.fontFamily = `var(${cssVar})`;
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const fam = getComputedStyle(probe).fontFamily;
  probe.remove();
  return fam && fam.trim() ? fam : fallback;
}

function sum(vals: (number | null)[]): number | null {
  const present = vals.filter((v): v is number => v != null);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

function fmtDrift(live: number | null, model: number | null): { text: string; color: string } {
  if (live == null || model == null) return { text: "—", color: FAINT };
  const d = Math.round((live - model) * 10_000) / 10_000;
  if (d === 0) return { text: "0.00%", color: INK_3 };
  return { text: `${d > 0 ? "+" : "−"}${fmtPct2(Math.abs(d))}`, color: Math.abs(d) >= DRIFT_TOLERANCE ? WARN : INK_2 };
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

export async function renderPositioningPng(snap: PositioningSnapshot): Promise<Blob> {
  if (typeof document !== "undefined" && document.fonts?.ready) {
    try { await document.fonts.ready; } catch { /* draw with whatever loaded */ }
  }
  const sans = resolveFont("--font-sans", "-apple-system, Helvetica, Arial, sans-serif");
  const mono = resolveFont("--font-mono", "ui-monospace, Menlo, monospace");

  const classes = snap.classes.filter((c) => c.rows.length > 0);
  const rowCount = classes.reduce((n, c) => n + c.rows.length, 0) + (snap.cash ? 1 : 0);
  // Class allocation chips (live vs model), laid out up front so a fourth chip
  // wraps to a second line instead of running off the edge.
  const chips: { label: string; live: number | null; model: number | null; color: string; soft: string }[] = classes.map((c) => ({
    label: c.label,
    live: sum(c.rows.map((r) => r.live)),
    model: sum(c.rows.map((r) => r.model)),
    color: CLASS_COLORS[c.key].ink,
    soft: CLASS_COLORS[c.key].soft,
  }));
  if (snap.cash) chips.push({ label: "Cash", live: snap.cash.live, model: snap.cash.model, color: INK_2, soft: "#f3f4f6" });
  const measure = document.createElement("canvas").getContext("2d");
  const chipFont = `500 11.5px ${sans}`;
  if (measure) measure.font = chipFont;
  const chipLayout: { text: string; x: number; line: number; w: number; color: string; soft: string }[] = [];
  let lx = PAD;
  let line = 0;
  for (const chip of chips) {
    const text = `${chip.label}  ${fmtPct2(chip.live)} live · ${fmtPct2(chip.model)} model`;
    const w = (measure ? measure.measureText(text).width : text.length * 6.5) + 20;
    if (lx > PAD && lx + w > W - PAD) { line += 1; lx = PAD; }
    chipLayout.push({ text, x: lx, line, w, color: chip.color, soft: chip.soft });
    lx += w + 8;
  }
  const headerBlock = 88 + line * 28;
  const totalRow = ROW_H + 6;
  const footer = 44;
  const H = PAD + headerBlock + HEAD_H + classes.length * CLASS_H + rowCount * ROW_H + totalRow + footer;

  const canvas = document.createElement("canvas");
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser");
  ctx.scale(SCALE, SCALE);
  ctx.textBaseline = "middle";

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // ── Title block ──
  let y = PAD;
  ctx.fillStyle = INK;
  ctx.font = `600 22px ${sans}`;
  ctx.textAlign = "left";
  ctx.fillText(snap.title, PAD, y + 12);
  ctx.fillStyle = INK_3;
  ctx.font = `400 13px ${sans}`;
  ctx.fillText(snap.subtitle, PAD, y + 40);
  ctx.textAlign = "right";
  ctx.font = `400 12px ${sans}`;
  const asOf = snap.asOf.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  ctx.fillText(`As of ${asOf}`, W - PAD, y + 12);

  ctx.textAlign = "left";
  ctx.font = chipFont;
  for (const c of chipLayout) {
    const chipY = y + 64 + c.line * 28;
    ctx.fillStyle = c.soft;
    ctx.beginPath();
    ctx.roundRect(c.x, chipY - 11, c.w, 22, 6);
    ctx.fill();
    ctx.fillStyle = c.color;
    ctx.fillText(c.text, c.x + 10, chipY);
  }
  y += headerBlock;

  // ── Column header ──
  ctx.fillStyle = "#f7f8fa";
  ctx.fillRect(PAD, y, W - PAD * 2, HEAD_H);
  ctx.fillStyle = LINE;
  ctx.fillRect(PAD, y + HEAD_H - 2, W - PAD * 2, 2);
  ctx.fillStyle = INK_2;
  ctx.font = `600 11px ${sans}`;
  ctx.textAlign = "left";
  ctx.fillText("Holding", PAD + 12, y + HEAD_H / 2);
  ctx.textAlign = "right";
  ctx.fillText("Model", COL_MODEL - 10, y + HEAD_H / 2);
  ctx.fillText("Live", COL_LIVE - 10, y + HEAD_H / 2);
  ctx.fillText("Live − Model", COL_DRIFT - 10, y + HEAD_H / 2);
  y += HEAD_H;

  const drawRow = (row: SnapshotRow) => {
    const mid = y + ROW_H / 2;
    ctx.textAlign = "left";
    ctx.fillStyle = INK;
    ctx.font = `500 12.5px ${mono}`;
    ctx.fillText(row.ticker, PAD + 12, mid);
    let nx = PAD + 12 + ctx.measureText(row.ticker).width + 8;
    if (row.currency === "USD") {
      ctx.fillStyle = INK_3;
      ctx.font = `400 10.5px ${sans}`;
      ctx.fillText("USD", nx, mid);
      nx += ctx.measureText("USD").width + 8;
    }
    if (row.name) {
      ctx.fillStyle = INK_3;
      ctx.font = `400 12px ${sans}`;
      ctx.fillText(ellipsize(ctx, row.name, COL_MODEL - 90 - nx), nx, mid);
    }
    ctx.textAlign = "right";
    ctx.font = `400 12.5px ${mono}`;
    ctx.fillStyle = row.model == null ? FAINT : INK_2;
    ctx.fillText(fmtPct2(row.model), COL_MODEL - 10, mid);
    ctx.fillStyle = row.live == null ? FAINT : INK;
    ctx.fillText(fmtPct2(row.live), COL_LIVE - 10, mid);
    const d = fmtDrift(row.live, row.model);
    ctx.fillStyle = d.color;
    ctx.fillText(d.text, COL_DRIFT - 10, mid);
    ctx.fillStyle = LINE_SOFT;
    ctx.fillRect(PAD, y + ROW_H - 1, W - PAD * 2, 1);
    y += ROW_H;
  };

  // ── Classes ──
  for (const c of classes) {
    const col = CLASS_COLORS[c.key];
    ctx.fillStyle = col.soft;
    ctx.fillRect(PAD, y, W - PAD * 2, CLASS_H);
    ctx.fillStyle = col.ink;
    ctx.fillRect(PAD, y, 3, CLASS_H);
    const mid = y + CLASS_H / 2;
    ctx.textAlign = "left";
    ctx.font = `600 12.5px ${sans}`;
    ctx.fillText(c.label, PAD + 12, mid);
    const lw = ctx.measureText(c.label).width;
    ctx.font = `400 11.5px ${sans}`;
    ctx.fillText(`${c.rows.length} holding${c.rows.length === 1 ? "" : "s"}`, PAD + 12 + lw + 10, mid);
    ctx.textAlign = "right";
    ctx.font = `600 12.5px ${mono}`;
    const cm = sum(c.rows.map((r) => r.model));
    const cl = sum(c.rows.map((r) => r.live));
    ctx.fillText(fmtPct2(cm), COL_MODEL - 10, mid);
    ctx.fillText(fmtPct2(cl), COL_LIVE - 10, mid);
    const d = fmtDrift(cl, cm);
    ctx.fillStyle = d.text === "—" ? FAINT : col.ink;
    ctx.fillText(d.text, COL_DRIFT - 10, mid);
    y += CLASS_H;
    for (const r of c.rows) drawRow(r);
  }

  if (snap.cash) {
    drawRow({ ticker: "Cash", name: "", currency: "CAD", live: snap.cash.live, model: snap.cash.model });
  }

  // ── Total ──
  y += 6;
  ctx.fillStyle = LINE;
  ctx.fillRect(PAD, y - 3, W - PAD * 2, 1);
  const allRows = classes.flatMap((c) => c.rows);
  const tModel = (sum(allRows.map((r) => r.model)) ?? 0) + (snap.cash?.model ?? 0);
  const liveParts = sum(allRows.map((r) => r.live));
  const tLive = liveParts == null ? null : liveParts + (snap.cash?.live ?? 0);
  const mid = y + ROW_H / 2;
  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `600 12.5px ${sans}`;
  ctx.fillText("Total", PAD + 12, mid);
  ctx.textAlign = "right";
  ctx.font = `600 12.5px ${mono}`;
  ctx.fillText(fmtPct2(tModel), COL_MODEL - 10, mid);
  ctx.fillText(fmtPct2(tLive), COL_LIVE - 10, mid);
  y += ROW_H;

  // ── Footnote ──
  ctx.textAlign = "left";
  ctx.fillStyle = FAINT;
  ctx.font = `400 11px ${sans}`;
  ctx.fillText(
    snap.footnote ?? "Weights are % of total portfolio. Live = current market value at live prices (CAD); Model = target weight.",
    PAD, y + 24,
  );

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png");
  });
}
