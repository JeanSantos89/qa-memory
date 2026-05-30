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
