"use client";

/**
 * Client Report one-pager preview.
 *
 * Route contract: `/client-report?group=<groupId>&profile=<profile>`.
 * Alpha is excluded at the button level (the Positioning header never
 * links here with `profile=alpha`) but we also validate it here — the
 * report is only meaningful for full model profiles (balanced, growth,
 * allEquity) because those are the ones we present to clients.
 *
 * Everything on this page flows from `useReportData`, which hits live
 * endpoints with `cache: no-store`. No stale data sneaks in via a
 * cached client bundle or a snapshot JSON. If we're ever unable to
 * fetch fresh data, the preview shows an error state rather than
 * silently filling in defaults.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useReportData, type ReportData } from "@/app/lib/useReportData";
import type { PimProfileType } from "@/app/lib/pim-types";

const VALID_PROFILES: readonly PimProfileType[] = ["balanced", "growth", "allEquity"];

// RBC Dominion Securities palette. Navy is the primary brand colour;
// gold is the accent used for rules, subtle highlights, and footer
// marks. Everything else stays neutral so the PDF prints cleanly.
const RBC_NAVY = "#002855";
const RBC_GOLD = "#FED141";

function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !isFinite(v)) return "—";
  return `${v >= 0 ? "" : ""}${v.toFixed(digits)}%`;
}

function fmtPctFrac(v: number | null | undefined, digits = 1): string {
  if (v == null || !isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

export default function ClientReportPage() {
  const router = useRouter();
  const params = useSearchParams();
  const groupId = params.get("group") || "pim";
  const profileParam = (params.get("profile") || "balanced") as PimProfileType;
  const profile = VALID_PROFILES.includes(profileParam) ? profileParam : "balanced";

  const { data, loading, error, refetch } = useReportData(groupId, profile);

  // Manager commentary — persisted per (group, profile) so switching
  // between Balanced / Growth doesn't clobber one with the other.
  const noteKey = `${groupId}::${profile}`;
  const [commentary, setCommentary] = useState("");
  const [commentarySaving, setCommentarySaving] = useState(false);
  const commentaryLoaded = useRef(false);

  // Load existing commentary once per (group, profile).
  useEffect(() => {
    let cancelled = false;
    commentaryLoaded.current = false;
    setCommentary("");
    fetch("/api/kv/client-report-notes", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { notes: {} }))
      .then((payload: { notes?: Record<string, string> }) => {
        if (cancelled) return;
        setCommentary(payload?.notes?.[noteKey] ?? "");
        commentaryLoaded.current = true;
      })
      .catch(() => {
        commentaryLoaded.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [noteKey]);

  // Debounced save on change.
  useEffect(() => {
    if (!commentaryLoaded.current) return;
    setCommentarySaving(true);
    const handle = setTimeout(async () => {
      try {
        const current = await fetch("/api/kv/client-report-notes", {
          cache: "no-store",
        })
          .then((r) => (r.ok ? r.json() : { notes: {} }))
          .catch(() => ({ notes: {} }));
        const notes = { ...(current.notes ?? {}), [noteKey]: commentary };
        await fetch("/api/kv/client-report-notes", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes }),
        });
      } finally {
        setCommentarySaving(false);
      }
    }, 600);
    return () => clearTimeout(handle);
  }, [commentary, noteKey]);

  const handlePrint = useCallback(() => {
    // Trigger the browser's native print dialog. Users pick "Save as
    // PDF" (Chrome/Safari both offer this) to end up with a real PDF.
    // The print CSS below strips the toolbar and backdrop so the page
    // reproduces exactly as previewed.
    window.print();
  }, []);

  return (
    <div className="min-h-screen bg-slate-100">
      {/* Print CSS — scoped to this route so we don't interfere with
          any other dashboard page. Ensures the letter-sized frame
          bleeds edge-to-edge and the screen toolbar is hidden. */}
      <style jsx global>{`
        @media print {
          @page {
            size: letter;
            margin: 0.4in;
          }
          html, body {
            background: #fff !important;
          }
          .report-preview-frame {
            box-shadow: none !important;
            margin: 0 !important;
            width: 100% !important;
          }
        }
      `}</style>
      {/* Screen-only toolbar — hidden on print so the page renders
          exactly as it will download. */}
      <div className="print:hidden sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur px-6 py-3 flex items-center gap-3 shadow-sm">
        <button
          onClick={() => router.back()}
          className="text-sm text-slate-600 hover:text-slate-800"
          aria-label="Back"
        >
          ← Back
        </button>
        <div className="text-sm font-semibold text-slate-800">Client Report Preview</div>
        <div className="flex-1" />
        <button
          onClick={() => refetch()}
          disabled={loading}
          className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200 disabled:opacity-50"
        >
          {loading ? "Refreshing…" : "Refresh live data"}
        </button>
        <button
          onClick={handlePrint}
          disabled={!data || loading}
          className="rounded-lg px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          style={{ backgroundColor: RBC_NAVY }}
        >
          Generate PDF
        </button>
      </div>

      {/* Page frame — letter-sized for print. On screen we show the
          same frame centred on a grey backdrop so what you see really
          is what you get. */}
      <div className="report-preview-frame mx-auto my-6 bg-white shadow-lg print:shadow-none print:my-0" style={{ width: "8.5in", minHeight: "11in" }}>
        {loading && !data && (
          <div className="p-12 text-center text-slate-500 text-sm">Loading live data…</div>
        )}
        {error && (
          <div className="p-12 text-center text-rose-600 text-sm">
            {error}. <button onClick={() => refetch()} className="underline">Try again</button>.
          </div>
        )}
        {data && (
          <OnePager
            data={data}
            commentary={commentary}
            onCommentaryChange={setCommentary}
            commentarySaving={commentarySaving}
          />
        )}
      </div>
    </div>
  );
}

