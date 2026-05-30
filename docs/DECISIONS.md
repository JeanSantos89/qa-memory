# DECISIONS — log append-only (mini-ADRs)

> Append only. Never rewrite past entries. New decision → new entry at the bottom.
> Format: `## NNN — title` / Date / Context / Decision / Consequences.

## 001 — Projeto pessoal independente
- **Date:** 2026-05-30
- **Context:** Repo nasceu numa máquina corporativa cujos plugins sugerem um padrão de organização (pnpm/uv/Node22/Py3.13/docs-structure/epics). Mas o projeto é 100% pessoal do autor.
- **Decision:** Ignorar convenções de organização externas. Tratar como projeto independente. Escolher a melhor stack isoladamente.
- **Consequences:** Sem automações de organização, sem design system externo, sem regras de commit externas. Stack escolhida por mérito próprio.

## 002 — Stack do projeto
- **Date:** 2026-05-30
- **Context:** Spec original pede Node 18 + npm + Python 3.11 + requirements.txt. Não negociável p/ decisões de PRODUTO, mas tooling é livre num projeto pessoal.
- **Decision:** MCP server = TS strict + Node 20 LTS + pnpm + better-sqlite3 + @modelcontextprotocol/sdk + zod + Vitest. Ingestion = Python 3.11+ + uv + pyproject.toml + ruff + mypy + typer + pydantic v2 + pytest. Mantidas decisões de produto da spec (SQLite, two-pass, embeddings locais, caveman).
- **Consequences:** Tooling moderno; versões mínimas da spec respeitadas onde fazem sentido.

## 003 — Auto-healing via pre-commit hook que bloqueia
- **Date:** 2026-05-30
- **Context:** Risco de docs ficarem desatualizados → chats futuros desenvolvem com contexto errado (AI slop). Disciplina sozinha não garante.
- **Decision:** Desenvolvimento em blocos (1 bloco = unidade + testes + docs + 1 commit). Garantia mecânica: `.githooks/pre-commit` versionado via `core.hooksPath`. Bloqueia commit se código mudou sem doc vivo; bloqueia se schema mudou sem `docs/SCHEMA.md`. Docs vivos: CLAUDE.md, docs/STATE.md, docs/SCHEMA.md, docs/DECISIONS.md.
- **Consequences:** Cada commit carrega contexto atualizado. Bypass de emergência: `ALLOW_DOC_SKIP=1`. Conjunto de docs vivos pode evoluir conforme o projeto.

## 004 — Git isolado de conta de trabalho
- **Date:** 2026-05-30
- **Context:** Máquina logada em outra conta corporativa; repo é da conta pessoal JeanSantos89.
- **Decision:** Identidade git LOCAL (não global): user.name=JeanSantos89, email=jeansaantos89@gmail.com. Remote com username embutido (`JeanSantos89@github.com/...`) p/ GCM isolar credenciais. PAT fine-grained da conta pessoal.
- **Consequences:** Commits atribuídos à conta pessoal sem afetar config global da máquina.

## 005 — Toolchain instalado sem admin
- **Date:** 2026-05-30
- **Context:** Máquina sem pnpm/Python/uv. corepack falhou (EPERM em Program Files, sem admin).
- **Decision:** pnpm via `npm install -g` (user prefix `%APPDATA%\npm`). Python 3.13 via `winget --scope user`. uv via installer oficial (`~/.local/bin`).
- **Consequences:** Tudo em diretório de usuário, sem admin. PATH não persiste entre shells → comandos usam caminho completo ou prepend.

## 006 — Isolamento de dados sensíveis (repo vs instância)
- **Date:** 2026-05-30
- **Context:** Usuário quer usar conhecimento do produto do trabalho, mas não pode expor nada no repo (potencialmente público).
- **Decision:** Separação total: repo só código/docs/exemplos neutros. Runtime instance `.qa-memory/` (DB + config real + creds) inteiramente git-ignored. Tokens só via env var. Config versionada só como `config.example.yaml` neutro. Repo pode ser dogfood (qa-memory sobre si mesmo) p/ exemplos.
- **Consequences:** Nenhum dado de produto entra no git, mesmo se o repo virar público. Instância de trabalho roda local, isolada.

## 007 — Migration runner mínimo + schema espelhado inline
- **Date:** 2026-05-30
- **Context:** Bloco 1.2 precisa do schema SQLite nos DOIS packages (TS + Py). Sem ORM, sem lib de migration externa (CLAUDE.md: "no unnecessary abstractions", "no new dependency sem checar").
- **Decision:** Runner próprio em cada package: lista `MIGRATIONS[]` (version, name, sql) + fn `migrate(conn)` que cria `schema_migrations`, aplica pendentes em transação, idempotente. SQL embutido inline como string em cada linguagem (espelho intencional, exigido pelo CLAUDE.md). Conexão helper liga FK ON + WAL. `:memory:` p/ testes.
- **Consequences:** Zero deps novas. Mudança de schema = editar SQL nos 2 arquivos + `docs/SCHEMA.md` no mesmo commit (hook reforça). Espelho duplicado é custo aceito e explícito.

