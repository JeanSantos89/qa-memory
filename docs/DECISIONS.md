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

## 015 — Busca semântica: query embedada via subprocess Python (não dep JS nativa)
- **Date:** 2026-05-30
- **Context:** Os vetores gravados na ingestão (float32 BLOB, 384-dim, all-MiniLM-L6-v2, só behaviors) nunca foram consultados — query_behavior/query_risk usam LIKE. Pra busca semântica é preciso embedar a QUERY em runtime com o MESMO modelo. O MCP é TS; o modelo vive no Python (sentence-transformers).
- **Options considered:** (A) `@huggingface/transformers` no TS — testado: puxa onnxruntime-node + sharp (deps NATIVAS, build scripts bloqueados pelo pnpm, mesmo gate do ADR 008) + footprint pesado (sharp é imagem, irrelevante p/ texto). (B) Subprocess Python que embeda a query reusando o LocalEmbeddingModel já instalado.
- **Decision:** Opção B. Python ganha um comando CLI `embed "<texto>"` que imprime o vetor como JSON (stdout limpo). O TS chama via subprocess (comando configurável por env `QA_MEMORY_EMBED_CMD`, default `uv run`), desserializa o BLOB float32 LE (espelha `pack_vector`/`unpack_vector`), e faz cosseno + ranking **no TS** (a lógica de retrieval mora junto das tools MCP; o Python só roda o modelo). `queryBehavior` vira HÍBRIDO: ranking semântico sobre behaviors que têm embedding + fallback LIKE p/ os que não têm (o seed dogfood, p.ex., não gera embedding — só a ingestão Python gera). `query_risk` herda de graça (chama queryBehavior por dentro). O `Embedder` é injetado (interface) → testes usam fake com vetores auto-consistentes, sem baixar torch/modelo.
- **Consequences:** Zero dep TS nova, vetores garantidamente no mesmo espaço (mesmo modelo+serialização), sem build nativo — honra CLAUDE.md. Custo: cold-start por query (spawn Python + load torch/modelo, ~segundos) e fragilidade de PATH no runtime (uv pode não estar no PATH do host) → comando configurável + fallback LIKE se o subprocess falhar. Otimização futura: helper Python "quente" (processo persistente) ou serviço de embedding. Validação ponta-a-ponta com modelo real fica p/ run manual (testes cobrem ranking com fake).

## 016 — add_to_memory: ingestão de texto via subprocess, texto por stdin (Bloco 5.1)
- **Date:** 2026-05-30
- **Context:** Concretiza o modelo agente-alimentado (ADR 014): a tool MCP que o agente chama p/ "lembrar" qualquer texto que ele já tem em mãos (página buscada por outro MCP, notas coladas, conhecimento manual). O pipeline de extração (LLM two-pass + embeddings) vive no Python e até agora só tinha entrada PDF.
- **Decision:** (1) Python ganha `TextSource` (source genérico, sem parsing/auth, checksum = sha256 do texto trimado, `source_type` default "conversation" mas sobrescrevível p/ taggear origem ex. confluence) + comando CLI `ingest-text` (reusa o MESMO `ingest_doc`). (2) TS expõe a tool `add_to_memory` que faz subprocess pro `ingest-text` (mesmo padrão/ADR 015 do embed — única fonte de verdade da extração no Python, sem duplicar two-pass em TS). (3) Texto vai por STDIN (`-`), não argv → foge de limite de tamanho/escaping. (4) `Ingester` é injetado (interface) → testes sem subprocess/API key. (5) ESCOPO do bloco = só TEXTO; roteamento de file-path (.pdf→PdfSource, .txt/.md→TextSource) e fetch de URL ficam p/ 5.2.
- **Consequences:** "Jogou, lembrou" funciona p/ texto: o agente busca o que quiser com as próprias tools e passa adiante — token-friendly (extração roda fora do chat). Custo: depende do runtime ter o pacote Python + ANTHROPIC_API_KEY; falha é reportada sem throw (tool devolve ok=false + msg). Cold-start por chamada (igual ADR 015). Validação ponta-a-ponta com LLM real = run manual (testes cobrem roteamento com fake ingester).

## 017 — LLM provider plugável: Anthropic | Gemini | Llama local (ollama), seleção por env
- **Date:** 2026-05-30
- **Context:** Validação do path LLM two-pass (ADR 016) ficou pendente por falta de `ANTHROPIC_API_KEY`. Usuário tentou Gemini mas a quota/key não é suficiente → vai rodar **Llama LOCAL** em outra máquina (sem custo de API). `LLMClient` já é Protocol (extractor nunca importa SDK vendor direto), mas a CLI hardcodava `AnthropicClient()` e o model id era fixo. Decisão de produto: providers plugáveis; suportar nuvem (Anthropic/Gemini) E local (Llama) — local é o caminho primário agora.
- **Decision:** (1) `GeminiClient` (wrapper do SDK unified `google-genai`, import lazy) implementando o Protocol `LLMClient`; JSON via `response_mime_type="application/json"`; tokens via `usage_metadata` (prompt_token_count/candidates_token_count). (2) `OllamaClient` p/ Llama local via API nativa `/api/chat` do daemon Ollama, usando **só stdlib `urllib`** (CLAUDE.md: no new dep sem necessidade — Ollama não exige SDK). Sem API key (daemon local). JSON forçado via `format="json"`; tokens via `prompt_eval_count`/`eval_count`. Base URL configurável (`QA_MEMORY_LLM_BASE_URL`, default `http://localhost:11434`). (3) Factory `make_llm_client()` escolhe por env `QA_MEMORY_LLM` = `anthropic` (DEFAULT, honra a spec) | `gemini` | `ollama` (alias `llama`); model override via `QA_MEMORY_LLM_MODEL`; provider desconhecido → ValueError. (4) CLI (`ingest` + `ingest-text`) usa `make_llm_client()` — seleção na borda, extractor agnóstico. (5) Dep nova só `google-genai>=1.0` (Gemini); Ollama = zero dep. Defaults: Gemini `gemini-2.5-flash`, Ollama `llama3.1`.
- **Consequences:** Path LLM rodável **localmente sem custo** (Llama via Ollama) — usuário clona em outra máquina, sobe `ollama serve` + `ollama pull llama3.1`, exporta `QA_MEMORY_LLM=ollama` e o pipeline funciona igual. Nuvem (Anthropic default / Gemini opt-in) continua disponível. Custo: +1 dep (`google-genai`); Ollama assume daemon local no ar (falha de conexão sobe como erro do subprocess → `add_to_memory` reporta ok=false). CLAUDE.md "token strategy" agora por-provider (haiku/flash/llama3.1, o mais barato de cada). A tool MCP `add_to_memory` (TS subprocess) herda de graça via env `QA_MEMORY_LLM` no runtime do subprocess. Validação ao vivo do path LLM = run manual com Ollama na outra máquina (testes cobrem factory + mapeamento de tokens dos 3 clients com fakes, sem rede/key/daemon).
