"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CollapsibleSection } from "@/app/components/CollapsibleSection";
import type { ThesisHealth, ThesisVerdict } from "@/app/lib/thesis-health";

/**
 * Thesis Watch (Phase 03) — the Living Thesis Tracker surface.
 * - Automated: per-holding intact/eroding/broken from tracked signals
 *   (/api/thesis-health, read-only cache).
 * - Human seed: your "why I own it" note per holding (pm:position-theses),
 *   fetched separately and joined here — the two-writer rule keeps the human
 *   note and the machine verdict in separate keys so neither clobbers the other.
 */

type Holding = ThesisHealth & { name?: string; sector?: string };
type ThesisData = {
  builtAt: string;
  counts: { broken: number; eroding: number; intact: number };
  holdings: Holding[];
};
type Theses = Record<string, { why: string; updatedAt: string }>;

const VERDICT_BADGE: Record<ThesisVerdict, string> = {
  broken: "bg-neg-soft text-neg",
  eroding: "bg-warn-soft text-warn",
  intact: "bg-pos-soft text-pos",
};

export function ThesisWatch() {
  const [data, setData] = useState<ThesisData | null>(null);
  const [theses, setTheses] = useState<Theses>({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch("/api/thesis-health", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
      fetch("/api/kv/position-theses", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
    ])
      .then(([health, seed]) => {
        if (!alive) return;
        if (health?.thesisHealth?.holdings) setData(health.thesisHealth as ThesisData);
        if (seed?.theses) setTheses(seed.theses as Theses);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const saveWhy = useCallback(async (ticker: string, why: string) => {
    setSaving(true);
    try {
      await fetch("/api/kv/position-theses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, why }),
      });
      setTheses((prev) => {
        const next = { ...prev };
        if (why.trim()) next[ticker.toUpperCase()] = { why: why.trim(), updatedAt: new Date().toISOString() };
        else delete next[ticker.toUpperCase()];
        return next;
      });
      setEditing(null);
      setDraft("");
    } catch {
      /* leave the editor open on failure */
    } finally {
      setSaving(false);
    }
  }, []);

  const startEdit = (ticker: string) => {
    setEditing(ticker);
    setDraft(theses[ticker.toUpperCase()]?.why ?? "");
  };

  const flagged = (data?.holdings ?? []).filter((h) => h.verdict !== "intact");

  return (
    <CollapsibleSection
      prefKey="portfolio.thesisWatchCollapsed"
      className="border-line"
      title="Thesis watch"
      subtitle="Is the reason you own each name still intact?"
      right={
        data ? (
          <span className="flex items-center gap-2 text-[11px] font-semibold">
            {data.counts.broken > 0 && <span className="text-neg">{data.counts.broken} broken</span>}
            {data.counts.eroding > 0 && <span className="text-warn">{data.counts.eroding} eroding</span>}
            <span className="text-pos">{data.counts.intact} intact</span>
          </span>
        ) : null
      }
    >
      {loading && <p className="py-2 text-sm text-ink-3">Loading…</p>}

      {data && flagged.length === 0 && (
        <p className="py-2 text-sm text-ink-2">
          Every holding&apos;s thesis is <span className="font-semibold text-pos">intact</span> — no deterioration in the signals we track (composite score, estimate revisions, risk alerts).
        </p>
      )}

      {flagged.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <p className="text-[11.5px] text-ink-3">
            These names show deterioration in the signals we track — worth a look before the story fully turns. Add <span className="font-semibold text-ink-2">why you own it</span> so you can judge whether the deterioration actually hits your thesis.
          </p>
          {flagged.map((h) => {
            const seeded = theses[h.ticker.toUpperCase()]?.why;
            return (
              <div key={h.ticker} className="flex items-start gap-3 rounded-control border border-line-soft px-3 py-2.5">
                <Link
                  href={`/stock/${h.ticker.toLowerCase()}`}
                  className="w-[64px] shrink-0 font-mono text-sm font-semibold text-ink hover:underline"
                >
                  {h.ticker}
                </Link>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${VERDICT_BADGE[h.verdict]}`}>
                  {h.verdict}
                </span>
                <div className="flex flex-1 flex-col gap-2">
                  <div className="flex flex-wrap gap-1.5">
                    {h.drivers
                      .filter((d) => d.direction === "negative")
                      .map((d, i) => (
                        <span
                          key={`${d.signal}-${i}`}
                          className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-2"
                          title={d.detail}
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-neg" aria-hidden />
                          {d.detail}
                        </span>
                      ))}
                  </div>

                  {/* Human "why" seed */}
                  {editing === h.ticker ? (
                    <div className="flex flex-col gap-1.5">
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder="Why do you own this? (e.g. pricing power + margin expansion into the cycle)"
                        rows={2}
                        className="w-full rounded-control border border-line bg-white px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => saveWhy(h.ticker, draft)}
                          disabled={saving}
                          className="rounded-control bg-ink px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-ink-2 disabled:opacity-50"
                        >
                          {saving ? "Saving…" : "Save"}
                        </button>
                        <button onClick={() => { setEditing(null); setDraft(""); }} className="text-[11px] font-semibold text-ink-3 hover:text-ink">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : seeded ? (
                    <div className="flex items-start gap-2 text-[12.5px] text-ink-2">
                      <span className="italic">“{seeded}”</span>
                      <button onClick={() => startEdit(h.ticker)} className="shrink-0 text-[11px] font-semibold text-accent hover:text-accent-ink">
                        edit
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => startEdit(h.ticker)} className="self-start text-[11px] font-semibold text-accent hover:text-accent-ink">
                      + Why do you own this?
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          <p className="text-[10.5px] leading-4 text-ink-faint">
            Verdict is automated from the composite score trend (~45d), FactSet FY+1 estimate revisions, and technical risk alerts. Your &ldquo;why&rdquo; is saved to your profile and shown here as context — the verdict does not change it.
          </p>
        </div>
      )}
    </CollapsibleSection>
  );
}
