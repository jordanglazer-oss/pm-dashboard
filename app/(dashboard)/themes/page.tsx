"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/app/components/PageHeading";
import { AppIcon } from "@/app/components/AppIcon";
import { Skeleton } from "@/app/components/Skeleton";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import { displayTicker } from "@/app/lib/ticker";
import type { Bellwether, DetectedTheme, ThemePillar, ThemeView } from "@/app/lib/themes";

/**
 * /themes — the investment themes the book is concentrated in (Phase 2).
 *
 * Each theme: its pillars (the durable drivers the whole theme rests on) with
 * a status, the holdings in it (from each signed thesis's themes) and their
 * share of Alpha, and its bellwethers (names we may not own whose results
 * decide whether the theme holds) with the latest FactSet evidence on them.
 *
 * "Draft with AI" researches and writes a theme (main key, web search,
 * nothing saved); the PM edits and signs. Saving is the only write —
 * POST /api/themes, one theme at a time. Archive never deletes.
 */

type Draft = {
  id?: string;
  name: string;
  aliases: string[];
  summary: string;
  pillars: ThemePillar[];
  bellwethers: Bellwether[];
  aiDrafted?: boolean;
};
type Evidence = { date: string; kind?: string; event?: string; headline?: string; summary?: string; bottomLine?: string };
type Payload = { themes: ThemeView[]; detected: DetectedTheme[]; alphaTotal: number; bellwetherEvidence: Record<string, Evidence[]> };

const BTN = "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover transition-colors disabled:opacity-50";
const BTN_PRI = "inline-flex h-7 items-center gap-1.5 rounded-control bg-ink px-2.5 text-[12.5px] font-medium !text-white hover:bg-ink-2 transition-colors disabled:opacity-40";
const INPUT = "h-7 rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent-border";

