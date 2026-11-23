import { describe, expect, it } from "vitest";
import { classifyMove, classifyMoveAgainst, industryEtfs } from "@/app/lib/agents/holdings-watch";
import { vixBand } from "@/app/lib/agents/stance-watch";
import { parseAgentJson } from "@/app/lib/agents/gateway";

describe("holdings watch classification", () => {
  it("sets tech names against XLK, semis and software", () => {
    expect(industryEtfs("Information Technology")).toEqual(["XLK", "SMH", "IGV"]);
    expect(industryEtfs("Financials")).toEqual(["XLF"]);
    expect(industryEtfs(undefined)).toEqual([]);
  });

  it("explains a semis-led fall that XLK alone would call company-specific (2026-11-20)", () => {
    // ANET -11.6%, SPY -3.6%, XLK -7.3%, SMH -10.6%
    expect(classifyMove(-11.6, 1.3, -3.6, -7.3).class).toBe("company");
    const r = classifyMoveAgainst(-11.6, 1.3, -3.6, [
      { symbol: "XLK", pct: -7.3 },
      { symbol: "SMH", pct: -10.6 },
      { symbol: "IGV", pct: -4.6 },
    ]);
    expect(r.class).toBe("sector");
    expect(r.symbol).toBe("SMH");
    expect(r.residual).toBeCloseTo(-1, 5);
  });

  it("keeps the old single-ETF behaviour", () => {
    expect(classifyMove(-5, 1, -4.5, null)).toEqual({ residual: -0.5, class: "market" });
    expect(classifyMove(-9, 1, -1, -1).class).toBe("company");
  });
});

describe("VIX band", () => {
  it("does not flip back to normal on a small dip below 25", () => {
    expect(vixBand(25.5)).toBe("high");
    expect(vixBand(24.6, "high")).toBe("high");
    expect(vixBand(22.9, "high")).toBe("normal");
    expect(vixBand(24.6, "normal")).toBe("normal");
    expect(vixBand(17, "complacent")).toBe("complacent");
  });
});

describe("watcher JSON", () => {
  it("refuses an answer cut off at max_tokens instead of repairing it", () => {
    expect(parseAgentJson({ text: '{"title": "NVDA beat and', truncated: true }).ok).toBe(false);
    expect(parseAgentJson({ text: '{"title": "ok"}', truncated: false })).toMatchObject({ ok: true, value: { title: "ok" } });
  });
});
