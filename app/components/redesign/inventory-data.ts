/**
 * Section inventory for the team's 4 PM sessions (Nov 2026 rebuild).
 * Compiled by reading every page's code on 2026-11-24. The "suggestion"
 * column is a starting point only — the team decides.
 */

export type Kind = "Fact" | "Rule" | "AI opinion" | "Mixed";
export type Suggestion = "Keep" | "Simplify" | "Move to detail" | "Candidate to cut" | "Merge";

export type Screen = {
  area: "Today" | "Portfolio" | "Ideas" | "Research" | "System";
  name: string;
  href: string;
  shows: string;
  sources: string;
  refresh: string;
  input: "Automatic" | "Manual" | "Both";
  kind: Kind;
  suggestion: Suggestion;
  note: string;
  /** Redesign option page for this screen, when one is built. */
  option?: string;
};

export const SCREENS: Screen[] = [
  // ── Today ──
  { area: "Today", name: "Brief", href: "/brief", shows: "Morning note, bottom line, regime dial, cash and hedging calls, performance, action queue, calendar, market drivers, macro board, sentiment, Fundstrat view", sources: "Yahoo, FRED, FactSet, CNN, AAII, hand-entered breadth, strategist notes, Anthropic AI", refresh: "Brief on demand · morning note weekdays 6:15 am · performance live", input: "Both", kind: "Mixed", suggestion: "Simplify", note: "About 20 sections. The performance table, calendar and market data are facts; the bottom line, regime verdict, cash call, hedging call and narrative are AI opinion.", option: "/redesign/main/a" },
  { area: "Today", name: "Hedging", href: "/hedging", shows: "SPY put prices by expiry and strike, week and month comparisons", sources: "CBOE (currently blocked — shows last saved prices)", refresh: "Live when available", input: "Automatic", kind: "Fact", suggestion: "Keep", note: "No AI on this page. Needs a permitted option-price source before it is live again." },
  { area: "Today", name: "Monitor", href: "/monitor", shows: "Open flags from the AI watchers, holdings moves, stance and hedge window, fund review, devil's advocate, Sunday memo", sources: "AI watchers (Anthropic), rule checks, Yahoo, FactSet alerts", refresh: "Weekday evenings · Sunday memo weekly", input: "Automatic", kind: "Mixed", suggestion: "Simplify", note: "Eleven sections. Rule flags (watch list target reached, portfolio audit) are facts; most others are AI-written." },

  // ── Portfolio ──
  { area: "Portfolio", name: "Holdings", href: "/", shows: "Ranked table of every holding with score, synthesis lean, setup grade, thesis status; sector weights vs S&P 500; funds list", sources: "AI scoring, FactSet, SIA, MarketEdge, BoostedAI, Yahoo", refresh: "On demand", input: "Both", kind: "Mixed", suggestion: "Simplify", note: "Score and synthesis lean are AI opinion. Sector weights and prices are facts." },
  { area: "Portfolio", name: "Stock page", href: "/stock/nvda", shows: "About 20 tiles per name: score by category, thesis and conditions, chart, synthesis, Street alerts, analyst history, contrarian checks, technicals", sources: "Yahoo, FactSet, bank reports, SEC, AI scoring and synthesis", refresh: "On demand · FactSet nightly · alerts by email", input: "Both", kind: "Mixed", suggestion: "Simplify", note: "Facts (price, targets, earnings date, bank ratings) are mixed in with AI write-ups.", option: "/redesign/stock/a" },
  { area: "Portfolio", name: "Positioning", href: "/portfolio", shows: "The live portfolio: each holding's live weight, target and drift; trades and rebalances", sources: "Positions on file × Yahoo prices", refresh: "Live on open", input: "Both", kind: "Fact", suggestion: "Merge", note: "Overlaps with Models. See \"Duplicates\" below.", option: "/redesign/portfolio/a" },
  { area: "Portfolio", name: "Models", href: "/pim-model", shows: "The target weights we enter in Client Link, by model; staging model changes from a screenshot", sources: "Targets set by the team", refresh: "When the team changes it", input: "Manual", kind: "Fact", suggestion: "Merge", note: "Overlaps with Positioning. See \"Duplicates\" below.", option: "/redesign/portfolio/a" },
  { area: "Portfolio", name: "Review", href: "/review", shows: "Monthly meeting table: each name's target, live weight, drift, decision; model undo history; bench", sources: "Models, positions, Yahoo, thesis reviews", refresh: "On open", input: "Both", kind: "Mixed", suggestion: "Move to detail", note: "Used once a month. The thesis verdict column is built on AI reviews." },
  { area: "Portfolio", name: "Performance", href: "/aa-performance", shows: "Model returns vs indices, sleeves vs Core, where returns came from, holdings since purchase, realized gains, asset allocation", sources: "Recorded daily values, Yahoo, trade log", refresh: "Nightly · on open", input: "Automatic", kind: "Fact", suggestion: "Simplify", note: "All facts; several panels are labelled estimates. Long page.", option: "/redesign/performance" },
  { area: "Portfolio", name: "Risk", href: "/risk", shows: "Portfolio volatility, beta, concentration, risk by holding, correlation clusters, stress replays", sources: "One year of Yahoo prices", refresh: "Every 6 hours", input: "Automatic", kind: "Fact", suggestion: "Move to detail", note: "All facts. Not a daily screen." },
  { area: "Portfolio", name: "Thesis", href: "/thesis", shows: "Every holding's thesis, conditions and their status; bulk AI drafting", sources: "Team text, AI drafts and reviews, FactSet results", refresh: "On open · nightly checks", input: "Both", kind: "Mixed", suggestion: "Candidate to cut", note: "The team said the AI-drafted theses are not used. Two options built: rework, or cut.", option: "/redesign/thesis/a" },
  { area: "Portfolio", name: "Themes", href: "/themes", shows: "Investment themes, which holdings belong to each, bellwether companies", sources: "AI drafts signed by the team, FactSet alerts", refresh: "On demand", input: "Both", kind: "Mixed", suggestion: "Candidate to cut", note: "Depends on the Thesis section. Decide together with it." },
  { area: "Portfolio", name: "Funds", href: "/funds", shows: "A client one-pager per fund: why we own it, manager, fees, record", sources: "Morningstar fund data, AI draft signed by the team", refresh: "On demand", input: "Both", kind: "Mixed", suggestion: "Keep", note: "Client-facing output the team asked for. Text is AI-drafted then signed; the performance table is fact." },
  { area: "Portfolio", name: "PM Monthly", href: "/pm-monthly", shows: "The monthly client letter in English and French, with the month's facts beside it", sources: "Recorded performance, trade log, AI draft", refresh: "On demand", input: "Both", kind: "Mixed", suggestion: "Keep", note: "Client-facing output. Draft is AI, edited by the team; no figures in the letter by rule." },
  { area: "Portfolio", name: "Journal", href: "/journal", shows: "Past buy and sell decisions and how each did afterwards vs its sector", sources: "Team entries, Yahoo", refresh: "Every 6 hours", input: "Both", kind: "Fact", suggestion: "Move to detail", note: "Facts. Useful a few times a year." },
  { area: "Portfolio", name: "Client report", href: "/client-report", shows: "A PDF report per model: positioning, allocation, exposures, performance, optional client comparison", sources: "Models, positions, fund holdings, AI highlights", refresh: "Live on open", input: "Both", kind: "Mixed", suggestion: "Keep", note: "Client-facing output. Highlights and recommendations are AI-written." },

  // ── Ideas ──
  { area: "Ideas", name: "Watchlist", href: "/watchlist", shows: "Names we would buy, target buy price, why, and an in/out-of-favour monitor", sources: "Team entries, Yahoo prices", refresh: "On open · alert once a day after the close", input: "Both", kind: "Fact", suggestion: "Simplify", note: "Target price is edited in a pop-out form today, and the alert fires once a month per name.", option: "/redesign/watch/a" },
  { area: "Ideas", name: "Synthesis", href: "/synthesis", shows: "AI base / bull / bear case and a verdict for each name", sources: "Anthropic AI over FactSet, bank reports, research lists", refresh: "On demand", input: "Automatic", kind: "AI opinion", suggestion: "Candidate to cut", note: "Entirely AI opinion (Advance / Watch / Pass)." },
  { area: "Ideas", name: "Pipeline", href: "/funnel", shows: "Where each idea sits: suggested, awaiting synthesis, ready to advance, review queue", sources: "Rules over thesis health and AI synthesis", refresh: "On open", input: "Automatic", kind: "Mixed", suggestion: "Candidate to cut", note: "Depends on Synthesis and Thesis." },
  { area: "Ideas", name: "Conviction board", href: "/conviction", shows: "Ideas ranked by a points total across scores, targets, rankings and lists", sources: "Composite score, FactSet, SIA, BoostedAI, MarketEdge", refresh: "On open", input: "Automatic", kind: "Rule", suggestion: "Candidate to cut", note: "A second ranking on top of the score. Reached from Pipeline." },
  { area: "Ideas", name: "Screener", href: "/screener", shows: "Technical signals for our names; scan of S&P 500 / Nasdaq 100 / TSX 60", sources: "Yahoo prices", refresh: "Nightly · on demand", input: "Automatic", kind: "Rule", suggestion: "Move to detail", note: "Not in the menu today; reached by link." },
  { area: "Ideas", name: "Scoring", href: "/scoring", shows: "Every name's score in one table with a Score all button", sources: "AI scoring, Yahoo", refresh: "On demand", input: "Both", kind: "Mixed", suggestion: "Merge", note: "Repeats the Holdings table." },

  // ── Research ──
  { area: "Research", name: "Ranked research", href: "/research", shows: "Every name on the research lists, ranked by how many lists it is on", sources: "Fundstrat, RBC, JPM, Veritas, Seeking Alpha lists (email and screenshots)", refresh: "When a list arrives", input: "Automatic", kind: "Fact", suggestion: "Keep", note: "Facts: who is on which list. Already a single table." },
  { area: "Research", name: "Research sources", href: "/research/sources", shows: "Each research list in full, sector views, and an AI cross-source summary", sources: "Emails, screenshots read by AI, hand entry", refresh: "When a list arrives", input: "Both", kind: "Mixed", suggestion: "Simplify", note: "Very long page. The lists are facts; the cross-source synthesis is AI opinion." },
  { area: "Research", name: "Inbox", href: "/inbox", shows: "Everything that arrived by email, what it was read as, coverage gaps, manual uploads", sources: "Email ingest", refresh: "Every 15 seconds", input: "Both", kind: "Fact", suggestion: "Keep", note: "This is how anyone on the team submits research: forward it to the inbox address." },

  // ── System ──
  { area: "System", name: "Ask (chat)", href: "/chat", shows: "A chat with the dashboard's data loaded", sources: "Anthropic AI with web search", refresh: "On demand", input: "Manual", kind: "AI opinion", suggestion: "Keep", note: "Only answers when asked." },
  { area: "System", name: "Appendix", href: "/appendix", shows: "Daily values and the trade log behind the performance numbers", sources: "Recorded values, trade log", refresh: "Nightly", input: "Both", kind: "Fact", suggestion: "Move to detail", note: "The audit trail. Rarely opened." },
  { area: "System", name: "Methodology", href: "/methodology", shows: "How scoring works, in plain language; growth-score data; scoring shadow", sources: "Static text, FactSet bands", refresh: "Static", input: "Automatic", kind: "Fact", suggestion: "Simplify", note: "Parts are out of date (see \"Things found that look wrong\")." },
  { area: "System", name: "Health", href: "/admin/health", shows: "Whether each data feed is up", sources: "Live checks of 9 sources", refresh: "Every minute", input: "Automatic", kind: "Fact", suggestion: "Keep", note: "Does not check backups despite its heading." },
];

