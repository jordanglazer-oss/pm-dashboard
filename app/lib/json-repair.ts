/**
 * Tolerant parser for model-emitted JSON.
 *
 * Prose-heavy responses fail in predictable ways, and the failure modes are
 * NOT interchangeable — the brief's repair path only closed unbalanced
 * brackets, so it could fix a truncated response but re-threw the same error
 * on the far more common one: an unescaped double quote inside a string
 * ("the "higher for longer" stance"), which reports as
 * `Expected ',' or '}' after property value`.
 *
 * Order matters: JSON.parse is always tried FIRST and unmodified, so a
 * well-formed response takes exactly the path it always did. Repairs only run
 * on failure, cheapest and least invasive first.
 *
 * Repairs, in order:
 *   1. escape unescaped inner quotes + raw control characters inside strings
 *   2. strip trailing commas before } or ]
 *   3. close brackets/braces left open by truncation
 */

/** Walk the source with string-awareness, escaping what JSON forbids inside a
 *  string literal. A `"` inside a string is treated as a TERMINATOR only when
 *  the next non-space character is one that legally follows a value or key
 *  (`,` `}` `]` `:`) or the input ends; otherwise it is inner prose and gets
 *  escaped. */
function escapeInsideStrings(src: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      const next = src[j];
      if (next === undefined || next === "," || next === "}" || next === "]" || next === ":") {
        inString = false;
        out += ch;
      } else {
        out += '\\"'; // inner quote the model forgot to escape
      }
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      // Raw control characters are illegal in JSON strings; keep the ones
      // that carry meaning (the brief uses \n inside prose) and drop the rest.
      out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : "";
      continue;
    }
    out += ch;
  }
  return out;
}

/** Balance brackets ignoring those inside string literals (a naive count would
 *  be thrown off by braces appearing in prose). */
function closeOpenBrackets(src: string): string {
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (const ch of src) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let out = src;
  if (inString) out += '"';
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === "{" ? "}" : "]";
  return out;
}

const stripTrailingCommas = (s: string): string => s.replace(/,(\s*[}\]])/g, "$1");

export type ModelJsonResult<T> =
  | { ok: true; value: T; repaired: boolean }
  | { ok: false; error: string; /** ±160 chars around the failure, for logs. */ excerpt?: string };

/**
 * Extract the outermost JSON object from a model response and parse it,
 * repairing the known malformations if needed.
 */
export function parseModelJson<T = unknown>(text: string): ModelJsonResult<T> {
  const match = text.match(/\{[\s\S]*\}/);
  const raw = match ? match[0] : text.trim();
  if (!raw) return { ok: false, error: "no JSON object in response" };

  try {
    return { ok: true, value: JSON.parse(raw) as T, repaired: false };
  } catch {
    /* fall through to repairs */
  }

  const attempts = [
    escapeInsideStrings(raw),
    stripTrailingCommas(escapeInsideStrings(raw)),
    closeOpenBrackets(stripTrailingCommas(escapeInsideStrings(raw))),
    closeOpenBrackets(raw), // truncation only — the pre-existing behaviour
  ];
  for (const candidate of attempts) {
    try {
      return { ok: true, value: JSON.parse(candidate) as T, repaired: true };
    } catch {
      /* try the next repair */
    }
  }

  // Report against the ORIGINAL text so the position in the message lines up
  // with what the model actually emitted.
  let error = "unparseable JSON";
  let excerpt: string | undefined;
  try {
    JSON.parse(raw);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    const pos = Number(/position (\d+)/.exec(error)?.[1] ?? NaN);
    if (isFinite(pos)) excerpt = raw.slice(Math.max(0, pos - 160), pos + 160);
  }
  return { ok: false, error, excerpt };
}
