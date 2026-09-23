"use client";

import React, { useEffect, useState } from "react";
import { CollapsibleSection } from "@/app/components/CollapsibleSection";
import { LaneChecklist, LaneChip } from "@/app/components/LaneChecklist";
import type { EntryScan } from "@/app/lib/entry-scan";
import type { LaneRead } from "@/app/lib/lanes";

/* Stock-page tile for an UNOWNED name: which lane it is in and what it is
 * still missing. Reads the cached entry scan — nothing is generated here. */
export function LaneTile({ ticker }: { ticker: string }) {
  const [lane, setLane] = useState<LaneRead | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    fetch("/api/entry-scan", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: EntryScan | null) => { if (!alive) return; setLane(d?.rows.find((r) => r.ticker.toUpperCase() === ticker.toUpperCase())?.lane ?? null); })
      .catch(() => alive && setLane(null));
    return () => { alive = false; };
  }, [ticker]);
  if (lane === undefined) return null;
  return (
    <CollapsibleSection
      prefKey="stock.lane"
      className="border-line"
      titleClass="text-[13px] font-semibold text-ink"
      title="Path"
      subtitle="Thesis or Tactical — what it is still missing"
      right={lane ? <LaneChip lane={lane} /> : null}
    >
      {lane ? <LaneChecklist lane={lane} /> : <p className="text-[12px] text-ink-3">Not on the entry scan (watchlist and suggested stocks only).</p>}
    </CollapsibleSection>
  );
}
