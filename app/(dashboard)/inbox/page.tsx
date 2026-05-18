"use client";

import React, { useCallback, useEffect, useState } from "react";
import type { InboxEvent } from "@/app/lib/inbox-log";

type Status = {
  events: InboxEvent[];
  configured: boolean;
};

function statusChip(status: InboxEvent["status"]) {
  if (status === "success") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "skipped") return "bg-slate-50 text-slate-600 border-slate-200";
  return "bg-red-50 text-red-700 border-red-200";
}

function fmtBytes(n: number | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
    });
  } catch {
    return iso;
  }
}

export default function InboxPage() {
  const [data, setData] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/inbox/status");
      if (!res.ok) {
        setError(`Failed to load (${res.status})`);
        return;
      }
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const events = data?.events ?? [];
  const successes = events.filter((e) => e.status === "success").length;
  const failures = events.filter((e) => e.status === "error").length;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Email Inbox Ingestion</h1>
          <p className="text-sm text-slate-500 mt-1">
            Live log of analyst-report PDFs received via the dfwreports123@gmail.com Apps Script webhook.
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="rounded-md border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="text-xs text-slate-500">Webhook secret</div>
          <div className="mt-1 text-sm font-semibold">
            {data?.configured ? (
              <span className="text-emerald-700">Configured</span>
            ) : (
              <span className="text-red-700">Missing — set INBOX_SECRET in Vercel</span>
            )}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="text-xs text-slate-500">Successes (last 100 events)</div>
          <div className="mt-1 text-xl font-bold text-emerald-700">{successes}</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="text-xs text-slate-500">Failures (last 100 events)</div>
          <div className="mt-1 text-xl font-bold text-red-700">{failures}</div>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="border-b border-slate-100 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Recent ingestion events
        </div>
        {loading && events.length === 0 ? (
          <p className="text-sm text-slate-400 p-4">Loading…</p>
        ) : error ? (
          <p className="text-sm text-red-600 p-4">{error}</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-slate-400 p-4 italic">
            No ingestion events yet. Once the Apps Script runs and forwards an email, events will appear here.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Time</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Ticker · Source</th>
                <th className="px-3 py-2 text-left">Subject / Sender</th>
                <th className="px-3 py-2 text-left">Detail</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-t border-slate-100 align-top">
                  <td className="px-3 py-2 whitespace-nowrap text-slate-500 text-xs">{fmtTime(e.receivedAt)}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${statusChip(e.status)}`}>
                      {e.status}
                    </span>
                    {e.cached && (
                      <span className="ml-1 inline-block rounded border border-slate-200 bg-slate-50 px-1 py-0.5 text-[9px] font-bold uppercase text-slate-500" title="Hash-gated cache hit — no Anthropic spend">
                        cached
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {e.ticker ? (
                      <span className="font-mono font-semibold text-slate-800">{e.ticker}</span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                    {e.source && <span className="ml-1 text-[10px] uppercase text-slate-500">{e.source}</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-700">
                    {e.subject ? <div className="truncate max-w-[260px]" title={e.subject}>{e.subject}</div> : <div className="text-slate-300">—</div>}
                    {e.sender && <div className="text-[10px] text-slate-400 truncate max-w-[260px]" title={e.sender}>{e.sender}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {e.message}
                    {e.filename && (
                      <div className="text-[10px] text-slate-400 mt-0.5">
                        {e.filename} · {fmtBytes(e.size)}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-6 rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm">
        <p className="font-semibold text-blue-900 mb-1">How to send a report</p>
        <p className="text-blue-800">
          From any email account, send <span className="font-mono">dfwreports123@gmail.com</span> a message with:
        </p>
        <ul className="mt-2 ml-4 list-disc text-blue-800 text-xs space-y-0.5">
          <li>Subject: <span className="font-mono">Analyst Report: &lt;TICKER&gt; &lt;RBC|JPM&gt;</span> (e.g. <span className="font-mono">Analyst Report: NVDA RBC</span>)</li>
          <li>Attach the analyst-report PDF (max ~15 MB). Multiple PDFs in one email all get ingested under the same ticker/source.</li>
          <li>The Apps Script polls every 5 minutes — events show up in this log within ~5 min.</li>
        </ul>
      </div>
    </div>
  );
}