export const DUPLICATES: { what: string; why: string; proposal: string; option?: string }[] = [
  { what: "Models vs Positioning", why: "Both show the same holdings with a weight beside each. Models = the targets we enter in Client Link. Positioning = where the portfolio sits today. Rob asked why it is in two places.", proposal: "Either merge into one table (Model beside Live, with the drift), or keep two tabs that say plainly what each is.", option: "/redesign/portfolio/a" },
  { what: "Holdings vs Scoring", why: "Two tables of every name with its score.", proposal: "Keep Holdings; fold the Score all button into it." },
  { what: "Synthesis, Pipeline and Conviction board", why: "Three screens that each rank or sort the same ideas, mostly from AI verdicts.", proposal: "Keep at most one, or cut all three in favour of the watch list with target prices." },
  { what: "Thesis page vs the thesis on each stock page", why: "The same text appears in both.", proposal: "Keep it on the stock page only.", option: "/redesign/thesis/b" },
  { what: "Performance tables", why: "Model returns appear on the Brief, on Performance and on PM Monthly.", proposal: "One table on the main screen with a date range; the detail stays on Performance." },
  { what: "Regime label", why: "Shown in the top bar on every page, on the Brief (four places), on Holdings and on Monitor.", proposal: "Remove the label everywhere; show the inputs as facts in one place.", option: "/redesign/market/a" },
];