## 008 — better-sqlite3 ^12 (Node 24) + pnpm allowBuilds
- **Date:** 2026-05-30
- **Context:** Máquina roda Node 24.14.1. better-sqlite3 11.x não publica prebuilt p/ Node 24 → install tentava `node-gyp rebuild`, falhava (sem Python/VS build tools no PATH do gyp). pnpm 11.5 também bloqueia install scripts por padrão.
- **Decision:** Bump better-sqlite3 p/ `^12.2.0` (tem prebuilt Node 24). Habilitar build scripts via `allowBuilds: {better-sqlite3: true, esbuild: true}` em `pnpm-workspace.yaml`.
- **Consequences:** Install sem toolchain C++. Versão mínima da spec (Node 18) continua compatível em runtime; só o piso de dev subiu. Se baixar Node, prebuilt ainda cobre.

## 009 — Vertical slice MCP: query_behavior real (não mock) + CLI + seed dogfood
- **Date:** 2026-05-30
- **Context:** Bloco 2.2 fecha a Fase 2. Spec/STATE chamavam `query_behavior` de "mock". A camada repo do 2.1 já fazia busca real LIKE sobre SQLite — não há motivo p/ retornar dado falso.
- **Decision:** Tool `query_behavior` consome `repo.queryBehavior` (LIKE name+description, exclui deprecated, case-insensitive) — slice real ponta a ponta, não mock. McpServer via stdio (`StdioServerTransport`). CLI `qa-memory` com `status`/`list behaviors`/`seed`. Seed dogfood NEUTRO (qa-memory sobre si mesmo) p/ demo compartilhável. Regras/confidence ficam p/ bloco futuro (não entram nesse slice). `main()` guardado por `process.argv[1] === fileURLToPath(import.meta.url)` p/ não rodar em import (testes). `openDb` cria dir pai p/ DBs em arquivo.
- **Consequences:** Slice demonstrável: `qa-memory seed` → MCP `query_behavior` retorna dados reais. Sem mock a manter. Embeddings/ranking semântico chegam na Fase 3 (substituem o LIKE). Bin novo `qa-memory` em package.json (além de `qa-memory-mcp`).

## 010 — Auditoria de neutralidade p/ repo público (fix PROJ-3053)
- **Date:** 2026-05-30
- **Context:** Usuário perguntou se pode tornar o repo público. CLAUDE.md proíbe chaves de projeto Jira reais. `docs/SCHEMA.md` usava `PROJ-3053` como exemplo de `source_ref` — PROJ é projeto real do trabalho.
- **Decision:** Auditar todo o histórico (`git log -p` por padrões sensíveis). Único achado: `PROJ-3053` → trocado por `PROJ-123` neutro. Não reescrever histórico (valor não é secreto, só viola neutralidade; custo de filter-repo não se justifica p/ chave de exemplo).
- **Consequences:** Repo apto a virar público após esse commit. Resto do histórico já limpo (creds/URLs/empresa/cliente ausentes; email pessoal no author é intencional).

## 011 — Wiring de ingestão: orquestrador puro + repo Py + CLI typer
- **Date:** 2026-05-30
- **Context:** Bloco 3.4 conecta as peças puras 3.1–3.3 (source→chunker→two-pass→embeddings) num pipeline persistido. Precisava de camada de persistência Py (não existia; só o lado TS tinha repo) e CLI (`qa_memory.cli:app` já referenciado no pyproject mas sem arquivo).
- **Decision:** `ingest_doc(conn, doc, extractor, embed_model)` em `pipeline/ingest.py` recebe deps por injeção (extractor + embed_model são Protocols já existentes) → testável com fakes, sem rede/torch/API key. Persistência em `db/repo.py` (funções livres espelhando o estilo de `repo/behaviors.ts`, sem ORM). Checksum-guard no início (`find_source_by_checksum`) → doc idêntico é skip total, zero LLM. Embeddings só de behaviors (entity_type='behavior', content=name+description) em batch único. Confidence de rules de PDF = 0.6 (meio da banda 0.5–0.8 do SCHEMA). CLI typer com `Annotated[...]` (não defaults com chamada → ruff B008). Persist numa transação (`conn.commit()` ao fim).
- **Consequences:** Fase 3 fechada — PDF ponta a ponta. Nenhuma dep nova. Embeddings de rules/incidents ficam p/ quando o ranking semântico substituir o LIKE (Fase futura). `query_behavior` (TS) ainda usa LIKE; os vetores gravados aqui ainda não são consultados — wiring de busca semântica é bloco próprio.

