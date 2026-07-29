/**
 * Client-safe half of the brief-progress contract: the step list the modal
 * renders and the blob shape it polls. NO server imports here — the modal is
 * a client component, and importing the redis client from it drags Node
 * built-ins (dns/promises) into the browser bundle and fails the build.
 * The server-side writer lives in brief-progress.ts.
 */

export const BRIEF_PROGRESS_KEY = "pm:brief-progress";

/** The phases the route ACTUALLY runs, in display order. Keys are marked by
 *  the route; labels render in the modal. Keep in sync with the POST handler. */
export const BRIEF_STEPS: { key: string; label: string }[] = [
  { key: "prices", label: "Refresh prices & sector tape" },
  { key: "macro", label: "Fetch forward-looking macro & breadth" },
  { key: "regime", label: "Read market regime" },
  { key: "research", label: "Load research & strategist notes" },
  { key: "hedging", label: "Price the SPY put ladder" },
  { key: "catalyst", label: "Build the catalyst calendar" },
  { key: "narrative", label: "Compose the narrative" },
];

export type BriefProgress = {
  runId: string;
  startedAt: string;
  done: string[]; // step keys, in completion order
  finishedAt?: string;
};
