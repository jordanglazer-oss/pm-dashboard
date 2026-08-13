import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { listBackupBlobs, readBackupBlob } from "@/app/lib/backup-store";

/**
 * GET /api/admin/diff-models-vs-backup[?pathname=backups/<stamp>.json]
 *
 * READ-ONLY. Compares the CURRENT pm:pim-models against a backup snapshot and
 * reports every holding whose weightInClass differs, plus every holding added
 * or removed, grouped by model and asset class.
 *
 * Written because "all the models' weights changed" is a claim that should be
 * checked before a restore, not after: a restore rolls back everything in the
 * chosen keys, so it is worth knowing exactly what it will undo — and whether
 * the weights really moved or only their DISPLAY did. Defaults to the newest
 * backup when no pathname is given.
 *
 * Writes nothing.
 */

type Holding = { symbol?: string; weightInClass?: number; assetClass?: string; name?: string };
type Group = { id: string; name: string; holdings?: Holding[] };
type Pim = { groups?: Group[]; lastUpdated?: string };

const pct = (v: number | undefined) => +(((v ?? 0) * 100)).toFixed(4);

export async function GET(req: NextRequest) {
  try {
    let pathname = req.nextUrl.searchParams.get("pathname") || "";
    const backups = await listBackupBlobs(); // newest first
    if (!pathname) {
      if (backups.length === 0) return NextResponse.json({ error: "no backups found" }, { status: 404 });
      pathname = backups[0].pathname;
    }

    const snap = await readBackupBlob(pathname);
    const backupRaw = snap.data?.["pm:pim-models"];
    if (!backupRaw) return NextResponse.json({ error: `pm:pim-models not present in ${pathname}` }, { status: 404 });

    const redis = await getRedis();
    const currentRaw = await redis.get("pm:pim-models");
    if (!currentRaw) return NextResponse.json({ error: "pm:pim-models is empty right now" }, { status: 404 });

    const before = JSON.parse(typeof backupRaw === "string" ? backupRaw : JSON.stringify(backupRaw)) as Pim;
    const after = JSON.parse(currentRaw) as Pim;

    const key = (s: string) => s.toUpperCase().replace("-T", ".TO");
    const groups: unknown[] = [];
    let changedCount = 0;

    for (const ag of after.groups ?? []) {
      const bg = (before.groups ?? []).find((g) => g.id === ag.id);
      const bMap = new Map((bg?.holdings ?? []).map((h) => [key(h.symbol || ""), h]));
      const aMap = new Map((ag.holdings ?? []).map((h) => [key(h.symbol || ""), h]));
      const symbols = [...new Set([...bMap.keys(), ...aMap.keys()])];

      const changed: unknown[] = [];
      for (const sym of symbols) {
        const b = bMap.get(sym);
        const a = aMap.get(sym);
        const bw = pct(b?.weightInClass);
        const aw = pct(a?.weightInClass);
        if (b && a && Math.abs(bw - aw) < 0.0001) continue;
        changed.push({
          symbol: a?.symbol ?? b?.symbol,
          assetClass: a?.assetClass ?? b?.assetClass,
          status: !b ? "ADDED" : !a ? "REMOVED" : "CHANGED",
          beforePct: b ? bw : null,
          afterPct: a ? aw : null,
          deltaPct: b && a ? +(aw - bw).toFixed(4) : null,
        });
      }
      if (changed.length === 0) continue;
      changedCount += changed.length;

      // Class sums on both sides, so a restore's effect on the 100% invariant
      // is visible too.
      const sums = ["equity", "fixedIncome", "alternative"].map((ac) => ({
        assetClass: ac,
        beforePct: +(((bg?.holdings ?? []).filter((h) => h.assetClass === ac).reduce((s, h) => s + (h.weightInClass || 0), 0)) * 100).toFixed(4),
        afterPct: +(((ag.holdings ?? []).filter((h) => h.assetClass === ac).reduce((s, h) => s + (h.weightInClass || 0), 0)) * 100).toFixed(4),
      })).filter((x) => x.beforePct > 0 || x.afterPct > 0);

      groups.push({ group: ag.name, groupId: ag.id, classSums: sums, changed });
    }

    return NextResponse.json({
      comparedAgainst: pathname,
      backupTakenAt: snap.backedUpAt ?? null,
      currentLastUpdated: after.lastUpdated ?? null,
      availableBackups: backups.slice(0, 10).map((b) => b.pathname),
      changedHoldings: changedCount,
      groups,
    });
  } catch (e) {
    console.error("diff-models-vs-backup failed:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
