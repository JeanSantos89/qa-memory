# qa-memory

> A QA team's institutional knowledge, persisted — and available to your AI assistant while you work.

QA engineers build deep product knowledge over time: what the edge cases are, what breaks when you touch a certain area, what the business rules actually are (not what the docs say). That knowledge lives in people's heads and spreadsheets and gets lost when someone leaves or a new dev asks "is it safe to change this?"

**qa-memory** captures that knowledge in a local database and makes it queryable by your AI coding assistant. Ask it *"what's the risk of touching checkout?"* or *"generate a test plan for this Jira task"* and it answers from everything your team already knows — without sending your product data to the cloud.

---

## Why this matters

**For QA engineers**
- Stop writing test plans from scratch. The assistant reads the Jira task, checks what already broke in that area, and produces a focused plan: new cases + regression targets, ranked by criticality.
- Your hard-won knowledge compounds. Every incident recorded, every rule confirmed, makes the next test plan better.
- You stay in control. The system proposes; you approve. Nothing gets marked "QA-confirmed" without your sign-off.

**For engineering teams**
- Know the risk before merging. *"What might break if we change the cancellation window?"* returns a concrete answer, not a shrug.
- Onboard faster. A new QA or dev can query what the product actually does in any area, distilled from specs and tickets your team already processed.
- Catch regressions earlier. Impact analysis flags which existing rules conflict with a proposed change before it ships.

---

## What it does

- **Remembers product knowledge** — behaviors (what the product does) and rules (constraints, business logic) extracted from specs, Jira tasks, Confluence pages, and PDFs.
- **Scores risk** — given a feature area or file path, returns a risk score, the relevant behaviors, their rules, and the history of what already broke there.
- **Analyzes impact** — given a proposed change in plain language, reasons about what may break, what to watch when testing, and which existing rules conflict.
- **Curates itself** — a memory-keeper agent reviews inferred rules, detects duplicates, and proposes promotions to QA-confirmed. You stay in control; it proposes, you approve.
- **Works locally** — embeddings run via `sentence-transformers` (no API required). LLM extraction works with Anthropic, Gemini, or a local Ollama model. Your product knowledge never leaves your machine unless you choose otherwise.

---

## How you'll use it day-to-day

### Feed knowledge from a Jira task or Confluence page
> *"Read PROJ-456 and save the product rules to memory."*

The assistant fetches the task, structures it as behaviors + rules, and persists it — no LLM cost if you're using Claude Code, since Claude itself does the extraction and calls `feed_to_memory` directly.

### Assess risk before testing
> *"What's the risk of touching the checkout payment flow?"*

Returns a risk score, the matched behaviors, their business rules, and any incidents recorded in that area (what already broke, when, and how bad).

### Generate a test plan for a task
> *"Create a test plan for PROJ-789 — consider the new functionality and what might regress."*

The assistant reads the task, checks risk for all affected areas, analyzes the proposed change, and generates a plan split into **new cases** (what the task adds) and **regression cases** (what might break, ranked by criticality and incident history).

### Analyze the impact of a change
> *"What breaks if we allow free cancellation up to 5 minutes after the restaurant accepts?"*

Returns what may break, what to watch when testing, and which existing rules conflict — reasoned against everything already in memory.

### Record an incident
> *"The order status badge didn't update after cancellation — log this as a P1 incident."*