export const AI_CALLS: { where: string; what: string }[] = [
  { where: "Top bar, every page", what: "Risk-On / Neutral / Risk-Off chip with a 0–100 score" },
  { where: "Brief", what: "Regime dial and label; \"Brief concurs / cautions / diverges\" verdict; bottom line" },
  { where: "Brief", what: "Cash call: Deploy / Partial / Wait, with a score" },
  { where: "Brief", what: "Hedging call: ADD / HOLD / SKIP, with strike and tenor" },
  { where: "Brief › Sentiment", what: "\"Strong Buy … Strong Sell Signal\" label and an AI contrarian take" },
  { where: "Brief › Horizons and Narrative", what: "Tactical / cyclical / structural views, each with a regime chip" },
  { where: "Holdings", what: "\"Engine suggests X — Apply\" (changes how scores are adjusted)" },
  { where: "Holdings and stock page", what: "Synthesis lean Bull / Neutral / Bear; Buy / Hold / Sell rating from the score" },
  { where: "Synthesis", what: "Advance / Watch / Pass and Thesis intact / Review / Exit watch" },
  { where: "Monitor", what: "Devil's advocate: would buy today / hold / would not buy today" },
  { where: "Client report", what: "Strengths, risks and action items for a client portfolio" },
];

export const MANUAL_INPUTS: { what: string; where: string; note: string }[] = [
  { what: "% of S&P 500 above 200-day and 50-day averages", where: "Brief › Daily input", note: "From Barchart" },
  { what: "% of broad market above 200-day and 50-day averages", where: "Brief › Daily input", note: "From Barchart" },
  { what: "NYSE new highs, new lows, up and down volume", where: "Brief › Daily input", note: "From Barchart" },
  { what: "S&P Oscillator", where: "Brief › Daily input", note: "MarketEdge needs a login" },
  { what: "Put/call ratio", where: "Brief › Daily input", note: "The automatic source is blocked, so in practice typed in" },
  { what: "Newton and Lee notes", where: "Brief › Daily input, or by email", note: "Usually arrive by email now" },
  { what: "Hedges we actually put on", where: "Brief › Hedging cell", note: "A log, not a daily input" },
  { what: "Monthly cash installments", where: "Brief › Cash cell", note: "A log, not a daily input" },
  { what: "Watch list target buy prices", where: "Watchlist", note: "Set by the team" },
];

