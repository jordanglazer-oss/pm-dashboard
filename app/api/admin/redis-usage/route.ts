import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

/**
 * READ-ONLY Redis memory diagnostic. No writes, no deletes — safe to run
 * even when the instance is OOM (read commands are still permitted).
 *
 * Reports:
 *   - INFO memory (used_memory_human / maxmemory_human when exposed)
 *   - per-prefix key counts + total value bytes (via STRLEN, so huge values
 *     are NOT transferred into the function — only their length is read)
 *   - the largest individual keys, so the memory hog is obvious at a glance
 *
 * Used to diagnose the "OOM command not allowed" error before pruning
 * pm:backup:* snapshots to recover headroom.
 */

async function scanAll(
  redis: Awaited<ReturnType<typeof getRedis>>,
  match: string,
): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of redis.scanIterator({ MATCH: match, COUNT: 200 })) {
    if (Array.isArray(key)) keys.push(...key);
    else keys.push(key);
  }
  return keys;
}

/** Collapse a key to a coarse prefix bucket for the breakdown table. */
function prefixBucket(key: string): string {
  // pm:attachment:<id> and pm:backup:<stamp> get grouped to the family.
  const m = key.match(/^(pm:[a-z0-9-]+)/i);
  return m ? m[1] : key;
}

export async function GET(_req: NextRequest) {
  const startedAt = Date.now();
  try {
    const redis = await getRedis();

    // ── Memory info (best-effort; some providers restrict INFO) ────────
    let memory: Record<string, string> = {};
    try {
      const raw = await redis.info("memory");
      for (const line of String(raw).split(/\r?\n/)) {
        const idx = line.indexOf(":");
        if (idx > 0) memory[line.slice(0, idx)] = line.slice(idx + 1).trim();
      }
    } catch {
      memory = { note: "INFO memory unavailable on this provider" };
    }

    // ── Per-key sizes via STRLEN (no value transfer) ───────────────────
    const allKeys = await scanAll(redis, "pm:*");
    const sizes: { key: string; bytes: number }[] = [];
    for (const key of allKeys) {
      let bytes = 0;
      try {
        bytes = await redis.strLen(key);
      } catch {
        bytes = -1; // non-string type (hash/set/etc.) — size unknown here
      }
      sizes.push({ key, bytes });
    }

    // ── Aggregate by prefix bucket ─────────────────────────────────────
    const buckets: Record<string, { count: number; bytes: number }> = {};
    let totalBytes = 0;
    for (const { key, bytes } of sizes) {
      const b = prefixBucket(key);
      if (!buckets[b]) buckets[b] = { count: 0, bytes: 0 };
      buckets[b].count += 1;
      if (bytes > 0) {
        buckets[b].bytes += bytes;
        totalBytes += bytes;
      }
    }
    const byPrefix = Object.entries(buckets)
      .map(([prefix, v]) => ({ prefix, count: v.count, bytes: v.bytes, mb: +(v.bytes / 1e6).toFixed(2) }))
      .sort((a, b) => b.bytes - a.bytes);

    const largestKeys = [...sizes]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 25)
      .map((s) => ({ key: s.key, bytes: s.bytes, mb: +(s.bytes / 1e6).toFixed(2) }));

    const backupKeys = allKeys.filter((k) => k.startsWith("pm:backup:")).sort();

    return NextResponse.json({
      ok: true,
      totalKeys: allKeys.length,
      totalValueBytes: totalBytes,
      totalValueMB: +(totalBytes / 1e6).toFixed(2),
      memory: {
        used_memory_human: memory.used_memory_human,
        maxmemory_human: memory.maxmemory_human,
        maxmemory_policy: memory.maxmemory_policy,
      },
      backupCount: backupKeys.length,
      backupKeys,
      byPrefix,
      largestKeys,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (e) {
    console.error("[redis-usage] diagnostic failed:", e);
    return NextResponse.json(
      { error: "Diagnostic failed", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
