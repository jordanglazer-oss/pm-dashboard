import { describe, expect, it } from "vitest";
import { auditFindings } from "@/app/lib/agents/portfolio-audit";
import type { PimModelData } from "@/app/lib/pim-types";
import { group, h, stock } from "./helpers";

const stocks = [stock("AAPL"), stock("MSFT"), stock("NVDA"), stock("XIC", { instrumentType: "etf", designation: "core" }), stock("GRNJ", { instrumentType: "mutual-fund", designation: "thematic" })];
const models = { groups: [group("pim", [h("XIC", 0.84), h("AAPL", 0.02), h("MSFT", 0.02), h("NVDA", 0.02), h("GRNJ", 0.1)])] } as unknown as PimModelData;
const today = "2026-11-19";
const pillar = (id: string, o: object = {}) => ({ id, title: `Pillar ${id}`, claim: "c", ...o });

describe("portfolio audit rules", () => {
  it("held stocks = model equity outside Core and Managed Alpha", () => {
    expect(auditFindings(models, stocks, {}, today).held).toEqual(["AAPL", "MSFT", "NVDA"]);
  });

  it("lists every held stock with no signed thesis in ONE finding", () => {
    const r = auditFindings(models, stocks, { AAPL: { underwrittenAt: "2026-10-01", pillars: [pillar("a", { status: "intact", statusSince: "2026-10-01" })] } }, today);
    const f = r.findings.find((x) => x.rule === "no-signed-thesis")!;
    expect(f.names).toEqual(["MSFT", "NVDA"]);
    expect(f.dedupeKey).toBe("audit-no-signed-thesis-2026-11");
    expect(r.findings).toHaveLength(1);
  });

  it("a pillar broken for 14+ days on a held stock is flagged per name; a fresh one is not", () => {
    const theses = {
      AAPL: { underwrittenAt: "2026-10-01", pillars: [pillar("a", { status: "broken", statusSince: "2026-11-01" })] },
      MSFT: { underwrittenAt: "2026-10-01", pillars: [pillar("a", { status: "broken", statusSince: "2026-11-15" })] },
      NVDA: { underwrittenAt: "2026-10-01", pillars: [pillar("a", { status: "intact", statusSince: "2026-10-01" })] },
    };
    const f = auditFindings(models, stocks, theses, today).findings;
    expect(f.map((x) => `${x.rule}:${x.ticker}`)).toEqual(["broken-pillar-held:AAPL"]);
  });

  it("a stale thesis and a long-tripped breaker are found; a thesis for a name we do not hold is ignored", () => {
    const theses = {
      AAPL: { underwrittenAt: "2026-01-01", pillars: [pillar("a", { status: "intact", statusSince: "2026-01-01" })] },
      MSFT: { underwrittenAt: "2026-10-01", pillars: [pillar("a", { status: "intact", statusSince: "2026-10-01" })], killConditions: [{ id: "k1", kind: "custom", note: "RPO falls", addedAt: "2026-10-01", trippedAt: "2026-10-20T12:00:00.000Z" }] },
      NVDA: { underwrittenAt: "2026-10-01", pillars: [pillar("a", { status: "intact", statusSince: "2026-10-01" })] },
      TSLA: { pillars: [pillar("a", { status: "broken", statusSince: "2026-01-01" })] },
    };
    const f = auditFindings(models, stocks, theses as never, today).findings;
    expect(f.map((x) => x.rule).sort()).toEqual(["stale-thesis", "tripped-breaker-held"]);
    expect(f.every((x) => x.ticker !== "TSLA")).toBe(true);
  });
});
