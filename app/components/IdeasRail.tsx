"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import TickerLink from "@/app/components/TickerLink";

/**
 * Ideas landing rail (canvas): compact read of the OTHER idea feeds beside
 * the Synthesis pane — Radar's top regime-tilted names and the Setup scan's
 * actionable count — each linking to its full segment. Read-only fetches of
 * the same endpoints those segments already use; renders nothing for a feed
 * whose data isn't built yet.
 */

type RadarLite = { ticker?: string; sector?: string; regimeFit?: number };

export function IdeasRail() {
  const [radar, setRadar] = useState<RadarLite[] | null>(null);
  const [setupCount, setSetupCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/radar", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && Array.isArray(d?.names)) setRadar(d.names.slice(0, 4));
      })
      .catch(() => {});
    fetch("/api/setup-scan", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && Array.isArray(d?.rows)) {
          setSetupCount(d.rows.filter((x: { base?: { score?: number } }) => (x.base?.score ?? 0) >= 3).length);
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const hasRadar = radar != null && radar.length > 0;
  if (!hasRadar && setupCount == null) return null;

  return (
    <div className="hidden w-64 shrink-0 space-y-4 xl:block">
      {hasRadar && (
        <div className="overflow-hidden rounded-card border border-line bg-white shadow-sm">
          <div className="flex items-center gap-2 border-b border-line-soft px-4 py-2.5">
            <span className="text-[13px] font-bold text-ink">Radar</span>
            <span className="text-[11px] text-ink-3">regime-tilted screen</span>
          </div>
          {radar!.map((n) => (
            <div key={n.ticker} className="flex items-center gap-2 border-b border-line-soft px-4 py-2 last:border-b-0">
              <TickerLink ticker={n.ticker ?? ""} className="w-16 shrink-0 font-mono text-[12px] font-semibold text-ink hover:text-accent hover:underline">{n.ticker}</TickerLink>
              <span className="min-w-0 flex-1 truncate text-[11px] text-ink-3">{n.sector || ""}</span>
              {typeof n.regimeFit === "number" && (
                <span className="shrink-0 font-mono text-[11px] font-semibold text-pos">{Math.round(n.regimeFit)}</span>
              )}
            </div>
          ))}
          <Link href="/radar" className="block bg-surface-2 px-4 py-2 text-[12px] font-semibold !text-accent hover:underline">
            Open Radar →
          </Link>
        </div>
      )}
      {setupCount != null && (
        <div className="overflow-hidden rounded-card border border-line bg-white shadow-sm">
          <div className="flex items-center gap-2 border-b border-line-soft px-4 py-2.5">
            <span className="text-[13px] font-bold text-ink">Setups</span>
            <span className="text-[11px] text-ink-3">technical scan</span>
            <span className="ml-auto rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-ink-2">{setupCount}</span>
          </div>
          <Link href="/setups" className="block bg-surface-2 px-4 py-2 text-[12px] font-semibold !text-accent hover:underline">
            Open Setups →
          </Link>
        </div>
      )}
    </div>
  );
}
