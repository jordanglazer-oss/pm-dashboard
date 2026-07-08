import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { canonicalTicker } from "@/app/lib/ticker";
import type { AnalystReports, AnalystSnapshots } from "@/app/lib/analyst-snapshots";

/**
 * GET /api/admin/rename-ticker?from=BK&to=BNY
 *
 * One-off surgical ticker rename for corporate symbol changes (e.g. BNY
 * Mellon changed its ticker from BK to BNY). The ticker is the identity key
 * that links a position to its analyst PDFs, score history, and model
 * holdings, so a rename has to touch every store that references it — doing
 * it in one place would orphan the rest.
 *
 * SAFETY (per the Redis-safety checklist):
 *  - DRY RUN by default. Pass `&confirm=YES` to actually write.
 *  - Stashes a pre-image of every key it changes to `<key>.pre-rename-<ts>`
 *    so any step is reversible (restore-from-stash).
 *  - Read-modify-write on every blob — unrelated tickers/fields untouched.
 *  - REFUSES if `to` already exists as a separate holding in pm:stocks
 *    (won't silently merge two positions).
 *  - Leaves append-only history (pm:portfolio-snapshots) alone by design —
 *    those are point-in-time records and must not be rewritten.
 *
 * Keys touched: pm:stocks, pm:analyst-reports (+ meta.id), pm:analyst-snapshots,
 * pm:analyst-report-pdf:<canon>-rbc/-jpm, pm:pim-models (holding.symbol),
 * pm:pim-positions (position.symbol — units + cost basis), pm:score-history.
 *
 * DETECT-ONLY (reported, never rewritten): pm:pim-portfolio-state (historical
 * transaction log + rebalance-snapshot price keys) and pm:pim-performance
 * (aggregate index, not symbol-keyed).
 */

