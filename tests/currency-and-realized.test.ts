import { describe, expect, it } from "vitest";
import { baseSymbol, classifyFx, currencyImpact, fxMove, fxRows, isOnHedgedList } from "@/app/lib/currency-impact";
import { tallyRealized, type RealizedDeps } from "@/app/lib/realized-gains";
import type { SaleEvent } from "@/app/lib/sales-ledger";
import type { PimTransaction } from "@/app/lib/pim-types";
import { group, h } from "./helpers";

describe("currency impact — classification", () => {
  it("matches the hedged list on any listing suffix", () => {
    expect(baseSymbol("QQC.F-T")).toBe("QQC.F");
    expect(baseSymbol("QQC-F.TO")).toBe("QQC.F");
    expect(["XSP-T", "XUH.TO", "XSU", "QQC.F-T", "QQC-F.TO"].every(isOnHedgedList)).toBe(true);
    expect(isOnHedgedList("XSPX")).toBe(false);
  });

  it("classifies only what the data supports", () => {
    expect(classifyFx({ symbol: "XSU-T", currency: "CAD", instrumentType: "etf", known: true }).cls).toBe("hedged");
    expect(classifyFx({ symbol: "ZZZ-T", name: "Some US Equity ETF (CAD-Hedged)", currency: "CAD", instrumentType: "etf", known: true }).cls).toBe("hedged");
    expect(classifyFx({ symbol: "ZZZ-T", name: "Some US Equity ETF (Unhedged)", currency: "CAD", instrumentType: "etf", known: true }).cls).toBe("usd-unhedged");
    expect(classifyFx({ symbol: "AAPL", currency: "USD", known: true }).cls).toBe("usd-unhedged");
    expect(classifyFx({ symbol: "RY-T", currency: "CAD", instrumentType: "stock", known: true }).cls).toBe("cad");
    expect(classifyFx({ symbol: "XIC-T", name: "iShares Core S&P/TSX Capped Composite", currency: "CAD", instrumentType: "etf", known: true }).cls).toBe("cad");
    expect(classifyFx({ symbol: "VFV-T", name: "Vanguard S&P 500 Index ETF", currency: "CAD", instrumentType: "etf", known: true }).cls).toBe("usd-unhedged");
    // A global fund holds some US dollars, but how much is not on file → not guessed.
    expect(classifyFx({ symbol: "FID5982", name: "Fidelity Global Innovators Class F", currency: "CAD", instrumentType: "mutual-fund", known: true }).cls).toBe("unclassified");
    expect(classifyFx({ symbol: "MYSTERY-T", currency: "CAD" }).cls).toBe("unclassified");
    // "US" inside a word is not a match.
    expect(classifyFx({ symbol: "BUS-T", name: "Industrial Focus Fund", currency: "CAD", instrumentType: "etf", known: true }).cls).toBe("unclassified");
  });
});

describe("currency impact — maths", () => {
  const fx = [
    { date: "2026-01-02", value: 1.4 },
    { date: "2026-03-31", value: 1.4 },
    { date: "2026-04-01", value: 1.41 },
    { date: "2026-06-30", value: 1.47 },
    { date: "2026-07-02", value: 1.5 },
  ];

  it("measures USD/CAD from the close before the start to the close on/before the end", () => {
    const m = fxMove(fx, "2026-04-01", "2026-06-30")!;
    expect(m.base.date).toBe("2026-03-31");
    expect(m.end.date).toBe("2026-06-30");
    expect(m.pct).toBeCloseTo(5, 6);
    expect(m.partial).toBe(false);
    expect(fxMove(fx, "2025-01-01", "2026-06-30")!.partial).toBe(true);
    expect(fxMove(fx, "2026-07-02", "2026-07-02")).not.toBeNull();
    expect(fxMove([fx[0]], null, "2026-06-30")).toBeNull();
  });

  it("contribution = unhedged weight × FX move; hedging effect = −hedged weight × FX move", () => {
    const g = group("pim", [h("SPY", 0.5, { currency: "USD" }), h("XSP-T", 0.3), h("RY-T", 0.2)]);
    g.profiles = { balanced: { cash: 0, fixedIncome: 0.4, equity: 0.6, alternatives: 0 } };
    const rows = fxRows(g, "balanced", (s) => ({ known: true, instrumentType: s === "RY-T" ? "stock" : "etf" }));
    expect(rows.find((r) => r.symbol === "SPY")!.weight).toBeCloseTo(0.3, 9);
    const out = currencyImpact(rows, fx, "2026-04-01", "2026-06-30");
    expect(out.unhedgedWeight).toBeCloseTo(0.3, 6);
    expect(out.hedgedWeight).toBeCloseTo(0.18, 6);
    expect(out.cadWeight).toBeCloseTo(0.12, 6);
    expect(out.fxPct).toBeCloseTo(5, 4);
    expect(out.contributionPct).toBeCloseTo(1.5, 4);
    expect(out.hedgingEffectPct).toBeCloseTo(-0.9, 4);
    expect(out.series[0]).toEqual({ date: "2026-03-31", value: 0 });
    expect(out.series[out.series.length - 1].value).toBeCloseTo(1.5, 4);
    expect(fxRows(g, "growth", () => ({}))).toEqual([]);
  });
});

