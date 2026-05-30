// MCP server wiring. Registers the query_behavior tool over the behaviors repo.
import type { Database } from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { queryBehavior } from "./repo/behaviors.js";
import { VERSION } from "./version.js";

export function createServer(db: Database): McpServer {
  const server = new McpServer({ name: "qa-memory", version: VERSION });

  server.registerTool(
    "query_behavior",
    {
      title: "Query behaviors",
      description:
        "Search product behaviors by free text (matches name + description). Empty query returns all active behaviors.",
      inputSchema: { query: z.string().describe("Free-text search over behavior name + description") },
    },
    (args: { query: string }) => {
      const results = queryBehavior(db, args.query);
      const text =
        results.length === 0
          ? `No behaviors match "${args.query}".`
          : results
              .map((b) => `${b.criticality} ${b.name}${b.confirmed_by_qa ? " ✓" : ""}\n  ${b.description}`)
              .join("\n\n");

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { count: results.length, behaviors: results },
      };
    },
  );

  return server;
}
