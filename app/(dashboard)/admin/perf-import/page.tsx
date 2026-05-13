"use client";

import React, { useState, useCallback } from "react";
import type { PimProfileType } from "@/app/lib/pim-types";

/**
 * Admin page: import third-party performance CSV files.
 *
 * Streamlines the SIA Charts (or compatible) CSV → /api/admin/import-
 * third-party-values flow into a click-through UI: select profile,
 * upload CSV, see a dry-run preview, then click Apply to write. The
 * underlying endpoint is the same one used previously via DevTools
 * console commands — this just wraps it in a friendlier UX so the
 * import can be re-run on a recurring (bi-weekly / monthly) cadence
 * without copy-pasting JSON into a developer console.
 *
 * CSV format (SIA Charts export, also any "Date,...,Total" CSV where
 * Total is the last quoted column):
 *   ,Edit,Date,Trades,"Corp. Act.",Cash,Total
 *   ,,05/12/2026,,,"$149,778.22","$113,711,130.86"
 *
 * The parser handles quoted commas inside the dollar amounts.
 *
 * Pre-fromDate values (e.g. Dec 31 prior year) are passed through to
 * the endpoint as the anchor so the boundary-day return is preserved.
 * Only current-year entries (date >= YYYY-01-01) are actually written.
 *
 * The Apply button uses a browser confirm() dialog as a final guard
 * — once the user confirms there, the write fires.
 */

type ParsedRow = { date: string; value: number };

type DryRunSummary = {
  profile: string;
  fromDate: string;
  baselineValue: number;
  importedValueCount: number;
  firstImportedDate: string;
  lastImportedDate: string;
  firstNormalizedIndex?: number;
  lastNormalizedIndex?: number;
  newYtdPct: number;
  existingYtdPct: number | null;
  anchoredLastEntry: boolean;
  entriesBeingReplaced: { perf: number; appendix: number };
  preFromDateEntriesPreserved: { perf: number; appendix: number };
  anchorPreValue: { date: string; value: number } | null;
};

type DryRunResponse = {
  ok: boolean;
  dryRun: boolean;
  wrote: boolean;
  summary: DryRunSummary;
  sample?: {
    first?: { date: string; value: number; dailyReturn: number };
    last?: { date: string; value: number; dailyReturn: number };
    midpoint?: { date: string; value: number; dailyReturn: number };
  };
  error?: string;
};

type WriteResponse = {
  ok: boolean;
  dryRun: false;
  wrote: true;
  stashKeys: { perf: string | null; appendix: string | null };
  summary: DryRunSummary;
  error?: string;
};

const PROFILE_OPTIONS: { value: PimProfileType; label: string }[] = [
  { value: "balanced", label: "Balanced" },
  { value: "growth", label: "Growth" },
  { value: "allEquity", label: "All-Equity" },
  { value: "alpha", label: "Alpha" },
];

function parseCsvRow(line: string): string[] {
  // Standard CSV row parse that respects double-quoted commas.
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === "," && !inQuote) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Parse the SIA Charts CSV format (Total in column 7, MM/DD/YYYY date).
 *  Returns ascending-by-date values. */
function parseSiaCsv(text: string): { rows: ParsedRow[]; warnings: string[] } {
  const warnings: string[] = [];
  const lines = text.trim().split(/\r?\n/);
  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvRow(lines[i]);
    if (cols.length < 7) continue;
    const dateRaw = cols[2].trim();
    const totalRaw = cols[6].trim().replace(/\$/g, "").replace(/,/g, "");
    const total = parseFloat(totalRaw);
    if (!isFinite(total) || total <= 0) continue;
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateRaw);
    if (!m) continue;
    rows.push({ date: `${m[3]}-${m[1]}-${m[2]}`, value: total });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length === 0) {
    warnings.push("No rows parsed — verify the CSV is in SIA Charts format (Date column 3, Total column 7).");
  }
  return { rows, warnings };
}

