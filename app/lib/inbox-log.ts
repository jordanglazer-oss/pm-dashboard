/**
 * Audit log for the Gmail inbox ingestion webhook. Bounded circular buffer
 * of the most recent N events so the user (and we) can see what's been
 * ingested, what failed, and why.
 *
 * Pure debug surface — not feed into scoring or any business logic. Safe
 * to nuke pm:inbox-log without data loss.
 */

import { getRedis } from "./redis";

const KEY = "pm:inbox-log";
const MAX_ENTRIES = 100;

export type InboxEventStatus = "success" | "skipped" | "error";

export type InboxEvent = {
  id: string;
  receivedAt: string;
  status: InboxEventStatus;
  /** Email subject line as received from the script. */
  subject?: string;
  /** Email sender "Name <addr@example.com>" as received. */
  sender?: string;
  /** Parsed ticker (canonical form) if subject parsed successfully. */
  ticker?: string;
  /** Parsed source if subject parsed successfully. */
  source?: "rbc" | "jpm";
  /** Attached PDF filename, if any. */
  filename?: string;
  /** PDF size in bytes, if available. */
  size?: number;
  /** Whether the extraction came from the hash-gated cache (free). */
  cached?: boolean;
  /** Human-readable status message. */
  message: string;
  /** SHA-256 of the dataUrl, for cross-reference with the extract cache. */
  hash?: string;
};

export async function appendInboxEvent(event: Omit<InboxEvent, "id" | "receivedAt"> & { id?: string; receivedAt?: string }) {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    const log: InboxEvent[] = raw ? JSON.parse(raw) : [];
    const entry: InboxEvent = {
      id: event.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      receivedAt: event.receivedAt ?? new Date().toISOString(),
      ...event,
    };
    log.unshift(entry);
    if (log.length > MAX_ENTRIES) log.length = MAX_ENTRIES;
    await redis.set(KEY, JSON.stringify(log));
  } catch (e) {
    console.error("Failed to write inbox-log:", e);
  }
}

export async function readInboxLog(): Promise<InboxEvent[]> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return [];
    const log: InboxEvent[] = JSON.parse(raw);
    return Array.isArray(log) ? log : [];
  } catch {
    return [];
  }
}
