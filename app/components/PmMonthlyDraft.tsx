"use client";

import React, { useEffect, useState } from "react";
import { AppIcon } from "@/app/components/AppIcon";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import type { MonthlyDraft } from "@/app/lib/pm-monthly-shared";

/**
 * The PM Monthly draft for one month: the PM's notes, Draft with AI (English
 * + French in the house style), side-by-side editing, re-translate, save, and
 * Word downloads of the SAVED text.
 */

/** Sentences carrying a percentage — the update must never state a return figure, so each one is shown for the PM to check. */
function percentSentences(text: string): string[] {
  return text
    .replace(/^#{2,3}\s+.*$/gm, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter((x) => /\d\s?%|\bpour cent\b|\bpercent\b/i.test(x));
}

const BTN =
  "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover disabled:opacity-50";

export function PmMonthlyDraft({ month }: { month: string }) {
  const [open, toggle] = usePersistedOpen("pmMonthly.draft.open", true);
  const [saved, setSaved] = useState<MonthlyDraft | null>(null);
  const [en, setEn] = useState("");
  const [fr, setFr] = useState("");
  const [notes, setNotes] = useState("");
  const [sources, setSources] = useState<{ url: string; title?: string }[]>([]);
  const [aiDrafted, setAiDrafted] = useState(false);
  const [busy, setBusy] = useState<null | "draft" | "translate" | "save">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/pm-monthly?month=${month}`)
      .then((r) => r.json())
      .then((d: { draft: MonthlyDraft | null }) => {
        if (!live) return;
        const x = d.draft;
        setSaved(x);
        setEn(x?.en ?? "");
        setFr(x?.fr ?? "");
        setNotes(x?.notes ?? "");
        setSources(x?.sources ?? []);
        setAiDrafted(x?.aiDrafted ?? false);
        setMsg(null);
        setLoaded(month);
      })
      .catch(() => live && setLoaded(month));
    return () => {
      live = false;
    };
  }, [month]);

  const dirty = loaded === month && (en !== (saved?.en ?? "") || fr !== (saved?.fr ?? "") || notes !== (saved?.notes ?? ""));

  const draft = async () => {
    if ((en.trim() || fr.trim()) && !window.confirm("Replace the English and French text on screen with a new AI draft? (Saved versions stay in the history.)")) return;
    setBusy("draft");
    setMsg(null);
    try {
      const d = await fetch("/api/pm-monthly/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month, notes }) }).then((r) => r.json());
      if (d?.en) {
        setEn(d.en);
        setFr(d.fr ?? "");
        setSources(d.sources ?? []);
        setAiDrafted(true);
        setMsg("Draft ready — read every line, edit, then Save. Nothing is saved yet.");
      } else setMsg(d?.error ?? "Draft failed.");
    } finally {
      setBusy(null);
    }
  };

  const translate = async () => {
    if (fr.trim() && !window.confirm("Replace the French with a fresh translation of the English on screen?")) return;
    setBusy("translate");
    setMsg(null);
    try {
      const d = await fetch("/api/pm-monthly/translate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month, en }) }).then((r) => r.json());
      if (d?.fr) {
        setFr(d.fr);
        setMsg("French updated from the English — not saved yet.");
      } else setMsg(d?.error ?? "Translation failed.");
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    setMsg(null);
    try {
      const d = await fetch("/api/pm-monthly", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month, en, fr, notes, aiDrafted, sources }) }).then((r) => r.json());
      if (d?.draft) {
        setSaved(d.draft);
        setMsg("Saved. The Word downloads use this saved text.");
      } else setMsg(d?.error ?? "Save failed.");
    } finally {
      setBusy(null);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text.replace(/^#{2,3}\s+/gm, ""));
      setMsg("Copied (headings as plain lines) — ready to paste into an email.");
    } catch {
      setMsg("Copy failed.");
    }
  };

  const area = "min-h-[420px] w-full rounded-control border border-line bg-surface px-3 py-2 text-[13px] leading-relaxed text-ink";
  return (
    <section className="panel">
      <button className="panel-h w-full text-left" onClick={toggle}>
        <span className="t">Client update draft</span>
        <span className="m">
          English + French · {saved ? `saved ${saved.updatedAt.slice(0, 16).replace("T", " ")}` : "not saved yet"}
          {dirty ? " · unsaved changes" : ""} · {open ? "hide" : "show"}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 px-3.5 py-3">
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            Optional notes. The draft already reads the site for you: the month&apos;s trades and rebalances, why we bought or sold (theses and journal), which areas drove the month, acted-on alerts and the weekly memos. Add anything to stress or avoid; these win over everything else.
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Optional — e.g. emphasise the move to fewer, higher-conviction names; don't mention the hedge." className="rounded-control border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink" />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button className={BTN} disabled={!!busy} onClick={draft} title="Researches the month's market backdrop and writes English + French in the house style from the facts below and your notes (~1-2 min, about 25¢).">
              <AppIcon name="spark" size={13} />
              {busy === "draft" ? "Researching and writing… (1-2 min)" : "Draft with AI"}
            </button>
            <button className={BTN} disabled={!!busy || !en.trim()} onClick={translate}>
              {busy === "translate" ? "Translating…" : "Re-translate French from English"}
            </button>
            <button className={BTN} disabled={!!busy || !dirty} onClick={save}>
              <AppIcon name="check" size={13} /> {busy === "save" ? "Saving…" : "Save"}
            </button>
            <a className={`${BTN} ${!saved?.en ? "pointer-events-none opacity-50" : ""}`} href={`/api/pm-monthly/docx?month=${month}&lang=en`}>
              <AppIcon name="download" size={13} /> Word (English)
            </a>
            <a className={`${BTN} ${!saved?.fr ? "pointer-events-none opacity-50" : ""}`} href={`/api/pm-monthly/docx?month=${month}&lang=fr`}>
              <AppIcon name="download" size={13} /> Word (French)
            </a>
            {msg && <span className="text-[12.5px] text-ink-2">{msg}</span>}
          </div>
          {[...percentSentences(en), ...percentSentences(fr)].length > 0 && (
            <div className="rounded-control border border-warn/40 bg-warn/5 px-3 py-2 text-[12.5px] text-ink-2">
              <div className="font-medium text-warn">Check these sentences — they contain a percentage. Return figures must not appear (other statistics, like the share of companies beating estimates, are fine):</div>
              <ul className="mt-1 list-disc pl-5">
                {[...percentSentences(en), ...percentSentences(fr)].map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
          )}
          {dirty && (saved?.en || saved?.fr) && <p className="text-[12px] text-warn">The Word downloads use the last SAVED text — save first to include your edits.</p>}
          <p className="text-[12px] text-ink-3">Lines starting with &quot;## &quot; are section headings and &quot;### &quot; sub-headings; leave a blank line between paragraphs.</p>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-[12px] text-ink-3">
                <span>English</span>
                <button className="text-accent hover:underline disabled:opacity-50" disabled={!en.trim()} onClick={() => copy(en)}>Copy for email</button>
              </div>
              <textarea value={en} onChange={(e) => setEn(e.target.value)} className={area} placeholder="Draft with AI, or write here." />
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-[12px] text-ink-3">
                <span>Français</span>
                <button className="text-accent hover:underline disabled:opacity-50" disabled={!fr.trim()} onClick={() => copy(fr)}>Copier pour le courriel</button>
              </div>
              <textarea value={fr} onChange={(e) => setFr(e.target.value)} className={area} placeholder="Traduction française." />
            </div>
          </div>
          {sources.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-3">
              <span>Sources for the market backdrop:</span>
              {sources.map((s) => (
                <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  {s.title || new URL(s.url).hostname}
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
