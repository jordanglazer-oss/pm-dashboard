"use client";

import React from "react";
import Link from "next/link";
import { GrowthBandsTable } from "@/app/components/GrowthBandsTable";

/**
 * /methodology — plain-language reference for how the selection & discipline
 * stack fits together (boss-readable, no jargon). Static prose plus ONE live,
 * read-only table (the calibrated growth bands); nothing else to go stale except the prose — update it when the process
 * genuinely changes, not per release.
 */

function Sect({ n, title, children }: { n?: string; title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-h">
        {n && <span className="font-mono text-[11px] text-ink-3">{n.padStart(2, "0")}</span>}
        <span className="t">{title}</span>
      </div>
      <div className="flex max-w-[76ch] flex-col gap-2 px-3.5 py-3 text-[13px] leading-[1.55] text-ink-2 [&_b]:font-medium [&_b]:text-ink [&_a]:text-accent [&_a:hover]:underline">
        {children}
      </div>
    </section>
  );
}

export default function MethodologyPage() {
  return (
    <main className="text-ink">
      <div className="flex flex-col gap-3.5">
        <p className="text-[11.5px] text-ink-3">
          The selection &amp; discipline stack, in plain language — for anyone reviewing how decisions get made here.
        </p>

        <Sect title="The one-paragraph version">
          <p>
            Stock <b>selection</b> is scored; portfolio <b>discipline</b> is pre-registered and measured.
            A 33-point conviction score answers &ldquo;is this a business worth owning&rdquo;; a separate
            0&ndash;10 setup grade, built from the technical inputs, answers &ldquo;is now the time.&rdquo; The
            two are read side by side, never blended. A separate quantitative factor screen gives an independent
            second opinion. When a position is taken, the manager writes
            the thesis down <i>with the conditions that would prove it wrong</i> — and software watches those
            conditions daily and grades every decision against its sector afterward. AI assists at exactly two
            points; it never scores mechanically alone, never edits a thesis, and never trades.
          </p>
        </Sect>

        <Sect n="1" title="Scoring — the primary verdict (33-point conviction score + setup grade)">
          <p>
            Every name&rsquo;s conviction score is built from five groups &mdash; long-term franchise, research
            (analyst consensus and list mentions), fundamentals (forward growth, returns and margins, relative
            and historical valuation, leverage, cash-flow quality), company-specific factors and management
            &mdash; using FactSet as the primary data source, verified against public filings. Technicals
            (SIA relative strength, BoostedAI, MarketEdge, trend and the manager&rsquo;s own chart read) are
            deliberately kept out of that number: they are price-derived and fast-moving, so they form a
            separate setup grade that times entries and exits without moving the verdict on the business. Scores are re-run on material events (earnings, guidance,
            rating changes), not on a calendar, and every change is logged to an append-only history so score
            drift is visible over time.
          </p>
          <p className="text-ink-3">
            Where you see it: the Rankings table and each stock page. The score is the house view of the stock.
          </p>
        </Sect>

        <section id="growth-score" className="scroll-mt-4">
        <Sect title="How the growth score is calculated (shown on every stock page)">
          <p>
            Growth is the one fundamental category the app <b>computes</b> rather than asks the AI to judge. Four
            numbers are pulled from FactSet for the company: <b>forward sales growth</b> and <b>forward earnings
            growth</b> (what analysts expect over the next twelve months against the last twelve), the
            analysts&rsquo; <b>three-to-five-year growth estimate</b>, and <b>delivered growth</b> over the last three
            years. Each is ranked against the company&rsquo;s own kind of business &mdash; a bank against banks, a
            semiconductor maker against semiconductor makers &mdash; using the S&amp;P 500 and TSX 60 as the peer pool.
          </p>
          <p>
            The four rankings are blended (30% forward sales, 30% forward earnings, 20% long-term estimate, 20%
            delivered). A blend in the bottom fifth of the group scores 0, below the middle scores 1, and above
            the middle scores 2. The top mark of 3 is deliberately hard to get: the blend must be in the top 15%
            of the group, <b>no single measure may be below the group&rsquo;s middle</b>, and forward growth must be at
            least 5% in absolute terms &mdash; being the fastest grower in a no-growth industry is not an outstanding
            growth story. Shrinking sales score 0 outright.
          </p>
          <p>
            Then one automatic adjustment: if analysts have raised next year&rsquo;s earnings estimate by more than 3%
            in three months the score moves up one; if they have cut it by more than 3% it moves down one. An upward revision can only produce the top mark of 3 when the growth is broad-based (no measure below the group&rsquo;s middle) and clears the 5% floor. Finally
            the AI may move the result by <b>at most one point</b>, and only for a stated reason from a short list:
            growth flattered by a one-off, peak-cycle earnings, growth bought through acquisition, or a disclosed
            event analysts have not yet absorbed. Anything further is rejected by the app.
          </p>
          <p>
            Where a measure does not mean anything for a business it is left out and the others carry more weight
            &mdash; revenue for a bank (book value growth is used for delivered growth instead), accounting earnings
            for a real-estate trust. With fewer than two usable measures no score is given: growth is marked as a
            data gap and left out of the total rather than guessed. One limit to keep in mind: the peer pool is
            large companies, so a smaller holding is being ranked against large-cap peers.
          </p>
          <p className="text-ink-3">
            Where you see it: open the Growth row on any stock page and choose &ldquo;Show the math&rdquo; &mdash; every
            figure, ranking, test and adjustment behind that company&rsquo;s score is listed, enough to redo it by hand.
            Each rescore also saves that working with the score history.
          </p>
          <GrowthBandsTable />
        </Sect>
        </section>

        <Sect title="How the cash-deployment call is decided (Brief)">
          <p>
            New client cash is deployed in monthly installments between the 1st and the 20th. The Brief does not
            decide <i>whether</i> to deploy &mdash; only whether today is a good day within that window. It weighs
            Mark Newton&rsquo;s daily technical note (40%), the S&amp;P oscillator (25%), market breadth (15%), the
            VIX (10%), sentiment (6%) and the five-day move in the S&amp;P (4%) into a score from 0 to 100.
          </p>
          <p>
            The score maps one way: <b>70 or more is DEPLOY, 55 to 69 is PARTIAL</b> (half now, half held back),
            <b> below 55 is WAIT</b>. Because a quiet month could otherwise say WAIT every day, a calendar backstop
            applies: with five or fewer trading days left before the 20th a WAIT becomes PARTIAL, and with two or
            fewer the call is DEPLOY. The app enforces that backstop itself after the AI answers.
          </p>
          <p>
            When you log that the cash has actually gone in, the Brief stops making the call until the 1st of the
            next month, and the log keeps a timing record: the S&amp;P&rsquo;s close on your day against the average
            close across that month&rsquo;s window, which is what spreading the cash evenly would have paid.
          </p>
          <p className="text-ink-3">Where you see it: the Cash Deployment tile on the Brief.</p>
        </Sect>

        <Sect n="2" title="Factor screen — the independent second opinion">
          <p>
            In parallel, a purely quantitative screen ranks the universe on a small set of factors with
            long-run academic support (valuation vs sector, quality, momentum, estimate-revision momentum),
            computed sector-neutrally with no human judgment. It deliberately is <b>not</b> blended into the
            33-point score: when the two disagree, that disagreement is the information. The screen&rsquo;s own
            predictive power is validated against forward returns before it earns any formal weight.
          </p>
          <p className="text-ink-3">
            Where you see it: <Link href="/factor-lab">Factor Lab</Link>,
            including the side-by-side comparison against the 33-point score.
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
            The <Link href="/journal">Decision Journal</Link> measures
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
            <b>33-point score:</b> FactSet is the primary source for fundamentals, estimates and sector
            classification (via a dedicated relay); figures are verified against public filings during each
            scoring run, with the source of every data point stored in an audit trail. Prices and technicals
            come from Yahoo Finance; insider activity from SEC filings (US listings). Scores refresh on
            material events — earnings, guidance, rating changes — not on a fixed clock.
          </p>
          <p>
            <b>Factor screen:</b> two moving parts, both fully deterministic code.
          </p>
          <ul className="flex list-disc flex-col gap-1 pl-5">
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
