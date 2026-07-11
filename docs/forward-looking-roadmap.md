# Forward-Looking Dashboard — Build Roadmap

> Living plan to shift the Brief and the wider site from **reporting the present**
> toward **guiding future decisions** — with every new piece of data persisted
> safely to Redis / Blob so nothing is lost across refreshes, devices, or time.
>
> Branch: `redesign/precision-light` · additive-only · 10 phases.
> Interactive version: Claude artifact "Forward-Looking Dashboard — Build Roadmap".

## The shift

| Today — a dashboard | Goal — a guide |
| --- | --- |
| You go to it and read the current state (regime, credit, breadth, what already moved). Accurate but rear-view. It waits for you. | It knows what's coming, remembers what you believe and whether it's holding, tells you what you're missing, and comes to you when it matters. |

## Non-negotiables — carried into every phase

1. **Persist, never lose.** Every seeded or generated output round-trips through `/api/kv/*` to Redis — never browser-only — so it survives refresh **and** syncs across devices. Read-modify-write with a spread; GET returns empty on a missing key, never seeds defaults.
2. **History is append-only.** Anything that evolves over time (thesis health, decisions) copies the `pm:score-history` pattern: keyed by date, past-dated writes rejected (400). Past states are immutable.
3. **Two writers, two keys.** Where a human and the automation both write (the thesis "why" vs. the auto verdict), they live in **separate keys** so neither can clobber the other. Joined at read time.
4. **In the backup set.** New irreplaceable user data must **not** land in the backup `EXCLUDE_PATTERNS` — it's captured in the nightly Blob backup like `pm:stocks`.
5. **Automate to the floor.** Every feature is fully functional with zero typing. Human input is optional enrichment, never a required field.
6. **Additive & verified.** Nothing disturbs existing Brief sections, scores, or positions. `tsc` + lint before every commit, the written Redis-safety checklist per commit, and **push after every commit**.

## The phases

| # | Phase | Blast | Gist |
| --- | --- | --- | --- |
| 00 | Foundations & persistence scaffolding | Low | Append-only KV helper, key registry, backup-inclusion — set the safety pattern before any feature writes. |
| 01 | **Catalyst Calendar** (Brief unlock) | Low | Feed the Brief upcoming econ releases + earnings dates for your names → new lead section "the next 10 trading days and how this book is exposed." Fixes the Brief's line-160 punt on the future. |
| 02 | Regime-Transition Engine | Low | Model the probability of the regime *flipping* (~30d) from signals already computed; surface the early tells. Input to Phase 05. |
| 03 | Living Thesis Tracker | Med | Per-position intact/eroding/broken verdicts (auto), macro thesis ledger (auto-promoted from Brief horizons), optional one-tap "why". The memory layer. |
| 04 | **Performance Attribution** | Med | Portfolio tab: decompose returns into market/beta · allocation · selection · currency · (factor, later). Turns a number into a diagnosis. |
| 05 | Forward-Looking Scoring Blend | **High** | Blend the regime we're heading *into* (weighted by transition prob) into `regimeMultiplier()`. Gated: before/after sample scores shown first, no auto-rescore. Depends on Phase 02. |
| 06 | Extend the existing Chat | Low | Not a new build — teach the existing data-grounded Chat about the new data + add live retrieval. Near-free upgrade. |
| 07 | Proactive Push | Med | Pre-market anomaly scan, intraday trips, EOD wrap. In-app first, **automated email** as a config flip (same cron, no manual send). |
| 08 | Decision Journal | Med | Capture the *why* on each action; close the loop against outcomes with confidence calibration. |
| 09 | **Pipeline** (candidate conviction) | Low–Med | Upgrade the Conviction tab → renamed **Pipeline**. Flag not-yet-owned names as forward-ranked potential adds vs. holds (own/don't-own swap lens, equal-weight — never sizing). Wires in FactSet revisions/targets + RBC/JPM snapshots. |

### Sequencing logic

Foundations set the safety pattern. The **Catalyst Calendar** is the fastest, highest-payoff win. The **Regime-Transition Engine** comes next because it's the input that makes **Forward Scoring** possible — and forward scoring is fenced off as the one high-risk change, shown to you before it touches a single score. The **Thesis Tracker** establishes the memory the **Chat** and **Push** layers surface. **Pipeline** is the capstone — it depends on the forward-view inputs (01–03) and realizes the "what you're missing" idea offensively.

## New Redis key registry

All new keys are `pm:*`. **BU** = must be in the nightly Blob backup (irreplaceable user data — keep OUT of `EXCLUDE_PATTERNS`). **Cache** = regenerable, safe to nuke, may be excluded from backup.

| Key | Phase | Type | Notes |
| --- | --- | --- | --- |
| `pm:catalyst-calendar` | 01 | Cache | Econ + earnings calendar. Rebuilds on refresh. |
| `pm:regime-transition` | 02 | Cache | Transition-probability snapshot, like `pm:market-regime`. |
| `pm:position-theses` | 03 | **BU** | Human-seeded "why" per ticker. Irreplaceable. |
| `pm:thesis-health` | 03 | Cache | Auto verdict per ticker (separate key from the seed — two-writer rule). |
| `pm:thesis-history` | 03 | **BU** | Append-only verdict evolution (date-guarded). |
| `pm:market-theses` | 03 | **BU** | Macro thesis ledger. |
| `pm:attribution-cache` | 04 | Cache | Recomputed attribution result. |
| `pm:attribution-history` | 04 | **BU** | Append-only period snapshots for trend. |
| `pm:decision-journal` | 08 | **BU** | Append-only decisions + rationale + outcomes. |
| `pm:candidate-conviction` | 09 | Cache | Cached forward-ranked candidate list. |

> When adding any of these, update `EXCLUDE_PATTERNS` in the backup route so **BU** keys are captured and **Cache** keys may be skipped — and verify a fresh backup via `/api/admin/list-backups` after the first write.

## FactSet status (affects Phases 01 & 09)

- **Revisions available:** `getFactsetEstimatesByTicker` pulls `revUp`/`revDown` (FY+1 EPS analyst up/down counts), mean price target, analyst count — formulas confirmed working June 2026.
- **Forward estimate *values*** (mean EPS/revenue for future years) are not currently requested but are the same `FE_ESTIMATE` family — a one-line addition.
- **Gate:** all FactSet calls no-op until `FACTSET_RELAY_URL` + `FACTSET_RELAY_SECRET` are set (static-IP relay live on Vercel). FactSet-fed pieces are built behind `factsetConfigured()` so they activate automatically when the relay is deployed.

## Today's execution order

1. **Phase 00** — persistence scaffolding (`app/lib/append-only-kv.ts` + this registry).
2. **Phase 01** — Catalyst Calendar (free econ + earnings sources; Brief lead section).
3. **Phase 02** — Regime-Transition Engine.
4. **Phase 04** — Performance Attribution (allocation/selection/currency; factor later).
5. **Phase 03** — Living Thesis Tracker (auto-first).
6. **Phase 09** — Pipeline (non-FactSet parts live now; FactSet parts behind the guard).
7. **Phase 06 / 07 / 08** — Chat extension, Push (in-app + email-ready), Decision Journal.
8. **Phase 05** — Forward Scoring Blend — **built last, before/after review with the user before any rescore.**

Nothing mutates production data until each phase's Redis-safety checklist is walked in writing.