// ───────── Report body ─────────

function OnePager({
  data,
  commentary,
  onCommentaryChange,
  commentarySaving,
}: {
  data: ReportData;
  commentary: string;
  onCommentaryChange: (v: string) => void;
  commentarySaving: boolean;
}) {
  const dateStr = useMemo(
    () =>
      new Date(data.generatedAt).toLocaleDateString("en-CA", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
    [data.generatedAt]
  );

  return (
    <div className="p-8 text-slate-800" style={{ fontFamily: "system-ui, -apple-system, sans-serif" }}>
      {/* ── Header ── */}
      <div className="flex items-start justify-between pb-4 border-b-4" style={{ borderColor: RBC_NAVY }}>
        <div>
          <div className="text-xs tracking-[0.2em] uppercase text-slate-500">RBC Dominion Securities</div>
          <div className="mt-1 text-2xl font-bold" style={{ color: RBC_NAVY }}>
            Di Iorio Wealth Management
          </div>
          <div className="mt-1 text-sm text-slate-600">
            {data.profileLabel} Model — Current Positioning
          </div>
        </div>
        <div className="text-right">
          {/* Logo slot — drops in once we have the asset. Until then a
              tasteful placeholder labelled correctly so it prints. */}
          <div
            className="w-24 h-12 border rounded flex items-center justify-center text-[10px] text-slate-400"
            style={{ borderColor: RBC_NAVY }}
            aria-label="RBC logo placeholder"
          >
            RBC
          </div>
          <div className="mt-2 text-xs text-slate-500">{dateStr}</div>
        </div>
      </div>

      {/* ── Top row: holdings + geography ── */}
      <div className="grid grid-cols-3 gap-6 mt-5">
        <div className="col-span-2">
          <SectionTitle>Current Positioning</SectionTitle>
          <HoldingsTable data={data} />
          <div className="mt-2 text-[10px] text-slate-400 flex justify-between">
            <span>CAD: {data.totals.cad.toFixed(1)}% · USD: {data.totals.usd.toFixed(1)}%</span>
            <span>Core ETF family rows show CAD/USD split when both variants are held.</span>
          </div>
        </div>
        <div>
          <SectionTitle>Geography</SectionTitle>
          <BarList
            rows={data.geography.map((g) => ({ label: g.country, value: g.weight }))}
            accent={RBC_NAVY}
          />
        </div>
      </div>

      {/* ── Middle row: sectors + performance ── */}
      <div className="grid grid-cols-2 gap-6 mt-6">
        <div>
          <SectionTitle>Top Sector Exposures</SectionTitle>
          <BarList
            rows={data.sectors.slice(0, 8).map((s) => ({ label: s.sector, value: s.weight }))}
            accent={RBC_GOLD}
            textColor={RBC_NAVY}
          />
          {!data.sectors.length && (
            <div className="text-[11px] text-slate-400 italic mt-2">
              Sector data will populate once look-through fund data is cached for this model&apos;s ETFs.
            </div>
          )}
        </div>
        <div>
          <SectionTitle>Performance vs S&amp;P 500</SectionTitle>
          <PerformanceBlock data={data} />
        </div>
      </div>

      {/* ── Manager commentary ──
           On screen we render an editable textarea (debounced-save to
           Redis so it survives reloads). On print, we swap to a plain
           div with the same content so the PDF doesn't include form
           chrome. */}
      <div className="mt-6">
        <div className="flex items-center justify-between">
          <SectionTitle>Manager Commentary</SectionTitle>
          <span className="print:hidden text-[9px] text-slate-400 pl-2 pb-1">
            {commentarySaving ? "Saving…" : "Auto-saved"}
          </span>
        </div>
        <textarea
          value={commentary}
          onChange={(e) => onCommentaryChange(e.target.value)}
          placeholder="Optional — leave blank if not used."
          className="print:hidden mt-2 w-full min-h-[64px] rounded border border-slate-200 p-3 text-xs text-slate-700 focus:outline-none focus:ring-1"
          style={{ resize: "vertical" }}
          rows={3}
        />
        <div className="hidden print:block mt-2 text-xs text-slate-700 whitespace-pre-wrap">
          {commentary}
        </div>
      </div>

      {/* ── Footer ── */}
      <div className="mt-6 pt-3 border-t text-[9px] text-slate-400 flex justify-between" style={{ borderColor: RBC_GOLD }}>
        <span>
          Di Iorio Wealth Management · RBC Dominion Securities Inc. · For client presentation purposes only.
        </span>
        <span>Generated {new Date(data.generatedAt).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
    </div>
  );
}

// ───────── Subcomponents ─────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="text-[11px] font-bold uppercase tracking-[0.15em] pb-1 border-b"
      style={{ color: RBC_NAVY, borderColor: RBC_GOLD }}
    >
      {children}
    </div>
  );
}

