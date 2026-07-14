import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { enqueueMail } from "@/app/lib/mail-outbox";
import type { TechnicalIndicators } from "@/app/lib/types";

/**
 * Intraday monitor — the "between the morning emails" watchdog. Pinged hourly
 * during US market hours by the Gmail Apps Script (which already runs every
 * 5 minutes and holds the INBOX_SECRET), so it costs nothing extra to run.
 *
 * Checks (deliberately few, risk-focused, level-based):
 *   - A Portfolio stock BREAKING BELOW its 200-DMA intraday (was above at the
 *     last close; level from the nightly technicals refresh).
 *   - A Portfolio stock down ≥ 4% on the day.
 *   - VIX spiking ≥ 15% on the day, or crossing above 25 from below.
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

    // Portfolio equities only — the names where an intraday break costs money.
    const holdings = stocks.filter(
      (s) => s.bucket === "Portfolio" && s.ticker && (s.instrumentType == null || s.instrumentType === "stock")
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

    const trips: string[] = [];
    const tripIds: string[] = [];
    const consider = (id: string, line: string) => {
      if (fired.has(id)) return;
      tripIds.push(id);
      trips.push(line);
    };

    // ── VIX ──
    const vix = await fetchQuote("^VIX");
    if (vix) {
      const chg = ((vix.price - vix.prevClose) / vix.prevClose) * 100;
      if (chg >= VIX_SPIKE_PCT) {
        consider(`vix-spike`, `VIX spiking: ${vix.price.toFixed(1)} (+${chg.toFixed(0)}% today) — volatility event in progress; check hedges and hold off on adds.`);
      } else if (vix.price >= VIX_LEVEL && vix.prevClose < VIX_LEVEL) {
        consider(`vix-25`, `VIX crossed above ${VIX_LEVEL}: ${vix.price.toFixed(1)} (from ${vix.prevClose.toFixed(1)}) — stress threshold; regime signals may flip at tonight's refresh.`);
      }
    }

    // ── Holdings: 200-DMA breaks + big drops ──
    const queue = [...holdings];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const s = queue.shift();
        if (!s) return;
        const tk = (s.ticker as string).trim();
        const q = await fetchQuote(toYahoo(tk));
        if (!q) continue;
        const chg = ((q.price - q.prevClose) / q.prevClose) * 100;
        const sma200 = s.technicals?.sma200;
        if (typeof sma200 === "number" && sma200 > 0 && q.prevClose >= sma200 && q.price < sma200) {
          consider(
            `${tk}-200dma`,
            `${tk}${s.name ? ` (${s.name})` : ""} broke BELOW its 200-DMA intraday: $${q.price.toFixed(2)} vs 200-DMA $${sma200.toFixed(2)} (${chg >= 0 ? "+" : ""}${chg.toFixed(1)}% today). Major trend level — check the chart before the close.`
          );
        }
        if (chg <= DROP_PCT) {
          consider(
            `${tk}-drop`,
            `${tk}${s.name ? ` (${s.name})` : ""} down ${chg.toFixed(1)}% today ($${q.prevClose.toFixed(2)} → $${q.price.toFixed(2)}). Check for news/print before reacting.`
          );
        }
      }
    });
    await Promise.all(workers);

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
        emailed = await enqueueMail({
          id: nowId,
          to: alertTo,
          subject: `Intraday: ${trips.length} new trip${trips.length === 1 ? "" : "s"} (${ny.date})`,
          text: [
            `INTRADAY MONITOR — ${ny.date}`,
            "",
            ...trips.map((t) => `• ${t}`),
            "",
            "Each trip fires once per day. Levels come from last night's technicals refresh.",
            "https://pm-dashboard-7rr9.vercel.app/",
          ].join("\n"),
          queuedAt: new Date().toISOString(),
        });
      }
      // Mark fired regardless of email config so trips don't pile up unsent.
      for (const id of tripIds) fired.add(id);
      await redis.set(MARKER_KEY, JSON.stringify({ date: ny.date, fired: [...fired] }));
    }

    return NextResponse.json({ ok: true, checked: holdings.length, newTrips: trips.length, emailed });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