Lifts the risk score for that area. Future test plans will flag it as a known breakage point.

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | ≥ 20 | |
| pnpm | any | `npm i -g pnpm` if not installed |
| uv | any | [docs.astral.sh/uv](https://docs.astral.sh/uv) |
| Ollama | optional | For fully local LLM extraction — [ollama.com](https://ollama.com) |

---

## Installation

```powershell
# Windows
git clone https://github.com/JeanSantos89/QA-memory.git && cd QA-memory
pwsh -File scripts/install.ps1
```

```bash
# macOS / Linux
git clone https://github.com/JeanSantos89/QA-memory.git && cd QA-memory
./scripts/install.sh
```

The script:
1. Checks prerequisites
2. Installs and builds the MCP server (TypeScript)
3. Installs the ingestion package (Python)
4. Initializes your local instance at `.qa-memory/` (git-ignored — your product knowledge stays private)
5. Prints the MCP config snippet to paste into Claude Code

**Flags:** `--check` (only verify prerequisites), `--no-seed` (skip dogfood data).

---

## Connecting to your AI assistant

### Option A — Claude Code (recommended)

After install, paste the printed snippet into your Claude Code MCP settings (`.mcp.json` in your project root):

```json
{
  "mcpServers": {
    "qa-memory": {
      "command": "node",
      "args": ["/path/to/QA-memory/packages/mcp-server/dist/index.js"],
      "env": {
        "QA_MEMORY_DB": "/path/to/QA-memory/.qa-memory/qa-memory.db",
        "QA_MEMORY_LLM": "anthropic",
        "QA_MEMORY_LLM_MODEL": "claude-haiku-4-5-20251001"
      }
    }
  }
}
```

Once connected, Claude Code can call all memory tools directly during your conversation — no extra steps.

### Option B — Any MCP-compatible client with an API key

Set `QA_MEMORY_LLM` to your preferred provider and supply the API key as an environment variable:

```json
{
  "mcpServers": {
    "qa-memory": {
      "command": "node",
      "args": ["/path/to/QA-memory/packages/mcp-server/dist/index.js"],
      "env": {
        "QA_MEMORY_DB": "/path/to/.qa-memory/qa-memory.db",
        "QA_MEMORY_LLM": "gemini",
        "QA_MEMORY_LLM_MODEL": "gemini-2.5-flash",
        "GEMINI_API_KEY": "your-key-here"
      }
    }
  }
}
```

### Option C — Fully local (no API key)

Run extraction entirely on your machine with Ollama:

```json
{
  "env": {
    "QA_MEMORY_LLM": "ollama",
    "QA_MEMORY_LLM_MODEL": "qwen2.5:14b"
  }
}
```

`qwen2.5:14b` is the recommended local model. The 8B variant works for extraction; 14B+ is needed for reliable impact analysis.

---

## Configuration

All configuration via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `QA_MEMORY_DB` | `.qa-memory/qa-memory.db` | Path to the SQLite database |
| `QA_MEMORY_LLM` | `anthropic` | LLM provider: `anthropic` \| `gemini` \| `ollama` |
| `QA_MEMORY_LLM_MODEL` | provider default | Model override (e.g. `qwen2.5:14b` for Ollama) |
| `QA_MEMORY_LANG` | `en` | Output language: `en` \| `pt-BR` |
| `QA_MEMORY_INGESTION_DIR` | package path | Path to the ingestion package (auto-detected) |

---

## MCP Tools

Once connected, these tools are available to your AI assistant:

| Tool | What it does |
|------|-------------|
| `feed_to_memory` | Persist behaviors + rules from structured JSON — **no LLM call** (the assistant is the extractor). Use this for Jira/Confluence content already in context. |
| `add_to_memory` | Ingest raw text, a local file, or a public URL — LLM extracts behaviors + rules internally. |
| `query_behavior` | Search product behaviors by free text. |
| `query_risk` | Get a risk score + matched behaviors + rules for a feature area or file path. |
| `analyze_impact` | Reason about a proposed change: what may break, what to watch, which rules conflict. |
| `map_area` | Associate a file glob (e.g. `checkout/**/*.ts`) with its behaviors so `query_risk` can resolve by path. |
| `update_rule` | Define or override a rule in QA voice (pins it as confirmed, confidence 1.0). |
| `record_incident` | Record something that broke — lifts the risk score for that area with recency + severity weighting. |
| `review_memory` | List inferred rules awaiting QA confirmation (the memory-keeper's worklist). |
| `find_duplicate_rules` | Detect clusters of near-duplicate rules across behaviors. |
| `retire_rule` | Retire a redundant rule (sets status to superseded, removes from all reads). |

---

## Privacy

Your product knowledge lives in `.qa-memory/` which is git-ignored. The repo contains only neutral code and documentation — no company names, internal URLs, real ticket keys, or customer data. Clone it, point it at your product, and your knowledge stays local.

To protect against accidental leaks, copy `.githooks/neutrality.local.example` to `.githooks/neutrality.local` and fill in your company-specific terms. The pre-commit and pre-push hooks will block any staged content that matches.

---

## Project structure

```
packages/
  mcp-server/     TypeScript — MCP server, tools, search, risk scoring, embedder
  ingestion/      Python — LLM extraction pipeline, PDF/URL sources, impact analysis
scripts/
  install.ps1     Windows setup
  install.sh      macOS/Linux setup
docs/
  STATE.md        Current development status (living doc)
  SCHEMA.md       SQLite schema source of truth
  DECISIONS.md    Architecture decision log
.githooks/        Commit/push guards (doc enforcement, neutrality scan)
.qa-memory/       Your local instance — git-ignored, never committed
```

---

## Development

```powershell
# MCP server (TypeScript)
cd packages/mcp-server
pnpm install && pnpm build
pnpm test          # Vitest
pnpm typecheck     # tsc --noEmit

# Ingestion (Python)
cd packages/ingestion
uv sync
uv run pytest
uv run ruff check src/
uv run mypy src/
```

Commit discipline: one block = code + tests + living doc update in the same commit. The pre-commit hook blocks code changes without a corresponding doc update.
