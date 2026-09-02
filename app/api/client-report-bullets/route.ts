import Anthropic from "@anthropic-ai/sdk";
import { parseModelJson } from "@/app/lib/json-repair";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";

/**
 * Client-report presentation bullets.
 *
 * Produces a short, copy-paste-ready set of client-facing talking points
 * about the MODEL itself — broad index exposure, diversification, cost,
 * risk posture, asset mix. Distinct from /api/client-report-analysis,
 * which is the "your portfolio vs our model" comparison and only exists
 * once the PM has typed a client's holdings.
 *
 * Hard editorial rule: NO individual positions. No company names, no
 * tickers, no fund/ETF product names. Everything rolls up to the
 * asset-class / index / sector / geography level so the bullets can be
 * dropped into a client presentation without becoming a stock
 * recommendation.
 *
 * Freshness: the caller is expected to re-pull live report data
 * immediately before POSTing here (the Client Report page's button
 * awaits `refetch()` first), so the bullets can never describe a stale
 * snapshot of the model.
 *
 * Caching mirrors /api/client-report-analysis: the payload is hashed
 * (MD5 over a canonical projection) and stored in
 * `pm:client-report-bullets-cache`. Regenerating on unchanged data is
 * free; `force: true` bypasses the cache.
 *
 * Redis footprint: reads/writes ONE key, `pm:client-report-bullets-cache`,
 * a pure regenerable cache. Touches no user data.
 */

const log = createLogger("Client-report-bullets");

const CACHE_KEY = "pm:client-report-bullets-cache";
const client = new Anthropic();

/** Bump when the prompt changes in a way that should invalidate
 *  previously-cached output. Folded into the hash. */
const PROMPT_VERSION = "v1-index-exposure-themes";

// ───────── Request / response shapes ─────────

type Slice = { label: string; weight: number };

type BulletsRequest = {
  /** "Balanced" / "Growth" / "All-Equity". */
  profileLabel: string;
  /** Asset-allocation slices (percent units). */
  allocation: Slice[];
  /** Post-look-through sector weights (percent of equity exposure). */
  sectors: Slice[];
  /** Post-look-through geography weights (percent). */
  geography: Slice[];
  /** Position-agnostic breadth stats from the look-through. */
  breadth?: {
    /** Distinct underlying companies after look-through. */
    underlyingNames?: number;
    /** Combined weight of the 10 largest underlying names (%). */
    top10Weight?: number;
    /** Number of GICS sectors represented. */
    sectorCount?: number;
  };
  /** Model blended MER (%) and the share of weight it covers. */
  blendedMerPct?: number;
  merCoveragePct?: number;
  /** Cash weight (%). */
  cashWeight?: number;
  performance?: {
    annualizedReturnPct?: number | null;
    sinceInceptionReturnPct?: number | null;
    yearsOfHistory?: number | null;
    volatility?: number | null;
    benchmarkVolatility?: number | null;
    upsideCapture?: number | null;
    downsideCapture?: number | null;
  };
  /** Whether weights came from live positions or target model weights. */
  weightsSource?: "live" | "target";
  force?: boolean;
};

export type ClientReportBullets = {
  bullets: string[];
  generatedAt: string;
};

type CachedBullets = {
  hash: string;
  result: ClientReportBullets;
};

// ───────── Helpers ─────────

function canonicalize(body: BulletsRequest): string {
  const round = (v: number | null | undefined, d = 2) =>
    typeof v === "number" && Number.isFinite(v) ? +v.toFixed(d) : null;
  const slices = (rows: Slice[] | undefined) =>
    [...(rows ?? [])]
      .map((r) => [r.label, round(r.weight, 1)] as [string, number | null])
      .sort();
  const norm = {
    profile: body.profileLabel,
    alloc: slices(body.allocation),
    sect: slices(body.sectors),
    geo: slices(body.geography),
    breadth: {
      n: body.breadth?.underlyingNames ?? null,
      t10: round(body.breadth?.top10Weight, 1),
      s: body.breadth?.sectorCount ?? null,
    },
    mer: round(body.blendedMerPct, 3),
    cov: round(body.merCoveragePct, 0),
    cash: round(body.cashWeight, 1),
    perf: {
      a: round(body.performance?.annualizedReturnPct),
      si: round(body.performance?.sinceInceptionReturnPct),
      y: round(body.performance?.yearsOfHistory, 1),
      v: round(body.performance?.volatility, 4),
      bv: round(body.performance?.benchmarkVolatility, 4),
      u: round(body.performance?.upsideCapture, 1),
      d: round(body.performance?.downsideCapture, 1),
    },
    src: body.weightsSource ?? null,
    pv: PROMPT_VERSION,
  };
  return JSON.stringify(norm);
}