export default function PerfImportPage() {
  const [profile, setProfile] = useState<PimProfileType>("alpha");
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedRow[] | null>(null);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);
  const [dryRun, setDryRun] = useState<DryRunResponse | null>(null);
  const [writeResult, setWriteResult] = useState<WriteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setDryRun(null);
    setWriteResult(null);
    setError(null);
    try {
      const text = await file.text();
      const { rows, warnings } = parseSiaCsv(text);
      setParsed(rows);
      setParseWarnings(warnings);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setParsed(null);
    }
  }, []);

  const callEndpoint = useCallback(async (dryRunFlag: boolean): Promise<DryRunResponse | WriteResponse | null> => {
    if (!parsed) return null;
    setLoading(true);
    setError(null);
    try {
      const yearStart = `${new Date().toISOString().slice(0, 4)}-01-01`;
      const priorYearEndYear = parseInt(yearStart.slice(0, 4)) - 1;
      const cutoff = `${priorYearEndYear}-01-01`;
      // Pass anything from prior-year-onward; the endpoint splits at
      // fromDate and uses pre-fromDate as anchor. Filtering at this
      // layer just avoids sending unnecessary historical data.
      const values = parsed.filter((v) => v.date >= cutoff);
      const res = await fetch("/api/admin/import-third-party-values", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, values, dryRun: dryRunFlag }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || `HTTP ${res.status}`);
        return null;
      }
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, [parsed, profile]);

  const handleDryRun = useCallback(async () => {
    const data = (await callEndpoint(true)) as DryRunResponse | null;
    if (data) {
      setDryRun(data);
      setWriteResult(null);
    }
  }, [callEndpoint]);

  const handleApply = useCallback(async () => {
    if (!dryRun) return;
    const ok = confirm(
      `Confirm WRITE for ${profile.toUpperCase()}?\n\n` +
      `This will replace current-year daily values in pm:pim-performance and pm:appendix-daily-values ` +
      `with ${dryRun.summary.importedValueCount} SIA-imported entries. All imported entries will be ` +
      `marked anchored (locked from future recompute). Stash keys will be created for rollback.\n\n` +
      `New YTD: ${dryRun.summary.newYtdPct}%\n` +
      `Currently stored YTD: ${dryRun.summary.existingYtdPct ?? "n/a"}%\n\n` +
      `Proceed?`
    );
    if (!ok) return;
    const data = (await callEndpoint(false)) as WriteResponse | null;
    if (data) {
      setWriteResult(data);
      setDryRun(null); // dry-run preview consumed
    }
  }, [callEndpoint, dryRun, profile]);

  return (
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 md:px-8 md:py-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">SIA Performance Import</h1>
          <p className="text-sm text-slate-500 mt-1">
            Replace this year&apos;s daily portfolio values with a fresh export from your third-party
            tracker. Pre-current-year history stays locked. All imported entries are anchored so
            future daily-update runs cannot overwrite them.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
          {/* Profile selector */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-2">
              Profile
            </label>
            <div className="flex gap-2 flex-wrap">
              {PROFILE_OPTIONS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => {
                    setProfile(p.value);
                    setDryRun(null);
                    setWriteResult(null);
                  }}
                  className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                    profile === p.value
                      ? "bg-blue-600 text-white"
                      : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* File upload */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-2">
              CSV file (SIA Charts export)
            </label>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={handleFile}
              className="block w-full text-sm text-slate-600 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
            />
            {fileName && (
              <p className="text-xs text-slate-500 mt-2">Loaded: {fileName}</p>
            )}
          </div>

          {/* Parsed preview */}
          {parsed && (
            <div className="rounded-lg bg-slate-50 p-4 text-sm space-y-1">
              <div className="font-semibold text-slate-700">Parsed {parsed.length} rows</div>
              {parsed.length > 0 && (
                <>
                  <div className="text-slate-600">
                    First: <span className="font-mono">{parsed[0].date}</span> → <span className="font-mono">${parsed[0].value.toLocaleString()}</span>
                  </div>
                  <div className="text-slate-600">
                    Last: <span className="font-mono">{parsed[parsed.length - 1].date}</span> → <span className="font-mono">${parsed[parsed.length - 1].value.toLocaleString()}</span>
                  </div>
                </>
              )}
              {parseWarnings.map((w, i) => (
                <div key={i} className="text-amber-700 text-xs">⚠ {w}</div>
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2 pt-2">
            <button
              onClick={handleDryRun}
              disabled={!parsed || loading}
              className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? "Running…" : "Dry Run (preview)"}
            </button>
            <button
              onClick={handleApply}
              disabled={!dryRun || loading}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? "Writing…" : "Apply (Write to Redis)"}
            </button>
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
              <strong>Error:</strong> {error}
            </div>
          )}
        </div>

        {/* Dry-run result */}
        {dryRun && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 shadow-sm space-y-3">
            <h2 className="text-lg font-bold text-amber-900">Dry-run preview — NOT written yet</h2>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wider text-amber-800 font-semibold">Profile</div>
                <div className="font-semibold text-slate-900">{dryRun.summary.profile}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-amber-800 font-semibold">From date</div>
                <div className="font-mono text-slate-900">{dryRun.summary.fromDate}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-amber-800 font-semibold">New YTD</div>
                <div className="font-semibold text-slate-900">{dryRun.summary.newYtdPct}%</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-amber-800 font-semibold">Existing YTD (will be replaced)</div>
                <div className="font-semibold text-slate-900">{dryRun.summary.existingYtdPct ?? "n/a"}%</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-amber-800 font-semibold">Entries imported</div>
                <div className="font-semibold text-slate-900">{dryRun.summary.importedValueCount}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-amber-800 font-semibold">Range</div>
                <div className="font-mono text-slate-900 text-xs">{dryRun.summary.firstImportedDate} → {dryRun.summary.lastImportedDate}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-amber-800 font-semibold">Anchor (pre-fromDate)</div>
                <div className="font-mono text-slate-900 text-xs">
                  {dryRun.summary.anchorPreValue
                    ? `${dryRun.summary.anchorPreValue.date} · $${dryRun.summary.anchorPreValue.value.toLocaleString()}`
                    : "none — first day return collapses to 0"}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-amber-800 font-semibold">Pre-fromDate preserved</div>
                <div className="font-semibold text-slate-900">{dryRun.summary.preFromDateEntriesPreserved.appendix} appendix · {dryRun.summary.preFromDateEntriesPreserved.perf} perf</div>
              </div>
            </div>
            <p className="text-xs text-amber-700 pt-1">
              Review these numbers. If correct, click <strong>Apply</strong> to write. If anything looks off, change profile/file and re-run Dry Run.
            </p>
          </div>
        )}

        {/* Write result */}
        {writeResult && (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 shadow-sm space-y-3">
            <h2 className="text-lg font-bold text-emerald-900">✓ Imported successfully</h2>
            <div className="text-sm text-slate-800">
              <strong>{writeResult.summary.importedValueCount}</strong> daily values written for{" "}
              <strong>{writeResult.summary.profile}</strong> covering{" "}
              <span className="font-mono">{writeResult.summary.firstImportedDate}</span> →{" "}
              <span className="font-mono">{writeResult.summary.lastImportedDate}</span>.
            </div>
            <div className="text-sm text-slate-800">
              New YTD: <strong>{writeResult.summary.newYtdPct}%</strong>
            </div>
            <div className="text-xs text-slate-600 pt-2">
              Rollback stash keys (if ever needed):
              <ul className="list-disc list-inside pt-1 font-mono">
                <li>{writeResult.stashKeys.perf}</li>
                <li>{writeResult.stashKeys.appendix}</li>
              </ul>
            </div>
            <p className="text-xs text-emerald-700 pt-1">
              Refresh the PIM Model / PIM Performance pages to see the updated chart.
            </p>
          </div>
        )}

        {/* Quick reference */}
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-xs text-slate-500 space-y-1">
          <div className="font-semibold text-slate-700 mb-2 text-sm">Tips</div>
          <div>• Bi-weekly / monthly cadence is reasonable. The endpoint is additive at the boundary so importing fresh data once a month catches the latest weeks.</div>
          <div>• Pre-current-year history is permanently locked. Only the current year&apos;s entries get replaced.</div>
          <div>• Include Dec 31 of the prior year in the export so the Jan 2 boundary return is preserved (otherwise it&apos;ll collapse to 0).</div>
          <div>• All imported entries are marked anchored — future <code>update-daily-value</code> runs and PUT writes cannot modify them.</div>
          <div>• Today&apos;s entry is computed live by the daily-update path. Don&apos;t worry about it being in the CSV — it&apos;ll get appended automatically.</div>
        </div>
      </div>
    </main>
  );
}
