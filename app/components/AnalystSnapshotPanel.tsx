"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  TickerSnapshot,
  AnalystRating,
  AnalystEntry,
  ConsensusBreakdown,
  TickerReports,
  ExtractedReport,
} from "@/app/lib/analyst-snapshots";
import { displayTicker } from "@/app/lib/ticker";

type Props = {
  ticker: string;
  /** Trading currency of this stock (from Yahoo, e.g. "USD", "CAD", "DKK"). */
  stockCurrency: string;
  snapshot: TickerSnapshot | undefined;
  breakdown: ConsensusBreakdown;
  reports: TickerReports | undefined;
  onChange: (next: TickerSnapshot | undefined) => void;
  onUpload: (source: "rbc" | "jpm" | "morningstar", dataUrl: string, label: string) => Promise<{ ok: true; extracted: ExtractedReport } | { ok: false; error: string }>;
  onRemoveReport: (source: "rbc" | "jpm" | "morningstar") => Promise<void>;
  /** Convert an analyst target from one currency to the stock's trading currency.
   *  Returns the converted target and FX rate, or null on failure. */
  onConvertTarget: (source: "rbc" | "jpm", fromCurrency: string) => Promise<void>;
};

const RATING_OPTIONS: { value: AnalystRating; label: string }[] = [
  { value: "outperform", label: "Outperform / Overweight" },
  { value: "neutral", label: "Sector Perform / Neutral / Hold" },
  { value: "underperform", label: "Underperform / Underweight" },
  { value: "not-covered", label: "Not covered" },
];

const BLOCK = "rounded-control border border-line bg-surface px-3 py-2.5";
const INPUT = "h-7 w-full rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent-border";