export const AUTO_FETCHED_NOTE = "CNN Fear & Greed and the AAII survey are fetched automatically today — they are not typed in. What went stale last week was the hand-entered breadth numbers, the oscillator and the put/call ratio.";

export const EMAILS: { name: string; when: string; note: string }[] = [
  { name: "End-of-day portfolio audit", when: "Every weekday about 5 pm — always sent, even with nothing new", note: "Could skip quiet days" },
  { name: "Portfolio flag", when: "Immediately, whenever a watcher raises a high flag — up to 8 a day", note: "Could fold into the end-of-day email" },
  { name: "Intraday move", when: "Hourly in market hours when a holding falls 4% or rises 5%, crosses its 200-day average, or VIX jumps", note: "Several a day are possible" },
  { name: "Daily alert digest", when: "About 1 am on trading days, only when something is high priority", note: "Overlaps with the end-of-day email" },
  { name: "Sunday memo", when: "Sundays about 5 pm", note: "AI-written weekly summary" },
  { name: "Weekly health report", when: "Mondays about 7 am — always sent", note: "System status only" },
  { name: "Devil's advocate ready", when: "Once a month", note: "" },
  { name: "Backup failed / overdue", when: "Only when a backup fails or is late", note: "Keep" },
];

export const FOUND_WRONG: string[] = [
  "Brief › Narrative shows a \"Composite Signal\" (Bearish · High) that nothing updates — it is a leftover default, and it is also fed to the AI brief.",
  "Brief › Daily input shows an AAII tile badged \"Live\" that reads fixed leftover numbers (30 / 17 / 52). The Sentiment tab uses the real live figures.",
  "Hedging and the put/call ratio: the CBOE source is blocked, so option prices are the last saved ones and put/call is typed in.",
  "Methodology describes a factor screen that was retired, says AI does not monitor positions (it now does), and says backups are kept 14 days (it is 30).",
  "Health says it checks backups but does not; backup status is only in the System dot and the Monday email.",
  "The notification bell only shows messages from this browser. Watch list alerts and watcher flags never reach it.",
  "The watch list alert runs once a day after the close and fires once a month per name, so a name that touches its target intraday can be missed.",
  "The Manager Evaluator exists (Monitor, collapsed) but only reviews funds we already own — the wider search of Canadian funds vs the S&P 500 is not built.",
];

