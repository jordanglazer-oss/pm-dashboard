"use client";

/**
 * Third-Party Managers (Nov 26 2026 team session, section 9).
 *
 * The twice-yearly outside-manager screen, entered BY HAND (Jeff updates it
 * from Morningstar as of Dec 31 and Jun 30 — there is no import). Every
 * screen's result is kept, so the page shows how long a manager has stayed
 * on the list. Facts only: returns against the category index, years on the
 * list, and a flag when an OWNED manager has trailed the index two or more
 * years in a row.
 *
 * Reads and writes ONLY pm:third-party-managers, through
 * /api/third-party-managers (one manager per save; nothing is deleted).
 */

import React, { useMemo, useState } from "react";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import { Explain } from "@/app/components/Explain";
import { useGet } from "@/app/components/redesign/data";
import { BTN, BTN_PRIMARY, Bullets, Card, Empty, INPUT, Loading, Page, Table, Tag, TD, TDN, todayET } from "@/app/components/redesign/ui";
import {
  CATEGORIES,
  SEED_MANAGERS,
  STATUSES,
  TOLERANCE_YEARS,
  latestScreen,
  managerId,
  screenStatus,
  toleranceFlag,
  yearsOnList,
  type AnnualReturn,
  type Manager,
  type ManagerCategory,
  type ManagerStatus,
} from "@/app/lib/third-party-managers";

