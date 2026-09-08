"use client";

import { usePersistedOpen } from "@/app/lib/useCollapsed";
import React, { useEffect, useState } from "react";
import Link from "next/link";
import { MAX_SCORE } from "@/app/lib/types";
import { AppIcon } from "@/app/components/AppIcon";

/**
 * Factor Lens (shadow) — per-name read-out of the quantitative factor model
 * that runs BESIDE the 41-pt score (Phase B2). Read-only: fetches the nightly
 * pm:factor-scores snapshot and shows this ticker's quant percentile, the
 * qualitative judgment overlay, the blend candidates, and the four factor
 * group z-scores. Changes no existing number; the 41-pt score is unaffected.
 *
 * Renders as a flush row-set inside the stock page's "Risk & factors" panel:
 * the condensed label/value rows are always visible; the full lens (z bars,
 * blend candidates, divergence read) sits one persisted click away.
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

function fmtZ(z: number | undefined): string {
  if (z == null) return "—";
  return `${z > 0 ? "+" : z < 0 ? "−" : ""}${Math.abs(z).toFixed(1)}`;
}

/** ±3 z bar, pos-right / neg-left. */
function ZBar({ z }: { z: number | undefined }) {
  if (z == null) return <span className="inline-block h-1 w-full rounded-sm bg-line-soft" />;
  const clamped = Math.max(-3, Math.min(3, z));
  const pct = (Math.abs(clamped) / 3) * 50;
  const pos = clamped >= 0;
  return (
    <span className="relative inline-block h-1 w-full rounded-sm bg-line-soft align-middle" title={`z ${z.toFixed(2)}`}>
      <span className="absolute left-1/2 top-0 h-full w-px bg-line" />
      <span
        className={`absolute top-0 h-full rounded-sm ${pos ? "bg-pos" : "bg-neg"}`}
        style={pos ? { left: "50%", width: `${pct}%` } : { right: "50%", width: `${pct}%` }}
      />
    </span>
  );
}

function Kv({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12px]">
      <span className="text-ink-2">{label}</span>
      <span className={`font-mono font-medium ${tone ?? "text-ink"}`}>{value}</span>
    </div>
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
  const [open, toggleOpen] = usePersistedOpen("stock.factorLens.open", false);

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
  const scored = loaded && entry && entry.quant != null;

  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] font-medium text-ink">Factor lens</span>
        <span className="text-[11.5px] text-ink-3">shadow model · read-only</span>
        <button
          onClick={toggleOpen}
          className="ml-auto grid h-7 w-7 place-items-center rounded-control text-ink-3 hover:bg-surface-hover hover:text-ink"
          aria-expanded={open}
          aria-label={open ? "Hide full factor lens" : "Show full factor lens"}
          title={open ? "Hide full factor lens" : "Show full factor lens"}
        >
          <AppIcon name={open ? "chevU" : "chevD"} size={14} />
        </button>
      </div>

      {!loaded ? (
        <div className="py-1 text-[11.5px] text-ink-3">Loading…</div>
      ) : !scored ? (
        <div className="py-1 text-[12px] text-ink-2">
          Not yet factor-scored. Quant read-outs are computed nightly for Portfolio + Watchlist names against the
          sector universe. <Link href="/factor-lab" className="text-accent hover:underline">Open Factor Lab</Link>.
        </div>
      ) : (
        <>
          <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1.5">
            <Kv label="Quant pctile" value={entry!.quant} tone={pctTone(entry!.quant)} />
            <Kv label="Overlay" value={entry!.overlay ?? "—"} />
            {GROUP_ORDER.map((g) => (
              <Kv key={g} label={`${GROUP_LABEL[g]} z`} value={fmtZ(entry!.groups?.[g])} />
            ))}
          </div>

          {open && (
            <div className="mt-3 border-t border-line-soft pt-3">
              <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
                <div>
                  <div className="text-[11px] text-ink-3">Quant pctile</div>
                  <div className={`font-mono text-[22px] font-semibold ${pctTone(entry!.quant)}`}>{entry!.quant}</div>
                  <div className="text-[11px] text-ink-3">{entry!.sector || "—"}{entry!.confidence != null ? ` · conf ${entry!.confidence}` : ""}</div>
                </div>
                <div>
                  <div className="text-[11px] text-ink-3">41-pt</div>
                  <div className="font-mono text-[22px] font-semibold text-ink-2">{Number(adjusted.toFixed(1))}<span className="text-[13px] text-ink-faint">/{MAX_SCORE}</span></div>
                  <div className="text-[11px] text-ink-3">committee score</div>
                </div>
                <div className="flex gap-4">
                  <div>
                    <div className="text-[11px] text-ink-3">Overlay</div>
                    <div className="font-mono text-[16px] font-semibold text-ink">{entry!.overlay ?? "—"}</div>
                  </div>
                  <div>
                    <div className="text-[11px] text-ink-3">70/30</div>
                    <div className="font-mono text-[16px] font-semibold text-ink">{entry!.blend70 ?? "—"}</div>
                  </div>
                  <div>
                    <div className="text-[11px] text-ink-3">Mod</div>
                    <div className="font-mono text-[16px] font-semibold text-ink">{entry!.blendMod ?? "—"}</div>
                  </div>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                {GROUP_ORDER.map((g) => (
                  <div key={g} className="flex items-center gap-2">
                    <span className="w-20 shrink-0 text-[11.5px] text-ink-2">{GROUP_LABEL[g]}</span>
                    <span className="flex-1"><ZBar z={entry!.groups?.[g]} /></span>
                    <span className="w-9 shrink-0 text-right font-mono text-[11.5px] text-ink-3">
                      {entry!.groups?.[g] != null ? entry!.groups[g].toFixed(1) : "·"}
                    </span>
                  </div>
                ))}
              </div>

              {divergence && (
                <div className={`mt-3 text-[11.5px] ${divergence.tone}`}>{divergence.text}</div>
              )}

              <div className="mt-3 flex items-center justify-between text-[11px] text-ink-3">
                <span>Sector-neutral z-scores vs S&amp;P 500 + TSX 60 peers. Nothing here changes the 41-pt score.</span>
                {built && <span className="font-mono">built {built}</span>}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
