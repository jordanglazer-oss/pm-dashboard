"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  TickerSnapshot,
  AnalystRating,
  AnalystEntry,
  FactSetEntry,
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
  onUpload: (source: "rbc" | "jpm", dataUrl: string, label: string) => Promise<{ ok: true; extracted: ExtractedReport } | { ok: false; error: string }>;
  onRemoveReport: (source: "rbc" | "jpm") => Promise<void>;
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

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function freshnessChip(label: "fresh" | "stale" | "very-stale") {
  if (label === "fresh") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (label === "stale") return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-red-50 text-red-700 border-red-200";
}

export function AnalystSnapshotPanel({ ticker, stockCurrency, snapshot, breakdown, reports, onChange, onUpload, onRemoveReport, onConvertTarget }: Props) {
  const [local, setLocal] = useState<TickerSnapshot>(() => snapshot ?? {});
  const [uploading, setUploading] = useState<{ source: "rbc" | "jpm" } | null>(null);
  const [uploadError, setUploadError] = useState<{ source: "rbc" | "jpm"; message: string } | null>(null);
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
      const hasAny = Boolean(next.rbc || next.jpm || next.factset);
      onChangeRef.current(hasAny ? next : undefined);
      saveTimerRef.current = null;
    }, 500);
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        const hasAny = Boolean(local.rbc || local.jpm || local.factset);
        onChangeRef.current(hasAny ? local : undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchFactSet = (patch: Partial<FactSetEntry>) => {
    const existing: FactSetEntry = local.factset ?? {};
    const merged: FactSetEntry = { ...existing, ...patch, lastUpdated: new Date().toISOString() };
    if (!merged.asOf && (patch.averageTarget !== undefined || patch.analystCount !== undefined)) {
      merged.asOf = todayIso();
    }
    const next: TickerSnapshot = { ...local, factset: merged };
    setLocal(next);
    scheduleSave(next);
  };

  const clearFactSet = () => {
    const next: TickerSnapshot = { ...local };
    delete next.factset;
    setLocal(next);
    scheduleSave(next);
  };

  const patchAnalyst = (which: "rbc" | "jpm", patch: Partial<AnalystEntry>) => {
    const existing: AnalystEntry = local[which] ?? { rating: "not-covered" };
    const merged: AnalystEntry = { ...existing, ...patch, lastUpdated: new Date().toISOString() };
    // When the user manually edits the target, clear any prior FX conversion
    // fields so the new value is treated as already in the stock's currency.
    if ("target" in patch) {
      delete merged.targetOriginal;
      delete merged.targetCurrency;
      delete merged.fxRate;
    }
    const next: TickerSnapshot = { ...local, [which]: merged };
    setLocal(next);
    scheduleSave(next);
  };

  const handleFile = async (which: "rbc" | "jpm", file: File) => {
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
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-slate-700">{label}</span>
            {contribution && (
              <span
                className={`rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${freshnessChip(contribution.freshnessLabel)}`}
                title={contribution.freshnessReason || `Freshness multiplier ${contribution.freshness.toFixed(2)}×`}
              >
                {contribution.freshnessLabel}
              </span>
            )}
            {contribution && (
              <span className="text-[10px] text-slate-500">
                {contribution.contribution.toFixed(2)} pts
              </span>
            )}
            {report && (
              <span className="text-[10px] text-slate-500" title={`Uploaded ${report.uploadedAt.slice(0, 10)} · ${report.label}`}>
                · PDF: {report.label.length > 30 ? report.label.slice(0, 27) + "..." : report.label}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <label className={`text-[10px] cursor-pointer ${isUploading ? "text-slate-300" : "text-blue-600 hover:text-blue-800"}`}>
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
                className="text-[10px] text-slate-400 hover:text-red-600"
                title="Remove the uploaded PDF and clear extracted fields"
              >
                Remove PDF
              </button>
            )}
          </div>
        </div>
        {errMsg && (
          <p className="text-[10px] text-red-600 mb-2">{errMsg}</p>
        )}
        {!report ? (
          <p className="text-[11px] text-slate-400 italic">
            No PDF uploaded. Click <span className="font-medium">Upload PDF</span> above to extract rating, target, and report date.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
            <label className="flex flex-col gap-0.5">
              <span className="text-slate-500">Rating</span>
              <select
                value={entry?.rating ?? "not-covered"}
                onChange={(e) => patchAnalyst(which, { rating: e.target.value as AnalystRating })}
                className="rounded border border-slate-200 bg-white px-1.5 py-1 outline-none focus:border-blue-400"
              >
                {RATING_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            <div className="flex flex-col gap-0.5">
              <span className="text-slate-500">Target price ({stockCurrency})</span>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  step="0.01"
                  value={entry?.target ?? ""}
                  onChange={(e) => patchAnalyst(which, { target: e.target.value === "" ? undefined : Number(e.target.value) })}
                  placeholder="$"
                  className="rounded border border-slate-200 bg-white px-1.5 py-1 outline-none focus:border-blue-400 flex-1 min-w-0"
                />
                {entry?.targetOriginal && entry.targetCurrency && (
                  <span className="text-[9px] text-slate-400 whitespace-nowrap" title={`Converted from ${entry.targetCurrency} $${entry.targetOriginal.toFixed(2)} at report-date rate ${entry.targetCurrency}${stockCurrency}=${entry.fxRate?.toFixed(4) ?? "?"}`}>
                    ({entry.targetCurrency} ${entry.targetOriginal.toFixed(2)})
                  </span>
                )}
                {entry?.target && !entry.targetOriginal && !entry.targetCurrency && (
                  <select
                    className="text-[9px] border border-slate-200 rounded px-0.5 py-0.5 bg-white text-blue-600 cursor-pointer shrink-0"
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
                {converting === which && <span className="text-[9px] text-slate-400">…</span>}
              </div>
            </div>
            <label className="flex flex-col gap-0.5">
              <span className="text-slate-500">Report date</span>
              <input
                type="date"
                value={entry?.asOf ?? ""}
                onChange={(e) => patchAnalyst(which, { asOf: e.target.value || undefined })}
                className="rounded border border-slate-200 bg-white px-1.5 py-1 outline-none focus:border-blue-400"
              />
            </label>
            <div className="flex flex-col gap-0.5">
              <span className="text-slate-500" title="Underlying price captured at upload time.">
                Price at report
              </span>
              <span className="rounded border border-slate-100 bg-slate-50 px-1.5 py-1 text-slate-700">
                {entry?.priceAtReport ? `$${entry.priceAtReport.toFixed(2)}` : <span className="italic text-slate-400">—</span>}
              </span>
            </div>
          </div>
        )}
        {report && (report.extracted.thesis?.length || report.extracted.risks?.length || report.extracted.sectorView || report.extracted.keyMetrics?.length) && (
          <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
            {report.extracted.sectorView && (
              <p className="text-[11px] text-slate-600 italic">{report.extracted.sectorView}</p>
            )}
            {report.extracted.thesis && report.extracted.thesis.length > 0 && (
              <div>
                <p className="text-[9px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Thesis</p>
                <ul className="text-[11px] text-slate-600 space-y-0.5 list-disc list-inside">
                  {report.extracted.thesis.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              </div>
            )}
            {report.extracted.risks && report.extracted.risks.length > 0 && (
              <div>
                <p className="text-[9px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Risks</p>
                <ul className="text-[11px] text-slate-600 space-y-0.5 list-disc list-inside">
                  {report.extracted.risks.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            )}
            {report.extracted.keyMetrics && report.extracted.keyMetrics.length > 0 && (
              <div>
                <p className="text-[9px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Key metrics</p>
                <ul className="text-[11px] text-slate-600 space-y-0.5">
                  {report.extracted.keyMetrics.map((m, i) => (
                    <li key={i}><span className="text-slate-500">{m.label}:</span> <span className="font-medium">{m.value}</span></li>
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
    <div className="ml-1 mt-3 mb-1 space-y-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
        Analyst Snapshot · {displayTicker(ticker)}
      </p>

      {/* FactSet street consensus */}
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-slate-700">FactSet street consensus</span>
          {factset && (
            <button
              type="button"
              onClick={clearFactSet}
              className="text-[10px] text-slate-400 hover:text-red-600"
            >
              Clear
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
          <label className="flex flex-col gap-0.5">
            <span className="text-slate-500">Avg target price</span>
            <input
              type="number"
              step="0.01"
              value={factset?.averageTarget ?? ""}
              onChange={(e) => patchFactSet({ averageTarget: e.target.value === "" ? undefined : Number(e.target.value) })}
              placeholder="$"
              className="rounded border border-slate-200 bg-white px-1.5 py-1 outline-none focus:border-blue-400"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-slate-500"># of analysts</span>
            <input
              type="number"
              value={factset?.analystCount ?? ""}
              onChange={(e) => patchFactSet({ analystCount: e.target.value === "" ? undefined : Number(e.target.value) })}
              className="rounded border border-slate-200 bg-white px-1.5 py-1 outline-none focus:border-blue-400"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-slate-500">As of</span>
            <input
              type="date"
              value={factset?.asOf ?? ""}
              onChange={(e) => patchFactSet({ asOf: e.target.value })}
              className="rounded border border-slate-200 bg-white px-1.5 py-1 outline-none focus:border-blue-400"
            />
          </label>
        </div>
        {breakdown.upside.target && breakdown.upside.upsidePercent !== undefined && (
          <p className="mt-2 text-[10px] text-slate-500">
            Implied upside: {breakdown.upside.upsidePercent >= 0 ? "+" : ""}
            {breakdown.upside.upsidePercent.toFixed(1)}% → contribution {breakdown.upside.contribution.toFixed(2)} pts
            {breakdown.upside.targetSource === "none" && (
              <span className="ml-1 italic">(no FactSet target entered — upside not computed)</span>
            )}
          </p>
        )}
      </div>

      {renderAnalyst("rbc", "RBC")}
      {renderAnalyst("jpm", "JPM")}

      <p className="text-[10px] text-slate-400 italic">
        Edits save automatically. The analystConsensus score auto-updates when FactSet target is changed via the Coverage Checklist.
      </p>
    </div>
  );
}