function hashBody(body: BulletsRequest): string {
  return createHash("md5").update(canonicalize(body)).digest("hex");
}

async function getCached(hash: string): Promise<ClientReportBullets | null> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedBullets;
    return cached.hash === hash ? cached.result : null;
  } catch {
    return null;
  }
}

async function saveCached(hash: string, result: ClientReportBullets) {
  try {
    const redis = await getRedis();
    await redis.set(CACHE_KEY, JSON.stringify({ hash, result } satisfies CachedBullets));
  } catch (e) {
    log.error("failed to cache bullets:", e);
  }
}

// ───────── Prompt ─────────

function buildPrompt(body: BulletsRequest): string {
  const fmtPct = (v: number | null | undefined, d = 1) =>
    typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(d)}%` : null;
  const line = (label: string, value: string | null) =>
    value ? `  - ${label}: ${value}` : "";

  const allocBlock =
    body.allocation
      ?.filter((a) => a.weight > 0)
      .map((a) => `  - ${a.label}: ${a.weight.toFixed(1)}%`)
      .join("\n") || "  (none provided)";

  const sectorBlock =
    body.sectors
      ?.slice(0, 11)
      .map((s) => `  - ${s.label}: ${s.weight.toFixed(1)}%`)
      .join("\n") || "  (none provided)";

  const geoBlock =
    body.geography
      ?.filter((g) => g.weight > 0)
      .map((g) => `  - ${g.label}: ${g.weight.toFixed(1)}%`)
      .join("\n") || "  (none provided)";

  const breadthBlock =
    [
      line(
        "Distinct underlying companies (after look-through)",
        body.breadth?.underlyingNames != null ? String(body.breadth.underlyingNames) : null,
      ),
      line("Combined weight of the 10 largest underlying names", fmtPct(body.breadth?.top10Weight)),
      line(
        "Sectors represented",
        body.breadth?.sectorCount != null ? String(body.breadth.sectorCount) : null,
      ),
    ]
      .filter(Boolean)
      .join("\n") || "  (none provided)";

  const feeBlock =
    typeof body.blendedMerPct === "number" && Number.isFinite(body.blendedMerPct)
      ? `  - Blended management expense ratio: ${body.blendedMerPct.toFixed(2)}%${
          typeof body.merCoveragePct === "number"
            ? ` (covers ${body.merCoveragePct.toFixed(0)}% of portfolio weight)`
            : ""
        }`
      : "  (fee data unavailable — do not mention a fee number)";

  const perf = body.performance;
  const perfBlock =
    [
      line("Annualized return since inception (HISTORICAL)", fmtPct(perf?.annualizedReturnPct, 2)),
      line("Cumulative return since inception (HISTORICAL)", fmtPct(perf?.sinceInceptionReturnPct, 2)),
      line(
        "Length of live track record",
        perf?.yearsOfHistory != null ? `${perf.yearsOfHistory.toFixed(1)} years` : null,
      ),
      line(
        "Portfolio annualized standard deviation",
        // volatility is carried as a FRACTION (0.14 = 14%) on the report.
        perf?.volatility != null ? fmtPct(perf.volatility * 100, 1) : null,
      ),
      line(
        "S&P 500 annualized standard deviation",
        perf?.benchmarkVolatility != null ? fmtPct(perf.benchmarkVolatility * 100, 1) : null,
      ),
      line("Upside capture vs S&P 500", fmtPct(perf?.upsideCapture, 0)),
      line("Downside capture vs S&P 500", fmtPct(perf?.downsideCapture, 0)),
    ]
      .filter(Boolean)
      .join("\n") || "  (no performance data provided)";

  return `You are writing client-facing talking points for a portfolio manager at RBC Dominion Securities. The bullets will be pasted into a client presentation describing the ${body.profileLabel} PIM model portfolio. The audience is a retail client, not an analyst.

ALL figures below are current as of right now (the manager re-pulled live data immediately before this request). Use only these numbers.

ASSET ALLOCATION:
${allocBlock}
${
  // Only surface cash separately when the allocation list doesn't
  // already carry a Cash slice — otherwise the model sees the same
  // number twice and tends to write two bullets about it.
  typeof body.cashWeight === "number" &&
  body.cashWeight > 0 &&
  !body.allocation?.some((a) => /cash/i.test(a.label))
    ? `  - Cash: ${body.cashWeight.toFixed(1)}%\n`
    : ""
}
SECTOR EXPOSURE (post look-through, % of equity):
${sectorBlock}

