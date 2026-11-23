"use client";

import React, { useCallback, useEffect, useState } from "react";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import { noteToText, snapshotText, talkingPointsText, type EarningsDate, type MorningNote, type Source } from "@/app/lib/morning-note-shared";
import { AppIcon } from "../AppIcon";
import { Skeleton } from "../Skeleton";
import { timeAgo } from "./summary-ui";

/**
 * Morning note — the pre-open read at the top of the Brief (Nov 2026).
 * ADDITIVE: it sits above the existing Brief and changes nothing in it.
 * Reads GET /api/morning-note (free); Regenerate POSTs (one paid AI call,
 * today's note only). Copy buttons put plain text on the clipboard for an
 * email. Open / closed persists in pm:ui-prefs.
 */

type Payload = { note: MorningNote | null; dates: string[]; today: string; ok?: boolean; skipped?: string; error?: string };

const fetchNote = (date?: string): Promise<Payload> => fetch(`/api/morning-note${date ? `?date=${date}` : ""}`, { cache: "no-store" }).then((r) => r.json() as Promise<Payload>);

const longDate = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" }) : ymd;
};
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

function SourceLink({ s }: { s: Source }) {
  return (
    <a href={s.url} target="_blank" rel="noopener noreferrer" className="whitespace-nowrap text-[11.5px] !text-accent hover:underline" title={s.title ?? s.url}>
      {host(s.url)}
    </a>
  );
}

function Head({ children }: { children: React.ReactNode }) {
  return <h3 className="m-0 mb-1.5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink-3">{children}</h3>;
}

