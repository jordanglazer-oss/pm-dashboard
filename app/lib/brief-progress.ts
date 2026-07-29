import { getRedis } from "./redis";
import { BRIEF_PROGRESS_KEY, type BriefProgress } from "./brief-progress-shared";

export { BRIEF_PROGRESS_KEY, BRIEF_STEPS, type BriefProgress } from "./brief-progress-shared";

/**
 * Brief-generation progress — REAL phase completions, not theatre.
 *
 * The generation modal used to show a static step list with an honesty note:
 * the route returned one JSON blob, the phases ran inside a single
 * Promise.all, and ticking steps on a timer would have invented a progress
 * signal that didn't exist. This is the promised follow-through: the route
 * marks each phase the moment its promise actually resolves (they run
 * CONCURRENTLY, so steps complete in whatever order the upstreams answer —
 * the modal reflects that truthfully rather than pretending a sequence), and
 * the client polls the tiny progress blob while the modal is open.
 *
 * pm:brief-progress — ephemeral, regenerable, one generation at a time
 * (single-user app). The runId guards against a stale blob from a previous
 * run being read as current. Marks accumulate in a per-invocation closure and
 * each write persists the full set, so concurrent same-run writes can only
 * ever differ by which just-finished step they include — last write wins
 * harmlessly and no read-modify-write race can drop a mark.
 */




/** Per-invocation progress writer. Fire-and-forget: progress is cosmetic and
 *  must never fail or slow the brief itself. */
export function createProgressWriter(runId: string | undefined) {
  const doneKeys: string[] = [];
  const startedAt = new Date().toISOString();
  const write = (finished = false) => {
    if (!runId) return; // old clients send no runId — feature simply inert
    const blob: BriefProgress = {
      runId,
      startedAt,
      done: [...doneKeys],
      ...(finished ? { finishedAt: new Date().toISOString() } : {}),
    };
    getRedis()
      .then((r) => r.set(BRIEF_PROGRESS_KEY, JSON.stringify(blob)))
      .catch(() => {});
  };
  write(); // announce the run so the modal stops showing a stale blob
  return {
    /** Wrap a phase promise: marks the step when it settles (success OR
     *  failure — a failed best-effort fetch still ENDS the phase). */
    track<T>(key: string, p: Promise<T>): Promise<T> {
      const mark = () => {
        if (!doneKeys.includes(key)) doneKeys.push(key);
        write();
      };
      p.then(mark, mark);
      return p;
    },
    mark(key: string) {
      if (!doneKeys.includes(key)) doneKeys.push(key);
      write();
    },
    finish() {
      write(true);
    },
  };
}
