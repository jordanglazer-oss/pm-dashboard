# Record: what still runs in the background, and what may need to change

**Started:** Nov 26 2026, during the team-led rebuild. Kept up to date as pages are retired.
**Purpose:** a page leaving the sidebar does not mean its machinery stopped. This lists what is still running or stored, so nothing is forgotten and nothing is switched off by accident.

Rule in force: nothing is deleted and no stored data is changed without a yes from Jordan for that item.

---

## 1. Retired from view, still running

| Item | Where it was | Still running / stored | Who still uses it | To decide later |
|---|---|---|---|---|
| **PIM Scoring** (33-point conviction score, setup grade, rating labels) | Scoring page, stock page, Holdings table | Scores stored on every stock; score history; nightly FactSet inputs; growth bands | Review, Pipeline / Conviction, alert digest, change monitor, devil's advocate (context only), Client Report rating labels, Synthesis | Switch off scoring runs? Remove score columns from kept pages? Stored scores stay as an archive either way |
| **Current Brief** (AI-written morning brief) | "Market Brief" in the sidebar until the roll-up replaces it | Generated on demand; morning note cron (weekdays 6:15 am ET) | Stance watch and hedge window (hedging call), hedging refresh, PM Monthly (outlook inputs), cash deployment log | Keep generating, or move the hedging call to its own job and stop the rest |
| **Thesis desk** (pillars, breakers, AI review) | Thesis tab | All theses, archive, reviews | Portfolio audit, holdings watch, devil's advocate, earnings comparison, themes | Which parts roll into Holdings; whether pillars / breakers stay |
| **Journal** | Journal tab | Appended automatically (review commits, acting on a flag) | PM Monthly | Nothing: it becomes the thesis history on Holdings |
| **Themes** | Themes tab | Themes, bellwether alerts, theme reviews | Theme watcher | Keep or retire the theme watcher |
| **Synthesis** (AI base / bull / bear per name) | Synthesis tab | Stored write-ups | Scoring prompt context | Conflicts with "facts, no opinions": retire the runs? |
| **Pipeline / Conviction / Funnel** | Pipeline tab | Reads scores and lists; stores nothing of its own | Nobody else | Roll list logic into Ideas |
| **Market Research** (ranked lists) | Market Research tab | List history, research sources | Ideas, watchlist alerts | Page retires once the signal grid shows targets, ratings, revisions |
| **Risk** | Risk tab | Cached risk analytics | Nobody else | Roll concentration figures into the Snapshot? |
| **Monitors** | Monitors tab | Nothing of its own | Nobody | Retire once Sentiment and Strategists show the same content |

## 2. Running with no page of their own

| Item | What it does | Status |
|---|---|---|
| Watchers (holdings watch, stance watch, portfolio audit, manager evaluator, devil's advocate, Sunday memo, watchlist alerts) | Monitor and raise flags | Running. Results on the Watchers page ("Other") |
| **Emails** | Notifications | **Paused since Nov 26**, except intraday price alerts, backup alarms and requests you send by button |
| Nightly backup, daily performance update, fund NAV log, weekly health check | Housekeeping | Running. Health check email is paused; the report is still stored |
| Regime engine | One market regime label | Running. Feeds the stance watch and the chip in the top bar |
| Email intake (reports, SIA files, FactSet alerts, strategist notes) | Files what is forwarded | Running. Address changed to `www.dfwdashboard.app` on Nov 26 |

## 3. Boosted.ai: what depends on it (cancelled per the Nov 26 notes)

Nothing has been removed yet. 39 code files mention it. In plain terms:

| Where | What it does there | If removed |
|---|---|---|
| **Inbox page (data setup)** | Two columns in the coverage table (rating, consensus), a "missing" count, CSV and screenshot upload boxes, a line in the subject-line guide | Page change only |
| **Email intake** | Files an emailed Boosted CSV onto each stock | A Boosted email would be ignored |
| **"Request export" button** | Emails you a reminder to send the Boosted CSV | Button option removed |
| **Watchlist export** | Builds the CSV you upload to Boosted | Removed |
| **Setup grade** (0 to 10, technical read) | Boosted is one of four inputs (2 of 10 points) | **Every setup grade changes.** Needs a yes |
| **Stored on each stock** | `boostedAi`, consensus, last-read date, and the `aiRating` score category | Kept as is (archive) |
| **Scoring prompt, score calibration, change monitor, entry conditions, Conviction, Synthesis, stock page tiles** | Show or read the Boosted rating | Mostly on pages already in "Removed" |
| **Caches** (`pm:boosted-ai-scrape-cache`) | Screenshot reads | Safe to drop |

Proposed order when you say go: (1) Inbox page columns and upload boxes, request button, watchlist export; (2) email intake stops accepting it; (3) setup grade, only with a separate yes. Stored values stay.

## 4. Things that may need to change

| Item | Why | Status |
|---|---|---|
| Recorded performance before Nov 24 2026 | Fund returns ignored distributions (Balanced understated about 0.3 to 0.7 pts since April, Growth 0.2 to 0.3) | Not corrected. Needs sign-off |
| Core series vs SIA log | Core reads about 1 pt below the recorded Core series, Apr 13 to Nov 20 | Open, not investigated |
| SIA cost basis vs SIA's own figure | Alphabet: dashboard +106% (Balanced, average cost C$188.44) vs SIA +114% | Open. Need SIA's own average cost and price for the position |
| Fund holdings as-of date | Only our fetch date is stored, not the fund company's as-of date (June 30) | Source pending |
| Put/call ratio | CBOE file is blocked; typed in by hand | Source pending |
| Option prices | Market Data. 15-minute delay starts when the trial becomes paid | Retest after the trial |
| Links in emails | Still point to the old address (it redirects, so they work) | Low priority |
| Market Data credits | About 30 per Hedging refresh of 10,000 a day; 100 a day on the free plan | Watch if the plan changes |
| Email "report request" for new watchlist names | Not sent while emails are paused, and not sent later for those names | Accepted |
| Strategist stance (Positive / Neutral / Negative) | Read from the report by the summary step, with a manual override | Team to review a few for accuracy |
| Signal grid thresholds and metric lists | Placeholders in one settings file | Team to confirm |
