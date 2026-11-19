import type { PimHolding, PimModelGroup } from "@/app/lib/pim-types";
import type { Stock } from "@/app/lib/types";

/** A minimal PimHolding. */
export function h(symbol: string, weightInClass: number, extra: Partial<PimHolding> = {}): PimHolding {
  return { name: symbol, symbol, currency: "CAD", assetClass: "equity", weightInClass, ...extra };
}

export function group(id: string, holdings: PimHolding[], equity = 1): PimModelGroup {
  return {
    id,
    name: id.toUpperCase(),
    profiles: { allEquity: { cash: 0, fixedIncome: 0, equity, alternatives: 0 } },
    cadSplit: 0.5,
    usdSplit: 0.5,
    holdings,
  };
}

/** A minimal pm:stocks record (only the fields the PIM math reads). */
export function stock(ticker: string, extra: Partial<Stock> = {}): Stock {
  return { ticker, bucket: "Portfolio", ...extra } as Stock;
}

export const equitySum = (holdings: PimHolding[]) =>
  holdings.filter((x) => x.assetClass === "equity").reduce((a, x) => a + x.weightInClass, 0);

export const weightOf = (holdings: PimHolding[], symbol: string) => holdings.find((x) => x.symbol === symbol)?.weightInClass;