export function AnalystSnapshotPanel({ ticker, stockCurrency, snapshot, breakdown, reports, onChange, onUpload, onRemoveReport, onConvertTarget }: Props) {
  const [local, setLocal] = useState<TickerSnapshot>(() => snapshot ?? {});
  const [uploading, setUploading] = useState<{ source: "rbc" | "jpm" | "morningstar" } | null>(null);
  const [uploadError, setUploadError] = useState<{ source: "rbc" | "jpm" | "morningstar"; message: string } | null>(null);
  const [converting, setConverting] = useState<"rbc" | "jpm" | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const incoming = snapshot ?? {};
    if (JSON.stringify(local) !== JSON.stringify(incoming)) setLocal(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSave = useCallback((next: TickerSnapshot) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const hasAny = Boolean(next.rbc || next.jpm || next.factset || next.morningstar);
      onChangeRef.current(hasAny ? next : undefined);
      saveTimerRef.current = null;
    }, 500);
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        const hasAny = Boolean(local.rbc || local.jpm || local.factset || local.morningstar);
        onChangeRef.current(hasAny ? local : undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchAnalyst = (which: "rbc" | "jpm", patch: Partial<AnalystEntry>) => {
    const existing: AnalystEntry = local[which] ?? { rating: "not-covered" };
    const merged: AnalystEntry = { ...existing, ...patch, lastUpdated: new Date().toISOString() };
    // When the user manually edits the target, clear any prior FX conversion
    // fields so the new value is treated as already in the stock's currency.
    if ("target" in patch) {
      // A hand-typed target is already in the stock's currency, so the FX
      // trail for THAT number is void — but preferredCurrency is a standing
      // preference about future uploads, not a property of this value, so it
      // deliberately survives.
      delete merged.targetOriginal;
      delete merged.targetCurrency;
      delete merged.fxRate;
    }
    const next: TickerSnapshot = { ...local, [which]: merged };
    setLocal(next);
    scheduleSave(next);
  };

  const handleFile = async (which: "rbc" | "jpm" | "morningstar", file: File) => {
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      setUploadError({ source: which, message: `PDF too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 15 MB.` });
      return;
    }
    setUploadError(null);
    setUploading({ source: which });
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsDataURL(file);
      });
      const res = await onUpload(which, dataUrl, file.name);
      if (!res.ok) setUploadError({ source: which, message: res.error });
    } catch (e) {
      setUploadError({ source: which, message: e instanceof Error ? e.message : "Upload failed" });
    } finally {
      setUploading(null);
    }
  };

  const renderAnalyst = (which: "rbc" | "jpm", label: string) => {
    const entry = local[which];
    const contribution = which === "rbc" ? breakdown.rbc : breakdown.jpm;
    const report = reports?.[which];
    const isUploading = uploading?.source === which;
    const errMsg = uploadError?.source === which ? uploadError.message : null;
    return (
      <div className={BLOCK}>
        <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[12.5px] font-medium text-ink">{label}</span>
          {/* Freshness chip removed — the underlying multiplier is now
              always 1.0 (no decay), so the chip would only ever read
              "FRESH" and added visual noise without information. */}
          {contribution && (
            <span className="font-mono text-[11.5px] text-ink-3">{contribution.contribution.toFixed(2)} pts</span>
          )}
          {report && (
            <span className="text-[11.5px] text-ink-3" title={`Uploaded ${report.uploadedAt.slice(0, 10)} · ${report.label}`}>
              · PDF: {report.label.length > 30 ? report.label.slice(0, 27) + "..." : report.label}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2.5">
            <label className={`cursor-pointer text-[12px] ${isUploading ? "text-ink-faint" : "text-accent hover:underline"}`}>
              <input
                type="file"
                accept="application/pdf"
                className="hidden"
                disabled={isUploading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(which, f);
                  e.target.value = ""; // allow re-upload of same file
                }}
              />
              {isUploading ? "Extracting…" : report ? "Replace PDF" : "Upload PDF"}
            </label>
            {report && (
              <button
                type="button"
                onClick={() => void onRemoveReport(which)}
                className="text-[12px] text-ink-3 hover:text-neg"
                title="Remove the uploaded PDF and clear extracted fields"
              >
                Remove PDF
              </button>
            )}
          </div>
        </div>
        {errMsg && (
          <p className="mb-2 text-[11.5px] text-neg">{errMsg}</p>
        )}
        {!report ? (
          <p className="text-[12px] text-ink-3">
            No PDF uploaded. Click <span className="text-ink-2">Upload PDF</span> above to extract rating, target, and report date.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-0.5">
              <span className="text-[11px] text-ink-3">Rating</span>
              <select
                value={entry?.rating ?? "not-covered"}
                onChange={(e) => patchAnalyst(which, { rating: e.target.value as AnalystRating })}
                className={INPUT}
              >
                {RATING_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] text-ink-3">Target price ({stockCurrency})</span>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  step="0.01"
                  value={entry?.target ?? ""}
                  onChange={(e) => patchAnalyst(which, { target: e.target.value === "" ? undefined : Number(e.target.value) })}
                  placeholder="$"
                  className={`${INPUT} min-w-0 flex-1 font-mono`}
                />
                {entry?.targetOriginal && entry.targetCurrency && (
                  <span className="whitespace-nowrap font-mono text-[11px] text-ink-3" title={`Converted from ${entry.targetCurrency} $${entry.targetOriginal.toFixed(2)} at report-date rate ${entry.targetCurrency}${stockCurrency}=${entry.fxRate?.toFixed(4) ?? "?"}`}>
                    ({entry.targetCurrency} ${entry.targetOriginal.toFixed(2)})
                  </span>
                )}
                {entry?.target && !entry.targetOriginal && !entry.targetCurrency && (
                  <select
                    className="h-7 shrink-0 cursor-pointer rounded-control border border-line bg-surface px-1 text-[11px] text-accent"
                    defaultValue=""
                    disabled={converting === which}
                    onChange={async (e) => {
                      const fromCcy = e.target.value;
                      if (!fromCcy) return;
                      setConverting(which);
                      try { await onConvertTarget(which, fromCcy); } finally { setConverting(null); }
                    }}
                    title={`If this target is in a different currency, select it to convert to ${stockCurrency} at the report-date FX rate.`}
                  >
                    <option value="">Ccy…</option>
                    {["USD", "CAD", "DKK", "SEK", "NOK", "GBP", "EUR", "CHF", "JPY", "AUD"]
                      .filter((c) => c !== stockCurrency)
                      .map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                )}
                {converting === which && <span className="text-[11px] text-ink-3">…</span>}
                {entry?.preferredCurrency && converting !== which && (
                  <span
                    className="whitespace-nowrap text-[11px] text-ink-3"
                    title={`Future ${which.toUpperCase()} reports for this name will assume ${entry.preferredCurrency} targets instead of guessing from the listing exchange. Pick another currency to change it.`}
                  >
                    {entry.preferredCurrency} default
                  </span>
                )}
              </div>
            </div>
            <label className="flex flex-col gap-0.5">
              <span className="text-[11px] text-ink-3">Report date</span>
              <input
                type="date"
                value={entry?.asOf ?? ""}
                onChange={(e) => patchAnalyst(which, { asOf: e.target.value || undefined })}
                className={INPUT}
              />
            </label>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] text-ink-3" title="Underlying price captured at upload time.">
                Price at report
              </span>
              <span className="flex h-7 items-center font-mono text-[12.5px] text-ink">
                {entry?.priceAtReport ? `$${entry.priceAtReport.toFixed(2)}` : <span className="text-ink-3">—</span>}
              </span>
            </div>
          </div>
        )}
        {report && (report.extracted.thesis?.length || report.extracted.risks?.length || report.extracted.sectorView || report.extracted.keyMetrics?.length) && (
          <div className="mt-2.5 space-y-2 border-t border-line-soft pt-2.5">
            {report.extracted.sectorView && (
              <p className="text-[12px] leading-[1.5] text-ink-2">{report.extracted.sectorView}</p>
            )}
            {report.extracted.thesis && report.extracted.thesis.length > 0 && (
              <div>
                <p className="mb-0.5 text-[11px] text-ink-3">Thesis</p>
                <ul className="list-inside list-disc space-y-0.5 text-[12px] leading-[1.5] text-ink-2">
                  {report.extracted.thesis.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              </div>
            )}
            {report.extracted.risks && report.extracted.risks.length > 0 && (
              <div>
                <p className="mb-0.5 text-[11px] text-ink-3">Risks</p>
                <ul className="list-inside list-disc space-y-0.5 text-[12px] leading-[1.5] text-ink-2">
                  {report.extracted.risks.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            )}
            {report.extracted.keyMetrics && report.extracted.keyMetrics.length > 0 && (
              <div>
                <p className="mb-0.5 text-[11px] text-ink-3">Key metrics</p>
                <ul className="space-y-0.5 text-[12px] text-ink-2">
                  {report.extracted.keyMetrics.map((m, i) => (
                    <li key={i}><span className="text-ink-3">{m.label}</span> <span className="font-mono font-medium text-ink">{m.value}</span></li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const factset = local.factset;
  return (
    <div className="mt-2.5 space-y-2.5">
      <p className="text-[11px] text-ink-3">Analyst snapshot · {displayTicker(ticker)}</p>

      {/* FactSet street consensus */}
      <div className={BLOCK}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[12.5px] font-medium text-ink">FactSet street consensus</span>
          <span className="text-[11px] text-ink-3" title="Auto-populated from the FactSet Formula API on every rescore. Not manually editable.">Auto · FactSet</span>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] text-ink-3">Avg target price</span>
            <span className="font-mono text-[12.5px] font-medium text-ink">
              {typeof factset?.averageTarget === "number" ? `$${factset.averageTarget.toFixed(2)}` : "—"}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] text-ink-3">Analysts</span>
            <span className="font-mono text-[12.5px] font-medium text-ink">
              {typeof factset?.analystCount === "number" ? String(factset.analystCount) : "—"}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] text-ink-3">As of</span>
            <span className="font-mono text-[12.5px] font-medium text-ink">
              {factset?.asOf || "—"}
            </span>
          </div>
        </div>
        {breakdown.upside.target && breakdown.upside.upsidePercent !== undefined && (
          <p className="mt-2 text-[11.5px] text-ink-3">
            Implied upside <span className="font-mono">{breakdown.upside.upsidePercent >= 0 ? "+" : ""}{breakdown.upside.upsidePercent.toFixed(1)}%</span>
            {" "}→ contribution <span className="font-mono">{breakdown.upside.contribution.toFixed(2)}</span> pts
            {breakdown.upside.targetSource === "none" && (
              <span className="ml-1">(no FactSet target entered — upside not computed)</span>
            )}
          </p>
        )}
      </div>

      {/* ── Headroom diagnostic ────────────────────────────────────────
          The category sums five components into a raw figure and clamps it to
          [0, 3]. Level components alone (RBC + JPM + street upside) can reach
          3.0, so on a strongly-rated name the revision and Morningstar tilts
          can land entirely outside the range and never move the score.
          Measured across all component combinations, that happens ~6% of the
          time — but whether it happens on THIS book is the number that
          matters, and it was previously invisible. rawScore is already
          computed; this only surfaces it. Display-only: changes no score,
          writes nothing. Delete this block to remove the diagnostic. */}
      {(() => {
        const clipped = +(breakdown.rawScore - breakdown.score).toFixed(2);
        if (Math.abs(clipped) < 0.01) return null;
        const over = clipped > 0;
        return (
          <div className={`rounded-control px-3 py-2 text-[11.5px] ${over ? "bg-warn-soft" : "bg-surface-2"}`}>
            <span className={`font-medium ${over ? "text-warn" : "text-ink-2"}`}>
              {over ? "At the ceiling" : "At the floor"}
            </span>{" "}
            <span className="text-ink-2">
              raw <span className="font-mono">{breakdown.rawScore.toFixed(2)}</span> → capped to <span className="font-mono">{breakdown.score.toFixed(2)}</span>
              {" · "}
              <span className="font-mono">{over ? "+" : ""}{clipped.toFixed(2)}</span> of signal not reflected
            </span>
            <span className="ml-1 text-ink-3">
              {over
                ? "— further positive evidence can't raise this score. Negative evidence still moves it."
                : "— further negative evidence can't lower this score."}
            </span>
          </div>
        );
      })()}

      {renderAnalyst("rbc", "RBC")}
      {renderAnalyst("jpm", "JPM")}
      {/* Morningstar — structured ratings, not a rating/target pair. Stars
          enter the consensus as a ±0.5 modifier; moat + capital allocation
          feed the scoring prompt as evidence; FVE is display-only. */}
      {(() => {
        const ms = local.morningstar;
        const report = reports?.morningstar;
        const isUploading = uploading?.source === "morningstar";
        const errMsg = uploadError?.source === "morningstar" ? uploadError.message : null;
        return (
          <div className={BLOCK}>
            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[12.5px] font-medium text-ink">Morningstar</span>
              {breakdown.morningstar && (
                <span className="font-mono text-[11.5px] text-ink-3">
                  {breakdown.morningstar.stars}/5 stars → {breakdown.morningstar.contribution >= 0 ? "+" : ""}{breakdown.morningstar.contribution.toFixed(2)} pts
                </span>
              )}
              {report && (
                <span className="text-[11.5px] text-ink-3" title={`Uploaded ${report.uploadedAt.slice(0, 10)} · ${report.label}`}>
                  · PDF: {report.label.length > 30 ? report.label.slice(0, 27) + "..." : report.label}
                </span>
              )}
              <div className="ml-auto flex items-center gap-2.5">
                <label className={`cursor-pointer text-[12px] ${isUploading ? "text-ink-faint" : "text-accent hover:underline"}`}>
                  <input
                    type="file"
                    accept="application/pdf"
                    className="hidden"
                    disabled={isUploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleFile("morningstar", f);
                      e.target.value = "";
                    }}
                  />
                  {isUploading ? "Extracting…" : report ? "Replace PDF" : "Upload PDF"}
                </label>
                {report && (
                  <button type="button" onClick={() => void onRemoveReport("morningstar")} className="text-[12px] text-ink-3 hover:text-neg">
                    Remove
                  </button>
                )}
              </div>
            </div>
            {errMsg && <p className="mb-1 text-[11.5px] text-neg">{errMsg}</p>}
            {ms ? (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
                {ms.stars != null && <span>Stars <span className="font-mono font-medium text-ink">{ms.stars}<span className="text-ink-faint">/5</span></span></span>}
                {ms.moat && <span>Moat <span className="font-medium text-ink">{ms.moat}</span>{ms.moatTrend ? ` (${ms.moatTrend})` : ""}</span>}
                {ms.capitalAllocation && <span>Capital allocation <span className="font-medium text-ink">{ms.capitalAllocation}</span></span>}
                {ms.fairValue != null && <span>FVE <span className="font-mono font-medium text-ink">{ms.fairValue}</span> <span className="text-ink-faint">(cross-check only)</span></span>}
                {ms.uncertainty && <span>Uncertainty {ms.uncertainty}</span>}
                {ms.asOf && <span className="text-ink-3">as of {ms.asOf}</span>}
              </div>
            ) : (
              <p className="text-[12px] text-ink-3">
                No Morningstar report. Upload the PDF — stars, moat, capital allocation, FVE and uncertainty are extracted automatically. Stars tilt analystConsensus ±0.5; moat and capital allocation become scoring evidence.
              </p>
            )}
          </div>
        );
      })()}

      <p className="text-[11.5px] text-ink-3">
        RBC / JPM edits save automatically. The FactSet street consensus is auto-populated from the FactSet Formula API on every rescore and drives the analystConsensus score.
      </p>
    </div>
  );
}