const fmtDay = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};
const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`);
const LABEL = "mb-1 block text-[13px] font-medium text-ink-3";

type Post = (body: Record<string, unknown>) => Promise<string | null>;

/** "8.2% vs 6.1%" with the gap in points beneath. Colour marks the sign of the gap only. */
function VsIndex({ fund, index }: { fund?: number; index?: number }) {
  if (fund == null && index == null) return <span className="text-ink-3">—</span>;
  const gap = fund != null && index != null ? fund - index : null;
  return (
    <>
      <div>
        {pct(fund)} <span className="text-ink-3">vs</span> {pct(index)}
      </div>
      {gap != null && <div className={`text-[13px] font-semibold ${gap > 0 ? "text-pos" : gap < 0 ? "text-neg" : "text-ink-3"}`}>{gap >= 0 ? "+" : "−"}{Math.abs(gap).toFixed(1)} pts</div>}
    </>
  );
}

function statusTag(s: ManagerStatus) {
  return <Tag kind={s === "Owned" ? "blue" : "neutral"}>{s}</Tag>;
}

type FormState = { manager: string; firm: string; fundName: string; fundCode: string; category: ManagerCategory; sectorName: string; goAnywhere: boolean; wholesaler: string; notes: string; status: ManagerStatus };
const blank: FormState = { manager: "", firm: "", fundName: "", fundCode: "", category: "Global equity", sectorName: "", goAnywhere: false, wholesaler: "", notes: "", status: "Watching" };
const fromManager = (m: Manager): FormState => ({ manager: m.manager ?? "", firm: m.firm ?? "", fundName: m.fundName ?? "", fundCode: m.fundCode ?? "", category: m.category, sectorName: m.sectorName ?? "", goAnywhere: Boolean(m.goAnywhere), wholesaler: m.wholesaler ?? "", notes: m.notes ?? "", status: m.status });

/** Add or edit a manager's descriptive fields. */
function ManagerForm({ initial, id, post, onDone, submitLabel }: { initial: FormState; id?: string; post: Post; onDone: () => void; submitLabel: string }) {
  const [f, setF] = useState<FormState>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));
  const text = (k: "manager" | "firm" | "fundName" | "fundCode" | "sectorName" | "wholesaler", label: string, placeholder = "") => (
    <label className="block min-w-0">
      <span className={LABEL}>{label}</span>
      <input className={INPUT} value={f[k]} placeholder={placeholder} onChange={(e) => set(k, e.target.value)} />
    </label>
  );
  const save = async () => {
    setBusy(true);
    setErr(null);
    const e = await post({ manager: { ...f, sectorFund: f.category === "Sector", ...(id ? { id } : {}) } });
    setBusy(false);
    if (e) setErr(e);
    else onDone();
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {text("manager", "Manager")}
        {text("firm", "Firm")}
        {text("fundName", "Fund name")}
        {text("fundCode", "Fund code (F-class)", "e.g. MFC1234")}
        <label className="block min-w-0">
          <span className={LABEL}>Category</span>
          <select className={INPUT} value={f.category} onChange={(e) => set("category", e.target.value as ManagerCategory)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c === "Sector" ? "Sector fund" : c}</option>
            ))}
          </select>
        </label>
        {f.category === "Sector" && text("sectorName", "Which sector", "e.g. Energy")}
        <label className="block min-w-0">
          <span className={LABEL}>Status</span>
          <select className={INPUT} value={f.status} onChange={(e) => set("status", e.target.value as ManagerStatus)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        {text("wholesaler", "Wholesaler contact")}
        <label className="flex min-h-10 items-center gap-2 self-end text-[15px] text-ink">
          <input type="checkbox" className="h-5 w-5" checked={f.goAnywhere} onChange={(e) => set("goAnywhere", e.target.checked)} />
          Go-anywhere mandate
        </label>
      </div>
      <label className="block">
        <span className={LABEL}>Notes</span>
        <textarea className={`${INPUT} h-24 py-2`} value={f.notes} onChange={(e) => set("notes", e.target.value)} />
      </label>
      {err && <p className="text-[14px] font-semibold text-neg">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={save}>{busy ? "Saving…" : submitLabel}</button>
        <button type="button" className={BTN} disabled={busy} onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

/** One screen result (as of a Dec 31 or Jun 30). Saving a date already on file replaces that screen. */
function ScreenForm({ id, defaultDate, post }: { id: string; defaultDate: string; post: Post }) {
  const [date, setDate] = useState(defaultDate);
  const [v, setV] = useState({ ret5y: "", idx5y: "", ret10y: "", idx10y: "" });
  const [onList, setOnList] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const num = (k: keyof typeof v, label: string) => (
    <label className="block min-w-0">
      <span className={LABEL}>{label}</span>
      <input className={INPUT} inputMode="decimal" placeholder="%" value={v[k]} onChange={(e) => setV((p) => ({ ...p, [k]: e.target.value }))} />
    </label>
  );
  const save = async () => {
    setBusy(true);
    setErr(null);
    const e = await post({ id, screen: { date, onList, ...v } });
    setBusy(false);
    if (e) setErr(e);
    else setV({ ret5y: "", idx5y: "", ret10y: "", idx10y: "" });
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <label className="block min-w-0">
          <span className={LABEL}>Screen as of</span>
          <input type="date" className={INPUT} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        {num("ret5y", "Fund, 5 years")}
        {num("idx5y", "Index, 5 years")}
        {num("ret10y", "Fund, 10 years")}
        {num("idx10y", "Index, 10 years")}
        <label className="flex min-h-10 items-center gap-2 self-end text-[15px] text-ink">
          <input type="checkbox" className="h-5 w-5" checked={onList} onChange={(e) => setOnList(e.target.checked)} />
          Made the list
        </label>
      </div>
      {err && <p className="text-[14px] font-semibold text-neg">{err}</p>}
      <div>
        <button type="button" className={BTN_PRIMARY} disabled={busy || !date} onClick={save}>{busy ? "Saving…" : "Save screen result"}</button>
      </div>
    </div>
  );
}

/** Calendar-year fund vs index returns: what the "trailed its index" count is built from. */
function AnnualEditor({ m, post }: { m: Manager; post: Post }) {
  const [row, setRow] = useState({ year: String(new Date().getFullYear() - 1), fund: "", index: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const annual = [...(m.annual ?? [])].sort((a, b) => b.year - a.year);
  const send = async (next: (AnnualReturn | { year: string; fund: string; index: string })[]) => {
    setBusy(true);
    setErr(null);
    const e = await post({ manager: { ...fromManager(m), sectorFund: m.category === "Sector", id: m.id, annual: next } });
    setBusy(false);
    if (e) setErr(e);
    return !e;
  };
  const add = async () => {
    if (!row.fund.trim() || !row.index.trim()) {
      setErr("Enter both the fund's return and the index's return.");
      return;
    }
    if (await send([...(m.annual ?? []).filter((a) => String(a.year) !== row.year.trim()), row])) setRow((p) => ({ ...p, fund: "", index: "" }));
  };
  return (
    <div className="flex flex-col gap-3">
      {annual.length > 0 && (
        <div className="overflow-x-auto">
          <table className="border-collapse text-[14.5px]">
            <thead>
              <tr className="text-left text-[12.5px] font-semibold uppercase tracking-wide text-ink-3">
                <th className="py-1 pr-6">Year</th>
                <th className="py-1 pr-6 text-right">Fund</th>
                <th className="py-1 pr-6 text-right">Index</th>
                <th className="py-1 pr-6 text-right">Gap</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {annual.map((a) => (
                <tr key={a.year} className="border-t border-line-soft">
                  <td className="py-1.5 pr-6 tabular-nums">{a.year}</td>
                  <td className="py-1.5 pr-6 text-right tabular-nums">{pct(a.fund)}</td>
                  <td className="py-1.5 pr-6 text-right tabular-nums">{pct(a.index)}</td>
                  <td className={`py-1.5 pr-6 text-right font-semibold tabular-nums ${a.fund < a.index ? "text-neg" : a.fund > a.index ? "text-pos" : "text-ink-3"}`}>{a.fund - a.index >= 0 ? "+" : "−"}{Math.abs(a.fund - a.index).toFixed(1)} pts</td>
                  <td className="py-1.5">
                    <button type="button" className="text-[13px] text-ink-3 underline hover:text-ink" disabled={busy} onClick={() => send((m.annual ?? []).filter((x) => x.year !== a.year))}>remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="grid max-w-[640px] gap-3 sm:grid-cols-4">
        <label className="block min-w-0">
          <span className={LABEL}>Year</span>
          <input className={INPUT} inputMode="numeric" value={row.year} onChange={(e) => setRow((p) => ({ ...p, year: e.target.value }))} />
        </label>
        <label className="block min-w-0">
          <span className={LABEL}>Fund return</span>
          <input className={INPUT} inputMode="decimal" placeholder="%" value={row.fund} onChange={(e) => setRow((p) => ({ ...p, fund: e.target.value }))} />
        </label>
        <label className="block min-w-0">
          <span className={LABEL}>Index return</span>
          <input className={INPUT} inputMode="decimal" placeholder="%" value={row.index} onChange={(e) => setRow((p) => ({ ...p, index: e.target.value }))} />
        </label>
        <div className="self-end">
          <button type="button" className={BTN} disabled={busy} onClick={add}>{busy ? "Saving…" : "Add year"}</button>
        </div>
      </div>
      {err && <p className="text-[14px] font-semibold text-neg">{err}</p>}
    </div>
  );
}

const HEAD = [
  { label: "Manager" },
  { label: "Fund" },
  { label: "5 years vs index", right: true, title: "Annualized, latest screen on file" },
  { label: "10 years vs index", right: true, title: "Annualized, latest screen on file" },
  { label: "On the list", right: true, title: "Screens in a row the manager has made the list (two screens a year)" },
  { label: "Status" },
  { label: "Vs index, by year" },
];

function Detail({ m, post, lastScreenDate }: { m: Manager; post: Post; lastScreenDate: string }) {
  const [editing, setEditing] = useState(false);
  const screens = [...(m.screens ?? [])].sort((a, b) => b.date.localeCompare(a.date));
  const [busy, setBusy] = useState(false);
  const setStatus = async (status: ManagerStatus) => {
    setBusy(true);
    await post({ id: m.id, status });
    setBusy(false);
  };
  const H = "mb-2 text-[13px] font-semibold uppercase tracking-wide text-ink-3";
  return (
    <div className="flex flex-col gap-5 bg-surface-2 px-5 py-4">
      <div className="grid gap-x-8 gap-y-2 text-[14.5px] sm:grid-cols-2">
        <div><span className="text-ink-3">Wholesaler: </span>{m.wholesaler || "—"}</div>
        <div><span className="text-ink-3">Last edited: </span>{fmtDay(m.updatedAt)}</div>
        <div className="sm:col-span-2"><span className="text-ink-3">Notes: </span><span className="whitespace-pre-wrap">{m.notes || "—"}</span></div>
      </div>

      <div>
        <div className={H}>Every screen on file ({screens.length})</div>
        {screens.length ? (
          <div className="overflow-x-auto">
            <table className="border-collapse text-[14.5px]">
              <thead>
                <tr className="text-left text-[12.5px] font-semibold uppercase tracking-wide text-ink-3">
                  <th className="py-1 pr-6">Screen as of</th>
                  <th className="py-1 pr-6">Made the list</th>
                  <th className="py-1 pr-6 text-right">Fund 5y</th>
                  <th className="py-1 pr-6 text-right">Index 5y</th>
                  <th className="py-1 pr-6 text-right">Fund 10y</th>
                  <th className="py-1 pr-6 text-right">Index 10y</th>
                  <th className="py-1">Entered</th>
                </tr>
              </thead>
              <tbody>
                {screens.map((s) => (
                  <tr key={s.date} className="border-t border-line-soft">
                    <td className="py-1.5 pr-6 tabular-nums">{fmtDay(s.date)}</td>
                    <td className="py-1.5 pr-6">{s.onList ? "Yes" : "No"}</td>
                    <td className="py-1.5 pr-6 text-right tabular-nums">{pct(s.ret5y)}</td>
                    <td className="py-1.5 pr-6 text-right tabular-nums">{pct(s.idx5y)}</td>
                    <td className="py-1.5 pr-6 text-right tabular-nums">{pct(s.ret10y)}</td>
                    <td className="py-1.5 pr-6 text-right tabular-nums">{pct(s.idx10y)}</td>
                    <td className="py-1.5 text-ink-3">{fmtDay(s.enteredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[14.5px] text-ink-3">No screen result entered yet.</p>
        )}
      </div>

      <div>
        <div className={H}>Add a screen result</div>
        <ScreenForm id={m.id} defaultDate={lastScreenDate} post={post} />
      </div>

      <div>
        <div className={H}>Calendar-year returns, fund vs index</div>
        <AnnualEditor m={m} post={post} />
      </div>

      <div>
        <div className={H}>Details</div>
        {editing ? (
          <ManagerForm initial={fromManager(m)} id={m.id} post={post} onDone={() => setEditing(false)} submitLabel="Save changes" />
        ) : (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BTN} onClick={() => setEditing(true)}>Edit details</button>
            {STATUSES.filter((s) => s !== m.status).map((s) => (
              <button key={s} type="button" className={BTN} disabled={busy} onClick={() => setStatus(s)}>Mark as {s.toLowerCase()}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ManagerRows({ list, openId, setOpenId, post, lastScreenDate }: { list: Manager[]; openId: string | null; setOpenId: (id: string | null) => void; post: Post; lastScreenDate: string }) {
  return (
    <>
      {list.map((m) => {
        const s = latestScreen(m);
        const y = yearsOnList(m);
        const t = toleranceFlag(m);
        const open = openId === m.id;
        return (
          <React.Fragment key={m.id}>
            <tr className="cursor-pointer hover:bg-surface-hover" onClick={() => setOpenId(open ? null : m.id)} aria-expanded={open}>
              <td className={TD}>
                <div className="font-semibold text-ink">{m.manager || "Manager to be confirmed"}</div>
                <div className="text-[13px] text-ink-3">{m.firm || "firm not entered"}</div>
              </td>
              <td className={TD}>
                <div>{m.fundName || "—"}{m.sectorFund && m.sectorName ? ` · ${m.sectorName}` : ""}</div>
                <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-ink-3">
                  <span className="tabular-nums">{m.fundCode || "no fund code"}</span>
                  {m.goAnywhere && <Tag kind="blue" title="The manager may invest across regions and company sizes">Go-anywhere</Tag>}
                </div>
              </td>
              <td className={TDN}>
                <VsIndex fund={s?.ret5y} index={s?.idx5y} />
              </td>
              <td className={TDN}>
                <VsIndex fund={s?.ret10y} index={s?.idx10y} />
                <div className="text-[13px] text-ink-3">{s ? `screen ${fmtDay(s.date)}` : "no screen yet"}</div>
              </td>
              <td className={TDN}>
                {y.consecutive ? (
                  <>
                    <div>{y.years % 1 === 0 ? y.years : y.years.toFixed(1)} {y.years === 1 ? "year" : "years"}</div>
                    <div className="text-[13px] text-ink-3">{y.consecutive} {y.consecutive === 1 ? "screen" : "screens"} in a row</div>
                  </>
                ) : (
                  <span className="text-ink-3">{s ? "not on the latest" : "—"}</span>
                )}
              </td>
              <td className={TD}>{statusTag(m.status)}</td>
              <td className={TD}>
                {t.flagged ? (
                  <Tag kind="red" title={`Owned, and behind its category index for ${t.years} calendar years in a row`}>Trailed index {t.years} years</Tag>
                ) : t.years > 0 ? (
                  <span className="text-[13.5px] text-ink-2">Trailed index {t.years} {t.years === 1 ? "year" : "years"}</span>
                ) : (m.annual ?? []).length ? (
                  <span className="text-[13.5px] text-ink-3">Not trailing</span>
                ) : (
                  <span className="text-[13.5px] text-ink-3">no yearly returns entered</span>
                )}
              </td>
            </tr>
            {open && (
              <tr>
                <td colSpan={HEAD.length} className="border-b border-line-soft p-0">
                  <Detail m={m} post={post} lastScreenDate={lastScreenDate} />
                </td>
              </tr>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}

export default function ManagersPage() {
  const [nonce, setNonce] = useState(0);
  const { data, loading } = useGet<Record<string, Manager>>(`/api/third-party-managers?n=${nonce}`, (raw) => (raw as { managers?: Record<string, Manager> })?.managers ?? null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [seedBusy, setSeedBusy] = useState(false);
  const [seedErr, setSeedErr] = useState<string | null>(null);
  const [showRemoved, toggleRemoved] = usePersistedOpen("managers.showRemoved", false);

  const post: Post = async (body) => {
    try {
      const r = await fetch("/api/third-party-managers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) return j.error || `Save failed (${r.status})`;
      setNonce((n) => n + 1);
      return null;
    } catch {
      return "Save failed. Check the connection and try again.";
    }
  };

  const all = useMemo(() => Object.values(data ?? {}), [data]);
  const today = todayET();
  const screen = useMemo(() => screenStatus({ managers: data ?? {} }, today), [data, today]);
  const byName = (a: Manager, b: Manager) => (a.manager || a.fundName).localeCompare(b.manager || b.fundName);
  const active = all.filter((m) => m.status !== "Removed");
  const diversified = active.filter((m) => !m.sectorFund && m.category !== "Sector");
  const sector = active.filter((m) => m.sectorFund || m.category === "Sector").sort(byName);
  const removed = all.filter((m) => m.status === "Removed").sort(byName);
  const groups = CATEGORIES.filter((c) => c !== "Sector").map((c) => ({ category: c, list: diversified.filter((m) => m.category === c).sort(byName) })).filter((g) => g.list.length);
  const flagged = active.filter((m) => toleranceFlag(m).flagged);
  const seedsLeft = SEED_MANAGERS.filter((s) => !data?.[managerId(s)]).length;

  const addSeeds = async () => {
    setSeedBusy(true);
    setSeedErr(null);
    const e = await post({ seed: true });
    setSeedBusy(false);
    if (e) setSeedErr(e);
  };

  const first = loading && !data;
  return (
    <Page
      title="Third-Party Managers"
      lede="The twice-yearly manager screen, entered by hand."
      right={<button type="button" className={BTN_PRIMARY} onClick={() => setAdding((v) => !v)}>{adding ? "Close" : "Add manager"}</button>}
    >
      {!first && (
        <div className={`rounded-card border px-5 py-3 text-[15px] ${screen.due ? "border-warn-border bg-warn-soft text-ink" : "border-line-soft bg-surface text-ink-2"}`}>
          {screen.due ? (
            <>
              <span className="font-semibold">A screen is due.</span> The {fmtDay(screen.last)} screen has not been entered. {screen.onFile ? `Newest screen on file: ${fmtDay(screen.onFile)}.` : "No screen is on file yet."}
            </>
          ) : (
            <>
              Newest screen on file: <span className="font-semibold text-ink">{fmtDay(screen.onFile)}</span>. Next screen: as of {fmtDay(screen.next)}.
            </>
          )}
        </div>
      )}

      {flagged.length > 0 && (
        <div className="rounded-card border border-neg-border bg-neg-soft px-5 py-3 text-[15px] text-ink">
          <span className="font-semibold">Owned and behind the index {TOLERANCE_YEARS}+ years in a row:</span> {flagged.map((m) => `${m.manager || m.fundName} (${toleranceFlag(m).years} years)`).join(", ")}.
        </div>
      )}

      {adding && (
        <Card title="Add a manager">
          <ManagerForm initial={blank} post={post} onDone={() => setAdding(false)} submitLabel="Add manager" />
        </Card>
      )}

      {first ? (
        <Card><Loading what="Loading the manager list" /></Card>
      ) : !all.length ? (
        <Card title="No managers entered yet">
          <Empty>Add a manager with the button above, or start from the three names from the Nov 26 session.</Empty>
          <Bullets className="pb-3" items={SEED_MANAGERS.map((s) => `${s.fundName || s.manager}${s.manager && s.fundName ? ` (${s.manager})` : ""} · ${s.status}`)} />
          <button type="button" className={BTN} disabled={seedBusy} onClick={addSeeds}>{seedBusy ? "Adding…" : "Add the three seed entries"}</button>
          {seedErr && <p className="mt-2 text-[14px] font-semibold text-neg">{seedErr}</p>}
        </Card>
      ) : (
        <>
          <Card title="Diversified managers" sub={`${diversified.length} · by category`} pad={false}>
            {groups.length ? (
              <Table head={HEAD} minWidth={980}>
                {groups.map((g) => (
                  <React.Fragment key={g.category}>
                    <tr>
                      <td colSpan={HEAD.length} className="border-b border-line-soft bg-surface-2 px-5 py-2 text-[13px] font-semibold uppercase tracking-wide text-ink-2">
                        {g.category} <span className="font-normal normal-case tracking-normal text-ink-3">· {g.list.length}</span>
                      </td>
                    </tr>
                    <ManagerRows list={g.list} openId={openId} setOpenId={setOpenId} post={post} lastScreenDate={screen.last} />
                  </React.Fragment>
                ))}
              </Table>
            ) : (
              <div className="px-5"><Empty>No diversified managers on the list.</Empty></div>
            )}
          </Card>

          <Card title="Sector funds" sub={`${sector.length} · listed apart from diversified managers`} pad={false}>
            {sector.length ? (
              <Table head={HEAD} minWidth={980}>
                <ManagerRows list={sector} openId={openId} setOpenId={setOpenId} post={post} lastScreenDate={screen.last} />
              </Table>
            ) : (
              <div className="px-5"><Empty>No sector funds on the list.</Empty></div>
            )}
          </Card>

          {removed.length > 0 && (
            <Card title="Removed" sub={`${removed.length} · kept on file`} pad={false} right={<button type="button" className="font-semibold text-accent underline" onClick={toggleRemoved} aria-expanded={showRemoved}>{showRemoved ? "Hide" : "Show"}</button>}>
              {showRemoved && (
                <Table head={HEAD} minWidth={980}>
                  <ManagerRows list={removed} openId={openId} setOpenId={setOpenId} post={post} lastScreenDate={screen.last} />
                </Table>
              )}
            </Card>
          )}

          {seedsLeft > 0 && (
            <div className="px-1">
              <button type="button" className={BTN} disabled={seedBusy} onClick={addSeeds}>{seedBusy ? "Adding…" : seedsLeft === SEED_MANAGERS.length ? "Add the three seed entries" : `Add the ${seedsLeft} seed ${seedsLeft === 1 ? "entry" : "entries"} not on file`}</button>
              {seedErr && <p className="mt-2 text-[14px] font-semibold text-neg">{seedErr}</p>}
            </div>
          )}
        </>
      )}

      <Explain prefKey="explain.managers.rules" label="How this page works" className="px-1">
        <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px]">
          <li>Everything here is typed in by hand from the Morningstar screen, twice a year (as of Dec 31 and Jun 30). Nothing is imported.</li>
          <li>Click a row to see every screen on file, add a new screen result, enter calendar-year returns, or edit the details.</li>
          <li>5-year and 10-year figures are annualized and come from the newest screen entered for that manager; the screen date is shown under them.</li>
          <li>&ldquo;On the list&rdquo; counts the screens in a row the manager has made the list, back from the newest. Two screens make one year.</li>
          <li>&ldquo;Trailed index&rdquo; counts calendar years in a row, back from the newest year entered, in which the fund returned less than its category index. A missing year ends the count.</li>
          <li>The red flag appears only for an Owned manager who has trailed for {TOLERANCE_YEARS} or more years in a row (the team&apos;s draft rule: review after 2 to 3 years, never after 1). It is a prompt to look, not a decision.</li>
          <li>Nothing is deleted. A manager who leaves the list is marked Removed and kept, with every screen and the earlier versions of the entry.</li>
        </ul>
      </Explain>
    </Page>
  );
}
