"use client";

/**
 * Long-form text block.
 *
 * This used to clamp AI prose to a few lines behind a "Show more" toggle. That
 * was wrong twice over: the sections these paragraphs live in are ALREADY
 * collapsible, so opening one and then being asked to expand again is a second
 * gate on the same content — and the char-length heuristic that decided
 * whether to show the toggle fired on paragraphs that fit anyway, so the
 * button frequently did nothing at all.
 *
 * Now it renders the full text. `lines` and `threshold` are accepted and
 * ignored so the call sites did not have to change in lockstep.
 */
export function ClampText({
  text,
  className = "",
  textClassName = "text-sm leading-6 text-ink-2",
}: {
  text: string | null | undefined;
  /** @deprecated no longer clamped — accepted so call sites keep compiling. */
  lines?: number;
  className?: string;
  textClassName?: string;
  /** @deprecated no longer clamped. */
  threshold?: number;
}) {
  if (!text) return null;
  return (
    <div className={className}>
      <p className={textClassName}>{text}</p>
    </div>
  );
}
