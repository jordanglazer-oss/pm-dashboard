import { getRedis } from "@/app/lib/redis";
import { easternToday } from "@/app/lib/date-eastern";
import type { AgentFlag } from "./flags";

/**
 * The PM's decision on a watcher flag → the decision journal
 * (pm:decision-journal, shape { entries: DecisionEntry[] }, the same store
 * /journal and the monthly review write). APPEND-ONLY read-merge-write:
 * every existing entry and any unknown top-level field is kept.
 *
 * Written when the PM acts on / dismisses a theme-review flag (always — the
 * decision is the point of the conversation) or any other flag WITH a note
 * (a bare dismiss of a routine flag is not a decision worth journalling).
 * The next theme review reads these entries back, so each test of a theme
 * starts from the last decision.
 */
export async function journalFlagDecision(flag: AgentFlag, action: "act" | "dismiss", note?: string): Promise<boolean> {
  const isTheme = flag.watcher === "theme-review";
  if (!isTheme && !note?.trim()) return false;
  const redis = await getRedis();
  const raw = await redis.get("pm:decision-journal");
  let blob: { entries?: unknown[]; [k: string]: unknown } = { entries: [] };
  try {
    blob = raw ? JSON.parse(raw) : { entries: [] };
  } catch {
    return false; // unreadable journal: never overwrite it
  }
  const entries = Array.isArray(blob.entries) ? blob.entries : [];
  const at = new Date().toISOString();
  const themeName = isTheme ? flag.title.split(":")[0] : "";
  entries.push({
    id: `dj_flag_${flag.id.slice(0, 8)}_${Date.now().toString(36)}`,
    date: easternToday(),
    timestamp: at,
    ...(flag.ticker ? { ticker: flag.ticker } : {}),
    action: isTheme ? "hold" : "other",
    rationale: `${isTheme ? `Theme review — ${themeName}` : "Watcher flag"} (${action === "act" ? "acted on" : "dismissed"}): ${flag.title}${note?.trim() ? ` · PM: ${note.trim().slice(0, 600)}` : ""}`,
  });
  await redis.set("pm:decision-journal", JSON.stringify({ ...blob, entries }));
  return true;
}
