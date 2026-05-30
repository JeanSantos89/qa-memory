// qa-memory MCP server entry point. Opens the DB, wires stdio transport.
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveDbPath } from "./config.js";
import { openDb } from "./db/index.js";
import { createServer } from "./server.js";

export { VERSION } from "./version.js";

async function main(): Promise<void> {
  const db = openDb(resolveDbPath());
  const server = createServer(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run only when invoked directly (not on import).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // stdout is the MCP channel → diagnostics go to stderr.
    process.stderr.write(`qa-memory MCP failed to start: ${String(err)}\n`);
    process.exit(1);
  });
}