## 012 — query_risk: score derivado e transparente (Bloco 4.1)
- **Date:** 2026-05-30
- **Context:** Fase 4 abre com `query_risk`. Decisão de produto: como expressar risco? Opções — score sintético, sinais brutos, ou nível por criticality. Usuário escolheu score derivado.
- **Decision:** Score 0..1 puro em `risk.ts` (sem acesso a DB → testável isolado). Base = pior criticality entre behaviors casados (P0=1.0/P1=0.7/P2=0.4/P3=0.2/custom=0.5). Bônus de incerteza (+0.1 cada, capado em 1.0): behaviors não confirmados por QA / behaviors sem rules conhecidas / rules todas inferidas com confidence<0.7. Todo contribuinte ecoado em `reasons[]` — score nunca é caixa-preta. Level: ≥0.8 high / ≥0.5 medium / >0 low / sem match → unknown. Lado TS ganhou `repo/rules.ts` (não existia; só Python persistia rules) que esconde under_review (confidence<0.5, conforme SCHEMA L105). Incidents ainda NÃO entram no score (tabela vazia até ingestão Jira) — fica como addend futuro explícito.
- **Consequences:** Agente que consome o MCP vê score + porquê e decide profundidade de teste. Nenhuma dep nova, nenhuma mudança de schema. `update_rule`/override (escrita, qa_override=1) é o Bloco 4.2. Quando incidents existirem, somam ao score sem quebrar a interface.

## 013 — update_rule: resolução de behavior sem chute + override por id (Bloco 4.2)
- **Date:** 2026-05-30
- **Context:** Fase 4 fecha com a escrita em linguagem natural: QA afirma/sobrescreve uma rule. Duas operações distintas — criar rule nova num behavior, ou sobrescrever uma rule existente (ex.: promover uma inferência low-confidence a verdade).
- **Decision:** Tool único `update_rule`. Override → via `rule_id` explícito (`overrideRule` fixa confidence 1.0 + qa_override=1 + override_reason). Criação → resolve o behavior por texto livre com `queryBehavior` (mesmo LIKE), mas EXIGE match único: 0 → erro pedindo p/ criar behavior; >1 → devolve a lista e pede refinamento. NUNCA escolhe um behavior ambíguo sozinho (escrita é irreversível-ish; chute errado contamina conhecimento). `reason` é sempre obrigatório → trilha de auditoria (`override_reason`). `behaviors.confirmed_by_qa` NÃO é alterado: confirmar o behavior é um ato separado de definir uma rule (evita efeito colateral surpresa); fica como bloco futuro se fizer sentido.
- **Consequences:** Fase 4 fechada. Nenhuma dep nova, nenhuma mudança de schema. QA passa a alimentar conhecimento "da cabeça" por conversa (decisão 006/STATE). Resolução por LIKE herda a limitação atual (sem semântica) — quando a busca vetorial entrar, `update_rule` melhora de graça. Override por texto (sem id) ficou de fora p/ não reintroduzir ambiguidade na escrita.

## 014 — Modelo de ingestão agente-alimentado + superfície guiada (sem UI) + reordenação por risco
- **Date:** 2026-05-30
- **Context:** Pergunta de produto: como facilitar AO MÁXIMO o usuário adicionar fontes, token-friendly, "fazer o mínimo possível"? Discussão concluiu: qa-memory É um MCP server → o agente já é a interface. Usuário já tem Atlassian/Drive/Slack conectados via claude.ai MCP. Surgiu a tentação de construir uma UI/chat dedicado.
- **Decision:** (1) **Conectores = agente-alimentado, híbrido.** qa-memory NÃO implementa conectores próprios agora; expõe tools de ingestão burras (`add_to_memory`: text|path|url) e o AGENTE usa os MCPs que o usuário já tem p/ buscar conteúdo e alimentar. Conteúdo de path/url-público é lido/fetchado server-side (token-free); fontes com auth o agente busca e passa como texto. Conectores nativos + scheduler = futuro (subagent que cuida da memória sozinho). (2) **Inteligência mora no AGENTE, não em código de conector** — o "memory-keeper" automatizado será uma skill/subagent. (3) **Descoberta resolve-se com SUPERFÍCIE GUIADA (B), não UI:** MCP prompts (`/qa-memory:add`, `:setup`) + estado vazio que ensina + skill de onboarding. (4) **UI dedicada (C) ADIADA** — só se usuário não-técnico virar prioridade (usuário avisa). Público primário = "os dois/indefinido" → B serve ambos e é fundação de C, não desvio. (5) **Auto-init já está pronto** (openDb cria dir + migra no boot) → usuário não roda setup. (6) **Roadmap reordenado por risco→valor:** busca semântica (S.1) ANTES de add_to_memory, porque sem ela adicionar fontes só enche um buscador LIKE burro mais rápido — semântica prova a tese.
- **Consequences:** Zero conector pesado no curto prazo; entrega rápida e token-light. Custo: ingestão de fontes com auth depende do agente (gasta token do chat até o subagent automatizado existir). UI não fecha porta — plugaria nas mesmas tools/prompts. Próximo bloco = S.1 busca semântica (ver ADR 015).
