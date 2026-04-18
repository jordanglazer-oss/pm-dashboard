#!/usr/bin/env bash
# Runs typecheck + lint before Claude finishes responding.
# If either fails, Claude sees the errors and is expected to fix them
# before declaring the task "done".

set -uo pipefail

cd "$(dirname "$0")/../.."

# Only run if TS/TSX files changed in this session — cheap heuristic:
# if no .ts/.tsx files exist in the working tree diff, skip.
if ! git diff --name-only HEAD 2>/dev/null | grep -qE '\.(ts|tsx)$'; then
  # No TS files changed — nothing to verify.
  exit 0
fi

echo "🔎 Running typecheck..." >&2
if ! npx tsc --noEmit 2>&1; then
  echo "" >&2
  echo "❌ Typecheck failed. Fix the errors above before declaring the task done." >&2
  exit 2
fi

echo "🔎 Running lint..." >&2
# Lint is advisory — warnings are allowed, only errors block.
# Only lint files changed in the working tree, so pre-existing errors
# in untouched files don't block a valid change.
changed_files=$(git diff --name-only HEAD 2>/dev/null | grep -E '\.(ts|tsx|js|jsx)$' || true)
if [ -n "$changed_files" ]; then
  # shellcheck disable=SC2086
  if ! npx eslint --quiet $changed_files 2>&1; then
    echo "" >&2
    echo "❌ Lint errors found in changed files. Fix them before declaring the task done." >&2
    exit 2
  fi
fi

echo "✅ Typecheck + lint passed." >&2
exit 0
