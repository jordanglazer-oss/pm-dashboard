/**
 * The watchers — every AI agent that runs on the AGENTS key
 * (ANTHROPIC_AGENTS_API_KEY, its own Anthropic workspace with a $100 limit).
 * Watchers monitor and suggest; they never trade, change weights or change
 * scores. Every existing dashboard AI feature stays on the main key.
 *
 * `defaultModel` is the plan's choice; the PM can change any watcher's model
 * (pm:agent-settings) without a deploy. `shadow` = run a second model side by
 * side for the comparison period so the cheaper model can be judged against
 * the stronger one before it is trusted alone.
 */

export type AgentModelTier = "haiku" | "sonnet";

export const AGENT_MODEL_IDS: Record<AgentModelTier, string> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
};

export type WatcherDef = {
  id: string;
  label: string;
  /** Build phase in the agents plan (docs: Proactive Agents for the PM Dashboard). */
  phase: number;
  defaultModel: AgentModelTier;
  shadow?: AgentModelTier;
  /** Last day (YYYY-MM-DD, inclusive) the shadow model runs. After it only the
   *  watcher's own model runs — the comparison period is over. */
  shadowUntil?: string;
  what: string;
};

export const WATCHERS: WatcherDef[] = [
  { id: "earnings-compare", label: "Earnings comparison", phase: 1, defaultModel: "haiku", shadow: "sonnet", shadowUntil: "2026-11-30", what: "Compares a FactSet results recap with the preview that came before it" },
  { id: "triage", label: "Triage", phase: 3, defaultModel: "haiku", what: "Decides whether a holding's move is the market, the sector, or the company" },
  { id: "fact-check", label: "Fact-checker", phase: 3, defaultModel: "haiku", what: "Checks each finding against its source before it is flagged" },
  { id: "reconcile", label: "Reconcile", phase: 3, defaultModel: "haiku", what: "Squares a provisional finding with the FactSet alert once it arrives" },
  { id: "holdings-investigate", label: "Holdings investigation", phase: 3, defaultModel: "sonnet", what: "Looks into a company-specific move against the thesis" },
  { id: "thesis-review", label: "Thesis review", phase: 3, defaultModel: "sonnet", what: "Quarterly long-term thesis review per holding" },
  { id: "hedge-window", label: "Hedge window", phase: 4, defaultModel: "haiku", what: "After the close: is protection cheap and sentiment calm enough to hedge" },
  { id: "manager-watch", label: "Manager watch", phase: 4, defaultModel: "haiku", what: "Watches the thematic funds' managers and their record" },
  { id: "theme-detect", label: "Theme detection", phase: 5, defaultModel: "haiku", what: "Spots which theme a market move belongs to" },
  { id: "theme-review", label: "Theme review", phase: 5, defaultModel: "sonnet", what: "Reviews a theme and our exposure to it after a large move" },
  { id: "sunday-memo", label: "Sunday memo", phase: 5, defaultModel: "sonnet", what: "The weekly memo on the book, the stance and open threads" },
  { id: "watchlist-watch", label: "Watchlist watch", phase: 6, defaultModel: "haiku", shadow: "sonnet", what: "Flags watchlist names whose long-term case has strengthened, with a buy case" },
];

export const WATCHER_IDS = new Set(WATCHERS.map((w) => w.id));

export function watcherDef(id: string): WatcherDef | undefined {
  return WATCHERS.find((w) => w.id === id);
}
