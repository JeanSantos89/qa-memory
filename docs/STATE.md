# STATE — onde paramos

> Living doc. Updated every block, same commit. New chat reads this to know where to continue.

## Status atual
- **Fase atual:** Fase 3 — Ingestão PDF (EM ANDAMENTO)
- **Último bloco concluído:** Bloco 3.4 — wiring/persistência + CLI ingest. `config.py` (`resolve_db_path`, env `QA_MEMORY_DB` ou default `.qa-memory/qa-memory.db`, espelha config.ts). `db/repo.py`: `find_source_by_checksum` (guard) + `insert_source`/`insert_behavior` (confirmed_by_qa=0, source_ids JSON) /`insert_rule` (confidence 0.6, mid 0.5–0.8) /`insert_embedding` (vector BLOB). `pipeline/ingest.py`: `ingest_doc(conn, doc, extractor, embed_model)` → checksum-skip → chunk → two-pass → embed behaviors (batch) → persist em transação; retorna `IngestReport` (counts+tokens+budget_exhausted). `cli.py`: typer `app` com `ingest <pdf>` (deps reais: PdfSource+AnthropicClient+LocalEmbeddingModel) + `status` (path+counts). 35 testes pytest ✓ (4 novos: persist ponta a ponta com fakes, link source/embedding BLOB, checksum-skip sem dup, config), ruff ✓, mypy strict ✓.
- **Próximo bloco:** Fase 4 — `query_risk` + `update_rule`/override em linguagem natural (MCP, lado TS). Alternativa de prioridade (ver decisões em aberto): subir Jira+Confluence como próximas fontes ingeridas (Atlassian, mesmo token) antes da Fase 4.

## Toolchain (instalado nesta máquina)
- Node 24.14.1 · pnpm 11.5.0 (em `%APPDATA%\npm`)
- Python 3.13.13 (em `%LOCALAPPDATA%\Programs\Python\Python313`) · uv 0.11.17 (em `~/.local/bin`)
- PATH não persiste entre shells novos → usar caminhos completos ou prepend ao rodar.

## Roadmap por fases (da spec, faseado)
- [x] **Fase 0** — Infra auto-healing: docs vivos + hook de bloqueio.
- [x] **Fase 1** — Fundação: estrutura + configs (✓ 1.1) + schema SQLite + migrations (TS+Py) com testes (✓ 1.2).
- [x] **Fase 2** — Vertical slice: repo+config (✓ 2.1) + MCP server `query_behavior` + CLI `status`/`list behaviors`/`seed` + seed dogfood (✓ 2.2).
- [x] **Fase 3** — Ingestão PDF: base.py + pdf.py + chunker (✓ 3.1) + two-pass extractor log tokens (✓ 3.2) + embeddings locais (✓ 3.3) + wiring/persistência + CLI ingest (✓ 3.4). Pipeline PDF ponta a ponta completo.
- [ ] **Fase 4** — `query_risk` + `update_rule`/override em linguagem natural.
- [ ] **Fase 5** — Jira, Google Docs, scheduler, Confluence/Notion/HAR, `suggest_tests`, install.sh, README real.

## Decisões em aberto
- Reordenar fontes: usuário tem conhecimento "na cabeça" + Confluence + Jira (não PDF como prioridade real). PDF continua sendo a 1ª fonte IMPLEMENTADA (simples, sem auth, fácil de testar), mas Jira+Confluence (Atlassian, mesmo token) sobem na prioridade logo após. "Na cabeça" → via update_rule (conversa).

## Privacidade / dados (importante)
- REGRA DE NEUTRALIDADE (ver CLAUDE.md): repo neutro/reutilizável. Nunca commitar nome de empresa, URLs internas, chaves de projeto reais, dados de cliente, credenciais. Quem clonar usa as próprias infos.
- Repo = SÓ código/docs/exemplos neutros. Conhecimento real do produto NUNCA é commitado.
- `.qa-memory/` inteiro é git-ignored (DB + config real + creds). Tokens via env var.
- Usuário pode apontar instância local pro produto do trabalho sem exposição. Repo pode ser dogfood (qa-memory sobre si mesmo) p/ exemplos compartilháveis.
- **Repo público — auditado em 2026-05-30:** histórico limpo (sem creds/tokens/URLs internas/nome de empresa/dados de cliente). Único vazamento: `PROJ-3053` (chave Jira real) em `docs/SCHEMA.md` → trocado por `PROJ-123` neutro. Após esse fix, repo OK p/ tornar público. Email pessoal no author é intencional.

## Notas para o próximo chat
- Git: remote `JeanSantos89/qa-memory` (privado), identidade LOCAL JeanSantos89 / jeansaantos89@gmail.com. Token no GCM.
- Hooks ativados via `git config core.hooksPath .githooks` (rodar após clone).
- Projeto pessoal independente — NÃO seguir convenções de organização externas; seguir este repo.
- Validar TS: `pnpm install && pnpm typecheck && pnpm test` em packages/mcp-server. Validar Py: `uv sync && uv run ruff check && uv run mypy && uv run pytest` em packages/ingestion.
- **Tooling gotcha (Node 24):** better-sqlite3 11.x NÃO tem prebuilt p/ Node 24 → tentava compilar e falhava (sem VS build tools). Bumpado p/ `^12.2.0` (prebuilt Node 24 ok). pnpm 11.5 exige `allowBuilds: {pkg: true}` em `pnpm-workspace.yaml` p/ rodar install scripts (better-sqlite3, esbuild).
- Shell: rodar via PowerShell com PATH prepend (`$env:APPDATA\npm` p/ pnpm, `~/.local/bin` p/ uv). Bash tool mistura PATH do Git → quebra.
