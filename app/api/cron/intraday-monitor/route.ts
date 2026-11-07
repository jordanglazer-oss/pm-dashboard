import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { enqueueMail } from "@/app/lib/mail-outbox";
import type { TechnicalIndicators } from "@/app/lib/types";
import { isFundservCode } from "@/app/lib/factset-symbols";
import { yahooClassShare } from "@/app/lib/yahoo-symbol";
import { loadHedges, isActiveHedge } from "@/app/lib/hedges";

/**
 * Intraday monitor — the "between the morning emails" watchdog. Pinged hourly
 * during US market hours by the Gmail Apps Script (which already runs every
 * 5 minutes and holds the INBOX_SECRET), so it costs nothing extra to run.
 *
 * Checks (deliberately few, level-based, both directions), over EVERY
 * Portfolio holding with an intraday price — stocks and ETFs; mutual funds
 * (FUNDSERV codes, or instrumentType "mutual-fund") price once a day and are
 * skipped:
 *   - A holding BREAKING BELOW its 200-DMA intraday (was above at the last
 *     close; level from the nightly technicals refresh, where one exists).
 *   - A holding RECLAIMING its 200-DMA from below — the mirror.
 *   - A holding down ≥ 4%, or up ≥ 5%, on the day.
 *   - VIX spiking ≥ 15% on the day, or crossing above 25 from below.
 *
 * The email is one line per trip under a single line of index context
 * (S&P 500 and Nasdaq on the day). A move within 1.5 points of either index
 * in the same direction is marked "in line with the market", so a market-wide
 * day reads as one event rather than a dozen separate problems.
 *
 * The up/down thresholds are ASYMMETRIC on purpose: a drop is a risk event
 * wanting same-day attention, a rise is information. The higher bar on the
 * upside keeps the inbox honest while still catching the moves that matter
 * (a beat, a takeout, a guidance raise).
 *
 * Each trip fires ONCE per day (deduped in pm:intraday-monitor, an operational
 * marker — safe to nuke; worst case one repeat email). New trips are queued to
 * the Gmail outbox, which the same Apps Script drains within ~5 minutes.
 *
 * READ-ONLY over pm:stocks; writes only pm:intraday-monitor + pm:mail-outbox.
 * Auth: Bearer CRON_SECRET or INBOX_SECRET (the Apps Script sends the latter).
 * The /api/cron/* namespace is exempt from the cookie middleware; this handler
 * enforces the bearer itself.
 */

const log = createLogger("IntradayMonitor");
export const maxDuration = 60;

const MARKER_KEY = "pm:intraday-monitor";
const YAHOO_BASE = "https://query2.finance.yahoo.com";
const CONCURRENCY = 8;
const DROP_PCT = -4; // daily move that warrants an intraday ping
const RISE_PCT = 5; // see the asymmetry note in the header
const VIX_SPIKE_PCT = 15;
const VIX_LEVEL = 25;

function toYahoo(ticker: string): string {
  if (ticker.endsWith(".U")) return ticker.replace(/\.U$/, "-U.TO");
  if (ticker.endsWith("-T")) return ticker.replace(/-T$/, ".TO");
  return ticker;
}

/** New York wall-clock parts, DST-correct via Intl. */
function nyNow(): { dow: number; minutes: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dows: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dow: dows[get("weekday")] ?? 0,
    minutes: parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10),
    date: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

/** Live price + previous close from Yahoo chart meta (one light call). */
async function fetchQuote(symbol: string): Promise<{ price: number; prevClose: number } | null> {
  try {
    const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    const prevClose = meta?.chartPreviousClose ?? meta?.previousClose;
    if (typeof price !== "number" || typeof prevClose !== "number" || prevClose <= 0) return null;
    return { price, prevClose };
  } catch {
    return null;
  }
}

type StoredStock = {
  ticker?: string;
  name?: string;
  bucket?: string;
  instrumentType?: string;
  technicals?: TechnicalIndicators;
};

