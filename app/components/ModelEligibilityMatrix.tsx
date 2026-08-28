"use client";

import { useStocks } from "@/app/lib/StockContext";
import { displayTicker } from "@/app/lib/ticker";

/**
 * Model eligibility matrix — every scoreable Portfolio name × every PIM model
 * group, one checkbox per cell. This replaces the per-stock "Model
 * Eligibility" section on STOCK pages (funds keep theirs, since their weight
 * overrides + US-equity % live there). Same data (stock.modelEligibility) and
 * the same toggleModelEligibility write path the stock page used — one
 * surface instead of forty.
 */
export function ModelEligibilityMatrix() {
  const { scoredStocks, pimModels, toggleModelEligibility, uiPrefs, setUiPref } = useStocks();
  const collapsed = (uiPrefs["models.eligibilityMatrix.collapsed"] ?? "1") === "1";
  const rows = scoredStocks
    .filter((s) => s.bucket === "Portfolio" && (!s.instrumentType || s.instrumentType === "stock"))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
  const groups = pimModels.groups;
  if (rows.length === 0 || groups.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-card border border-line bg-white shadow-sm">
      <div className={`flex flex-wrap items-center gap-2 px-5 py-3 ${collapsed ? "" : "border-b border-line-soft"}`}>
        <button
          onClick={() => setUiPref("models.eligibilityMatrix.collapsed", collapsed ? "0" : "1")}
          aria-expanded={!collapsed}
          className="flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-opacity"
        >
          <svg className={`h-3.5 w-3.5 text-ink-3 transition-transform ${collapsed ? "-rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
          <h2 className="text-[15px] font-bold text-ink">Model eligibility</h2>
        </button>
        <span className="text-[11px] text-ink-3">
          {rows.length} stocks × {groups.length} models · funds manage eligibility + weights on their own page
        </span>
      </div>
      {!collapsed && (<>
      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(230_232_236)]">
            <tr className="text-xs text-ink-3">
              <th className="sticky left-0 z-20 bg-white px-4 py-2 text-left font-semibold">Ticker</th>
              {groups.map((g) => (
                <th key={g.id} className="px-3 py-2 text-center font-semibold whitespace-nowrap">{g.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.ticker} className="border-t border-line-soft hover:bg-surface-hover">
                <td className="sticky left-0 z-10 bg-white px-4 py-1.5 font-mono text-[13px] font-bold text-ink">
                  {displayTicker(s.ticker)}
                </td>
                {groups.map((g) => {
                  const eligible = s.modelEligibility?.[g.id] !== false;
                  return (
                    <td key={g.id} className="px-3 py-1.5 text-center">
                      <input
                        type="checkbox"
                        checked={eligible}
                        onChange={() => toggleModelEligibility(s.ticker, g.id, !eligible)}
                        className="h-3.5 w-3.5 cursor-pointer accent-accent"
                        title={`${displayTicker(s.ticker)} ${eligible ? "eligible for" : "excluded from"} ${g.name}`}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-line bg-surface-2 px-4 py-2 text-[11px] text-ink-3">
        unchecked = the buy/sell + rebalance flows skip that model
      </div>
      </>)}
    </div>
  );
}
