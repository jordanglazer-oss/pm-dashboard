"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CollapsibleSection } from "@/app/components/CollapsibleSection";

/**
 * Decision Journal (Phase 08) — capture the WHY behind each portfolio action,
 * with a confidence, so it can be reviewed against outcomes later. Persisted to
 * pm:decision-journal (backed up). The behavioural-edge layer: PMs improve most
 * from honestly reviewing their own past decisions.
 */

type DecisionEntry = {
  id: string;
  date: string;
  timestamp: string;
  ticker?: string;
  action: string;
  rationale: string;
  confidence?: "low" | "medium" | "high";
};

const ACTIONS = ["add", "trim", "hold", "hedge", "watch", "sell", "other"];
const ACTION_TONE: Record<string, string> = {
  add: "bg-pos-soft text-pos",
  trim: "bg-warn-soft text-warn",
  sell: "bg-neg-soft text-neg",
  hedge: "bg-violet-soft text-violet",
  hold: "bg-surface-2 text-ink-2",
  watch: "bg-accent-soft text-accent",
  other: "bg-surface-2 text-ink-2",
};
const CONF_TONE: Record<string, string> = {
  high: "text-pos",
  medium: "text-warn",
  low: "text-ink-3",
};

export function DecisionJournal() {
  const [entries, setEntries] = useState<DecisionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [ticker, setTicker] = useState("");
  const [action, setAction] = useState("add");
  const [rationale, setRationale] = useState("");
  const [confidence, setConfidence] = useState<"" | "low" | "medium" | "high">("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    fetch("/api/kv/decision-journal", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setEntries(Array.isArray(j?.entries) ? j.entries : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!rationale.trim()) return;
    setSaving(true);
    try {
      await fetch("/api/kv/decision-journal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: ticker.trim() || undefined, action, rationale: rationale.trim(), confidence: confidence || undefined }),
      });
      setTicker("");
      setRationale("");
      setConfidence("");
      setAction("add");
      setOpen(false);
      load();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    await fetch(`/api/kv/decision-journal?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  };

  const fmtDate = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return iso;
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
  };

  return (
    <CollapsibleSection
      prefKey="portfolio.decisionJournalCollapsed"
      className="border-line"
      title="Decision journal"
      subtitle="Capture why you acted — review it against outcomes later"
      right={
        <button
          onClick={() => setOpen((v) => !v)}
          className={`rounded-control px-2.5 py-1 text-[11px] font-semibold transition-colors ${
            open ? "bg-ink text-white" : "border border-line text-ink-3 hover:bg-surface-2"
          }`}
        >
          {open ? "Close" : "+ Log a decision"}
        </button>
      }
    >
      {open && (
        <div className="mb-4 flex flex-col gap-2.5 rounded-control border border-line bg-surface-2/40 p-3">
          <div className="flex flex-wrap gap-2">
            <input
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              placeholder="Ticker (optional)"
              className="w-[140px] rounded-control border border-line bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-accent"
            />
            <select value={action} onChange={(e) => setAction(e.target.value)} className="rounded-control border border-line bg-white px-2.5 py-1.5 text-[13px]">
              {ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a[0].toUpperCase() + a.slice(1)}
                </option>
              ))}
            </select>
            <select value={confidence} onChange={(e) => setConfidence(e.target.value as typeof confidence)} className="rounded-control border border-line bg-white px-2.5 py-1.5 text-[13px] text-ink-3">
              <option value="">Confidence…</option>
              <option value="high">High confidence</option>
              <option value="medium">Medium confidence</option>
              <option value="low">Low confidence</option>
            </select>
          </div>
          <textarea
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder="Why are you doing this? (the thesis / trigger — what you'd want to remember when reviewing it later)"
            rows={2}
            className="w-full rounded-control border border-line bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-accent"
          />
          <div className="flex items-center gap-2">
            <button onClick={save} disabled={saving || !rationale.trim()} className="rounded-control bg-ink px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-ink-2 disabled:opacity-50">
              {saving ? "Saving…" : "Save decision"}
            </button>
            <button onClick={() => setOpen(false)} className="text-[12px] font-semibold text-ink-3 hover:text-ink">
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="py-2 text-sm text-ink-3">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="py-2 text-[13px] text-ink-3">
          No decisions logged yet. When you add, trim, or hedge, jot down <span className="font-semibold text-ink-2">why</span> — future-you will thank present-you when reviewing what worked.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line-soft">
          {entries.map((e) => (
            <li key={e.id} className="flex items-start gap-3 py-2.5">
              <span className="w-[52px] shrink-0 font-mono text-[11px] tabular-nums text-ink-3">{fmtDate(e.date)}</span>
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${ACTION_TONE[e.action] ?? ACTION_TONE.other}`}>
                {e.action}
              </span>
              {e.ticker && (
                <Link href={`/stock/${e.ticker.toLowerCase()}`} className="w-[56px] shrink-0 font-mono text-[13px] font-semibold text-ink hover:underline">
                  {e.ticker}
                </Link>
              )}
              <span className="min-w-0 flex-1 text-[13px] text-ink-2">
                {e.rationale}
                {e.confidence && <span className={`ml-2 text-[11px] font-semibold ${CONF_TONE[e.confidence]}`}>· {e.confidence} conf.</span>}
              </span>
              <button onClick={() => remove(e.id)} title="Delete entry" className="shrink-0 text-[11px] text-ink-faint hover:text-neg">
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </CollapsibleSection>
  );
}
