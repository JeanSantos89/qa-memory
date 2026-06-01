#!/bin/sh
# qa-memory neutrality guard. Reads a unified diff on STDIN and scans the ADDED
# lines for content that must never reach git (CLAUDE.md neutrality / ADR 010):
#   1. internal Jira-like keys (minus neutral placeholders),
#   2. credentials / tokens,
#   3. company-specific terms from the LOCAL, git-ignored denylist
#      .githooks/neutrality.local (so the denylist itself never leaks).
#
# Exit 1 (block) on any hit. Bypass (rare, explain in commit body):
#   ALLOW_NEUTRALITY_SKIP=1 git commit ...
#
# Run manually:  git diff --cached | sh .githooks/neutrality-scan.sh
set -eu

if [ "${ALLOW_NEUTRALITY_SKIP:-0}" = "1" ]; then
  echo "neutrality: skipped (ALLOW_NEUTRALITY_SKIP=1)." >&2
  exit 0
fi

root=$(git rev-parse --show-toplevel 2>/dev/null || echo ".")
denylist="$root/.githooks/neutrality.local"

# Added lines only (drop the +++ file headers).
added=$(grep -E '^\+' | grep -vE '^\+\+\+' || true)
[ -z "$added" ] && exit 0

hits=""

# 1. Jira-like keys (e.g. ABCD-1234), minus neutral placeholders and common
#    false positives (SHA-256, UTF-8, RFC-2119, ...).
jira=$(printf '%s\n' "$added" | grep -oE '\b[A-Z]{2,5}-[0-9]{2,}\b' \
  | grep -vE '^(PROJ|CONF|SHA|UTF|ISO|RFC|CP|ABC|FOO|BAR|XXX|TEST|EXAMPLE|ASCII|UTC)-' \
  | sort -u || true)
[ -n "$jira" ] && hits="$hits\n  Jira-like key(s): $(printf '%s' "$jira" | tr '\n' ' ')"

# 2. Credentials / tokens.
creds=$(printf '%s\n' "$added" | grep -nE \
  'sk-ant-|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|[Bb]earer [A-Za-z0-9._-]{20,}' \
  || true)
[ -n "$creds" ] && hits="$hits\n  Credential/token pattern:\n$(printf '%s' "$creds" | sed 's/^/    /')"

# 3. Company-specific terms from the local (git-ignored) denylist.
if [ -f "$denylist" ]; then
  while IFS= read -r term; do
    case "$term" in '' | \#*) continue ;; esac
    found=$(printf '%s\n' "$added" | grep -niE "$term" || true)
    [ -n "$found" ] && hits="$hits\n  Denylisted term '$term':\n$(printf '%s' "$found" | sed 's/^/    /')"
  done < "$denylist"
fi

if [ -n "$hits" ]; then
  printf '\n✗ neutrality guard: sensitive content in the changes:%b\n\n' "$hits" >&2
  echo "  This must NOT reach git (CLAUDE.md neutrality / ADR 010)." >&2
  echo "  Real product data lives ONLY in the git-ignored .qa-memory/ instance." >&2
  echo "  Extend the guard with company terms in .githooks/neutrality.local (git-ignored)." >&2
  echo "  Bypass (rare, explain in commit body): ALLOW_NEUTRALITY_SKIP=1 git ..." >&2
  echo "" >&2
  exit 1
fi
exit 0
