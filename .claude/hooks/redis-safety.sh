#!/usr/bin/env bash
# Pre-flight check on bash commands. Blocks anything that could
# wipe or mass-delete data from the Upstash Redis store.
#
# Input: JSON on stdin from Claude Code with { "tool_input": { "command": "..." } }
# Exit 2 = block with feedback shown to Claude.
# Exit 0 = allow.

set -uo pipefail

payload=$(cat)

cmd=$(printf '%s' "$payload" | /usr/bin/python3 -c 'import sys, json
try:
    d = json.load(sys.stdin)
    print((d.get("tool_input") or {}).get("command", ""))
except Exception:
    pass' 2>/dev/null)

if [ -z "$cmd" ]; then
  exit 0
fi

# Skip families of commands that may legitimately contain dangerous-looking
# strings as data (commit messages, file content, search queries). None of
# these commands actually execute Redis operations.
case "$cmd" in
  "git commit"*|"git push"*|"git log"*|"git show"*|"git diff"*|"git tag"*|\
  "gh pr"*|"gh issue"*|\
  "echo "*|"printf "*|"cat "*|"grep "*|"rg "*|"sed "*|"awk "*)
    exit 0
    ;;
esac

# If the command is purely writing content to a file (heredoc, cat > file,
# tee), the dangerous-looking strings are data, not execution.
if printf '%s' "$cmd" | grep -Eq '^[[:space:]]*(cat|tee|printf)[[:space:]]+>'; then
  exit 0
fi
if printf '%s' "$cmd" | grep -Eq '<<[[:space:]]*[A-Z'"'"']'; then
  # Heredoc-based file writes — treat as data, not execution.
  exit 0
fi

# Tight patterns — only match when the command actually invokes redis,
# not when it merely mentions a keyword in argument text. Each pattern
# requires the literal binary "redis-cli" (or a node script that imports
# the redis client) to be present alongside the destructive verb.
block_patterns=(
  # redis-cli destructive verbs
  'redis-cli([[:space:]]+-[^[:space:]]+)*[[:space:]]+(flushall|flushdb|del|unlink|keys)([[:space:]]|$)'
  # Node one-liners that call destructive client methods on a redis client
  'node[[:space:]].*\.(flushAll|flushDb|del)\('
)

for pat in "${block_patterns[@]}"; do
  if printf '%s' "$cmd" | grep -Eqi "$pat"; then
    echo "BLOCKED: command appears to invoke a destructive Redis operation." >&2
    echo "" >&2
    echo "The pm-dashboard stores the user's portfolio, watchlist, PIM models," >&2
    echo "and other irreplaceable state in Redis under pm:* keys. This command" >&2
    echo "could wipe that data." >&2
    echo "" >&2
    echo "If genuinely intentional, ask the user to run it themselves outside" >&2
    echo "the Claude Code session." >&2
    exit 2
  fi
done

exit 0
