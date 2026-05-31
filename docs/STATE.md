# STATE — onde paramos

> Living doc. Updated every block, same commit. New chat reads this to know where to continue.

## Status atual
- **Fase atual:** Fase 5 (reordenada) — Bloco 5.1 `add_to_memory` (texto) fechado.
- **Último bloco concluído:** Bloco 5.1 — `add_to_memory` ("jogou, lembrou", texto puro). Python: `sources/text.py` (`TextSource` → ExtractedDoc, checksum sha256 do texto trimado, source_type default "conversation" sobrescrevível) + CLI `ingest-text "<texto>"` (ou `-` p/ stdin; `--label`/`--source-type`/`--budget`; mesmo pipeline chunk→two-pass→embed→persist). TS: `ingester.ts` (`Ingester` interface + `PythonIngester` via subprocess, texto por STDIN p/ fugir de limite de arg, env `QA_MEMORY_INGEST_CMD`, default `uv run qa-memory ingest-text`) + tool `add_to_memory` no server (args text + label?/source_type?; injeta ingester; reporta ok/erro sem throw). `createServer(db, embedder?, ingester?)`. 44 testes Vitest ✓ (add_to_memory +2), 38 pytest ✓ (TextSource +3), ruff/mypy/typecheck ✓. Ver ADR 016. Escopo: SÓ texto — file-path/PDF-routing = 5.2.
- **Bloco anterior:** S.1 — busca semântica ligada (furo #1 resolvido). Python ganhou comando CLI `embed "<texto>"` (imprime vetor JSON, stdout limpo, reusa LocalEmbeddingModel). TS: `embeddings.ts` (`unpackVector` BLOB float32 LE + `cosineSimilarity`, puros), `embedder.ts` (`Embedder` interface + `PythonEmbedder` via subprocess, comando configurável por env `QA_MEMORY_EMBED_CMD`, default `uv run qa-memory embed`; retorna null → fallback), `repo/behaviors.ts.listBehaviorEmbeddings` (behaviors não-deprecated + último vetor), `search.ts.searchBehaviors` (HÍBRIDO: ranking cosseno acima de floor 0.25, backfill LIKE; fallback puro LIKE se sem embeddings/embedder indisponível). `createServer(db, embedder?)` injeta embedder (default PythonEmbedder) → `query_behavior` e `query_risk` agora usam `searchBehaviors` (semântico+LIKE). `update_rule` mantém LIKE (escrita precisa precisão, não recall). 42 testes Vitest ✓ (embeddings 3, search 4), typecheck/ruff/mypy/pytest ✓. Ver ADR 015.
- **Bloco anterior:** 4.2 — `update_rule`/override (write). 4.1 — `query_risk` + repo de rules TS + score derivado (`risk.ts`). Ver ADR 012/013.
- **VALIDAÇÃO S.1 (2026-05-30, run manual):** embedding PONTA-A-PONTA PROVADO com modelo real. DB semeado com 3 behaviors + vetores reais (all-MiniLM, pack_vector BLOB), query SEM overlap lexical com o alvo → LIKE=0 matches, mas híbrido retorna só "User authentication" (cosine 0.3985 acima do floor 0.25; payment 0.207 e email 0.085 filtrados). Confirma: serialização float32 BLOB Python→TS bate, modelo no mesmo espaço, semântica supera LIKE, SEMANTIC_FLOOR corta certo, subprocess plumbing OK neste host. **Cold-start medido: ~10s/query** (modelo cacheado; 1ª vez ~48s c/ download ~90MB) → otimização (helper Python "quente"/persistente) continua pendente e é custo real. Embeddings ainda só de behaviors (rules/incidents = futuro).
- **Bloco LLM-provider-plugável (2026-05-30, ver ADR 017):** 3 clients atrás do Protocol `LLMClient` — `AnthropicClient`, `GeminiClient` (SDK `google-genai`, JSON via response_mime_type, tokens via usage_metadata), `OllamaClient` (Llama LOCAL via `/api/chat`, só stdlib urllib, sem dep/key, JSON via format=json, tokens via prompt_eval_count/eval_count, base URL `QA_MEMORY_LLM_BASE_URL` default localhost:11434). Factory `make_llm_client()` escolhe por env `QA_MEMORY_LLM` = anthropic (DEFAULT) | gemini | ollama(alias llama); model override `QA_MEMORY_LLM_MODEL`. CLI (`ingest`+`ingest-text`) usa a factory. Dep nova só `google-genai>=1.0` (ollama=zero dep). 44 pytest ✓ (+6 test_llm: factory default/gemini/ollama/unknown + mapeamento de tokens gemini & ollama), ruff/mypy ✓.
- **PENDÊNCIA ABERTA — extração LLM two-pass ao vivo (próxima máquina):** path two-pass (`ingest-text`/`add_to_memory`/`ingest` PDF) ainda não rodado ponta-a-ponta com LLM REAL. Plano: clonar noutra máquina, `ollama serve` + `ollama pull llama3.1`, `QA_MEMORY_LLM=ollama`, rodar `uv run qa-memory ingest-text "<texto>"` e conferir `N behaviors, M rules, T tokens`. Anthropic (sem key) e Gemini (key insuficiente) não validados aqui. Testes cobrem factory + tokens + roteamento, todos com fakes.
- **Próximo bloco:** seguir roadmap reordenado → **5.1 `add_to_memory`** (text|path) ou **B superfície guiada** (prompts+estado vazio+skill). Ver ADR 014.

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
- [ ] **Fase 5 (REORDENADA — ver ADR 014/015)** — ordem por risco→valor:
  - [x] **S.1 — Busca semântica** (furo #1 RESOLVIDO): query embedada via subprocess Python (`qa-memory embed`), ranking cosseno no TS, híbrido com fallback LIKE. query_behavior/query_risk não dependem mais só de LIKE. VALIDADO ponta-a-ponta com modelo real (2026-05-30, ver acima). Pendência restante: otimizar cold-start ~10s/query (helper Python quente) + validar path LLM (sem API key ainda). Embeddings ainda só de behaviors (rules/incidents futuros).
  - [x] **5.1 — `add_to_memory` (TEXTO)** — "jogou, lembrou". TextSource + CLI ingest-text + tool MCP via subprocess (stdin). File-path/PDF-routing fica p/ 5.2.
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
