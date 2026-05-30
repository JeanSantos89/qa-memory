# STATE — onde paramos

> Living doc. Updated every block, same commit. New chat reads this to know where to continue.

## Status atual
- **Fase atual:** Fase 1 — Fundação (em andamento)
- **Último bloco concluído:** Bloco 1.1 — estrutura de pastas + configs base (mcp-server TS + ingestion Py)
- **Próximo bloco:** Bloco 1.2 — schema SQLite + migrations nos DOIS packages, com testes (Vitest + pytest)

## Toolchain (instalado nesta máquina)
- Node 24.14.1 · pnpm 11.5.0 (em `%APPDATA%\npm`)
- Python 3.13.13 (em `%LOCALAPPDATA%\Programs\Python\Python313`) · uv 0.11.17 (em `~/.local/bin`)
- PATH não persiste entre shells novos → usar caminhos completos ou prepend ao rodar.

## Roadmap por fases (da spec, faseado)
- [x] **Fase 0** — Infra auto-healing: docs vivos + hook de bloqueio.
- [~] **Fase 1** — Fundação: estrutura + configs (✓ 1.1) + schema SQLite + migrations (TS+Py) com testes (1.2). ← agora
- [ ] **Fase 2** — Vertical slice: MCP server `query_behavior` (mock) + CLI `status`/`list behaviors`.
- [ ] **Fase 3** — Ingestão PDF: base.py + pdf.py + chunker + two-pass extractor (log tokens) + embeddings locais.
- [ ] **Fase 4** — `query_risk` + `update_rule`/override em linguagem natural.
- [ ] **Fase 5** — Jira, Google Docs, scheduler, Confluence/Notion/HAR, `suggest_tests`, install.sh, README real.

## Decisões em aberto
- Reordenar fontes: usuário tem conhecimento "na cabeça" + Confluence + Jira (não PDF como prioridade real). PDF continua sendo a 1ª fonte IMPLEMENTADA (simples, sem auth, fácil de testar), mas Jira+Confluence (Atlassian, mesmo token) sobem na prioridade logo após. "Na cabeça" → via update_rule (conversa).

## Privacidade / dados (importante)
- REGRA DE NEUTRALIDADE (ver CLAUDE.md): repo neutro/reutilizável. Nunca commitar nome de empresa, URLs internas, chaves de projeto reais, dados de cliente, credenciais. Quem clonar usa as próprias infos.
- Repo = SÓ código/docs/exemplos neutros. Conhecimento real do produto NUNCA é commitado.
- `.qa-memory/` inteiro é git-ignored (DB + config real + creds). Tokens via env var.
- Usuário pode apontar instância local pro produto do trabalho sem exposição. Repo pode ser dogfood (qa-memory sobre si mesmo) p/ exemplos compartilháveis.

## Notas para o próximo chat
- Git: remote `JeanSantos89/qa-memory` (privado), identidade LOCAL JeanSantos89 / jeansaantos89@gmail.com. Token no GCM.
- Hooks ativados via `git config core.hooksPath .githooks` (rodar após clone).
- Projeto pessoal independente — NÃO seguir convenções de organização externas; seguir este repo.
- Validar TS: `pnpm install && pnpm typecheck` em packages/mcp-server. Validar Py: `uv sync && uv run ruff check` em packages/ingestion.