type Stock = { ticker: string; name?: string; bucket?: string };
type PimModelsBlob = { groups?: Array<{ id: string; holdings?: Array<{ symbol: string }> }> };
type ScoreHistory = Record<string, unknown>;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const fromRaw = (url.searchParams.get("from") || "").trim();
  const toRaw = (url.searchParams.get("to") || "").trim();
  const confirm = url.searchParams.get("confirm") === "YES";
  const rollback = (url.searchParams.get("rollback") || "").trim();

  // ── Rollback mode ───────────────────────────────────────────────────
  // ?rollback=<ts>[&confirm=YES] restores every key that a prior rename
  // stashed under `<key>.pre-rename-<ts>`. Restoring the manifest blob
  // re-points the analyst PDFs at the old ticker; the new-ticker PDF copy
  // is left as harmless orphan (delete manually if desired). DRY RUN unless
  // confirm=YES.
  if (rollback) {
    const redis = await getRedis();
    const suffix = `.pre-rename-${rollback}`;
    const keys = await redis.keys(`*${suffix}`);
    if (keys.length === 0) {
      return NextResponse.json({ error: `No stash found for rollback id ${rollback}.` }, { status: 404 });
    }
    const restored: string[] = [];
    for (const sk of keys) {
      const baseKey = sk.slice(0, sk.length - suffix.length);
      const val = await redis.get(sk);
      if (val == null) continue;
      if (confirm) await redis.set(baseKey, val);
      restored.push(baseKey);
    }
    return NextResponse.json({
      mode: confirm ? "ROLLED BACK" : "DRY RUN — add &confirm=YES to restore",
      rollbackId: rollback,
      restored,
      note: "If the rename moved analyst PDFs, the new-ticker PDF copy may remain as an unreferenced orphan — harmless.",
    });
  }

  if (!fromRaw || !toRaw) {
    return NextResponse.json(
      { error: "Pass ?from=OLD&to=NEW (e.g. ?from=BK&to=BNY). Add &confirm=YES to apply." },
      { status: 400 },
    );
  }

  const fromCanon = canonicalTicker(fromRaw);
  const toCanon = canonicalTicker(toRaw);
  const toDisplay = toRaw.toUpperCase();
  if (fromCanon === toCanon) {
    return NextResponse.json({ error: "from and to resolve to the same ticker." }, { status: 400 });
  }

  const redis = await getRedis();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const changes: string[] = [];
  const warnings: string[] = [];
  const stashed: string[] = [];

  // Helper: stash a key's current raw value before mutating.
  const stash = async (key: string, raw: string) => {
    if (!confirm) return;
    const stashKey = `${key}.pre-rename-${ts}`;
    await redis.set(stashKey, raw);
    stashed.push(stashKey);
  };

  // ── 1. pm:stocks — the position itself ──────────────────────────────
  const stocksRaw = await redis.get("pm:stocks");
  if (stocksRaw) {
    const stocks = JSON.parse(stocksRaw) as Stock[];
    const fromIdx = stocks.findIndex((s) => canonicalTicker(s.ticker) === fromCanon);
    const toExists = stocks.some((s) => canonicalTicker(s.ticker) === toCanon);
    if (fromIdx < 0) {
      warnings.push(`pm:stocks: no holding found with ticker ${fromCanon}.`);
    } else if (toExists) {
      return NextResponse.json(
        { error: `pm:stocks already has a separate ${toCanon} holding. Refusing to merge two positions. Resolve manually first.` },
        { status: 409 },
      );
    } else {
      changes.push(`pm:stocks: ${stocks[fromIdx].ticker} → ${toDisplay} (${stocks[fromIdx].name ?? ""}, ${stocks[fromIdx].bucket ?? "?"})`);
      if (confirm) {
        await stash("pm:stocks", stocksRaw);
        stocks[fromIdx] = { ...stocks[fromIdx], ticker: toDisplay };
        await redis.set("pm:stocks", JSON.stringify(stocks));
      }
    }
  } else {
    warnings.push("pm:stocks: missing/unreadable.");
  }

  // ── 2. pm:analyst-reports — manifest keyed by canonical ticker ──────
  const reportsRaw = await redis.get("pm:analyst-reports");
  if (reportsRaw) {
    const reports = JSON.parse(reportsRaw) as AnalystReports;
    const entry = reports[fromCanon] ?? reports[fromRaw.toUpperCase()];
    if (entry) {
      if (reports[toCanon]) {
        warnings.push(`pm:analyst-reports: ${toCanon} already exists — left ${fromCanon} reports in place to avoid overwrite.`);
      } else {
        const sources = (["rbc", "jpm"] as const).filter((s) => entry[s]);
        changes.push(`pm:analyst-reports: move ${fromCanon} → ${toCanon} (${sources.join(", ") || "no sources"}); meta.id retargeted`);
        if (confirm) {
          await stash("pm:analyst-reports", reportsRaw);
          const moved = { ...entry };
          for (const s of sources) {
            if (moved[s]) moved[s] = { ...moved[s]!, id: `${toCanon}-${s}` };
          }
          const next: AnalystReports = { ...reports, [toCanon]: moved };
          delete next[fromCanon];
          delete next[fromRaw.toUpperCase()];
          await redis.set("pm:analyst-reports", JSON.stringify(next));
        }

        // ── 3. The PDF blobs, one per source ──────────────────────────
        for (const s of sources) {
          const oldKey = `pm:analyst-report-pdf:${fromCanon}-${s}`;
          const newKey = `pm:analyst-report-pdf:${toCanon}-${s}`;
          const pdf = await redis.get(oldKey);
          if (pdf) {
            changes.push(`${oldKey} → ${newKey}`);
            if (confirm) {
              await stash(oldKey, pdf);
              await redis.set(newKey, pdf);
              await redis.del(oldKey);
            }
          }
        }
      }
    }
  }

  // ── 4. pm:analyst-snapshots — keyed by canonical ticker ─────────────
  const snapsRaw = await redis.get("pm:analyst-snapshots");
  if (snapsRaw) {
    const snaps = JSON.parse(snapsRaw) as AnalystSnapshots;
    const entry = snaps[fromCanon] ?? snaps[fromRaw.toUpperCase()];
    if (entry) {
      if (snaps[toCanon]) {
        warnings.push(`pm:analyst-snapshots: ${toCanon} already exists — left ${fromCanon} snapshot in place.`);
      } else {
        changes.push(`pm:analyst-snapshots: move ${fromCanon} → ${toCanon}`);
        if (confirm) {
          await stash("pm:analyst-snapshots", snapsRaw);
          const next: AnalystSnapshots = { ...snaps, [toCanon]: entry };
          delete next[fromCanon];
          delete next[fromRaw.toUpperCase()];
          await redis.set("pm:analyst-snapshots", JSON.stringify(next));
        }
      }
    }
  }

  // ── 5. pm:pim-models — holding.symbol inside each group ─────────────
  const pimRaw = await redis.get("pm:pim-models");
  if (pimRaw) {
    const pim = JSON.parse(pimRaw) as PimModelsBlob;
    const hits: string[] = [];
    for (const g of pim.groups ?? []) {
      for (const h of g.holdings ?? []) {
        if (canonicalTicker(h.symbol) === fromCanon) hits.push(g.id);
      }
    }
    if (hits.length > 0) {
      changes.push(`pm:pim-models: rename holding ${fromCanon} → ${toDisplay} in group(s): ${hits.join(", ")}`);
      if (confirm) {
        await stash("pm:pim-models", pimRaw);
        for (const g of pim.groups ?? []) {
          for (const h of g.holdings ?? []) {
            if (canonicalTicker(h.symbol) === fromCanon) h.symbol = toDisplay;
          }
        }
        await redis.set("pm:pim-models", JSON.stringify(pim));
      }
    }
  }

  // ── 5b. pm:pim-positions — units + cost basis per symbol, per portfolio ─
  // This is the store the Positioning tab reads for "units". It's keyed by the
  // exact symbol string, so a rename that skips it (as the original did) leaves
  // units + ACB stranded under the OLD ticker while the model shows the new one
  // → the Positioning row renders 0 units and loses its cost basis. Renaming
  // here restores units, ACB, gain/loss, and current weights.
  const posRaw = await redis.get("pm:pim-positions");
  if (posRaw) {
    const blob = JSON.parse(posRaw) as { portfolios?: Array<{ groupId?: string; profile?: string; positions?: Array<{ symbol: string }> }> };
    const hits: string[] = [];
    for (const p of blob.portfolios ?? []) {
      for (const pos of p.positions ?? []) {
        if (canonicalTicker(pos.symbol) === fromCanon) hits.push(`${p.groupId ?? "?"}/${p.profile ?? "?"}`);
      }
    }
    if (hits.length > 0) {
      changes.push(`pm:pim-positions: rename ${fromCanon} → ${toDisplay} in ${hits.length} portfolio(s): ${hits.join(", ")}`);
      if (confirm) {
        await stash("pm:pim-positions", posRaw);
        for (const p of blob.portfolios ?? []) {
          for (const pos of p.positions ?? []) {
            if (canonicalTicker(pos.symbol) === fromCanon) pos.symbol = toDisplay;
          }
        }
        await redis.set("pm:pim-positions", JSON.stringify(blob));
      }
    } else {
      warnings.push(`pm:pim-positions: no position found with ${fromCanon}.`);
    }
  } else {
    warnings.push("pm:pim-positions: missing/unreadable.");
  }

  // ── 6. pm:score-history — keyed by ticker ───────────────────────────
  const histRaw = await redis.get("pm:score-history");
  if (histRaw) {
    const hist = JSON.parse(histRaw) as ScoreHistory;
    const fromKey = Object.keys(hist).find((k) => canonicalTicker(k) === fromCanon);
    if (fromKey) {
      const toKey = Object.keys(hist).find((k) => canonicalTicker(k) === toCanon);
      if (toKey) {
        warnings.push(`pm:score-history: ${toCanon} already exists — left ${fromCanon} history in place.`);
      } else {
        changes.push(`pm:score-history: move ${fromKey} → ${toDisplay}`);
        if (confirm) {
          await stash("pm:score-history", histRaw);
          const next: ScoreHistory = { ...hist, [toDisplay]: hist[fromKey] };
          delete next[fromKey];
          await redis.set("pm:score-history", JSON.stringify(next));
        }
      }
    }
  }

  // ── 7. pm:pim-portfolio-state — DETECT ONLY (no auto-rewrite) ────────
  // Transaction log + rebalance-snapshot price maps reference the symbol, but
  // these are point-in-time trade/rebalance records (the trade genuinely
  // executed under the OLD symbol). We surface any lingering references so the
  // operator can decide, rather than silently rewriting history. The one place
  // it can matter live is a trackingStart/lastRebalance `prices` map keyed by
  // the old symbol (forward-performance baseline lookups go by current symbol).
  const stateRaw = await redis.get("pm:pim-portfolio-state");
  if (stateRaw) {
    try {
      const state = JSON.parse(stateRaw) as {
        groupStates?: Array<{
          groupId?: string;
          lastRebalance?: { prices?: Record<string, number> } | null;
          trackingStart?: { prices?: Record<string, number> } | null;
          transactions?: Array<{ symbol?: string; pairedWith?: string }>;
        }>;
      };
      const refs: string[] = [];
      for (const gs of state.groupStates ?? []) {
        const g = gs.groupId ?? "?";
        const txMatches = (gs.transactions ?? []).filter(
          (t) => canonicalTicker(t.symbol ?? "") === fromCanon || canonicalTicker(t.pairedWith ?? "") === fromCanon,
        ).length;
        if (txMatches > 0) refs.push(`${g}: ${txMatches} transaction(s)`);
        for (const snap of [gs.lastRebalance, gs.trackingStart]) {
          const priceKeys = Object.keys(snap?.prices ?? {});
          if (priceKeys.some((k) => canonicalTicker(k) === fromCanon)) refs.push(`${g}: rebalance-snapshot price key`);
        }
      }
      if (refs.length > 0) {
        warnings.push(
          `pm:pim-portfolio-state still references ${fromCanon} (${refs.join("; ")}). NOT auto-rewritten — these are historical trade/rebalance records. If forward-performance tracking looks off, ask to relabel the rebalance-snapshot price keys ${fromCanon} → ${toDisplay}.`,
        );
      }
    } catch {
      warnings.push("pm:pim-portfolio-state: unreadable — skipped detection.");
    }
  }

  // pm:pim-performance is an aggregate per-profile index (not symbol-keyed), so
  // a rename doesn't alter its structure. But any DAILY value computed while the
  // position was stranded (new symbol valued at 0 units) is understated — after
  // this rename, re-run the daily-value recompute for the affected window.
  warnings.push("pm:pim-performance is aggregate (not symbol-keyed) — unaffected structurally, but recompute recent daily values if any were captured while units were stranded.");

  // Append-only history is intentionally not rewritten.
  warnings.push("pm:portfolio-snapshots left untouched (append-only point-in-time history).");

  return NextResponse.json({
    mode: confirm ? "APPLIED" : "DRY RUN — add &confirm=YES to apply",
    from: fromCanon,
    to: toDisplay,
    changes,
    warnings,
    stashed: confirm ? stashed : undefined,
    rollbackId: confirm ? ts : undefined,
    rollback: confirm
      ? `To undo: /api/admin/rename-ticker?rollback=${ts}&confirm=YES`
      : undefined,
  });
}
