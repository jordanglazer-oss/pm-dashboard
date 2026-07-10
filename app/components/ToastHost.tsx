"use client";

import { useEffect, useRef, useState } from "react";
import { useNotifications, type NotificationLevel } from "@/app/lib/NotificationsContext";

/**
 * Transient toasts. Rather than wire a new call site into every action, this
 * host subscribes to the existing notification stream — so every place that
 * already calls notify() (saves, rescores, imports, errors) now also pops a
 * brief slide-in toast, in addition to logging to the tray. Backlog events
 * present at mount are NOT toasted; only new ones after mount. Auto-dismiss.
 */

type Toast = { id: string; level: NotificationLevel; title: string; message?: string };

const TONE: Record<NotificationLevel, { box: string; dot: string }> = {
  success: { box: "border-pos-border bg-pos-soft text-ink", dot: "bg-pos" },
  error: { box: "border-neg-border bg-neg-soft text-ink", dot: "bg-neg" },
  warn: { box: "border-warn-border bg-warn-soft text-ink", dot: "bg-warn" },
  info: { box: "border-accent-border bg-accent-soft text-ink", dot: "bg-accent" },
};

export function ToastHost() {
  const { events } = useNotifications();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seen = useRef<Set<string>>(new Set());
  const primed = useRef(false);

  useEffect(() => {
    if (!primed.current) {
      // First pass: swallow the backlog so we don't toast old events on load.
      events.forEach((e) => seen.current.add(e.id));
      primed.current = true;
      return;
    }
    const fresh = events.filter((e) => !seen.current.has(e.id));
    if (fresh.length === 0) return;
    fresh.forEach((e) => seen.current.add(e.id));
    setToasts((prev) =>
      [...fresh.map((e) => ({ id: e.id, level: e.level, title: e.title, message: e.message })), ...prev].slice(0, 4),
    );
    fresh.forEach((e) => {
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== e.id)), 4200);
    });
  }, [events]);

  const dismiss = (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id));

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 print:hidden">
      {toasts.map((t) => {
        const tone = TONE[t.level] ?? TONE.info;
        return (
          <div
            key={t.id}
            role="status"
            className={`animate-toast-in flex max-w-xs items-start gap-2.5 rounded-lg border px-3 py-2 shadow-md ${tone.box}`}
          >
            <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${tone.dot}`} />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold leading-snug">{t.title}</div>
              {t.message && <div className="mt-0.5 text-[11px] text-ink-2 line-clamp-2">{t.message}</div>}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="shrink-0 text-ink-faint transition-colors hover:text-ink-2"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