const STANCE: Record<string, { dot: string; text: string; word: string }> = {
  intact: { dot: "bg-pos", text: "text-pos", word: "Intact" },
  watch: { dot: "bg-warn", text: "text-warn", word: "Watch" },
  broken: { dot: "bg-neg", text: "text-neg", word: "Broken" },
};
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export default function ThemesPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [sources, setSources] = useState<Array<{ url: string; title?: string }>>([]);
  const [drafting, setDrafting] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetch("/api/themes", { cache: "no-store" }).then((r) => r.json());
      setData(d as Payload);
    } catch {
      setError("Couldn't load themes.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const draftWithAi = async (name: string, id?: string) => {
    setDrafting(name);
    setMsg(null);
    try {
      const d = await fetch("/api/themes/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, id }) }).then((r) => r.json());
      if (!d?.draft) throw new Error(d?.error || "draft failed");
      setEditing(d.draft as Draft);
      setSources(Array.isArray(d.sources) ? d.sources : []);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "draft failed");
    } finally {
      setDrafting(null);
    }
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const r = await fetch("/api/themes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: editing }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "save failed");
      setEditing(null);
      setSources([]);
      setMsg(`Saved ${editing.name}.`);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  };

  const archive = async (t: ThemeView) => {
    if (!window.confirm(`Archive the theme "${t.name}"? It leaves this page; nothing is deleted and the holdings' theses keep their theme lines.`)) return;
    await fetch("/api/themes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: t.id, archive: true }) });
    await load();
  };

  return (
    <main className="flex flex-col gap-3.5 text-ink">
      <PageHeading
        lede="The themes the book is concentrated in: what each rests on, which holdings are in it, and the bellwethers whose results decide whether it holds. AI drafts; you sign."
        actions={
          <span className="inline-flex items-center gap-2">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New theme, e.g. AI data-centre buildout" className={`${INPUT} w-64`} />
            <button className={BTN} disabled={!newName.trim() || !!drafting} onClick={() => draftWithAi(newName.trim())}>
              <AppIcon name="spark" size={13} />
              Draft with AI
            </button>
          </span>
        }
      />
      {drafting && <p className="text-[12.5px] text-ink-3">Researching “{drafting}” — about 1-2 minutes…</p>}
      {msg && <p className="text-[12.5px] text-ink-2">{msg}</p>}
      {error && <p className="text-[13px] text-neg">{error}</p>}
      {!data && !error && <Skeleton className="h-24 w-full" />}

      {editing && (
        <ThemeEditor draft={editing} sources={sources} onChange={setEditing} onCancel={() => { setEditing(null); setSources([]); }} onSave={save} saving={saving} />
      )}

      {data && data.themes.length === 0 && !editing && (
        <p className="panel px-3.5 py-3 text-[12.5px] text-ink-3">
          No themes yet. When a thesis is drafted with AI it names the themes the company belongs to; those names collect below as “Themes found in your theses”. Draft one with AI to give it pillars and bellwethers.
        </p>
      )}

      {data?.themes.map((t) => (
        <ThemeCard
          key={t.id}
          theme={t}
          evidence={data.bellwetherEvidence}
          drafting={drafting === t.name}
          onRedraft={() => draftWithAi(t.name, t.id)}
          onEdit={() => {
            setEditing({ id: t.id, name: t.name, aliases: t.aliases ?? [], summary: t.summary ?? "", pillars: t.pillars.map((p) => ({ ...p })), bellwethers: t.bellwethers.map((b) => ({ ...b })) });
            setSources([]);
          }}
          onArchive={() => archive(t)}
        />
      ))}

      {data && data.detected.length > 0 && (
        <section className="panel">
          <div className="panel-h">
            <span className="t-mark bg-hub-portfolio" aria-hidden />
            <span className="t">Themes found in your theses</span>
            <span className="m">not yet a theme — draft one, or it may be a variant of an existing theme (a redraft adds it as an alias)</span>
          </div>
          {data.detected.map((d) => (
            <div key={d.name} className="flex flex-wrap items-center gap-2 border-t border-line-soft px-3.5 py-2 text-[12.5px]">
              <span className="font-medium text-ink">{d.name}</span>
              <span className="text-ink-3">{d.tickers.map((tk) => displayTicker(tk)).join(", ")}</span>
              <button className={`${BTN} ml-auto`} disabled={!!drafting} onClick={() => draftWithAi(d.name)}>
                <AppIcon name="spark" size={13} />
                Draft with AI
              </button>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}

function ThemeCard({
  theme: t,
  evidence,
  drafting,
  onRedraft,
  onEdit,
  onArchive,
}: {
  theme: ThemeView;
  evidence: Record<string, Evidence[]>;
  drafting: boolean;
  onRedraft: () => void;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const [open, toggle] = usePersistedOpen(`themes.card.${t.id}`, true);
  const held = t.members.filter((m) => m.bucket === "Portfolio");
  return (
    <section className="panel">
      <div className="panel-h flex-wrap gap-y-1.5">
        <span className="t-mark bg-hub-portfolio" aria-hidden />
        <span className="t">{t.name}</span>
        <span className="m">
          {held.length} held · <span className="font-mono">{pct(t.alphaShare)}</span> of Alpha + Thematic
          {t.signedAt && <> · signed <span className="font-mono">{t.signedAt.slice(0, 10)}</span>{t.aiDrafted ? " · AI-drafted" : ""}</>}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button className={BTN} disabled={drafting} onClick={onRedraft} title="Researches the theme again and proposes updated pillars, statuses and bellwethers. Nothing is saved until you sign.">
            <AppIcon name="spark" size={13} />
            {drafting ? "Researching…" : "Redraft with AI"}
          </button>
          <button className={BTN} onClick={onEdit}>
            <AppIcon name="edit" size={13} />
            Edit
          </button>
          <button className={BTN} onClick={onArchive} title="Archive (never deletes)">
            Archive
          </button>
          <button
            type="button"
            onClick={toggle}
            className="grid h-7 w-7 place-items-center rounded-pill border border-line bg-surface text-ink-2 hover:border-accent-border hover:bg-accent-soft hover:text-accent"
            aria-label={open ? "Collapse" : "Expand"}
            aria-expanded={open}
          >
            <AppIcon name={open ? "chevU" : "chevD"} size={14} />
          </button>
        </div>
      </div>
      {open && (
        <>
          {t.summary && <p className="px-3.5 py-2.5 text-[12.5px] leading-[1.5] text-ink-2">{t.summary}</p>}
          <div className="border-t border-line-soft">
            <div className="bg-surface-2 px-3.5 py-1.5 text-[11px] text-ink-3">Pillars</div>
            {t.pillars.map((p) => (
              <div key={p.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3.5 py-1.5 text-[12.5px]">
                <span className="font-medium text-ink">{p.title}</span>
                <span className="min-w-0 flex-1 basis-[15rem] break-words text-ink-2">{p.claim}</span>
                {p.status && STANCE[p.status] && (
                  <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${STANCE[p.status].text}`} title={p.statusBy === "ai" ? "AI-proposed, signed by you" : "Your status"}>
                    <span className={`dot ${STANCE[p.status].dot}`} /> {STANCE[p.status].word}
                    {p.statusSince && <span className="font-mono font-normal text-ink-3">{p.statusSince.slice(5)}</span>}
                  </span>
                )}
                {p.statusNote && <span className="basis-full break-words text-[11.5px] text-ink-3">{p.statusNote}</span>}
              </div>
            ))}
          </div>
          <div className="border-t border-line-soft">
            <div className="bg-surface-2 px-3.5 py-1.5 text-[11px] text-ink-3">Holdings in this theme</div>
            {t.members.length === 0 && <p className="px-3.5 py-1.5 text-[12px] text-ink-3">No signed thesis names this theme yet.</p>}
            {t.members.map((m) => (
              <div key={m.ticker} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3.5 py-1.5 text-[12.5px]">
                <Link href={`/stock/${m.ticker.toLowerCase()}`} className="w-20 shrink-0 font-mono font-medium !text-accent hover:underline">{displayTicker(m.ticker)}</Link>
                <span className="w-20 shrink-0 text-[11px] text-ink-3">{m.bucket === "other" ? "—" : m.bucket}{m.equityBucket === "thematic" ? " · fund" : ""}</span>
                <span className="min-w-0 flex-1 basis-[15rem] break-words text-ink-2">{m.role}{m.exposure && <span className="ml-1.5 font-mono text-[11px] text-ink-3">{m.exposure}</span>}</span>
                <span className="font-mono text-[11.5px] text-ink-3">{m.alphaShare != null ? pct(m.alphaShare) : ""}</span>
              </div>
            ))}
          </div>
          <div className="border-t border-line-soft pb-1">
            <div className="bg-surface-2 px-3.5 py-1.5 text-[11px] text-ink-3">
              Bellwethers — their FactSet alerts are kept as theme evidence once they are on the FactSet alert list
            </div>
            {t.bellwethers.map((b) => {
              const ev = evidence[b.ticker.toUpperCase()]?.[0];
              return (
                <div key={b.ticker} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3.5 py-1.5 text-[12.5px]">
                  <span className="w-20 shrink-0 font-mono font-medium text-ink">{displayTicker(b.ticker)}</span>
                  <span className="min-w-0 flex-1 basis-[15rem] break-words text-ink-2">{b.name ? <span className="text-ink">{b.name}: </span> : null}{b.why}</span>
                  <span className="basis-full pl-[5.5rem] text-[11.5px] text-ink-3">
                    {ev ? <>Latest: {ev.date} · {ev.event ?? ev.headline ?? ev.kind}{ev.bottomLine || ev.summary ? ` — ${(ev.bottomLine ?? ev.summary ?? "").slice(0, 200)}` : ""}</> : "No FactSet alert on file yet"}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

function ThemeEditor({
  draft,
  sources,
  onChange,
  onCancel,
  onSave,
  saving,
}: {
  draft: Draft;
  sources: Array<{ url: string; title?: string }>;
  onChange: (d: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const setPillar = (id: string, patch: Partial<ThemePillar>) => set({ pillars: draft.pillars.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  const setBw = (i: number, patch: Partial<Bellwether>) => set({ bellwethers: draft.bellwethers.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  return (
    <section className="panel border-accent-border">
      <div className="panel-h">
        <span className="t-mark bg-accent" aria-hidden />
        <span className="t">{draft.id ? "Edit theme" : "New theme"}</span>
        <span className="m">{draft.aiDrafted ? "AI draft — read, edit, then sign" : "nothing is saved until you sign"}</span>
        <div className="ml-auto flex items-center gap-2">
          <button className={BTN} onClick={onCancel}>Cancel</button>
          <button className={BTN_PRI} onClick={onSave} disabled={saving || !draft.name.trim() || draft.pillars.length === 0}>
            {saving ? "Saving…" : "Sign theme"}
          </button>
        </div>
      </div>
      <div className="space-y-3 px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })} className={`${INPUT} w-72 font-medium`} placeholder="Theme name" disabled={!!draft.id} />
          {draft.aliases.length > 0 && <span className="text-[11.5px] text-ink-3">Also called:</span>}
          {draft.aliases.map((a) => (
            <span key={a} className="inline-flex items-center gap-1 rounded-control border border-line bg-surface px-1.5 py-0.5 text-[11.5px] text-ink-2">
              {a}
              <button onClick={() => set({ aliases: draft.aliases.filter((x) => x !== a) })} className="text-ink-3 hover:text-neg" aria-label={`Remove ${a}`}>×</button>
            </span>
          ))}
        </div>
        <textarea value={draft.summary} onChange={(e) => set({ summary: e.target.value })} rows={3} placeholder="What the theme is and why the book owns it" className="w-full rounded-control border border-line bg-surface px-2.5 py-2 text-[12.5px] leading-[1.5] text-ink focus:border-accent-border focus:outline-none" />

        <div className="space-y-2 rounded-control border border-line bg-surface-2 px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-ink-3">Pillars (3-5)</span>
            <button onClick={() => set({ pillars: [...draft.pillars, { id: `pillar-${Date.now()}`, title: "", claim: "" }] })} className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline">
              <AppIcon name="plus" size={12} /> Add pillar
            </button>
          </div>
          {draft.pillars.map((p) => (
            <div key={p.id} className="space-y-1.5 border-b border-line-soft pb-2 last:border-b-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <input value={p.title} onChange={(e) => setPillar(p.id, { title: e.target.value })} placeholder="Pillar (2-5 words)" className={`${INPUT} w-48 font-medium`} />
                <input value={p.claim} onChange={(e) => setPillar(p.id, { claim: e.target.value })} placeholder="One falsifiable long-term sentence" className={`${INPUT} min-w-[16rem] flex-1`} />
                <button onClick={() => set({ pillars: draft.pillars.filter((x) => x.id !== p.id) })} className="text-[11.5px] text-ink-3 hover:text-neg">remove</button>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-3">
                <select value={p.status ?? ""} onChange={(e) => setPillar(p.id, { status: (e.target.value || undefined) as ThemePillar["status"], statusBy: "pm" })} className={`${INPUT} w-28`}>
                  <option value="">Not set</option>
                  <option value="intact">Intact</option>
                  <option value="watch">Watch</option>
                  <option value="broken">Broken</option>
                </select>
                {p.status && p.statusBy === "ai" && <span className="text-accent">AI-proposed</span>}
                {p.status && (
                  <input value={p.statusNote ?? ""} onChange={(e) => setPillar(p.id, { statusNote: e.target.value || undefined, statusBy: "pm" })} placeholder="The evidence behind this status" className={`${INPUT} min-w-[16rem] flex-1`} />
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-1.5 rounded-control border border-line bg-surface-2 px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-ink-3">Bellwethers (5-8)</span>
            <button onClick={() => set({ bellwethers: [...draft.bellwethers, { ticker: "", why: "" }] })} className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline">
              <AppIcon name="plus" size={12} /> Add bellwether
            </button>
          </div>
          {draft.bellwethers.map((b, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input value={b.ticker} onChange={(e) => setBw(i, { ticker: e.target.value.toUpperCase() })} placeholder="Ticker" className={`${INPUT} w-24 font-mono`} />
              <input value={b.name ?? ""} onChange={(e) => setBw(i, { name: e.target.value })} placeholder="Company" className={`${INPUT} w-44`} />
              <input value={b.why} onChange={(e) => setBw(i, { why: e.target.value })} placeholder="What its results tell us about the theme" className={`${INPUT} min-w-[16rem] flex-1`} />
              <button onClick={() => set({ bellwethers: draft.bellwethers.filter((_, j) => j !== i) })} className="text-[11.5px] text-ink-3 hover:text-neg">remove</button>
            </div>
          ))}
        </div>

        {sources.length > 0 && (
          <p className="break-words text-[11px] leading-[1.6] text-ink-3 [overflow-wrap:anywhere]">
            Researched on the web:{" "}
            {sources.map((s, i) => {
              let host = s.url;
              try { host = new URL(s.url).hostname.replace(/^www\./, ""); } catch { /* keep url */ }
              return (
                <span key={s.url}>
                  {i > 0 && " · "}
                  <a href={s.url} target="_blank" rel="noreferrer" className="text-accent hover:underline" title={s.title ?? s.url}>{host}</a>
                </span>
              );
            })}
          </p>
        )}
      </div>
    </section>
  );
}
