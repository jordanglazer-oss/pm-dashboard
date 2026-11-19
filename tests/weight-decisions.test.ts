import { describe, expect, it } from "vitest";
import { reconcile } from "@/app/lib/weight-decisions";
import { group, h, stock } from "./helpers";

const stocks = [
  stock("AAPL"),
  stock("MSFT"),
  stock("XIC", { instrumentType: "etf", designation: "core" }),
  stock("FID5982", { instrumentType: "mutual-fund", designation: "thematic" }),
  stock("GRNJ", { instrumentType: "mutual-fund", designation: "thematic" }),
];

const AT = "2026-11-01T00:00:00.000Z"; // decision timestamp (required by WeightDecision)

// allEquity = 100% equity → the 10%-of-portfolio stock cap is 0.10 in class.
const g = group("pim", [h("XIC", 0.76), h("AAPL", 0.02), h("MSFT", 0.02), h("FID5982", 0.1), h("GRNJ", 0.1)]);

describe("reconcile (weight decisions)", () => {
  it("offsetting changes inside the Alpha bucket net to zero → ok", () => {
    const r = reconcile(g, stocks, {
      AAPL: { action: "set", at: AT, targetInClass: 0.03 },
      MSFT: { action: "set", at: AT, targetInClass: 0.01 },
    });
    expect(r.ok).toBe(true);
    expect(r.nets.find((n) => n.bucket === "alpha")!.delta).toBeCloseTo(0, 9);
  });

  it("does NOT net across buckets (Alpha up, Thematic down → refused)", () => {
    const r = reconcile(g, stocks, {
      AAPL: { action: "set", at: AT, targetInClass: 0.03 },
      GRNJ: { action: "set", at: AT, targetInClass: 0.09 },
    });
    expect(r.ok).toBe(false);
    expect(r.nets.find((n) => n.bucket === "alpha")).toMatchObject({ ok: false });
    expect(r.nets.find((n) => n.bucket === "thematic")).toMatchObject({ ok: false });
  });

  it("Thematic funds net among themselves", () => {
    const r = reconcile(g, stocks, {
      FID5982: { action: "set", at: AT, targetInClass: 0.12 },
      GRNJ: { action: "set", at: AT, targetInClass: 0.08 },
    });
    expect(r.ok).toBe(true);
  });

  it("a decision on a Core holding is refused", () => {
    const r = reconcile(g, stocks, { XIC: { action: "set", at: AT, targetInClass: 0.7 } });
    expect(r.coreDecided).toEqual(["XIC"]);
    expect(r.ok).toBe(false);
  });

  it("a stock above the 10%-of-portfolio cap is refused", () => {
    const r = reconcile(g, stocks, {
      AAPL: { action: "set", at: AT, targetInClass: 0.11 },
      MSFT: { action: "set", at: AT, targetInClass: -0.07 },
    });
    expect(r.capBreaches.map((c) => c.symbol)).toEqual(["AAPL"]);
    expect(r.ok).toBe(false);
  });

  it("'keep' changes nothing; 'release' nets like a set to the release weight", () => {
    expect(reconcile(g, stocks, { AAPL: { action: "keep", at: AT } }).ok).toBe(true);
    const r = reconcile(g, stocks, { AAPL: { action: "release", at: AT }, MSFT: { action: "set", at: AT, targetInClass: 0.01 } }, 0.03);
    expect(r.ok).toBe(true);
  });
});
