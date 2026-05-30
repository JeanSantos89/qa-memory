import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb } from "./db/index.js";
import { insertBehavior } from "./repo/behaviors.js";
import { createServer } from "./server.js";

async function connectedClient() {
  const db = openDb(":memory:");
  insertBehavior(db, {
    name: "Login auth",
    description: "User authenticates with email and password",
    criticality: "P0",
    confirmed_by_qa: true,
  });
  const server = createServer(db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("query_behavior tool over MCP", () => {
  it("is listed", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("query_behavior");
  });

  it("returns matching behaviors as text + structured content", async () => {
    const client = await connectedClient();
    const res = (await client.callTool({
      name: "query_behavior",
      arguments: { query: "authenticate" },
    })) as { content: Array<{ type: string; text: string }>; structuredContent?: { count: number } };

    expect(res.content[0]?.text).toContain("Login auth");
    expect(res.structuredContent?.count).toBe(1);
  });

  it("reports no match for an unknown query", async () => {
    const client = await connectedClient();
    const res = (await client.callTool({
      name: "query_behavior",
      arguments: { query: "zzz-nope" },
    })) as { content: Array<{ type: string; text: string }> };
    expect(res.content[0]?.text).toContain("No behaviors match");
  });
});
