/**
 * POST /api/admin/restore-from-backup
 * Body: { pathname: "backups/<stamp>.json", keys: string[], confirm: "YES" }
 *
 * Restores SPECIFIC keys from a specific Blob backup snapshot (get the
 * `pathname` from /api/admin/list-backups). Used to recover from data
 * corruption when a more targeted patch would be risky.
 *
 * Hard gates:
 *   - Body must include `confirm: "YES"` exactly.
 *   - `keys` must be a non-empty array. Common sets:
 *       ["pm:pim-positions"]
 *       ["pm:pim-positions", "pm:pim-models", "pm:stocks"]
 *   - Never restores pm:backup:* keys (avoid recursive bloat).
 *
 * The endpoint also stashes the CURRENT values of every key it's about
 * to overwrite into `pm:pre-restore-stash:{timestamp}` so the
 * pre-restore state is recoverable if something goes wrong here.
 *
 * Returns a per-key summary of what was restored, including byte size.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { readBackupBlob } from "@/app/lib/backup-store";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const pathname = typeof body?.pathname === "string" ? body.pathname : "";
    const keys: string[] = Array.isArray(body?.keys) ? body.keys.filter((k: unknown) => typeof k === "string") : [];
    const confirm = body?.confirm;

    if (confirm !== "YES") {
      return NextResponse.json({ error: "Body must include confirm: 'YES'" }, { status: 400 });
    }
    if (!pathname.startsWith("backups/")) {
      return NextResponse.json({ error: "pathname must be a Blob backup path like 'backups/<stamp>.json' (see /api/admin/list-backups)" }, { status: 400 });
    }
    if (keys.length === 0) {
      return NextResponse.json({ error: "keys array required (e.g. ['pm:pim-positions'])" }, { status: 400 });
    }
    for (const k of keys) {
      if (k.startsWith("pm:backup:")) {
        return NextResponse.json({ error: `Refusing to restore a pm:backup:* key (${k})` }, { status: 400 });
      }
    }

    const redis = await getRedis();
    const backupKey = pathname;
    let backup: { backedUpAt?: string; data?: Record<string, string> };
    try {
      backup = await readBackupBlob(pathname);
    } catch (e) {
      return NextResponse.json({ error: `Backup ${pathname} not found or unreadable: ${e instanceof Error ? e.message : String(e)}` }, { status: 404 });
    }
    const data = backup.data ?? {};

    // Validate every requested key is present in the backup before we
    // touch anything.
    const missing: string[] = [];
    for (const k of keys) {
      if (typeof data[k] !== "string") missing.push(k);
    }
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `Backup ${backupKey} does not contain: ${missing.join(", ")}` },
        { status: 400 },
      );
    }

    // Stash current values so this restore itself is reversible.
    const stashKey = `pm:pre-restore-stash:${new Date().toISOString()}`;
    const stash: Record<string, string | null> = {};
    for (const k of keys) {
      const current = await redis.get(k);
      stash[k] = current;
    }
    await redis.set(stashKey, JSON.stringify({
      stashedAt: new Date().toISOString(),
      restoringFromBackup: backupKey,
      keys,
      data: stash,
    }));

    // Apply the restore.
    const results: Array<{ key: string; restoredBytes: number; previousBytes: number | null }> = [];
    for (const k of keys) {
      let value = data[k];
      const previousBytes = stash[k]?.length ?? null;
      // pm:pim-models carries a revision the browser tabs compare against.
      // A backup holds an OLDER revision, so every open tab would pass the
      // stale-tab check and overwrite the restore on its next save. Stamp the
      // restored copy ahead of whatever is live.
      if (k === "pm:pim-models") {
        try {
          const restored = JSON.parse(value) as { revision?: number };
          const live = stash[k] ? (JSON.parse(stash[k] as string) as { revision?: number }) : null;
          const liveRev = typeof live?.revision === "number" ? live.revision : 0;
          const backupRev = typeof restored.revision === "number" ? restored.revision : 0;
          value = JSON.stringify({ ...restored, revision: Math.max(liveRev, backupRev) + 1 });
        } catch {
          /* unparseable — restore the backup's value as it is */
        }
      }
      await redis.set(k, value);
      results.push({ key: k, restoredBytes: value.length, previousBytes });
    }

    return NextResponse.json({
      ok: true,
      restoredFrom: backupKey,
      backedUpAt: backup.backedUpAt,
      stashedTo: stashKey,
      results,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Restore failed" },
      { status: 500 },
    );
  }
}