export const SCHEDULE: { day: string; topic: string; bring: string; links: { label: string; href: string }[] }[] = [
  { day: "Tue Nov 24", topic: "Main screen and market facts", bring: "Pick a main-screen layout. Agree which facts are \"key\". Confirm removing the regime label.", links: [{ label: "Main screen options", href: "/redesign/main/a" }, { label: "Market facts options", href: "/redesign/market/a" }, { label: "Manual inputs", href: "/redesign/manual-inputs" }] },
  { day: "Wed Nov 25", topic: "Watch list and the stock page", bring: "Pick a watch list layout. Start typing target prices. Decide what stays visible on a stock page.", links: [{ label: "Watch list options", href: "/redesign/watch/a" }, { label: "Stock page options", href: "/redesign/stock/a" }] },
  { day: "Thu Nov 26", topic: "Portfolio: Models vs Positioning, and Performance", bring: "Merge or keep separate. Which performance periods matter.", links: [{ label: "Portfolio options", href: "/redesign/portfolio/a" }, { label: "Performance", href: "/redesign/performance" }] },
  { day: "Fri Nov 27", topic: "Thesis, the Ideas screens, and notifications", bring: "Thesis: rework or cut. Which of Synthesis / Pipeline / Conviction survive. Which emails to stop.", links: [{ label: "Thesis options", href: "/redesign/thesis/a" }, { label: "This inventory", href: "/redesign/inventory" }] },
  { day: "Following week", topic: "Currency impact, Manager Evaluator, PM Monthly and fund one-pagers", bring: "These exist in some form; review against what the plan asks for.", links: [] },
];