export async function GET(req: NextRequest) {
  // Bearer auth — CRON_SECRET (Vercel) or INBOX_SECRET (the Gmail Apps Script).
  const auth = req.headers.get("authorization") ?? "";
  const okSecrets = [process.env.CRON_SECRET, process.env.INBOX_SECRET].filter(Boolean).map((s) => `Bearer ${s}`);
  if (okSecrets.length === 0) return NextResponse.json({ error: "no secret configured" }, { status: 503 });
  if (!okSecrets.includes(auth)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Market-hours gate (America/New_York, DST-correct): Mon–Fri 9:35–16:05.
  // Outside the window we return fast — the Apps Script pings blindly.
  const ny = nyNow();
  const open = 9 * 60 + 35;
  const close = 16 * 60 + 5;
  if (ny.dow === 0 || ny.dow === 6 || ny.minutes < open || ny.minutes > close) {
    return NextResponse.json({ skipped: true, reason: "outside market hours" });
  }

  try {
    const redis = await getRedis();
    const raw = await redis.get("pm:stocks");
    const stocks: StoredStock[] = (() => {
      try {
        const p = raw ? JSON.parse(raw) : [];
        return Array.isArray(p) ? p : [];
      } catch {
        return [];
      }
    })();

    // Every Portfolio holding with an intraday price: stocks and ETFs. Mutual
    // funds (FUNDSERV codes) strike one NAV a day, so an intraday read of
    // them is meaningless.
    const holdings = stocks.filter(
      (s) =>
        s.bucket === "Portfolio" &&
        s.ticker &&
        s.instrumentType !== "mutual-fund" &&
        !isFundservCode(s.ticker.trim())
    );

    // Dedupe marker: { date, fired: string[] } — resets naturally each day.
    let marker: { date?: string; fired?: string[] } = {};
    try {
      const m = await redis.get(MARKER_KEY);
      if (m) marker = JSON.parse(m);
    } catch {
      marker = {};
    }
    const fired = new Set<string>(marker.date === ny.date ? marker.fired ?? [] : []);

    // Trips sort VIX first, then the largest moves; `rank` orders them.
    const trips: Array<{ id: string; line: string; rank: number; head: string }> = [];
    const consider = (id: string, line: string, rank: number, head: string) => {
      if (fired.has(id)) return;
      trips.push({ id, line, rank, head });
    };
    const pct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}%`;
    const px = (x: number) => `$${x.toFixed(2)}`;

    // ── Index context: S&P 500 and Nasdaq on the day ──
    const [spx, ndx] = await Promise.all([fetchQuote("^GSPC"), fetchQuote("^IXIC")]);
    const idxChg = (q: { price: number; prevClose: number } | null) =>
      q ? ((q.price - q.prevClose) / q.prevClose) * 100 : null;
    const spxChg = idxChg(spx);
    const ndxChg = idxChg(ndx);
    const withMarket = (chg: number) =>
      [spxChg, ndxChg].some((m) => m != null && Math.sign(m) === Math.sign(chg) && Math.abs(chg - m) <= 1.5);

    // ── VIX ──
    // Information only. Policy: we hedge when protection is cheap and never
    // in reaction to a spike that has already made it expensive, so the alert
    // says where we stand rather than prompting a purchase.
    const vix = await fetchQuote("^VIX");
    if (vix) {
      const chg = ((vix.price - vix.prevClose) / vix.prevClose) * 100;
      const spiking = chg >= VIX_SPIKE_PCT;
      const crossed = !spiking && vix.price >= VIX_LEVEL && vix.prevClose < VIX_LEVEL;
      if (spiking || crossed) {
        let hedgeNote = "";
        try {
          const active = (await loadHedges()).filter((h) => isActiveHedge(h));
          hedgeNote = active.length === 0
            ? " No hedges on."
            : ` ${active.length} hedge${active.length === 1 ? "" : "s"} on${active[0].expiry ? ` (first expires ${active[0].expiry})` : ""}.`;
        } catch {
          hedgeNote = "";
        }
        const reading = spiking
          ? `VIX ${vix.price.toFixed(1)}, ${pct(chg)} today`
          : `VIX above ${VIX_LEVEL} (${vix.price.toFixed(1)}, from ${vix.prevClose.toFixed(1)})`;
        consider(
          spiking ? `vix-spike` : `vix-25`,
          `${reading}: protection is now expensive, so no new hedges.${hedgeNote}`,
          1000,
          spiking ? `VIX ${pct(chg)}` : `VIX above ${VIX_LEVEL}`
        );
      }
    }

    // ── Holdings: 200-DMA breaks/reclaims + big moves either way ──
    const queue = [...holdings];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const s = queue.shift();
        if (!s) return;
        const tk = (s.ticker as string).trim();
        const q = await fetchQuote(yahooClassShare(toYahoo(tk)));
        if (!q) continue;
        const chg = ((q.price - q.prevClose) / q.prevClose) * 100;
        const mkt = withMarket(chg) ? ", in line with the market" : "";
        const sma200 = s.technicals?.sma200;
        if (typeof sma200 === "number" && sma200 > 0 && q.prevClose >= sma200 && q.price < sma200) {
          consider(`${tk}-200dma`, `${tk} below its 200-day average (${px(q.price)} vs ${px(sma200)}, ${pct(chg)} today${mkt})`, 50, `${tk} below 200-day`);
        }
        if (typeof sma200 === "number" && sma200 > 0 && q.prevClose < sma200 && q.price >= sma200) {
          consider(`${tk}-200dma-reclaim`, `${tk} back above its 200-day average (${px(q.price)} vs ${px(sma200)}, ${pct(chg)} today${mkt})`, 10, `${tk} above 200-day`);
        }
        if (chg <= DROP_PCT) {
          consider(`${tk}-drop`, `${tk} ${pct(chg)} (${px(q.prevClose)} → ${px(q.price)}${mkt})`, 100 + Math.abs(chg), `${tk} ${pct(chg)}`);
        }
        if (chg >= RISE_PCT) {
          consider(`${tk}-rise`, `${tk} ${pct(chg)} (${px(q.prevClose)} → ${px(q.price)}${mkt})`, 60 + chg, `${tk} ${pct(chg)}`);
        }
      }
    });
    await Promise.all(workers);
    trips.sort((x, y) => y.rank - x.rank);

    // ── Email NEW trips (once each per day) ──
    let emailed = false;
    if (trips.length > 0) {
      const alertTo = (process.env.ALERT_EMAIL_TO || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .join(",");
      if (alertTo) {
        const nowId = `intraday-${ny.date}-${ny.minutes}`;
        const day = new Date(`${ny.date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
        const context = [
          spxChg != null ? `S&P 500 ${pct(spxChg)}` : null,
          ndxChg != null ? `Nasdaq ${pct(ndxChg)}` : null,
        ]
          .filter(Boolean)
          .join(" · ");
        emailed = await enqueueMail({
          id: nowId,
          to: alertTo,
          subject: `Intraday — ${trips[0].head}${trips.length > 1 ? ` +${trips.length - 1} more` : ""} (${day})`,
          text: [
            ...(context ? [context, ""] : []),
            ...trips.map((t) => t.line),
            "",
            "Each alert fires once per day · pm-dashboard-7rr9.vercel.app",
          ].join("\n"),
          queuedAt: new Date().toISOString(),
        });
      }
      // Mark fired regardless of email config so trips don't pile up unsent.
      for (const t of trips) fired.add(t.id);
      await redis.set(MARKER_KEY, JSON.stringify({ date: ny.date, fired: [...fired] }));
    }

    return NextResponse.json({ ok: true, checked: holdings.length, newTrips: trips.length, emailed });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