function Earn({ rows }: { rows: EarningsDate[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {rows.map((e) => (
        <span key={`${e.ticker}-${e.date}`} title={e.name} className={`inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-0.5 text-[11.5px] ${e.held ? "border-accent-border bg-accent-soft" : "border-line bg-surface-2"}`}>
          <span className={`font-mono font-semibold ${e.held ? "text-accent" : "text-ink-2"}`}>{e.ticker}</span>
          <span className="text-ink-3">{e.held ? "held" : "watchlist"} · {longDate(e.date)}</span>
        </span>
      ))}
    </div>
  );
}

function Body({ n }: { n: MorningNote }) {
  const snap = n.snapshot.filter((l) => l.value != null);
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-5 px-5 py-4 lg:grid-cols-2">
      <section className="lg:col-span-2">
        <Head>Pre-market snapshot</Head>
        {snap.length === 0 ? (
          <p className="m-0 text-[12.5px] text-ink-3">The price feed returned nothing this run.</p>
        ) : (
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 md:grid-cols-3 xl:grid-cols-5">
            {snap.map((l) => {
              const [label, rest] = snapshotText({ ...l, note: undefined }).split(": ");
              return (
                <div key={l.key} title={l.note} className="flex items-baseline justify-between gap-2 border-b border-line-soft py-1 text-[12.5px]">
                  <span className="min-w-0 truncate text-ink-3">{label}</span>
                  <span className="shrink-0 font-mono text-ink">
                    <span className={l.changePct == null ? "" : l.changePct >= 0 ? "text-pos" : "text-neg"}>{rest}</span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {n.closeLine && (
          <p className="m-0 mt-2 text-[13px] leading-[1.5] text-ink-2">
            {n.closeLine.text}{" "}
            {n.closeLine.sources.map((s) => (
              <span key={s.url} className="ml-1"><SourceLink s={s} /></span>
            ))}
          </p>
        )}
      </section>

      <section>
        <Head>Earnings</Head>
        {n.earningsToday.length === 0 && n.earningsReported.length === 0 && n.earningsWeek.length === 0 && <p className="m-0 text-[12.5px] text-ink-3">None of our names report today or in the next week.</p>}
        {n.earningsToday.length > 0 && (
          <div className="mb-2">
            <div className="mb-1 text-[11.5px] text-ink-3">Reporting today</div>
            <Earn rows={n.earningsToday} />
          </div>
        )}
        {n.earningsReported.length > 0 && (
          <ul className="m-0 mb-2 flex list-none flex-col gap-1.5 p-0">
            {n.earningsReported.map((e) => (
              <li key={e.ticker} className="text-[13px] leading-[1.5] text-ink-2">
                <span className="font-mono font-semibold text-ink">{e.ticker}</span>
                {e.held && <span className="ml-1.5 text-[11px] font-semibold text-accent">held</span>} <span>{e.summary}</span>
                {e.reaction && <span className="text-ink-3"> Reaction: {e.reaction}</span>}
                {e.sources.map((s) => (
                  <span key={s.url} className="ml-1.5"><SourceLink s={s} /></span>
                ))}
              </li>
            ))}
          </ul>
        )}
        {n.earningsWeek.length > 0 && (
          <div>
            <div className="mb-1 text-[11.5px] text-ink-3">Next seven days</div>
            <Earn rows={n.earningsWeek} />
          </div>
        )}
      </section>

      <section>
        <Head>Today&apos;s calendar</Head>
        {n.calendar.length === 0 ? (
          <p className="m-0 text-[12.5px] text-ink-3">Nothing confirmed for today.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {n.calendar.map((c, i) => (
              <li key={i} className="flex gap-2.5 text-[13px] leading-[1.45] text-ink-2">
                <span className="w-11 shrink-0 font-mono text-[12px] text-ink-3">{c.timeET ?? ""}</span>
                <span className="min-w-0">
                  {c.event}
                  {(c.consensus || c.prior) && <span className="text-ink-3"> · {[c.consensus && `consensus ${c.consensus}`, c.prior && `prior ${c.prior}`].filter(Boolean).join(" · ")}</span>}
                  {c.source && <span className="ml-1.5"><SourceLink s={c.source} /></span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <Head>News that matters</Head>
        {n.news.length === 0 ? (
          <p className="m-0 text-[12.5px] text-ink-3">No sourced items this run.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {n.news.map((x, i) => (
              <li key={i} className="text-[13px] leading-[1.5]">
                <div className="font-semibold text-ink">
                  {x.headline}
                  {x.tickers.map((t) => (
                    <span key={t} className="ml-1.5 font-mono text-[11px] font-semibold text-accent">{t}</span>
                  ))}
                </div>
                <div className="text-ink-2">
                  <span className="font-semibold text-ink-3">Why it matters: </span>
                  {x.whyItMatters} <SourceLink s={x.source} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <Head>Geopolitics</Head>
        {n.geopolitics.length === 0 ? (
          <p className="m-0 text-[12.5px] text-ink-3">Nothing with a clear market channel today.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {n.geopolitics.map((g, i) => (
              <li key={i} className="text-[13px] leading-[1.5]">
                <div className="font-semibold text-ink">{g.event}</div>
                <div className="text-ink-2">
                  <span className="font-semibold text-ink-3">Market channel: </span>
                  {g.channel} <SourceLink s={g.source} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <Head>What our strategists are saying</Head>
        {n.strategists.length === 0 ? (
          <p className="m-0 text-[12.5px] text-ink-3">No recent Newton or Lee note on file.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {n.strategists.map((s) => (
              <div key={s.author}>
                <div className="text-[13px] font-semibold text-ink">
                  {s.author}
                  {s.noteDate && <span className="ml-1.5 text-[11.5px] font-normal text-ink-3">note of {longDate(s.noteDate)}</span>}
                </div>
                <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
                  {s.points.map((p, i) => (
                    <li key={i} className="flex gap-2.5 text-[13px] leading-[1.5] text-ink-2">
                      <span className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                      <span className="min-w-0">{p}</span>
                    </li>
                  ))}
                </ul>
                {s.changeFromPrior && (
                  <p className="m-0 mt-1 text-[12px] leading-[1.5] text-ink-3">
                    <span className="font-semibold text-ink-2">Change from prior: </span>
                    {s.changeFromPrior}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <Head>Client talking points</Head>
        {n.talkingPoints.length === 0 ? (
          <p className="m-0 text-[12.5px] text-ink-3">None written this run.</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
            {n.talkingPoints.map((t, i) => (
              <li key={i} className="text-[13px] leading-[1.5]">
                <div className="font-semibold text-ink">{t.concern}</div>
                <div className="text-ink-2">
                  {t.response}
                  {t.attribution && <span className="text-ink-3"> ({t.attribution})</span>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

const BTN = "inline-flex h-7 items-center gap-1.5 rounded-pill border border-line bg-surface px-2.5 text-[11.5px] text-ink-2 hover:border-accent-border hover:bg-accent-soft hover:text-accent disabled:opacity-50";

export function MorningNotePanel() {
  const [open, toggle] = usePersistedOpen("brief.morningNote.open", true);
  const [note, setNote] = useState<MorningNote | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  const [today, setToday] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const apply = useCallback((j: Payload) => {
    if (j.note !== undefined) setNote(j.note);
    if (Array.isArray(j.dates)) setDates(j.dates);
    if (j.today) setToday(j.today);
  }, []);

  const load = async (date: string) => {
    try {
      apply(await fetchNote(date));
    } catch {
      setMessage("Could not load that morning note.");
    }
  };

  useEffect(() => {
    let alive = true;
    fetchNote()
      .then((j) => alive && apply(j))
      .catch(() => alive && setMessage("Could not load the morning note."))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [apply]);

  const regenerate = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await fetch("/api/morning-note", { method: "POST" });
      const j = (await r.json()) as Payload;
      apply(j);
      if (j.error) setMessage(j.error);
      else if (j.skipped) setMessage(j.skipped);
    } catch {
      setMessage("The morning note could not be written. Try again in a minute.");
    }
    setBusy(false);
  };

  const copy = async (what: "note" | "points") => {
    if (!note) return;
    try {
      await navigator.clipboard.writeText(what === "note" ? noteToText(note) : talkingPointsText(note));
      setCopied(what);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      setMessage("Copy was blocked by the browser.");
    }
  };

  const isToday = !!note && note.date === today;
  return (
    <section className="panel" id="s-morning-note" style={{ scrollMarginTop: 64 }}>
      <div className="panel-h">
        <span className="t-mark bg-accent" />
        <span className="t">Morning note</span>
        <span className="m min-w-0 truncate">
          {note ? `${longDate(note.date)} · written ${timeAgo(note.generatedAt)}${isToday ? "" : " · not today's"}` : "the pre-open read, weekdays before 8:00 ET"}
        </span>
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {open && dates.length > 0 && (
            <select
              value={note?.date ?? ""}
              onChange={(e) => load(e.target.value)}
              className="h-7 rounded-pill border border-line bg-surface px-2 text-[11.5px] text-ink-2"
              aria-label="Open a past morning note"
              title="Open a past morning note"
            >
              {dates.map((d) => (
                <option key={d} value={d}>{longDate(d)}{d === today ? " (today)" : ""}</option>
              ))}
            </select>
          )}
          {open && note && (
            <>
              <button type="button" onClick={() => copy("points")} disabled={!note.talkingPoints.length} className={BTN} title="Copy the client talking points as plain text">
                <span>{copied === "points" ? "Copied" : "Copy talking points"}</span>
              </button>
              <button type="button" onClick={() => copy("note")} className={BTN} title="Copy the whole note as plain text, for an email">
                <span>{copied === "note" ? "Copied" : "Copy note"}</span>
              </button>
            </>
          )}
          {open && (
            <button type="button" onClick={regenerate} disabled={busy || loading} className={BTN} title="Write today's note again with the latest news and research (one AI call)">
              <AppIcon name="refresh" size={13} className={busy ? "animate-spin" : ""} />
              <span>{busy ? "Writing…" : note && isToday ? "Regenerate" : "Write today's"}</span>
            </button>
          )}
          <button
            type="button"
            onClick={toggle}
            className="grid h-7 w-7 place-items-center rounded-pill border border-line bg-surface text-ink-2 hover:border-accent-border hover:bg-accent-soft hover:text-accent"
            title={open ? "Hide the morning note" : "Show the morning note"}
            aria-label={open ? "Hide the morning note" : "Show the morning note"}
            aria-expanded={open}
          >
            <AppIcon name={open ? "chevU" : "chevD"} size={14} />
          </button>
        </div>
      </div>

      {open &&
        (loading ? (
          <div className="grid grid-cols-1 gap-4 p-5 lg:grid-cols-2">
            <Skeleton className="h-[140px]" />
            <Skeleton className="h-[140px]" />
          </div>
        ) : (
          <>
            {message && <p className="m-0 border-b border-line-soft px-5 py-2 text-[12.5px] text-warn">{message}</p>}
            {note?.warnings?.map((w) => (
              <p key={w} className="m-0 border-b border-line-soft px-5 py-2 text-[12.5px] text-warn">{w}</p>
            ))}
            {!note ? (
              <p className="m-0 px-5 py-4 text-[12.5px] text-ink-3">
                No morning note yet. It is written automatically on weekday mornings; press “Write today&apos;s” to make one now (takes a minute or two).
              </p>
            ) : (
              <>
                <Body n={note} />
                <p className="m-0 border-t border-line-soft px-5 py-2 text-[11px] text-ink-3">
                  Snapshot and earnings dates come from our own data. News, calendar and talking points are AI-written from sourced pages; check a figure against its link before quoting it.
                  {note.usage ? ` This note used ${note.usage.searches} web searches, about $${note.usage.estUsd.toFixed(2)}.` : ""}
                </p>
              </>
            )}
          </>
        ))}
    </section>
  );
}
