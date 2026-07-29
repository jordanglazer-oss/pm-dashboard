"use client";

import React from "react";
import Link from "next/link";

/**
 * /methodology — plain-language reference for how the selection & discipline
 * stack fits together (boss-readable, no jargon). Static content, no data
 * fetches, nothing to go stale except the prose — update it when the process
 * genuinely changes, not per release.
 */

function Sect({ n, title, children }: { n?: string; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-white p-5 shadow-sm">
      <h2 className="flex items-baseline gap-2 text-sm font-semibold text-ink">
        {n && <span className="font-mono text-xs text-ink-3">{n}</span>}
        {title}
      </h2>
      <div className="mt-2 space-y-2 text-[13.5px] leading-6 text-ink-2">{children}</div>
    </section>
  );
}

export default function MethodologyPage() {
  return (
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-ink md:px-8 md:py-8">
      <div className="mx-auto max-w-3xl space-y-4">
        <div>
          <h1 className="text-[17px] font-semibold tracking-[-0.02em]">How the process works</h1>
          <p className="text-xs text-ink-3">
            the selection &amp; discipline stack, in plain language — for anyone reviewing how decisions get made here
          </p>
        </div>

        <Sect title="The one-paragraph version">
          <p>
            Stock <b>selection</b> is scored; portfolio <b>discipline</b> is pre-registered and measured.
            A 41-point fundamental score answers &ldquo;is this a good stock.&rdquo; A separate quantitative
            factor screen gives an independent second opinion. When a position is taken, the manager writes
            the thesis down <i>with the conditions that would prove it wrong</i> — and software watches those
            conditions daily and grades every decision against its sector afterward. AI assists at exactly two
            points; it never scores mechanically alone, never edits a thesis, and never trades.
          </p>
        </Sect>

        <Sect n="1" title="Scoring — the primary verdict (41-point composite)">
          <p>
            Every name is scored across seven categories — fundamentals, valuation, technicals, analyst
            revisions, ownership, external research, market regime fit — using FactSet as the primary data
            source, verified against public filings. Scores are re-run on material events (earnings, guidance,
            rating changes), not on a calendar, and every change is logged to an append-only history so score
            drift is visible over time.
          </p>
          <p className="text-ink-3">
            Where you see it: the Rankings table and each stock page. The score is the house view of the stock.
          </p>
        </Sect>

        <Sect n="2" title="Factor screen — the independent second opinion">
          <p>
            In parallel, a purely quantitative screen ranks the universe on a small set of factors with
            long-run academic support (valuation vs sector, quality, momentum, estimate-revision momentum),
            computed sector-neutrally with no human judgment. It deliberately is <b>not</b> blended into the
            41-point score: when the two disagree, that disagreement is the information. The screen&rsquo;s own
            predictive power is validated against forward returns before it earns any formal weight.
          </p>
          <p className="text-ink-3">
            Where you see it: <Link href="/factor-lab" className="text-accent hover:underline">Factor Lab</Link>,
            including the side-by-side comparison against the 41-point score.
          </p>
        </Sect>

        <Sect n="3" title="Underwriting — the thesis is written down, falsifiably">
          <p>
            When a position is held with conviction, the manager underwrites it on the stock page: the thesis
            in plain language (&ldquo;buying because X, expecting Y, wrong if K&rdquo;) plus 2&ndash;4{" "}
            <b>kill conditions</b> — specific, numeric exit criteria chosen from tracked data, e.g.
            &ldquo;composite score stays above 22,&rdquo; &ldquo;analyst estimate revisions stay
            non-negative,&rdquo; &ldquo;price holds its 200-day average.&rdquo; The underwrite date and price
            are stamped, and a 90-day re-underwrite clock starts.
          </p>
          <p>
            This is <b>pre-registration</b>: the conditions are committed before they can trip, so hindsight
            cannot soften them. They are stored append-safely and are not editable by any automated process.
          </p>
        </Sect>

        <Sect n="4" title="Watching — software checks the conditions; no AI involved">
          <p>
            Every kill condition is checked by deterministic code against data the dashboard already tracks —
            daily, at zero marginal cost. A condition the data cannot currently answer shows{" "}
            <b>NO&nbsp;DATA</b> rather than silently passing. When a condition breaks, it is marked{" "}
            <b>TRIPPED</b> with the date, a high-priority alert appears in the daily alert digest and morning
            email, and the portfolio page badges the name.
          </p>
        </Sect>

        <Sect n="5" title="The trip response — AI comments once; the manager decides">
          <p>
            On a trip, one AI assessment can be generated: does the tripped condition actually hit the thesis
            as written, or is it noise near it? It returns a verdict (direct hit / partial / noise), the bear
            case as it now stands, what would restore the thesis, and a suggested next step. It is instructed
            never to recommend an automatic trade, it cannot modify the thesis, and identical facts are served
            from cache — the assessment re-runs only when the facts change.
          </p>
          <p>
            The manager then responds — <b>Acknowledge&nbsp;&amp;&nbsp;hold</b> or{" "}
            <b>Flag&nbsp;trim/exit</b> — and that response is logged automatically with the score, revisions,
            and price frozen at that moment.
          </p>
        </Sect>

        <Sect n="6" title="Attribution — every decision is graded against its sector">
          <p>
            The <Link href="/journal" className="text-accent hover:underline">Decision Journal</Link> measures
            each logged decision 1 and 3 months later against the name&rsquo;s sector ETF. Buys that
            outperformed their sector were right; trims where the name then underperformed were right. Hit
            rates count <b>completed windows only</b> — pending windows show &ldquo;so far&rdquo; and are
            excluded — and small samples are labelled as such. Entries that cannot be measured are listed with
            the reason rather than dropped.
          </p>
          <p>
            Over time this answers the question no scoring system can: not &ldquo;were the scores right&rdquo;
            but <b>&ldquo;were the decisions right&rdquo;</b> — and it is the evidence that will decide how
            much weight the fundamental score versus the factor screen each ultimately deserve.
          </p>
        </Sect>

        <Sect title="Where AI is — and is not — in the loop">
          <p>
            AI is used at two points only: writing the research narrative behind a score (with every data
            point source-verified), and the one-time trip assessment above. AI does <b>not</b> monitor
            positions (code does), does not edit theses, does not size positions, and cannot execute or
            recommend automatic trades. All monitoring runs at zero standing AI cost by design.
          </p>
        </Sect>

        <Sect title="Data sources &amp; refresh cadence">
          <p>
            <b>41-point score:</b> FactSet is the primary source for fundamentals, estimates and sector
            classification (via a dedicated relay); figures are verified against public filings during each
            scoring run, with the source of every data point stored in an audit trail. Prices and technicals
            come from Yahoo Finance; insider activity from SEC filings (US listings). Scores refresh on
            material events — earnings, guidance, rating changes — not on a fixed clock.
          </p>
          <p>
            <b>Factor screen:</b> two moving parts, both fully deterministic code.
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <b>The measuring stick (universe):</b> roughly the S&amp;P 500 plus the S&amp;P/TSX 60 —
              ~560 names — with raw fundamentals pulled from the FactSet Formula API. Rebuilt <b>weekly</b>
              (Sundays, in resumable chunks), because the distributions it provides shift slowly.
            </li>
            <li>
              <b>The book&rsquo;s scores:</b> every Portfolio and Watchlist name is re-scored{" "}
              <b>nightly</b> in the overnight batch (~2 batched FactSet calls for the whole book). Each
              metric is compared against its GICS sector&rsquo;s distribution within the universe —
              winsorized, sign-normalized so higher is always better, missing metrics dropped from both
              sides rather than counted as bearish — then rolled into four groups (quality 30%, momentum
              30%, growth 20%, valuation 20%) and mapped to the 0&ndash;100 percentile shown in Factor
              Lab, with a confidence figure reflecting data coverage. Each night&rsquo;s result is also
              appended to an immutable history, which is what the validation work measures against.
            </li>
          </ul>
          <p>
            <b>Calibration:</b> the Rankings page&rsquo;s calibration panel joins the score history to
            realized forward returns (benchmark-relative) and reports, per rating tier and per category,
            whether higher scores actually preceded higher returns — including a category-overlap matrix
            that flags when two categories are effectively the same signal counted twice. Sample sizes are
            shown everywhere; thin cells are marked rather than smoothed over.
          </p>
        </Sect>

        <Sect title="Data integrity">
          <p>
            Theses, kill conditions, and the decision journal are stored server-side in Redis with
            read-merge-write semantics (a save can never clobber another field), the journal and score history
            are append-only, and every store above is captured by the nightly full-database backup with 14-day
            retention. AI assessments and attribution results are regenerable caches — losing one costs a
            recomputation, never data.
          </p>
        </Sect>
      </div>
    </main>
  );
}
