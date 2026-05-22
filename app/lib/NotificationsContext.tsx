"use client";

/**
 * Persistent notifications tray — every notable event (a Score All
 * failure, a refresh that returned partial data, an uncaught JS
 * error) gets pushed onto a ring buffer that the user can review at
 * any time from the bell icon in the top nav.
 *
 * Why a tray instead of more inline toasts: the existing inline error
 * surfaces (red banner under Score All, the "Forward-looking fetch
 * failed" inline note) disappear when you leave the page. If a
 * background refresh failed while you were on another tab, you'd
 * never know. The tray gives you a session-level audit trail.
 *
 * Persistence: localStorage under `pm:notifications:log`. Capped at
 * MAX_EVENTS to keep the storage write cost negligible. Each event
 * gets a stable id so the tray can dedupe rapid duplicates (e.g. the
 * same fetch failing on every poll).
 *
 * Read-only from the perspective of business data — notifications are
 * UI state only, never feed into scoring, persistence of holdings, or
 * any other Redis-backed logic.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export type NotificationLevel = "info" | "success" | "warn" | "error";

export type NotificationEvent = {
  id: string;
  level: NotificationLevel;
  title: string;
  message?: string;
  /** Free-form short label for the source — usually a route or component
   *  name, e.g. "Score All", "Finviz breadth", "Window error". Surfaced
   *  in the tray so the user can tell at a glance who fired the event. */
  source?: string;
  /** ISO timestamp. */
  at: string;
};

type Ctx = {
  events: NotificationEvent[];
  unreadCount: number;
  notify: (e: Omit<NotificationEvent, "id" | "at">) => void;
  markAllRead: () => void;
  clear: () => void;
};

const NotificationsContext = createContext<Ctx | null>(null);

const STORAGE_KEY = "pm:notifications:log";
const UNREAD_KEY = "pm:notifications:unread";
const MAX_EVENTS = 50;
// Same-message dedupe window — within 5 seconds, repeat events fold
// into the existing one rather than spamming the tray.
const DEDUPE_WINDOW_MS = 5000;

function readPersisted(): NotificationEvent[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_EVENTS);
  } catch {
    return [];
  }
}

function writePersisted(events: NotificationEvent[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events.slice(0, MAX_EVENTS)));
  } catch { /* quota / private-mode → tray still works in-memory */ }
}

function readUnread(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = localStorage.getItem(UNREAD_KEY);
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch { return 0; }
}

function writeUnread(n: number) {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(UNREAD_KEY, String(n)); } catch { /* ignore */ }
}

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const [events, setEvents] = useState<NotificationEvent[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const initialized = useRef(false);

  // Hydrate from localStorage on first mount (skipped on the server to
  // avoid SSR/CSR text mismatches).
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    setEvents(readPersisted());
    setUnreadCount(readUnread());
  }, []);

  const notify = useCallback((e: Omit<NotificationEvent, "id" | "at">) => {
    setEvents((prev) => {
      const now = Date.now();
      // Dedupe: if the most recent event has the same title+source AND
      // landed less than DEDUPE_WINDOW_MS ago, just refresh its timestamp
      // rather than appending a duplicate. Keeps the tray usable when a
      // polling loop is hitting the same error.
      const newest = prev[0];
      if (
        newest &&
        newest.title === e.title &&
        newest.source === e.source &&
        newest.level === e.level &&
        now - new Date(newest.at).getTime() < DEDUPE_WINDOW_MS
      ) {
        const updated = [{ ...newest, at: new Date().toISOString(), message: e.message ?? newest.message }, ...prev.slice(1)];
        writePersisted(updated);
        return updated;
      }
      const entry: NotificationEvent = {
        id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
        at: new Date().toISOString(),
        ...e,
      };
      const next = [entry, ...prev].slice(0, MAX_EVENTS);
      writePersisted(next);
      return next;
    });
    setUnreadCount((c) => {
      const next = c + 1;
      writeUnread(next);
      return next;
    });
  }, []);

  const markAllRead = useCallback(() => {
    setUnreadCount(0);
    writeUnread(0);
  }, []);

  const clear = useCallback(() => {
    setEvents([]);
    writePersisted([]);
    setUnreadCount(0);
    writeUnread(0);
  }, []);

  // Global error capture — anything that bubbles to window.onerror or
  // unhandledrejection lands in the tray with a "Window error" source
  // tag. Doesn't replace inline error UIs, just ensures NOTHING is
  // truly silent any more.
  useEffect(() => {
    const onError = (ev: ErrorEvent) => {
      notify({
        level: "error",
        title: "Uncaught error",
        message: ev.message,
        source: ev.filename ? `${ev.filename.split("/").pop()}:${ev.lineno}` : "Window error",
      });
    };
    const onRejection = (ev: PromiseRejectionEvent) => {
      const reason = ev.reason;
      const msg = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Unhandled promise rejection";
      notify({
        level: "error",
        title: "Unhandled promise rejection",
        message: msg,
        source: "Window",
      });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [notify]);

  const value = useMemo<Ctx>(() => ({ events, unreadCount, notify, markAllRead, clear }), [events, unreadCount, notify, markAllRead, clear]);

  return (
    <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>
  );
}

export function useNotifications(): Ctx {
  const ctx = useContext(NotificationsContext);
  if (!ctx) {
    // Safe fallback — if a component renders outside the provider for
    // some reason, return a no-op shape rather than throwing.
    return {
      events: [],
      unreadCount: 0,
      notify: () => {},
      markAllRead: () => {},
      clear: () => {},
    };
  }
  return ctx;
}
