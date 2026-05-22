/**
 * GET /api/admin/health
 *
 * Pings every external data source the app depends on in parallel and
 * reports per-source status. Designed to be the first place to look
 * when a tile shows N/A — instead of guessing whether Finviz, Yahoo,
 * FRED, or CNN broke, you open /admin/health and the failing source
 * is highlighted red.
 *
 * Each check:
 *   - Has its own short timeout (6s) so one slow upstream doesn't
 *     hold up the whole report
 *   - Returns latency in ms so we can spot degrading-but-not-yet-dead
 *     sources
 *   - Treats HTTP 200 with the expected response shape as "ok",
 *     non-200 / timeout / unparseable as "fail"
 *
 * Read-only. Does NOT update any cache, mutate Redis, or trigger
 * downstream computations.
 */

import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("Health");

// Common browser-fingerprint UA used across the scraping helpers.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const TIMEOUT_MS = 6000;

type Status = "ok" | "warn" | "fail" | "skipped";

type CheckResult = {
  name: string;
  category: "prices" | "sentiment" | "macro" | "ai" | "infra";
  status: Status;
  latencyMs: number | null;
  message: string;
  // Optional source URL the user can click to verify manually.
  sourceUrl?: string;
};

async function timed(
  name: string,
  category: CheckResult["category"],
  fn: () => Promise<{ status: Status; message: string; sourceUrl?: string }>,
): Promise<CheckResult> {
  const start = Date.now();
  try {
    // Wrap each check in a hard timeout so the slowest upstream can't
    // hold the whole health page.
    const result = await Promise.race([
      fn(),
      new Promise<{ status: Status; message: string }>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
      ),
    ]);
    return {
      name,
      category,
      status: result.status,
      latencyMs: Date.now() - start,
      message: result.message,
      sourceUrl: "sourceUrl" in result ? result.sourceUrl : undefined,
    };
  } catch (e) {
    return {
      name,
      category,
      status: "fail",
      latencyMs: Date.now() - start,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

async function fetchWithUA(url: string): Promise<Response> {
  return fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    cache: "no-store",
    redirect: "follow",
  });
}

// ── Individual source checks ─────────────────────────────────────────────

async function checkYahoo(): Promise<CheckResult> {
  return timed("Yahoo prices", "prices", async () => {
    const res = await fetch("https://query2.finance.yahoo.com/v7/finance/quote?symbols=SPY", {
      headers: { "User-Agent": UA },
      cache: "no-store",
    });
    if (!res.ok) return { status: "fail", message: `HTTP ${res.status}` };
    const data = await res.json();
    const price = data?.quoteResponse?.result?.[0]?.regularMarketPrice;
    if (typeof price !== "number") return { status: "fail", message: "no price in response" };
    return { status: "ok", message: `SPY @ ${price.toFixed(2)}` };
  });
}

