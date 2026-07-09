"use client";

import { useState } from "react";

/**
 * Collapsible long-form text. AI-generated brief paragraphs (composite / credit
 * / volatility / breadth / sector / contrarian / hedging analysis) can run
 * several sentences; by default we clamp them to a few lines to keep the page
 * compact and let the reader expand the ones they care about. The FULL text is
 * always preserved — this is purely a display affordance, no content is lost.
 *
 * The toggle only appears when the text is long enough to actually overflow
 * (char-length heuristic — avoids a useless "Show more" on a one-liner and
 * keeps this render-pure, no layout-measuring effect).
 */
export function ClampText({
  text,
  lines = 3,
  className = "",
  textClassName = "text-sm leading-6 text-ink-2",
  threshold = 180,
}: {
  text: string | null | undefined;
  lines?: number;
  className?: string;
  textClassName?: string;
  threshold?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  const clampable = text.length > threshold;
  return (
    <div className={className}>
      <p
        className={textClassName}
        style={
          !expanded && clampable
            ? { display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" }
            : undefined
        }
      >
        {text}
      </p>
      {clampable && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] font-semibold text-accent hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
