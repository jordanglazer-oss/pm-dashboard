/**
 * GET /api/admin/diagnose-forward
 *
 * READ-ONLY diagnostic. Hits every external data source the
 * forward-looking bundle depends on and reports the actual response —
 * status code, latest observation date, value, and any error string.
 *
 * Built after the 2026-05-26 incident where many tiles started showing
 * STALE simultaneously and we needed to know whether the cause was:
 *   - FRED API key missing/expired
 *   - FRED publishing delay on specific series
 *   - Vercel→FRED network issue
 *   - Per-series rate limiting
 *   - Date parsing bug in fredStatusFromDate()
 *
 * Returns one row per source so we can see the truth in one shot
 * instead of guessing from UI symptoms.
 */

import { NextResponse } from "next/server";

const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";

type SourceResult = {
  source: string;
  ok: boolean;
  status?: number;
  latestDate?: string;
  latestValue?: number | string | null;
  ageDays?: number;
  willBeStale?: boolean; // true if ageDays > 5 (matches fredStatusFromDate)
  error?: string;
  raw?: unknown;
};

async function probeFred(seriesId: string): Promise<SourceResult> {
  const key = process.env.FRED_API_KEY;
  if (!key) {
    return { source: `FRED:${seriesId}`, ok: false, error: "FRED_API_KEY not configured" };
  }
  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${key}&file_type=json&sort_order=desc&limit=3`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        source: `FRED:${seriesId}`,
        ok: false,
        status: res.status,
        error: body.slice(0, 200),
      };
    }
    const data = await res.json();
    const obs = Array.isArray(data?.observations) ? data.observations : [];
    if (obs.length === 0) {
      return {
        source: `FRED:${seriesId}`,
        ok: true,
        status: res.status,
        error: "FRED returned 0 observations",
        raw: data,
      };
    }
    const latest = obs[0] as { date: string; value: string };
    const valueNum = parseFloat(latest.value);
    const ageDays = (Date.now() - new Date(latest.date + "T00:00:00Z").getTime()) / 86400000;
    return {
      source: `FRED:${seriesId}`,
      ok: true,
      status: res.status,
      latestDate: latest.date,
      latestValue: isNaN(valueNum) ? latest.value : valueNum,
      ageDays: parseFloat(ageDays.toFixed(2)),
      willBeStale: ageDays > 5,
    };
  } catch (e) {
    return {
      source: `FRED:${seriesId}`,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function probeFinvizBreadth(): Promise<SourceResult[]> {
  const urls = [
    { label: "Finviz S&P 500 >200DMA", url: "https://finviz.com/screener?v=111&f=idx_sp500,ta_sma200_pa&ft=4" },
    { label: "Finviz S&P 500 >50DMA", url: "https://finviz.com/screener?v=111&f=idx_sp500,ta_sma50_pa&ft=4" },
  ];
  return Promise.all(
    urls.map(async ({ label, url }) => {
      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
            Referer: "https://finviz.com/",
          },
          cache: "no-store",
          redirect: "follow",
        });
        if (!res.ok) {
          return { source: label, ok: false, status: res.status, error: `non-200` };
        }
        const html = await res.text();
        const m = html.match(/#1\s*\/\s*(\d+)/) || html.match(/\b1\s*\/\s*(\d+)\s*Total\b/i);
        if (!m) {
          // Look for telltale Cloudflare challenge markers
          const looksLikeChallenge =
            html.includes("cf-challenge") ||
            html.includes("Just a moment") ||
            html.includes("Checking your browser") ||
            html.length < 2000;
          return {
            source: label,
            ok: false,
            status: res.status,
            error: looksLikeChallenge
              ? `Cloudflare challenge page (html length=${html.length})`
              : `no count pattern matched (html length=${html.length})`,
          };
        }
        const n = parseInt(m[1], 10);
        return {
          source: label,
          ok: true,
          status: res.status,
          latestValue: `${n} / 500 = ${((n / 500) * 100).toFixed(1)}%`,
        };
      } catch (e) {
        return { source: label, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
}

async function probeYahooAuth(): Promise<SourceResult> {
  try {
    // Step 1: consent cookie
    const consentRes = await fetch("https://finance.yahoo.com", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      redirect: "manual",
    });
    const cookie = consentRes.headers.get("set-cookie") ?? "";
    if (!cookie) {
      return {
        source: "Yahoo auth (consent cookie)",
        ok: false,
        status: consentRes.status,
        error: "no set-cookie header returned",
      };
    }
    // Step 2: crumb exchange
    const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Cookie: cookie,
      },
    });
    if (!crumbRes.ok) {
      return {
        source: "Yahoo auth (crumb)",
        ok: false,
        status: crumbRes.status,
        error: await crumbRes.text().catch(() => "non-200 from getcrumb"),
      };
    }
    const crumb = (await crumbRes.text()).trim();
    return {
      source: "Yahoo auth (crumb)",
      ok: crumb.length >= 5 && !crumb.includes("<"),
      latestValue: crumb.length < 5 ? `(empty crumb: "${crumb}")` : `(crumb received: ${crumb.length} chars)`,
    };
  } catch (e) {
    return { source: "Yahoo auth", ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function GET() {
  const startedAt = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  // Run all probes in parallel
  const [
    sp500,
    dgs10,
    dgs2,
    dgs3mo,
    vixcls,
    hyOas,
    igOas,
    finviz,
    yahooAuth,
  ] = await Promise.all([
    probeFred("SP500"),
    probeFred("DGS10"),
    probeFred("DGS2"),
    probeFred("DGS3MO"),
    probeFred("VIXCLS"),
    probeFred("BAMLH0A0HYM2"),
    probeFred("BAMLC0A0CM"),
    probeFinvizBreadth(),
    probeYahooAuth(),
  ]);

  const allResults: SourceResult[] = [
    sp500,
    dgs10,
    dgs2,
    dgs3mo,
    vixcls,
    hyOas,
    igOas,
    ...finviz,
    yahooAuth,
  ];

  return NextResponse.json({
    ok: true,
    today,
    elapsedMs: Date.now() - startedAt,
    fredConfigured: !!process.env.FRED_API_KEY,
    stalenessThresholdDays: 5,
    sources: allResults,
    summary: {
      fredFresh: allResults.filter(
        (r) => r.source.startsWith("FRED:") && r.ok && r.willBeStale === false,
      ).length,
      fredStale: allResults.filter(
        (r) => r.source.startsWith("FRED:") && r.ok && r.willBeStale === true,
      ).length,
      fredFailed: allResults.filter((r) => r.source.startsWith("FRED:") && !r.ok).length,
      finvizOk: finviz.filter((r) => r.ok).length,
      yahooAuthOk: yahooAuth.ok,
    },
  });
}
