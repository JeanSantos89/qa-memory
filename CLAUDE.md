# Communication style
Caveman mode. ACTIVE EVERY RESPONSE.
Drop articles, filler, pleasantries, hedging. Fragments OK. Short synonyms.
Abbreviate: DB, auth, fn, impl, req, res, config.
Arrows for causality: X → Y.
One word when one word enough.
Auto-clarity exception: revert to full prose for irreversible actions, security warnings, schema changes. Resume caveman after.
Code blocks always intact — caveman affects prose only.
Stop only if user says "normal mode" or "stop caveman".

# Token economy — ENFORCE EVERY SESSION

## MCP usage
- MCP qa-memory tools = EXPENSIVE. Call ONLY when user explicitly needs memory read/write.
- NEVER call MCP to "check" or "explore" — use Bash/Python+SQLite direct instead.
- Batch ops → Python script hitting SQLite directly (never MCP loop).
- One MCP call per task. No chained calls unless strictly required.
- If uncertain whether MCP needed: don't call it, do it locally.

## PDF reading
- ALWAYS run `tools\pdf-extract.ps1 <file>` first → reads the .txt output, NEVER the raw PDF.
- Never rasterize/read PDF directly → costs ~1600 tokens/page vs ~4 chars/token for .txt.
- If PDF is scanned (script warns): rasterize ONLY the key pages, not the whole doc.

## Agent/subagent usage
- NO subagents for single-file reads, single searches, or short tasks.
- Spawn agent only when task needs parallel independent work across 3+ files.
- Prefer: Glob → Grep → Read (direct tools) over any agent delegation.

## General
- Read only the lines needed (use offset+limit on Read).
- Glob before Grep; Grep before Read.
- No trailing summaries ("I just did X") — user can see the diff.
- No planning docs unless user asks.

# qa-memory

MCP server. QA knowledge layer. Stores product understanding, not test cases.

## Rules
- NEUTRAL repo. Reusable by anyone. NEVER commit: company/employer names, internal URLs, real Jira/Confluence project keys, customer data, credentials. Those live ONLY in the git-ignored `.qa-memory/` instance + env vars. A stranger cloning this repo plugs in their own info and it works. Examples/tests use neutral or dogfood data only.
- No unnecessary abstractions. Explicit > clever.
- Schema changes → update migrations in BOTH packages + `docs/SCHEMA.md` before anything else.
- Every LLM call → log tokens consumed (input + output). Non-negotiable.
- No new dependency without checking if existing ones solve it first.
- Claude Code only. No Cursor/Codex paths in v1.
- Token budget is a real constraint. If a prompt can be shorter, make it shorter.

## Dev workflow — blocks, not slop
- Work in BLOCKS. One block = one coherent unit + tests + living-doc update + ONE commit.
- Never dump many unrelated files in one commit. Each block reviewable alone.
- Block done = code + tests pass + living docs updated, all in same commit.

## Self-healing docs (read these FIRST, every new chat)
Order: `CLAUDE.md` → `docs/STATE.md` → `docs/SCHEMA.md` → `docs/DECISIONS.md`.
- `docs/STATE.md` — where we stopped: phases done, current block, next block, open decisions.
- `docs/SCHEMA.md` — SQLite schema source of truth, mirrored TS + Python.
- `docs/DECISIONS.md` — append-only mini-ADR log. Never rewrite past entries.

A pre-commit hook (`.githooks/pre-commit`) ENFORCES this:
- code changed but no living doc staged → commit blocked.
- schema/migration changed but `docs/SCHEMA.md` not staged → commit blocked.
- Emergency bypass: `ALLOW_DOC_SKIP=1 git commit ...` (use rarely, explain in commit body).

Enable hooks after clone: `git config core.hooksPath .githooks`.

## Source of truth
`qa-memory-spec.md` (the original spec) — all architectural product decisions. Do not re-decide.
Runtime truth = `CLAUDE.md` + `docs/` + the code.

## Stack (independent personal project)
- MCP server: TypeScript strict + Node 20 LTS, pnpm, better-sqlite3, @modelcontextprotocol/sdk, zod, Vitest.
- Ingestion: Python 3.11+, uv + pyproject.toml, ruff + mypy, typer, pydantic v2, pymupdf, sentence-transformers, APScheduler, anthropic. pytest.
- Storage: SQLite at `.qa-memory/qa-memory.db`.
- Embeddings: sentence-transformers local (all-MiniLM-L6-v2), no API.

## Token strategy
Two-pass extraction: summary first (≤150 tokens/chunk), full extraction only on relevant chunks.
Budget per sync run: configurable, default 50k tokens.
Model for batch extraction: cheapest per provider (Anthropic claude-haiku-4-5-20251001 / Gemini gemini-2.5-flash / local Llama via Ollama llama3.1). Provider via env `QA_MEMORY_LLM` (default anthropic; gemini|ollama opt-in). Ver ADR 017.
All internal pipeline prompts: caveman-style terse.
