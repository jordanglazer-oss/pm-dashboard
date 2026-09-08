"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { displayTicker } from "@/app/lib/ticker";
import TickerLink from "@/app/components/TickerLink";
import { AppIcon } from "@/app/components/AppIcon";
import { EmptyState } from "@/app/components/EmptyState";
import { useTableSort, currencyOf } from "@/app/lib/useTableSort";

/**
 * Setups — names that look ready to move, rather than names that already have.
 *
 * Kept apart from the Suggested Watchlist on purpose. Everything there is a
 * research provider's assertion, and every provider publishes AFTER a move, so
 * that list structurally cannot contain a stock still coiling. This is the one
 * reading the dashboard computes itself, and mixing the two would blur which
 * is which.
 *
 * Two scores, never averaged:
 *   Base (0-4)      a strong stock going quiet — near its high, range
 *                   tightening, volume drying up, holding above both MAs.
 *   Improving (0-6) a weak stock turning — RSI off a low, MACD up, nearing a
 *                   DMA from below, reclaiming the cloud.
 * They describe opposite situations and call for different trades; one blended
 * number would hide which one a name actually is.
 */

type Row = {
  ticker: string;
  name?: string;
  sector?: string;
  price: number;
  improving: { score: number; label: string; active: string[] };
  base: null | {
    pctFromHigh: number;
    contraction: number;
    volumeDryUp: number;
    volumeCharacter?: "dry-up" | "accumulation" | "distribution" | "neutral";
    upVolumeShare?: number;
    aboveBothMAs: boolean;
    score: number;
    label: string;
    detail: string;
  };
  error?: string;
};

type Scan = {
  generatedAt: string | null;
  universe?: string;
  scanned?: number;
  requested?: number;
  reused?: number;
  fetched?: number;
  failed?: number;
  remaining?: number;
  complete?: number;
  note?: string;
  rows: Row[];
};

/** Enough passes to cover a few hundred names; the loop exits early once the
 *  universe is covered or the limiter stops answering. */
const MAX_PASSES = 12;
const PAUSE_MS = 2500;

/** Base label = dot + word; colour carries the read (Coiled is the setup). */
const BASE_TONE: Record<string, { dot: string; cls: string }> = {
  Coiled: { dot: "bg-pos", cls: "text-pos" },
  Building: { dot: "bg-accent", cls: "text-ink" },
  Loose: { dot: "bg-ink-faint", cls: "text-ink-3" },
  None: { dot: "bg-ink-faint", cls: "text-ink-faint" },
};

const BTN = "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover disabled:opacity-40";
const BTN_PRI = "inline-flex h-7 items-center gap-1.5 rounded-control bg-ink px-2.5 text-[12.5px] font-medium text-white hover:bg-ink-2 disabled:opacity-40";
const BTN_NEG = "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-neg hover:bg-neg-soft";
const SELECT = "h-7 rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink-2 outline-none";

