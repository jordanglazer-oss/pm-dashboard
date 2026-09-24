"use client";

import { useStocks } from "@/app/lib/StockContext";
import type { Stock } from "@/app/lib/types";
import { isFund, isSleeveTaggable, sleevesOf, toggleSleeveFields, type AlphaSleeve } from "@/app/lib/sleeves";
import { ensurePlanSkeleton } from "@/app/lib/plan-skeleton";

/* Thesis / Tactical toggle pills for one holding. Stocks toggle each sleeve
 * independently (both = a Thesis name with a tactical overweight); on a fund,
 * choosing one clears the other. Tags only — no weights move. */
export function SleeveTags({ stock, size = "sm" }: { stock: Stock; size?: "sm" | "md" }) {
  const { updateStockFields } = useStocks();
  if (!isSleeveTaggable(stock)) return <span className="text-[10px] text-ink-faint">—</span>;
  const on = sleevesOf(stock);
  const fund = isFund(stock);
  const box = size === "md" ? "h-7 px-3 text-[12.5px]" : "h-5 px-1.5 text-[10px]";

  const pill = (sleeve: AlphaSleeve, label: string, active: boolean, activeCls: string, title: string) => (
    <button
      type="button"
      aria-pressed={active}
      onClick={(e) => {
        e.stopPropagation();
        const next = toggleSleeveFields(stock, sleeve);
        updateStockFields(stock.ticker, next);
        // Turning Tactical ON for a held name pre-fills its plan (entry = now).
        // Fire-and-forget — the tag never waits on it.
        if (sleeve === "tactical" && next.inTactical && stock.bucket === "Portfolio") void ensurePlanSkeleton(stock.ticker, stock.price);
      }}
      title={title}
      className={`inline-flex items-center rounded-md border font-medium transition-colors ${box} ${
        active ? activeCls : "border-line bg-surface text-ink-faint hover:text-ink-2 hover:border-ink-faint"
      }`}
    >
      {label}
    </button>
  );

  return (
    <span className="inline-flex items-center gap-1">
      {pill(
        "thesis",
        "Thesis",
        on.thesis,
        "border-accent-border bg-accent-soft text-accent",
        "Thesis — a long-run hold, sold only if the thesis breaks.",
      )}
      {pill(
        "tactical",
        "Tactical",
        on.tactical,
        "border-violet-border bg-violet-soft text-violet",
        fund
          ? "Tactical — a shorter-horizon position. A fund sits in one sleeve only."
          : "Tactical — a shorter-horizon position. With Thesis also on, this is a Thesis name carrying a tactical overweight.",
      )}
    </span>
  );
}
