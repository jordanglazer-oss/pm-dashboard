"use client";

/**
 * Bell-icon dropdown in the top bar that exposes the persistent
 * notifications log managed by NotificationsContext. Renders the last
 * ~50 events newest-first, each as a status dot + level word, with the
 * source tag and relative time per entry.
 *
 * Pure display + a couple of buttons (mark all read / clear). No
 * fetches, no writes outside the context API.
 */

import React, { useEffect, useRef, useState } from "react";
import { useNotifications, type NotificationLevel } from "@/app/lib/NotificationsContext";
import { AppIcon } from "./AppIcon";

const LEVEL: Record<NotificationLevel, { dot: string; word: string; text: string }> = {
  info:    { dot: "bg-ink-faint", word: "Info",    text: "text-ink" },
  success: { dot: "bg-pos",       word: "Done",    text: "text-ink" },
  warn:    { dot: "bg-warn",      word: "Warning", text: "text-warn" },
  error:   { dot: "bg-neg",       word: "Error",   text: "text-neg" },
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
        title={unreadCount > 0 ? `Notifications · ${unreadCount} unread` : "Notifications"}
        className="relative grid h-7 w-7 place-items-center rounded-control text-ink-3 transition-colors hover:bg-surface-hover hover:text-ink"
      >
        <AppIcon name="bell" size={15} />
        {unreadCount > 0 && (
          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-neg" aria-hidden />
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-[120] mt-2 w-[calc(100vw-1rem)] overflow-hidden rounded-card border border-line bg-surface shadow-[var(--shadow-pop)] sm:w-[360px]">
          <div className="panel-h">
            <span className="t">Notifications</span>
            {events.length > 0 && (
              <span className="m">{events.length}</span>
            )}
            {events.length > 0 && (
              <button
                onClick={() => { clear(); setOpen(false); }}
                className="ml-auto text-[11.5px] text-ink-3 transition-colors hover:text-neg"
              >
                Clear all
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {events.length === 0 ? (
              <div className="px-4 py-8 text-center text-[12.5px] text-ink-3">
                Nothing to report.
              </div>
            ) : (
              <ul className="divide-y divide-line-soft">
                {events.map((e) => {
                  const lv = LEVEL[e.level];
                  return (
                    <li key={e.id} className="flex items-start gap-2.5 px-3.5 py-2.5 text-[12.5px]">
                      <span className={`dot mt-[6px] ${lv.dot}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className={`font-medium ${lv.text}`}>{e.title}</span>
                          <span className="text-[11px] text-ink-3">{lv.word}</span>
                          {e.source && (
                            <span className="text-[11px] text-ink-3">· {e.source}</span>
                          )}
                        </div>
                        {e.message && (
                          <p className="mt-0.5 break-words text-[12px] leading-[1.45] text-ink-2">{e.message}</p>
                        )}
                        <p className="mt-0.5 text-[11px] text-ink-3" suppressHydrationWarning>
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