describe("realized gains tally", () => {
  const deps: RealizedDeps = {
    currencyOf: (s) => (s === "AAPL" ? "USD" : s === "MYST" ? null : "CAD"),
    fxOn: () => 1.4,
    priceCadOn: (s) => ({ AAPL: 280, "RY-T": 150, "BNS-T": 80 })[s] ?? null,
  };
  const book = [
    { symbol: "AAPL", units: 10, costBasis: 200 },
    { symbol: "RY-T", units: 20, costBasis: 100 },
    { symbol: "BNS-T", units: 10, costBasis: 90 },
  ]; // value = 2800 + 3000 + 800 = 6600
  const ev = (o: Partial<SaleEvent>): SaleEvent => ({ id: "e", at: "2026-11-20T20:00:00.000Z", date: "2026-11-20", groupId: "pim", profile: "balanced", source: "client", sales: [], bookBefore: book, ...o });
  const tx = (o: Partial<PimTransaction>): PimTransaction => ({ id: "t", date: "2026-11-20T19:30:00.000Z", groupId: "pim", type: "sell", symbol: "AAPL", direction: "sell", price: 200, targetWeight: 0, ...o });

  it("pairs a sale with the trade log, converts a US$ fill, and shows it as % of the book", () => {
    const r = tallyRealized(
      [ev({ sales: [{ symbol: "AAPL", unitsBefore: 10, unitsAfter: 4, costBasis: 200 }, { symbol: "BNS-T", unitsBefore: 10, unitsAfter: 0, costBasis: 90 }] })],
      [tx({ symbol: "AAPL", price: 200, profile: "balanced" }), tx({ id: "t2", symbol: "BNS.TO", price: 80 })],
      deps,
      "2026",
    );
    const aapl = r.sales.find((s) => s.symbol === "AAPL")!;
    // 6 units × (200 × 1.4 − 200) = 480 on a 6,600 book.
    expect(aapl.salePriceCad).toBe(280);
    expect(aapl.gainOnCostPct).toBeCloseTo(40, 4);
    expect(aapl.pctOfBook).toBeCloseTo((480 / 6600) * 100, 3);
    expect(aapl.shareSold).toBeCloseTo(0.6, 4);
    const bns = r.sales.find((s) => s.symbol === "BNS-T")!;
    expect(bns.pctOfBook).toBeCloseTo((-100 / 6600) * 100, 3);
    expect(r.books).toHaveLength(1);
    expect(r.books[0]).toMatchObject({ soldAtGain: 1, soldAtLoss: 1 });
    expect(r.books[0].netPct).toBeCloseTo((380 / 6600) * 100, 3);
    expect(r.uncounted).toEqual([]);
  });

  it("never counts a reduction with no matching sell, another profile's sell, an unsettled sale, or an unknown currency", () => {
    const r = tallyRealized(
      [
        ev({ sales: [{ symbol: "RY-T", unitsBefore: 20, unitsAfter: 10, costBasis: 100 }] }), // Edit positions
        ev({ profile: "growth", sales: [{ symbol: "AAPL", unitsBefore: 10, unitsAfter: 0, costBasis: 200 }] }), // sell belongs to balanced
        ev({ date: "2026-11-21", sales: [{ symbol: "BNS-T", unitsBefore: 10, unitsAfter: 0, costBasis: 90 }] }), // pending
        ev({ date: "2026-11-21", sales: [{ symbol: "MYST", unitsBefore: 5, unitsAfter: 0, costBasis: 10 }] }),
        ev({ date: "2025-12-30", sales: [{ symbol: "AAPL", unitsBefore: 10, unitsAfter: 0, costBasis: 200 }] }), // another year
      ],
      [
        tx({ symbol: "AAPL", profile: "balanced" }),
        tx({ id: "p", symbol: "BNS-T", date: "2026-11-21T19:30:00.000Z", price: 0, status: "pending" }),
        tx({ id: "m", symbol: "MYST", date: "2026-11-21T19:30:00.000Z", price: 12 }),
        tx({ id: "b", symbol: "RY-T", direction: "buy", type: "buy" }),
      ],
      deps,
      "2026",
    );
    expect(r.sales).toEqual([]);
    expect(r.books).toEqual([]);
    expect(r.uncounted.map((u) => u.symbol).sort()).toEqual(["AAPL", "BNS-T", "MYST", "RY-T"]);
    expect(r.uncounted.find((u) => u.symbol === "RY-T")!.why).toMatch(/not a trade/);
    expect(r.uncounted.find((u) => u.symbol === "BNS-T")!.why).toMatch(/not settled/);
    expect(r.uncounted.find((u) => u.symbol === "MYST")!.why).toMatch(/currency unknown/);
  });

  it("uses the Eastern day of the trade and values an unpriced holding at cost", () => {
    // 01:30 UTC on the 21st is still the 20th in New York.
    const r = tallyRealized(
      [ev({ bookBefore: [...book, { symbol: "NOPRICE", units: 10, costBasis: 40 }], sales: [{ symbol: "RY-T", unitsBefore: 20, unitsAfter: 0, costBasis: 100 }] })],
      [tx({ symbol: "RY-T", price: 150, date: "2026-11-21T01:30:00.000Z" })],
      deps,
      "2026",
    );
    expect(r.sales).toHaveLength(1);
    expect(r.sales[0].bookValuedAtCost).toEqual(["NOPRICE"]);
    expect(r.sales[0].pctOfBook).toBeCloseTo((1000 / 7000) * 100, 3);
  });
});