function HoldingsTable({ data }: { data: ReportData }) {
  return (
    <table className="w-full mt-2 text-[11px]">
      <thead>
        <tr className="text-slate-500 border-b border-slate-200">
          <th className="text-left font-semibold py-1">Holding</th>
          <th className="text-right font-semibold py-1">Weight</th>
          <th className="text-right font-semibold py-1">CAD</th>
          <th className="text-right font-semibold py-1">USD</th>
        </tr>
      </thead>
      <tbody>
        {data.holdings.map((h, i) => (
          <tr key={h.id} className={i % 2 ? "bg-slate-50" : ""}>
            <td className="py-1">
              <span className="text-slate-800">{h.name}</span>
              <span className="ml-2 text-[9px] text-slate-400 uppercase">{h.bucket}</span>
            </td>
            <td className="text-right py-1 tabular-nums font-semibold">{h.weight.toFixed(2)}%</td>
            <td className="text-right py-1 tabular-nums text-slate-500">
              {h.cadWeight != null ? `${h.cadWeight.toFixed(2)}%` : ""}
            </td>
            <td className="text-right py-1 tabular-nums text-slate-500">
              {h.usdWeight != null ? `${h.usdWeight.toFixed(2)}%` : ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BarList({
  rows,
  accent,
  textColor = "#1e293b",
}: {
  rows: { label: string; value: number }[];
  accent: string;
  textColor?: string;
}) {
  if (!rows.length) {
    return <div className="text-[11px] text-slate-400 italic mt-2">No data.</div>;
  }
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="mt-2 space-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="text-[11px]">
          <div className="flex justify-between">
            <span style={{ color: textColor }}>{r.label}</span>
            <span className="tabular-nums text-slate-600 font-semibold">{r.value.toFixed(1)}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-100 mt-0.5 overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.min(100, (r.value / max) * 100)}%`, backgroundColor: accent }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function PerformanceBlock({ data }: { data: ReportData }) {
  const { performance: p } = data;
  return (
    <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
      <Stat label="1Y Return" value={fmtPctFrac(p.oneYearReturn)} />
      <Stat label="3Y Return (ann.)" value={fmtPctFrac(p.threeYearReturn)} />
      <Stat label="5Y Return (ann.)" value={fmtPctFrac(p.fiveYearReturn)} />
      <Stat label="Volatility (5Y)" value={fmtPctFrac(p.volatility)} />
      <Stat label="Upside Capture" value={fmtPct(p.upsideCapture)} />
      <Stat label="Downside Capture" value={fmtPct(p.downsideCapture)} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border p-2" style={{ borderColor: "#e2e8f0" }}>
      <div className="text-[9px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="text-sm font-bold mt-0.5 tabular-nums" style={{ color: RBC_NAVY }}>
        {value}
      </div>
    </div>
  );
}
