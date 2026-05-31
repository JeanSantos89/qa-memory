#!/usr/bin/env bash
# qa-memory installer (POSIX) — Block "Install script", ADR 019.
# Day-0 setup made real: deps for both packages, build, an initialized instance,
# and the MCP config snippet to paste into Claude Code. Idempotent — safe to re-run.
#
#   ./scripts/install.sh            # full setup
#   ./scripts/install.sh --no-seed  # skip dogfood seed
#   ./scripts/install.sh --check    # only verify prerequisites
set -euo pipefail

NO_SEED=0; CHECK=0
for arg in "$@"; do
  case "$arg" in
    --no-seed) NO_SEED=1 ;;
    --check)   CHECK=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MCP="$REPO_ROOT/packages/mcp-server"
INGESTION="$REPO_ROOT/packages/ingestion"

step() { printf '\n==> %s\n' "$1"; }
info() { printf '  %s\n' "$1"; }
ok()   { printf '  OK %s\n' "$1"; }
die()  { printf '  X  %s\n' "$1" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found. $2"; ok "$1 ($(command -v "$1"))"; }

step "Checking prerequisites"
command -v node >/dev/null 2>&1 || die "node not found. Install Node 20 LTS or newer."
NODE_MAJOR="$(node --version | sed -E 's/v([0-9]+).*/\1/')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $NODE_MAJOR found; need >= 20."
ok "node $(node --version)"
need pnpm "Install with: npm install -g pnpm"
need uv   "Install with: pip install uv  (or see https://docs.astral.sh/uv/)"
if command -v ollama >/dev/null 2>&1; then ok "ollama ($(command -v ollama)) — local LLM path available"
else info "ollama not on PATH (optional; needed only for QA_MEMORY_LLM=ollama)"; fi

[ "$CHECK" -eq 1 ] && { step "Prerequisites OK"; exit 0; }

step "Installing MCP server deps (pnpm)"
( cd "$MCP" && pnpm install ) || die "pnpm install failed"
ok "deps installed"

step "Building MCP server (tsc)"
( cd "$MCP" && pnpm build ) || die "pnpm build failed"
ok "built to packages/mcp-server/dist"

step "Installing ingestion deps (uv)"
( cd "$INGESTION" && uv sync ) || die "uv sync failed"
ok "deps installed"

step "Initializing instance (.qa-memory/ + migrations)"
if [ "$NO_SEED" -eq 1 ]; then ( cd "$MCP" && node dist/cli.js status >/dev/null ) || die "instance init failed"
else ( cd "$MCP" && node dist/cli.js seed | sed 's/^/  /' ) || die "instance init failed"; fi
ok "instance ready at .qa-memory/qa-memory.db"

step "Done — add this to your Claude Code MCP config"
ENTRY="$MCP/dist/index.js"
cat <<EOF
  {
    "mcpServers": {
      "qa-memory": {
        "command": "node",
        "args": ["$ENTRY"],
        "env": { "QA_MEMORY_LLM": "ollama" }
      }
    }
  }
EOF
info "Drop QA_MEMORY_LLM (or set to anthropic|gemini) to change the extraction provider."
info "Inspect anytime: node packages/mcp-server/dist/cli.js status"
