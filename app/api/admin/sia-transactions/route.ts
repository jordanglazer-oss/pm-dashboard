import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { sameSymbol } from "@/app/lib/model-staging";
import type { PimModelData } from "@/app/lib/pim-types";
import { mergeSplits, parseSiaCsv, siaPositions, siaSummary, siaSymbol, unitsAt } from "@/app/lib/sia-holdings";
import { fetchSiaSplits } from "@/app/lib/sia-splits";
import { SIA_BOOKS, isSiaBook, packTxns, readSiaStore, siaKey, siaStatus, type SiaBook, type SiaStore } from "@/app/lib/sia-store";

/**
 * The SIA transaction log behind "Contribution by holding".
 *
 * GET  — what is on file (counts and dates only; never the trades). Read-only.
 * POST { csv, fileName? }                 — PREVIEW a file: parses it, looks up
 *        split history, and checks the resulting holdings against the model on
 *        the file's last trade day. Writes NOTHING.
 * POST { csv, fileName?, confirm: "LOAD" } — store it. The prior value is
 *        stashed at pm:sia-transactions.pre-import-<ts> first. Refuses a file
 *        that is older or shorter than the one on file unless `replace: true`,
 *        and a file with unreadable rows.
 * POST { action: "disable" | "enable" }   — the switch. "disable" keeps the
 *        data and makes the panel use the dashboard's own trade log again.
 *
 * `book` (allEquity — the default — growth, balanced, conservative) says which
 * mandate's log: each has its OWN key, so loading one never touches another.
 * GET ?all=1 lists what is on file for every mandate.
 *
 * Touches ONE key per call, that mandate's log (and its stash). It never reads or
 * writes a performance series, a position, a model or a score, so loading,
 * replacing or switching off the log cannot change recorded performance.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const log = createLogger("SIA-transactions");

export async function GET(req: NextRequest) {
  const q = new URL(req.url).searchParams;
  if (q.get("all")) {
    const books = await Promise.all(SIA_BOOKS.map(async (b) => ({ book: b.id, label: b.label, ...siaStatus(await readSiaStore(b.id)) })));
    return NextResponse.json({ books });
  }
  const book = q.get("book");
  return NextResponse.json(siaStatus(await readSiaStore(isSiaBook(book) ? book : "allEquity")));
}

const CLASS_KEY = { equity: "equity", fixedIncome: "fixedIncome", alternative: "alternatives" } as const;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { csv?: unknown; fileName?: unknown; confirm?: unknown; replace?: unknown; action?: unknown; book?: unknown } | null;
    if (!body) return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
    if (body.book != null && !isSiaBook(body.book)) return NextResponse.json({ error: "Unknown mandate." }, { status: 400 });
    const book: SiaBook = isSiaBook(body.book) ? body.book : "allEquity";
    const SIA_KEY = siaKey(book);
    const redis = await getRedis();
    const stored = await readSiaStore(book);

    if (body.action === "disable" || body.action === "enable") {
      if (!stored) return NextResponse.json({ error: "No SIA log is on file." }, { status: 409 });
      const next: SiaStore = { ...stored, enabled: body.action === "enable" };
      await redis.set(SIA_KEY, JSON.stringify(next));
      log.info("switched " + body.action);
      return NextResponse.json({ ok: true, ...siaStatus(next) });
    }

    if (typeof body.csv !== "string" || body.csv.length < 20) return NextResponse.json({ error: "No file content received." }, { status: 400 });
    if (body.csv.length > 6_000_000) return NextResponse.json({ error: "That file is too large for a transaction log." }, { status: 400 });
    const { txns, problems } = parseSiaCsv(body.csv);
    if (!txns.length) return NextResponse.json({ error: problems[0] ?? "No trades could be read from that file." }, { status: 400 });

    const firstTrade = new Map<string, string>();
    for (const t of txns) {
      const k = siaSymbol(t.symbol);
      if (!firstTrade.has(k)) firstTrade.set(k, t.date);
    }
    const looked = await fetchSiaSplits(firstTrade);
    const splits = mergeSplits(looked.splits);
    const summary = siaSummary(txns, splits);

    // Sanity check a person can read: on the file's last trade day (a full
    // rebalance in practice), do the units × that day's prices give the weights
    // the model says? A missing split shows up here as one name far off.
    let modelCheck: { date: string; rows: { symbol: string; logPct: number; modelPct: number | null }[]; worstGapPts: number | null; worst: { symbol: string; logPct: number; modelPct: number } | null; splitLike: string[]; unpriced: string[]; note: string } | null = null;
    try {
      const modelsRaw = await redis.get("pm:pim-models");
      const pim = modelsRaw ? (JSON.parse(modelsRaw) as PimModelData).groups?.find((g) => g.id === "pim") : null;
      const day = summary.last;
      if (pim && day) {
        const px = new Map<string, number>();
        for (const t of txns) if (t.date === day) px.set(siaSymbol(t.symbol), t.price);
        const pos = siaPositions(txns, splits);
        const priced = pos.map((p) => ({ symbol: p.symbol, value: unitsAt(p.steps, day) * (px.get(p.symbol) ?? 0) })).filter((r) => r.value > 0);
        const total = priced.reduce((a, r) => a + r.value, 0);
        const rows = priced
          .map((r) => {
            // All-Equity: the equity class is the whole book (as before). Other mandates: each class at its share of the mandate.
            const mix = book === "allEquity" ? null : pim.profiles[book];
            const m = pim.holdings.find((h) => (mix ? true : h.assetClass === "equity") && sameSymbol(h.symbol, r.symbol));
            const share = m ? m.weightInClass * (mix ? (mix[CLASS_KEY[m.assetClass]] ?? 0) : 1) : null;
            return { symbol: r.symbol, logPct: parseFloat(((r.value / total) * 100).toFixed(2)), modelPct: share != null ? parseFloat((share * 100).toFixed(2)) : null };
          })
          .sort((a, b) => b.logPct - a.logPct);
        const matched = rows.filter((r): r is { symbol: string; logPct: number; modelPct: number } => r.modelPct != null);
        const worst = matched.reduce<{ symbol: string; logPct: number; modelPct: number } | null>((a, r) => (!a || Math.abs(r.logPct - r.modelPct) > Math.abs(a.logPct - a.modelPct) ? r : a), null);
        // A missed split shows as one name at about half or double its model weight (or worse), not as a point or so of drift.
        const splitLike = matched.filter((r) => r.modelPct > 0.3 && (r.logPct / r.modelPct > 1.8 || r.logPct / r.modelPct < 0.56)).map((r) => r.symbol);
        // Held on that day but not traded, so not priced and not in the total — every other weight reads slightly high.
        const unpriced = pos.filter((p) => unitsAt(p.steps, day) > 0 && !(px.get(p.symbol)! > 0) && pim.holdings.some((h) => sameSymbol(h.symbol, p.symbol))).map((p) => p.symbol);
        modelCheck = { date: day, rows, worstGapPts: worst ? parseFloat(Math.abs(worst.logPct - worst.modelPct).toFixed(2)) : null, worst, splitLike, unpriced, note: "Weights from the log on its last trade day beside today's model. Only names traded that day are priced. A missed split shows as one name at about half or double its model weight; a point or so on a large holding is drift or a model change since that day." };
      }
    } catch {
      /* the check is a courtesy; never block on it */
    }

    // A file loaded under the wrong mandate is the likeliest mistake: say so when it is identical to another mandate's log.
    let sameAs: string | null = null;
    const packed = JSON.stringify(packTxns(txns));
    for (const b of SIA_BOOKS) {
      if (b.id === book) continue;
      const other = await readSiaStore(b.id);
      if (other && other.rows === txns.length && JSON.stringify(other.txns) === packed) sameAs = b.label;
    }

    const preview = {
      book,
      sameAs,
      file: typeof body.fileName === "string" ? body.fileName.slice(0, 120) : null,
      summary,
      unreadableRows: problems,
      splitsFound: Object.fromEntries(Object.entries(looked.splits).map(([k, v]) => [k, v.map((x) => x.date + " ×" + parseFloat(x.factor.toFixed(4))).join(", ")])),
      noPriceSource: looked.noData,
      modelCheck,
      onFileNow: siaStatus(stored),
    };

    if (body.confirm !== "LOAD") return NextResponse.json({ mode: "PREVIEW — nothing saved", ...preview });

    if (problems.length > Math.max(3, txns.length * 0.01)) return NextResponse.json({ mode: "refused", refuse: "Too many rows could not be read (" + problems.length + "). Nothing was saved.", ...preview }, { status: 409 });
    if (stored && body.replace !== true && (summary.last! < stored.last || txns.length < stored.rows))
      return NextResponse.json({ mode: "refused", refuse: "This file ends earlier or has fewer trades than the one on file (" + stored.rows + " trades to " + stored.last + "). Nothing was saved.", ...preview }, { status: 409 });

    const stamp = Date.now();
    const prior = await redis.get(SIA_KEY);
    if (prior) await redis.set(SIA_KEY + ".pre-import-" + stamp, prior);
    const next: SiaStore = {
      importedAt: new Date().toISOString(),
      ...(preview.file ? { fileName: preview.file } : {}),
      rows: txns.length,
      first: summary.first!,
      last: summary.last!,
      enabled: true,
      txns: packTxns(txns),
      splits: looked.splits,
      splitsNoData: looked.noData,
    };
    await redis.set(SIA_KEY, JSON.stringify(next));
    log.info(book + ": loaded " + txns.length + " trades to " + summary.last + (prior ? "; prior stashed .pre-import-" + stamp : ""));
    return NextResponse.json({ mode: "SAVED", stash: prior ? SIA_KEY + ".pre-import-" + stamp : null, ...preview, onFileNow: siaStatus(next) });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
