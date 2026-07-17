"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { MAX_SCORE } from "@/app/lib/types";

/**
 * Factor Lens (shadow) — per-name read-out of the quantitative factor model
 * that runs BESIDE the 41-pt score (Phase B2). Read-only: fetches the nightly
 * pm:factor-scores snapshot and shows this ticker's quant percentile, the
 * qualitative judgment overlay, the blend candidates, and the four factor
 * group z-scores. Changes no existing number; the 41-pt score is unaffected.
 */

type FactorEntry = {
  ticker: string;
  sector: string;
  quant: number | null;
  confidence: number | null;
  overlay: number | null;
  blend70: number | null;
  blendMod: number | null;
  groups: Record<string, number>;
};

const GROUP_ORDER = ["quality", "growth", "valuation", "momentum"] as const;
const GROUP_LABEL: Record<string, string> = {
  quality: "Quality", growth: "Growth", valuation: "Valuation", momentum: "Momentum",
};

function pctTone(p: number | null): string {
  if (p == null) return "text-ink-3";
  if (p >= 70) return "text-pos";
  if (p <= 30) return "text-neg";
  return "text-ink";
}

/** ±3 z bar, green-right/red-left. */
function ZBar({ z }: { z: number | undefined }) {
  if (z == null) return <span className="inline-block h-[10px] w-full rounded-sm bg-surface-2" />;
  const clamped = Math.max(-3, Math.min(3, z));
  const pct = (Math.abs(clamped) / 3) * 50;
  const pos = clamped >= 0;
  return (
    <span className="relative inline-block h-[10px] w-full rounded-sm bg-surface-2 align-middle" title={`z ${z.toFixed(2)}`}>
      <span className="absolute left-1/2 top-0 h-full w-px bg-line" />
      <span
        className={`absolute top-0 h-full rounded-sm ${pos ? "bg-pos/70" : "bg-neg/70"}`}
        style={pos ? { left: "50%", width: `${pct}%` } : { right: "50%", width: `${pct}%` }}
      />
    </span>
  );
}

export default function FactorLensTile({
  ticker,
  adjusted,
  className = "",
}: {
  ticker: string;
  adjusted: number;
  className?: string;
}) {
  const [entry, setEntry] = useState<FactorEntry | null>(null);
  const [builtAt, setBuiltAt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/factor-scores");
        const j = await r.json();
        if (!alive) return;
        setEntry((j.entries?.[ticker.toUpperCase()] as FactorEntry) ?? null);
        setBuiltAt(j.builtAt ?? null);
      } catch {
        /* leave null */
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => { alive = false; };
  }, [ticker]);

  // Divergence read: where does the factor lens sit vs the qualitative read?
  const divergence = (() => {
    if (!entry || entry.quant == null || entry.overlay == null) return null;
    const gap = entry.quant - entry.overlay;
    if (Math.abs(gap) < 12) return { tone: "text-ink-2", text: "Factors and the qualitative read broadly agree." };
    if (gap > 0) return { tone: "text-pos", text: "Factors rate this above the qualitative read — the numbers are ahead of the narrative." };
    return { tone: "text-neg", text: "The qualitative read sits above the factors — conviction the numbers don't yet support." };
  })();

  const built = builtAt ? new Date(builtAt).toLocaleDateString() : null;

  return (
    <div className={`rounded-card border border-line bg-white p-4 sm:p-5 shadow-sm ${className}`}>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between text-left">
        <span className="flex items-center gap-2">
          <span className="text-sm font-semibold text-ink">Factor Lens</span>
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-3">shadow · read-only</span>
        </span>
        <span className="text-ink-3">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-3">
          {!loaded ? (
            <div className="py-4 text-xs text-ink-3">Loading…</div>
          ) : !entry || entry.quant == null ? (
            <div className="py-2 text-xs text-ink-2">
              Not yet factor-scored. Quant read-outs are computed nightly for Portfolio + Watchlist names against the
              sector universe. <Link href="/factor-lab" className="text-accent hover:underline">Open Factor Lab</Link>.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-ink-3">Quant %ile</div>
                  <div className={`text-2xl font-semibold tabular-nums ${pctTone(entry.quant)}`}>{entry.quant}</div>
                  <div className="text-[10px] text-ink-3">{entry.sector || "—"}{entry.confidence != null ? ` · conf ${entry.confidence}` : ""}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-ink-3">41-pt</div>
                  <div className="text-2xl font-semibold tabular-nums text-ink-2">{Number(adjusted.toFixed(1))}<span className="text-sm text-ink-3">/{MAX_SCORE}</span></div>
                  <div className="text-[10px] text-ink-3">committee score</div>
                </div>
                <div className="flex gap-4">
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-ink-3">Overlay</div>
                    <div className="text-lg font-semibold tabular-nums text-ink">{entry.overlay ?? "—"}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-ink-3">70/30</div>
                    <div className="text-lg font-semibold tabular-nums text-ink">{entry.blend70 ?? "—"}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-ink-3">Mod</div>
                    <div className="text-lg font-semibold tabular-nums text-ink">{entry.blendMod ?? "—"}</div>
                  </div>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                {GROUP_ORDER.map((g) => (
                  <div key={g} className="flex items-center gap-2">
                    <span className="w-20 shrink-0 text-[11px] text-ink-2">{GROUP_LABEL[g]}</span>
                    <span className="flex-1"><ZBar z={entry.groups?.[g]} /></span>
                    <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-ink-3">
                      {entry.groups?.[g] != null ? entry.groups[g].toFixed(1) : "·"}
                    </span>
                  </div>
                ))}
              </div>

              {divergence && (
                <div className={`mt-3 text-[11px] ${divergence.tone}`}>{divergence.text}</div>
              )}

              <div className="mt-3 flex items-center justify-between text-[10px] text-ink-3">
                <span>Sector-neutral z-scores vs S&amp;P 500 + TSX 60 peers. Nothing here changes the 41-pt score.</span>
                {built && <span>built {built}</span>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
