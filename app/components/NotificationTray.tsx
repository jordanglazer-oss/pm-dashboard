"use client";

/**
 * Bell-icon dropdown in the top nav that exposes the persistent
 * notifications log managed by NotificationsContext. Renders the last
 * ~50 events newest-first, colour-coded by level (success / info /
 * warn / error), with the source tag and relative time per entry.
 *
 * Pure display + a couple of buttons (mark all read / clear). No
 * fetches, no writes outside the context API.
 */

import React, { useEffect, useRef, useState } from "react";
import { useNotifications, type NotificationLevel } from "@/app/lib/NotificationsContext";

const LEVEL_STYLES: Record<NotificationLevel, { dot: string; text: string }> = {
  info:    { dot: "bg-slate-400",    text: "text-slate-600" },
  success: { dot: "bg-emerald-500",  text: "text-emerald-700" },
  warn:    { dot: "bg-amber-500",    text: "text-amber-700" },
  error:   { dot: "bg-red-500",      text: "text-red-700" },
};

function fmtRel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
}

export function NotificationTray() {
  const { events, unreadCount, markAllRead, clear } = useNotifications();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [, setTick] = useState(0);

  // Keep relative timestamps ticking while the panel is open.
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [open]);

  // Mark events read whenever the user opens the tray. Subtle UX:
  // opening = acknowledgement, so the bell badge clears.
  useEffect(() => {
    if (open && unreadCount > 0) markAllRead();
  }, [open, unreadCount, markAllRead]);

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    // Defer so the toggle click that opened the panel doesn't immediately close it.
    const id = setTimeout(() => document.addEventListener("mousedown", onClick), 50);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
        title="Notifications"
        className="relative flex items-center justify-center w-9 h-9 rounded-lg hover:bg-slate-800 transition-colors text-slate-300 hover:text-white"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" /></svg>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-96 rounded-xl bg-white shadow-2xl border border-slate-200 z-[120] overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100">
            <h3 className="text-sm font-bold text-slate-800">Notifications</h3>
            <div className="flex items-center gap-2 text-[11px]">
              {events.length > 0 && (
                <button
                  onClick={() => { clear(); setOpen(false); }}
                  className="text-slate-500 hover:text-red-600 transition-colors"
                >
                  Clear all
                </button>
              )}
            </div>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {events.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-slate-400">
                Nothing to report.
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {events.map((e) => {
                  const styles = LEVEL_STYLES[e.level];
                  return (
                    <li key={e.id} className="flex items-start gap-3 px-4 py-2.5">
                      <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${styles.dot}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span className={`text-sm font-semibold ${styles.text}`}>{e.title}</span>
                          {e.source && (
                            <span className="text-[10px] text-slate-400 uppercase tracking-wider">
                              {e.source}
                            </span>
                          )}
                        </div>
                        {e.message && (
                          <p className="text-xs text-slate-600 mt-0.5 break-words">{e.message}</p>
                        )}
                        <p className="text-[10px] text-slate-400 mt-0.5" suppressHydrationWarning>
                          {fmtRel(e.at)}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
