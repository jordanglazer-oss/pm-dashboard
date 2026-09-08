"use client";

import { useStocks } from "@/app/lib/StockContext";
import { displayTicker } from "@/app/lib/ticker";
import { AppIcon } from "@/app/components/AppIcon";

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
    <section className="panel">
      <div className="panel-h flex-wrap py-1.5">
        <button
          onClick={() => setUiPref("models.eligibilityMatrix.collapsed", collapsed ? "0" : "1")}
          aria-expanded={!collapsed}
          className="flex items-center gap-1.5 text-left hover:opacity-80 transition-opacity"
        >
          <AppIcon name={collapsed ? "chevR" : "chevD"} size={13} className="text-ink-3" />
          <span className="t">Model eligibility</span>
        </button>
        <span className="m">
          {rows.length} stocks × {groups.length} models · funds manage eligibility + weights on their own page
        </span>
      </div>
      {!collapsed && (<>
      <div className="max-h-[70vh] max-w-full overflow-auto">
        <table className="data-table">
          <thead className="sticky top-0 z-10 bg-surface">
            <tr>
              <th className="sticky left-0 z-20 bg-surface pl-3.5">Ticker</th>
              {groups.map((g) => (
                <th key={g.id} className="text-center">{g.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.ticker}>
                <td className="sticky left-0 z-10 bg-surface pl-3.5 font-mono font-medium text-ink">
                  {displayTicker(s.ticker)}
                </td>
                {groups.map((g) => {
                  const eligible = s.modelEligibility?.[g.id] !== false;
                  return (
                    <td key={g.id} className="text-center">
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
      <div className="flex min-h-[32px] items-center border-t border-line-soft px-3.5 text-[11.5px] text-ink-3">
        unchecked = the buy/sell + rebalance flows skip that model
      </div>
      </>)}
    </section>
  );
}
