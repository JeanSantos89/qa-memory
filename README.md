# qa-memory

MCP server que funciona como camada de conhecimento semântico de produto para times de QA e engenheiros que usam ferramentas agênticas. Armazena e serve o entendimento de produto (regras de negócio, fluxos críticos, histórico de incidentes) de forma persistente e consultável por agentes de código.

## Setup (Dia 0)

Pré-requisitos: Node ≥ 20, [pnpm](https://pnpm.io), [uv](https://docs.astral.sh/uv/). Opcional: [Ollama](https://ollama.com) para o path LLM local.

```powershell
git clone <repo> && cd qa-memory
pwsh -File scripts/install.ps1     # Windows
./scripts/install.sh               # macOS/Linux
```

O script instala deps dos dois pacotes, builda o MCP server, inicializa a instância em `.qa-memory/` e imprime o snippet de config MCP pra colar no Claude Code. Flags: `-Check`/`--check` (só checa prereqs), `-NoSeed`/`--no-seed` (pula dados dogfood).

Provider de extração via env `QA_MEMORY_LLM` = `anthropic` (default) | `gemini` | `ollama` (Llama local). Inspecione a instância: `node packages/mcp-server/dist/cli.js status`.