async function checkFinvizBreadth(): Promise<CheckResult> {
  return timed("Finviz S&P breadth", "sentiment", async () => {
    const url = "https://finviz.com/screener?v=111&f=idx_sp500,ta_sma200_pa&ft=4";
    const res = await fetchWithUA(url);
    if (!res.ok) return { status: "fail", message: `HTTP ${res.status}`, sourceUrl: url };
    const html = await res.text();
    if (!html || html.length < 2000) {
      return { status: "fail", message: `short body (${html?.length ?? 0} chars) — likely bot challenge`, sourceUrl: url };
    }
    const m = html.match(/#1\s*\/\s*(\d+)/) || html.match(/\b1\s*\/\s*(\d+)\s*Total\b/i);
    if (!m) return { status: "fail", message: "no count pattern matched — Finviz may have changed layout", sourceUrl: url };
    const n = parseInt(m[1], 10);
    return { status: "ok", message: `${n} of 500 (${((n / 500) * 100).toFixed(1)}%) above 200DMA`, sourceUrl: url };
  });
}

async function checkFRED(): Promise<CheckResult> {
  return timed("FRED (St. Louis Fed)", "macro", async () => {
    const key = process.env.FRED_API_KEY;
    if (!key) return { status: "skipped", message: "FRED_API_KEY not set" };
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=SOFR&api_key=${key}&file_type=json&sort_order=desc&limit=1`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return { status: "fail", message: `HTTP ${res.status}` };
    const data = await res.json();
    const obs = data?.observations?.[0];
    if (!obs?.value || obs.value === ".") {
      return { status: "warn", message: "no recent observation" };
    }
    return { status: "ok", message: `SOFR ${obs.value}% as of ${obs.date}`, sourceUrl: "https://fred.stlouisfed.org/series/SOFR" };
  });
}

async function checkCnnFearGreed(): Promise<CheckResult> {
  return timed("CNN Fear & Greed", "sentiment", async () => {
    const url = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Origin: "https://www.cnn.com",
        Referer: "https://www.cnn.com/",
      },
      cache: "no-store",
    });
    if (!res.ok) return { status: "fail", message: `HTTP ${res.status}` };
    const data = await res.json();
    const score = data?.fear_and_greed?.score;
    if (typeof score !== "number") return { status: "fail", message: "no score field" };
    return { status: "ok", message: `index ${Math.round(score)}`, sourceUrl: "https://www.cnn.com/markets/fear-and-greed" };
  });
}

async function checkAAII(): Promise<CheckResult> {
  return timed("AAII sentiment", "sentiment", async () => {
    const url = "https://www.aaii.com/files/surveys/sentiment.xls";
    const res = await fetch(url, { headers: { "User-Agent": UA }, cache: "no-store" });
    if (!res.ok) return { status: "fail", message: `HTTP ${res.status}`, sourceUrl: url };
    // Don't parse the XLS — just confirm the file is downloadable and
    // looks like a real workbook (binary, >100KB historically). The
    // detailed parser lives in forward-looking.ts.
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 50_000) {
      return { status: "warn", message: `file smaller than expected (${buf.byteLength} bytes)`, sourceUrl: url };
    }
    return { status: "ok", message: `${(buf.byteLength / 1024).toFixed(0)} KB downloaded`, sourceUrl: url };
  });
}

async function checkSSGA(): Promise<CheckResult> {
  return timed("SSGA (SPY product page)", "macro", async () => {
    const url = "https://www.ssga.com/us/en/intermediary/etfs/spdr-sp-500-etf-trust-spy";
    const res = await fetchWithUA(url);
    if (!res.ok) return { status: "fail", message: `HTTP ${res.status}`, sourceUrl: url };
    const html = await res.text();
    // SSGA renders the P/E ratio on the product page; if we can't find
    // any P/E-shaped number the scrape will fail downstream too.
    if (html.length < 50_000) {
      return { status: "warn", message: `page smaller than expected (${html.length} chars)`, sourceUrl: url };
    }
    return { status: "ok", message: `${(html.length / 1024).toFixed(0)} KB downloaded`, sourceUrl: url };
  });
}

async function checkAnthropic(): Promise<CheckResult> {
  return timed("Anthropic API (env)", "ai", async () => {
    // Deliberately do NOT call the Anthropic API — every call costs money
    // and we don't want the health page running up the bill. Just
    // confirm the env var that the SDK reads is present.
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return { status: "fail", message: "ANTHROPIC_API_KEY not set" };
    return { status: "ok", message: `key present (${key.length} chars)` };
  });
}

async function checkRedis(): Promise<CheckResult> {
  return timed("Redis (Upstash)", "infra", async () => {
    // Read a key we know exists (stocks blob) and report whether it
    // parses. We don't ping a fake key because Upstash's response for a
    // missing key is ambiguous between "fine but empty" and "outage".
    const client = await getRedis();
    const raw = await client.get("pm:stocks");
    if (raw == null) {
      return { status: "warn", message: "pm:stocks not found (fresh install?)" };
    }
    const size = typeof raw === "string" ? raw.length : JSON.stringify(raw).length;
    return { status: "ok", message: `pm:stocks blob ${(size / 1024).toFixed(1)} KB` };
  });
}

async function checkEdgar(): Promise<CheckResult> {
  return timed("SEC EDGAR", "macro", async () => {
    const url = "https://www.sec.gov/files/company_tickers.json";
    const ua = process.env.SEC_USER_AGENT;
    if (!ua) return { status: "warn", message: "SEC_USER_AGENT not set — EDGAR will reject scoring fetches" };
    const res = await fetch(url, { headers: { "User-Agent": ua }, cache: "no-store" });
    if (!res.ok) return { status: "fail", message: `HTTP ${res.status}` };
    const data = await res.json();
    const count = Object.keys(data ?? {}).length;
    return { status: "ok", message: `${count.toLocaleString()} tickers indexed`, sourceUrl: url };
  });
}

export async function GET() {
  const checks = await Promise.all([
    checkYahoo(),
    checkFinvizBreadth(),
    checkFRED(),
    checkCnnFearGreed(),
    checkAAII(),
    checkSSGA(),
    checkEdgar(),
    checkAnthropic(),
    checkRedis(),
  ]);

  const failed = checks.filter((c) => c.status === "fail");
  if (failed.length > 0) {
    log.warn(`${failed.length} check(s) failed: ${failed.map((c) => c.name).join(", ")}`);
  }

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    summary: {
      ok: checks.filter((c) => c.status === "ok").length,
      warn: checks.filter((c) => c.status === "warn").length,
      fail: failed.length,
      skipped: checks.filter((c) => c.status === "skipped").length,
      total: checks.length,
    },
    checks,
  });
}