export function SetupScan({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const [scan, setScan] = useState<Scan>({ generatedAt: null, rows: [] });
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [universe, setUniverse] = useState<"suggested" | "watchlist" | "portfolio">("suggested");
  /** Seeds the initial sort only — the column headers drive it from there. */
  const sortBy: "base" | "improving" = "base";
  const [passInfo, setPassInfo] = useState<{ pass: number; remaining: number } | null>(null);
  const stopRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/setup-scan", { cache: "no-store" });
      if (r.ok) {
        const d: Scan = await r.json();
        setScan(d);
        onCountChange?.(d.rows.filter((x) => (x.base?.score ?? 0) >= 3).length);
      }
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);
  useEffect(() => { load(); }, [load]);

  /**
   * Run slices until the universe is covered, rather than making the PM press
   * the button five times.
   *
   * Each pass is a separate request on purpose: the slice size exists because
   * Yahoo throttles Vercel's shared IPs, so one long request would be refused
   * partway regardless. Pausing between passes gives the limiter room to
   * recover, which is what makes the next slice succeed.
   *
   * Stops on its own when nothing is left, when a pass reads NOTHING (fully
   * throttled — hammering will not help), or when the PM presses Stop.
   */
  const run = async () => {
    setRunning(true);
    stopRef.current = false;
    try {
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        if (stopRef.current) break;
        const body: Record<string, unknown> = universe === "suggested" ? {} : { universe };
        const r = await fetch("/api/setup-scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) break;
        const d: Scan = await r.json();
        setScan(d);
        onCountChange?.(d.rows.filter((x) => (x.base?.score ?? 0) >= 3).length);
        setPassInfo({ pass: pass + 1, remaining: d.remaining ?? 0 });
        if ((d.remaining ?? 0) <= 0) break;
        if ((d.fetched ?? 0) === 0) break; // throttled flat — stop rather than spin
        await new Promise((res) => setTimeout(res, PAUSE_MS));
      }
    } finally {
      setRunning(false);
      setPassInfo(null);
      stopRef.current = false;
    }
  };

  const [showUnread, setShowUnread] = useState(false);
  const [ccy, setCcy] = useState<"All" | "CAD" | "USD">("All");

  const readable = showUnread ? scan.rows : scan.rows.filter((r) => !r.error);
  const visible = ccy === "All" ? readable : readable.filter((r) => currencyOf(r.ticker) === ccy);

  const { sorted, key: sortKey, dir: sortDir, toggle } = useTableSort(
    visible,
    {
      ticker: (r) => r.ticker,
      name: (r) => r.name ?? null,
      sector: (r) => r.sector ?? null,
      price: (r) => (r.price > 0 ? r.price : null),
      offHigh: (r) => r.base?.pctFromHigh ?? null,
      base: (r) => r.base?.score ?? null,
      improving: (r) => r.improving.score,
    },
    sortBy === "base" ? "base" : "improving",
  );
  const rows = sorted;

  const cadCount = readable.filter((r) => currencyOf(r.ticker) === "CAD").length;
  const usdCount = readable.length - cadCount;
  const unreadCount = scan.rows.filter((r) => !!r.error).length;
  const SORT_LABEL: Record<string, string> = { ticker: "ticker", name: "name", sector: "sector", price: "price", offHigh: "off high", base: "base", improving: "recovering" };

  const Th = ({ id, label, className = "", title }: { id?: string; label: string; className?: string; title?: string }) => (
    <th className={className} title={title}>
      {id ? (
        <button type="button" onClick={() => toggle(id)} className={`inline-flex items-center gap-0.5 hover:text-ink ${sortKey === id ? "text-ink-2" : ""}`}>
          {label}
          {sortKey === id && <AppIcon name={sortDir === "asc" ? "chevU" : "chevD"} size={11} strokeWidth={2} />}
        </button>
      ) : label}
    </th>
  );

  return (
    <div className="flex flex-col gap-3.5">
      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="seg" role="group" aria-label="Currency">
          {(["All", "CAD", "USD"] as const).map((c) => (
            <button key={c} onClick={() => setCcy(c)} className={ccy === c ? "on" : ""}>
              {c}
              {c !== "All" && <span className="c">{c === "CAD" ? cadCount : usdCount}</span>}
            </button>
          ))}
        </div>
        <select
          value={universe}
          onChange={(e) => setUniverse(e.target.value as typeof universe)}
          className={SELECT}
          aria-label="Universe"
        >
          <option value="suggested">Suggested candidates</option>
          <option value="watchlist">Watchlist</option>
          <option value="portfolio">Portfolio</option>
        </select>
        <button onClick={() => setShowUnread((v) => !v)} aria-pressed={showUnread} className={`${BTN} ${showUnread ? "!border-accent-border !bg-accent-soft !text-accent" : ""}`}>
          <AppIcon name={showUnread ? "eyeOff" : "eye"} size={13} strokeWidth={2} />
          {showUnread ? "Hide unread" : "Show unread"} <span className="font-mono text-[11px] text-ink-3">{unreadCount}</span>
        </button>
        <span className="text-[11.5px] text-ink-3">
          computed from price, not taken from a research list
          {scan.generatedAt && (
            <>
              {" · "}
              <span className="text-ink-2">{scan.complete ?? scan.rows.filter((r) => !r.error).length} of {scan.requested ?? scan.rows.length} read</span>
              {` · ${new Date(scan.generatedAt).toLocaleString()}`}
            </>
          )}
        </span>
        <div className="ml-auto">
          {running ? (
            <button onClick={() => { stopRef.current = true; }} className={BTN_NEG}>
              <AppIcon name="stop" size={13} strokeWidth={2} /> Stop
            </button>
          ) : (
            <button onClick={run} className={BTN_PRI}>
              <AppIcon name="play" size={13} strokeWidth={2} />
              {(scan.remaining ?? 0) > 0 ? `Continue (${scan.remaining} left)` : "Run scan"}
            </button>
          )}
        </div>
      </div>

      <section className="panel">
        <div className="panel-h">
          <span className="t">Setups</span>
          <span className="m">names that look ready to move, not names that already have · sorted by {SORT_LABEL[sortKey] ?? sortKey}</span>
        </div>

        {running && (
          <div className="border-b border-line-soft px-3.5 py-2 text-[12.5px] text-ink-2">
            <AppIcon name="refresh" size={12} strokeWidth={2} className="mr-1.5 inline animate-spin align-[-2px] text-ink-3" />
            Scanning in passes{passInfo ? ` — pass ${passInfo.pass}, ${passInfo.remaining} left` : "…"}. Yahoo
            limits how much can be read at once, so this pauses between passes. Safe to leave running.
          </div>
        )}

        {!running && scan.note && (
          <div className="border-b border-line-soft px-3.5 py-2 text-[12.5px] text-ink-2">{scan.note}</div>
        )}

        {loading ? (
          <p className="px-3.5 py-3 text-[12.5px] text-ink-3">Loading…</p>
        ) : rows.length === 0 ? (
          <EmptyState
            className="!py-8"
            glyph={<AppIcon name="play" size={18} />}
            title="No scan yet"
            body="Pick a universe and hit Run scan."
          />
        ) : (
          <div className="tbl-wrap">
            <table className="data-table min-w-[820px]">
              <thead>
                <tr>
                  <Th id="ticker" label="Ticker" className="pl-3.5" />
                  <Th id="name" label="Name" />
                  <Th id="sector" label="Sector" />
                  <Th id="price" label="Price" className="n" />
                  <Th id="offHigh" label="Off high" className="n" />
                  <Th id="base" label="Base" title="0-4: a strong stock going quiet — near its high, range tightening, volume drying up, holding above both MAs" />
                  <Th id="improving" label="Recovering" title="0-6: a weak stock turning — RSI off a low, MACD up, nearing a DMA from below, reclaiming the cloud" />
                  <Th label="Why" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const tone = r.base ? (BASE_TONE[r.base.label] ?? BASE_TONE.None) : BASE_TONE.None;
                  return (
                    <tr key={r.ticker}>
                      <td className="pl-3.5"><TickerLink ticker={r.ticker} className="font-mono font-medium text-ink hover:text-accent hover:underline">{displayTicker(r.ticker)}</TickerLink></td>
                      <td className="max-w-[200px] truncate text-[12px] text-ink-3">{r.name || "—"}</td>
                      <td className="text-[12px] text-ink-2">{r.sector || "—"}</td>
                      <td className="n text-ink-2">{r.price > 0 ? r.price.toFixed(2) : "—"}</td>
                      <td className="n text-ink-2">{r.base ? `${r.base.pctFromHigh.toFixed(1)}%` : "—"}</td>
                      <td>
                        {r.base ? (
                          <span className={`inline-flex items-center gap-1.5 ${tone.cls}`}>
                            <span className={`dot ${tone.dot}`} />
                            {r.base.label}
                            <span className="font-mono text-[11.5px]">{r.base.score}<span className="text-ink-faint">/4</span></span>
                          </span>
                        ) : (
                          <span className="text-[11.5px] text-ink-faint">{r.error || "—"}</span>
                        )}
                      </td>
                      <td className="text-ink-2">
                        {r.improving.label} <span className="font-mono text-[11.5px]">{r.improving.score}<span className="text-ink-faint">/6</span></span>
                      </td>
                      <td className={`whitespace-normal py-2 text-[11.5px] ${r.base?.volumeCharacter === "distribution" ? "text-neg" : "text-ink-3"}`}>
                        {r.base?.detail || r.improving.active.join(" · ") || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!loading && rows.length > 0 && (
          <div className="flex h-8 items-center border-t border-line-soft px-3.5 text-[11.5px] text-ink-3">
            {rows.length} of {readable.length} · {cadCount} CAD · {usdCount} USD
          </div>
        )}
      </section>
    </div>
  );
}
