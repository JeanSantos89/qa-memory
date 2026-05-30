# STATE — onde paramos

> Living doc. Updated every block, same commit. New chat reads this to know where to continue.

## Status atual
- **Fase atual:** Fase 4 — query_risk + update_rule/override (FECHADA)
- **Último bloco concluído:** Bloco 4.2 — `update_rule`/override (write). `repo/rules.ts` ganhou `getRuleById` + `overrideRule(db, id, rule_text, reason)` → fixa rule como QA-confirmada (confidence 1.0, qa_override=1, override_reason, updated_at); retorna rule atualizada ou null se id desconhecido. Tool `update_rule` no server.ts (NL): args `rule_text`+`reason` obrigatórios; `rule_id` → override de rule existente; senão `behavior` (texto livre) resolve via queryBehavior — 0 match → erro "crie behavior", >1 → lista p/ refinar (não chuta), 1 → insertRule QA (confidence 1.0). Sempre retorna `{ok, action, rule}` em structuredContent. Behavior.confirmed_by_qa NÃO é tocado (ato separado; addend futuro). 35 testes Vitest ✓ (rules +2 override, server +2 create/refuse), typecheck ✓.
- **Bloco anterior:** 4.1 — `query_risk` (read) + repo de rules TS + score derivado transparente (`risk.ts`). Ver ADR 012.
- **Próximo bloco:** Fase 5 — fontes Jira/Confluence (Atlassian, mesmo token) como próximas fontes ingeridas. Ver decisões em aberto. Pendência técnica ainda viva: `query_behavior`/`query_risk` usam LIKE; vetores gravados pela ingestão NÃO são consultados — busca semântica é bloco próprio.

## Toolchain (instalado nesta máquina)
- Node 24.14.1 · pnpm 11.5.0 (em `%APPDATA%\npm`)
- Python 3.13.13 (em `%LOCALAPPDATA%\Programs\Python\Python313`) · uv 0.11.17 (em `~/.local/bin`)
- PATH não persiste entre shells novos → usar caminhos completos ou prepend ao rodar.

## Roadmap por fases (da spec, faseado)
- [x] **Fase 0** — Infra auto-healing: docs vivos + hook de bloqueio.
- [x] **Fase 1** — Fundação: estrutura + configs (✓ 1.1) + schema SQLite + migrations (TS+Py) com testes (✓ 1.2).
- [x] **Fase 2** — Vertical slice: repo+config (✓ 2.1) + MCP server `query_behavior` + CLI `status`/`list behaviors`/`seed` + seed dogfood (✓ 2.2).
- [x] **Fase 3** — Ingestão PDF: base.py + pdf.py + chunker (✓ 3.1) + two-pass extractor log tokens (✓ 3.2) + embeddings locais (✓ 3.3) + wiring/persistência + CLI ingest (✓ 3.4). Pipeline PDF ponta a ponta completo.
- [x] **Fase 4** — `query_risk` (✓ 4.1) + `update_rule`/override em linguagem natural (✓ 4.2).
- [ ] **Fase 5 (REORDENADA — ver ADR 014)** — ordem por risco→valor:
  - [ ] **S.1 — Busca semântica** (furo #1, prova a tese): ligar os vetores já gravados; query_behavior/query_risk param de usar só LIKE. ATACAR PRIMEIRO.
  - [ ] **5.1 — `add_to_memory`** (text | file-path): "jogou, lembrou". Núcleo do Dia 1. (auto-init já pronto.)
  - [ ] **B — Superfície guiada** (MCP prompts + estado vazio que ensina + skill onboarding). Resolve descoberta SEM UI. Serve técnico e não-técnico.
  - [ ] **Install script** (furo #2): sem ele o "Dia 0 ~2min" é mentira.
  - [ ] **Futuro:** subagent automatizado (cuida da memória sozinho) + conectores nativos (Jira/Confluence/Drive) + scheduler. UI dedicada (C) ADIADA — só se não-técnico virar prioridade (usuário avisa).

## Decisões em aberto
- Reordenar fontes: usuário tem conhecimento "na cabeça" + Confluence + Jira (não PDF como prioridade real). PDF continua sendo a 1ª fonte IMPLEMENTADA (simples, sem auth, fácil de testar), mas Jira+Confluence (Atlassian, mesmo token) sobem na prioridade logo após. "Na cabeça" → via update_rule (conversa).
- Modelo de fontes: AGENTE-ALIMENTADO (híbrido). qa-memory NÃO terá conectores próprios no curto prazo — expõe tools de ingestão burras e o agente usa os MCPs que o usuário já tem (Atlassian/Drive) p/ buscar e alimentar. Conectores nativos + sync automático = futuro (subagent). Ver ADR 014.

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
