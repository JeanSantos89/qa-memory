# qa-memory installer (Windows / PowerShell) — Block "Install script", ADR 019.
# Day-0 setup made real: deps for both packages, build, an initialized instance,
# and the MCP config snippet to paste into Claude Code. Idempotent — safe to re-run.
#
#   pwsh -File scripts/install.ps1            # full setup
#   pwsh -File scripts/install.ps1 -NoSeed    # skip dogfood seed
#   pwsh -File scripts/install.ps1 -Check     # only verify prerequisites
[CmdletBinding()]
param(
  [switch]$NoSeed,
  [switch]$Check
)
# NOT "Stop": pnpm/tsc/uv write progress to stderr, which PS 5.1 wraps as a
# terminating NativeCommandError. We gate on $LASTEXITCODE / artifacts instead.
$ErrorActionPreference = "Continue"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Mcp = Join-Path $RepoRoot "packages\mcp-server"
$Ingestion = Join-Path $RepoRoot "packages\ingestion"

function Info($m) { Write-Host "  $m" }
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK $m" -ForegroundColor Green }
function Die($m)  { Write-Host "  X  $m" -ForegroundColor Red; exit 1 }

function Need($name, $hint) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if (-not $cmd) { Die "$name not found. $hint" }
  Ok "$name ($($cmd.Source))"
}

Step "Checking prerequisites"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Die "node not found. Install Node 20 LTS or newer." }
$major = [int]((node --version) -replace "v(\d+)\..*", '$1')
if ($major -lt 20) { Die "Node $major found; need >= 20." }
Ok "node $(node --version)"
Need "pnpm" "Install with: npm install -g pnpm"
Need "uv"   "Install with: pip install uv  (or see https://docs.astral.sh/uv/)"
# Ollama is optional — only needed for the local-Llama LLM path.
$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if ($ollama) { Ok "ollama ($($ollama.Source)) — local LLM path available" }
else { Info "ollama not on PATH (optional; needed only for QA_MEMORY_LLM=ollama)" }

if ($Check) { Step "Prerequisites OK"; exit 0 }

# PS 5.1 flags any stderr from a native exe as a NativeCommandError and trips $?,
# so we gate on $LASTEXITCODE / real artifacts, not $?.
Step "Installing MCP server deps (pnpm)"
Push-Location $Mcp
try { pnpm install; if ($LASTEXITCODE -ne 0) { Die "pnpm install failed" } } finally { Pop-Location }
Ok "deps installed"

Step "Building MCP server (tsc)"
Push-Location $Mcp
try { pnpm build } finally { Pop-Location }
$entryPath = Join-Path $Mcp "dist\index.js"
if (-not (Test-Path $entryPath)) { Die "build produced no dist/index.js" }
Ok "built to packages/mcp-server/dist"

Step "Installing ingestion deps (uv)"
Push-Location $Ingestion
try { uv sync; if ($LASTEXITCODE -ne 0) { Die "uv sync failed" } } finally { Pop-Location }
Ok "deps installed"

Step "Initializing instance (.qa-memory/ + migrations)"
Push-Location $Mcp
try {
  if ($NoSeed) { node dist/cli.js status | Out-Null }
  else { node dist/cli.js seed | ForEach-Object { Info $_ } }
  if ($LASTEXITCODE -ne 0) { Die "instance init failed" }
} finally { Pop-Location }
Ok "instance ready at .qa-memory/qa-memory.db"

Step "Done — add this to your Claude Code MCP config"
$entry = (Join-Path $Mcp "dist\index.js").Replace('\', '\\')
Write-Host @"
  {
    "mcpServers": {
      "qa-memory": {
        "command": "node",
        "args": ["$entry"],
        "env": { "QA_MEMORY_LLM": "ollama" }
      }
    }
  }
"@ -ForegroundColor Yellow
Info "Drop QA_MEMORY_LLM (or set to anthropic|gemini) to change the extraction provider."
Info "Inspect anytime: node packages/mcp-server/dist/cli.js status"
