/**
 * Tiny shared logger that gives every API route a consistent `[Prefix]`
 * tag at the start of every log line. Consistent prefixes let the
 * Vercel runtime-log search ("[Score]", "[Brief]", "[Finviz breadth]")
 * actually find what you're looking for during an incident instead of
 * having to fuzzy-match free-form messages.
 *
 * Usage:
 *   const log = createLogger("Score");
 *   log.info("Started rescore for", ticker);
 *   log.warn("Yahoo returned empty payload");
 *   log.error("Anthropic call failed", err);
 *
 * The shape mirrors console (info/warn/error) so converting existing
 * console.log/warn/error calls is a mechanical rename — no message
 * format changes required at the call site.
 *
 * Intentionally a thin wrapper. We don't ship structured JSON logs
 * because Vercel's runtime log viewer renders plain text best.
 */

export type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export function createLogger(prefix: string): Logger {
  const tag = `[${prefix}]`;
  return {
    info: (...args) => console.log(tag, ...args),
    warn: (...args) => console.warn(tag, ...args),
    error: (...args) => console.error(tag, ...args),
  };
}
