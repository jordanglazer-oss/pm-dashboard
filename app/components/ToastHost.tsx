"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useNotifications, type NotificationLevel } from "@/app/lib/NotificationsContext";
import { AppIcon } from "./AppIcon";

/**
 * Transient toasts. Rather than wire a new call site into every action, this
 * host subscribes to the existing notification stream — so every place that
 * already calls notify() (saves, rescores, imports, errors) now also pops a
 * brief slide-in toast, in addition to logging to the tray. Backlog events
 * present at mount are NOT toasted; only new ones after mount. Auto-dismiss.
 */

type Toast = { id: string; level: NotificationLevel; title: string; message?: string; leaving?: boolean };

/** Level → status dot colour + the word beside it. */
const TONE: Record<NotificationLevel, { dot: string; word: string }> = {
  success: { dot: "bg-pos", word: "Done" },
  error: { dot: "bg-neg", word: "Error" },
  warn: { dot: "bg-warn", word: "Warning" },
  info: { dot: "bg-ink-faint", word: "Info" },
};

export function ToastHost() {
  const { events } = useNotifications();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seen = useRef<Set<string>>(new Set());
  const primed = useRef(false);

  // Two-step remove so the exit animation can play: flag as leaving, then drop
  // the node once the slide-out finishes. Stable so the effect can depend on it.
  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 200);
  }, []);

  useEffect(() => {
    if (!primed.current) {
      // First pass: swallow the backlog so we don't toast old events on load.
      events.forEach((e) => seen.current.add(e.id));
      primed.current = true;
      return;
    }
    const fresh = events.filter((e) => !seen.current.has(e.id) && !e.quiet);
    events.forEach((e) => { if (e.quiet) seen.current.add(e.id); });
    if (fresh.length === 0) return;
    fresh.forEach((e) => seen.current.add(e.id));
    setToasts((prev) =>
      [...fresh.map((e) => ({ id: e.id, level: e.level, title: e.title, message: e.message })), ...prev].slice(0, 4),
    );
    fresh.forEach((e) => {
      setTimeout(() => dismiss(e.id), 4200);
    });
  }, [events, dismiss]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 print:hidden">
      {toasts.map((t) => {
        const tone = TONE[t.level] ?? TONE.info;
        return (
          <div
            key={t.id}
            role="status"
            className={`${t.leaving ? "animate-toast-out" : "animate-toast-in"} flex w-[320px] max-w-[calc(100vw-2rem)] items-start gap-2.5 rounded-card border border-line bg-surface px-3 py-2.5 text-[12.5px] text-ink shadow-[var(--shadow-pop)]`}
          >
            <span className={`dot mt-[6px] ${tone.dot}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate font-medium">{t.title}</span>
                <span className="shrink-0 text-[11px] text-ink-3">{tone.word}</span>
              </div>
              {t.message && <div className="mt-0.5 line-clamp-2 text-[12px] leading-[1.45] text-ink-2">{t.message}</div>}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="-mr-1 -mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-control text-ink-3 transition-colors hover:bg-surface-hover hover:text-ink"
              aria-label="Dismiss"
            >
              <AppIcon name="x" size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
