import { describe, expect, it } from "vitest";
import { tickerMatch } from "@/app/lib/rebalance";
import { yahooClassShare } from "@/app/lib/yahoo-symbol";

describe("tickerMatch", () => {
  it("matches identical tickers", () => {
    expect(tickerMatch("AAPL", "AAPL")).toBe(true);
  });
  it("matches -T and .TO forms of the same Canadian listing", () => {
    expect(tickerMatch("CNR-T", "CNR.TO")).toBe(true);
    expect(tickerMatch("CNR.TO", "CNR-T")).toBe(true);
  });
  it("does not match different tickers", () => {
    expect(tickerMatch("CNR-T", "CP.TO")).toBe(false);
    expect(tickerMatch("RY", "RY.TO")).toBe(false);
  });
});

describe("yahooClassShare", () => {
  it("rewrites a class share to Yahoo's dash form", () => {
    expect(yahooClassShare("QQC.F.TO")).toBe("QQC-F.TO");
    expect(yahooClassShare("BBD.B.TO")).toBe("BBD-B.TO");
    expect(yahooClassShare("ABC.U.NE")).toBe("ABC-U.NE");
  });
  it("passes other symbols through unchanged", () => {
    expect(yahooClassShare("AAPL")).toBe("AAPL");
    expect(yahooClassShare("RY.TO")).toBe("RY.TO");
    expect(yahooClassShare("QQC-F.TO")).toBe("QQC-F.TO");
  });
});