GEOGRAPHIC EXPOSURE:
${geoBlock}

DIVERSIFICATION / BREADTH:
${breadthBlock}

COST:
${feeBlock}

RISK AND HISTORICAL PERFORMANCE:
${perfBlock}

ABSOLUTE RULES — a bullet that breaks any of these is unusable:
  1. NEVER name an individual position. No company names, no ticker symbols, no fund or ETF product names, no manager or issuer names. If you catch yourself writing a proper noun for a security, replace it with the asset-class, index, sector, or geographic concept instead ("broad U.S. large-cap index exposure", "the Canadian equity sleeve", "the fixed-income sleeve").
  2. Reference broad index/market concepts only ("S&P 500", "TSX", "U.S. large-cap", "broad market") — never a specific product that tracks them.
  3. No predictions, forecasts, guarantees, or promises about future returns. No "will outperform", "should deliver", "expected to". Describe how the portfolio is BUILT and how it has BEHAVED.
  4. Any return figure must be labelled as historical / since inception. Never present a past return as an expected future return.
  5. Use only the numbers supplied above. If a number isn't provided, write the bullet qualitatively or drop it — never invent or estimate one.
  6. NEVER use "international equities", "international exposure", or any variant. The model is deliberately U.S.-heavy and those holdings are globally diversified operators. Say "global equity exposure" when the concept is needed. Never suggest adding ex-U.S. exposure.
  7. Plain English. One sentence per bullet, maximum 24 words. No markdown, no bold, no bullet characters — the presentation styles them.
  8. No client name, no manager name, no salesy superlatives ("best-in-class", "unrivalled").

CONTENT: produce 5 bullets (4 minimum, 6 maximum). Across the set, cover these themes — one bullet each, in roughly this order:
  a. Efficient, low-cost broad index exposure at the core of the portfolio (quote the blended MER only if provided).
  b. Diversification and breadth — how many underlying companies the client effectively owns, across how many sectors, and how little sits in the largest names.
  c. Asset mix and how it matches the ${body.profileLabel} risk profile (equity / fixed income / cash split).
  d. Risk posture — volatility versus the index, and capture ratios if provided (quote downside capture only when it is favourable, i.e. below 100%).
  e. A general positioning theme visible in the data — e.g. where the sector weight is concentrated, the U.S./Canada/global balance, or the discipline of a professionally managed, systematically rebalanced structure.

Return JSON only, no prose and no code fences:

{ "bullets": [string, string, string, string, string] }`;
}

function tryParse(text: string): string[] | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();
  const res = parseModelJson<{ bullets?: unknown }>(cleaned);
  if (!res.ok) {
    log.error("JSON parse failed:", res.error, res.excerpt ?? "");
    return null;
  }
  const raw = res.value?.bullets;
  if (!Array.isArray(raw)) return null;
  const bullets = raw
    .map((b) =>
      typeof b === "string"
        ? b.replace(/^[-•*]\s*/, "").replace(/\*\*/g, "").trim()
        : "",
    )
    .filter(Boolean);
  return bullets.length ? bullets : null;
}

// ───────── Route handler ─────────

export async function POST(req: NextRequest) {
  let body: BulletsRequest;
  try {
    body = (await req.json()) as BulletsRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body?.profileLabel || !Array.isArray(body.allocation)) {
    return NextResponse.json(
      { error: "profileLabel and allocation are required" },
      { status: 400 },
    );
  }

  const hash = hashBody(body);
  if (!body.force) {
    const cached = await getCached(hash);
    if (cached) {
      log.info("cache hit for", body.profileLabel);
      return NextResponse.json({ result: cached, cached: true, hash });
    }
  }

  let bullets: string[] | null = null;
  try {
    const msg = await client.messages.create({
      model: "claude-sonnet-5",
      thinking: { type: "disabled" },
      max_tokens: 1024,
      messages: [{ role: "user", content: buildPrompt(body) }],
    });
    const text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
    bullets = tryParse(text);
    if (!bullets) log.error("unparseable model output:", text.slice(0, 400));
  } catch (e) {
    log.error("Anthropic call failed:", e);
  }

  if (!bullets) {
    return NextResponse.json(
      { error: "Failed to generate bullets. Try again in a moment." },
      { status: 502 },
    );
  }

  const result: ClientReportBullets = {
    bullets: bullets.slice(0, 6),
    generatedAt: new Date().toISOString(),
  };
  await saveCached(hash, result);
  return NextResponse.json({ result, cached: false, hash });
}
