import React from "react";

/**
 * Reusable empty state (#08): a tinted accent icon chip, a semibold title, a
 * one-line body, and optional actions (pass a primary + ghost button as
 * `action`). Fades up on mount (reduced-motion-safe). Use on empty Watchlist,
 * Screener no-results, Inbox zero, etc.
 */
export function EmptyState({
  glyph,
  title,
  body,
  action,
  className = "",
}: {
  glyph: React.ReactNode;
  title: React.ReactNode;
  body?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`animate-fade-up flex flex-col items-center justify-center gap-3 px-6 py-12 text-center ${className}`}>
      <div className="flex h-10 w-10 items-center justify-center rounded-[8px] border border-line bg-surface-2 text-ink-3">
        {glyph}
      </div>
      <div className="max-w-sm">
        <div className="text-[13px] font-semibold text-ink">{title}</div>
        {body && <div className="mt-1 text-[12.5px] leading-5 text-ink-2">{body}</div>}
      </div>
      {action && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
