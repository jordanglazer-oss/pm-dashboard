/** Yahoo writes a Canadian share CLASS with a dash: CI's Nasdaq-100 hedged
 *  ETF stored as "QQC.F-T" maps to "QQC.F.TO" by the usual -T → .TO rule,
 *  which Yahoo does not know ("QQC-F.TO" is the listing). Apply right before
 *  building a Yahoo URL; a symbol not in that shape passes through unchanged. */
export function yahooClassShare(symbol: string): string {
  const m = symbol.match(/^([A-Z0-9]+)\.([A-Z]{1,2})\.(TO|V|NE)$/i);
  return m ? `${m[1]}-${m[2]}.${m[3]}` : symbol;
}
