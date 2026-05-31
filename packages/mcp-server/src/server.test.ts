import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb } from "./db/index.js";
import { insertBehavior } from "./repo/behaviors.js";
import { insertRule } from "./repo/rules.js";
import type { Embedder } from "./embedder.js";
import type { Ingester, IngestResult } from "./ingester.js";
import { createServer } from "./server.js";

const noEmbed: Embedder = { embed: () => Promise.resolve(null) };

// Records the last ingestText call so tests can assert routing.
function spyIngester(result: IngestResult): Ingester & { last?: { text: string; label: string; sourceType: string } } {
  const spy: Ingester & { last?: { text: string; label: string; sourceType: string } } = {
    ingestText(text, opts) {
      spy.last = { text, ...opts };
      return result;
    },
  };
  return spy;
}

async function connectedClient(ingester: Ingester = spyIngester({ ok: true, message: "ok" })) {
  const db = openDb(":memory:");
  const bid = insertBehavior(db, {
    name: "Login auth",
    description: "User authenticates with email and password",
    criticality: "P0",
    confirmed_by_qa: true,
  });
  insertRule(db, {
    behavior_id: bid,
    rule_text: "Lockout after 5 failed attempts",
    confidence: 1.0,
    qa_override: true,
  });
  const server = createServer(db, noEmbed, ingester);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// Empty DB — exercises the guided/empty-state surface (Block B).
async function emptyClient() {
  const db = openDb(":memory:");
  const server = createServer(db, noEmbed, spyIngester({ ok: true, message: "ok" }));
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

describe("query_risk tool over MCP", () => {
  it("is listed", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("query_risk");
  });

  it("scores a matched P0 area HIGH and surfaces its rule + reasons", async () => {
    const client = await connectedClient();
    const res = (await client.callTool({
      name: "query_risk",
      arguments: { query: "authenticate" },
    })) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: { level: string; score: number; reasons: string[] };
    };
    expect(res.content[0]?.text).toContain("Risk: HIGH");
    expect(res.content[0]?.text).toContain("Lockout after 5 failed attempts");
    expect(res.structuredContent?.level).toBe("high");
  });

  it("reports unknown risk when no behavior matches", async () => {
    const client = await connectedClient();
    const res = (await client.callTool({
      name: "query_risk",
      arguments: { query: "zzz-nope" },
    })) as { structuredContent?: { level: string } };
    expect(res.structuredContent?.level).toBe("unknown");
  });
});

describe("update_rule tool over MCP", () => {
  it("attaches a QA rule to the single matching behavior", async () => {
    const client = await connectedClient();
    const res = (await client.callTool({
      name: "update_rule",
      arguments: {
        behavior: "authenticate",
        rule_text: "Sessions expire after 30 min idle",
        reason: "Security policy",
      },
    })) as { structuredContent?: { ok: boolean; action: string; rule: { qa_override: boolean; confidence: number } } };
    expect(res.structuredContent?.ok).toBe(true);
    expect(res.structuredContent?.action).toBe("create");
    expect(res.structuredContent?.rule.qa_override).toBe(true);
    expect(res.structuredContent?.rule.confidence).toBe(1.0);
  });

  it("refuses when the behavior text matches nothing", async () => {
    const client = await connectedClient();
    const res = (await client.callTool({
      name: "update_rule",
      arguments: { behavior: "zzz-nope", rule_text: "x", reason: "y" },
    })) as { structuredContent?: { ok: boolean } };
    expect(res.structuredContent?.ok).toBe(false);
  });
});

describe("add_to_memory tool over MCP", () => {
  it("routes text + label + source_type to the ingester and reports success", async () => {
    const spy = spyIngester({ ok: true, message: "ingested checkout: 3 behaviors" });
    const client = await connectedClient(spy);
    const res = (await client.callTool({
      name: "add_to_memory",
      arguments: { text: "Checkout locks the cart on payment", label: "Checkout", source_type: "confluence" },
    })) as { content: Array<{ text: string }>; structuredContent?: { ok: boolean } };

    expect(res.structuredContent?.ok).toBe(true);
    expect(res.content[0]?.text).toContain("3 behaviors");
    expect(spy.last).toEqual({
      text: "Checkout locks the cart on payment",
      label: "Checkout",
      sourceType: "confluence",
    });
  });

  it("surfaces ingestion failure (e.g. missing API key) without throwing", async () => {
    const client = await connectedClient(spyIngester({ ok: false, message: "ANTHROPIC_API_KEY not set" }));
    const res = (await client.callTool({
      name: "add_to_memory",
      arguments: { text: "something" },
    })) as { content: Array<{ text: string }>; structuredContent?: { ok: boolean } };
    expect(res.structuredContent?.ok).toBe(false);
    expect(res.content[0]?.text).toContain("Could not ingest");
  });
});

describe("guided surface (Block B)", () => {
  it("lists the getting_started and assess_change prompts", async () => {
    const client = await connectedClient();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(
      expect.arrayContaining(["getting_started", "assess_change"]),
    );
  });

  it("getting_started teaches the feed-then-query flow on an empty DB", async () => {
    const client = await emptyClient();
    const res = await client.getPrompt({ name: "getting_started" });
    const text = res.messages[0]?.content as { type: string; text: string };
    expect(text.text).toContain("qa-memory is empty");
    expect(text.text).toContain("add_to_memory");
  });

  it("assess_change walks through query_risk for the given area", async () => {
    const client = await connectedClient();
    const res = await client.getPrompt({ name: "assess_change", arguments: { area: "checkout" } });
    const text = res.messages[0]?.content as { type: string; text: string };
    expect(text.text).toContain("checkout");
    expect(text.text).toContain("query_risk");
  });

  it("query_behavior teaches instead of just 'no match' when the DB is empty", async () => {
    const client = await emptyClient();
    const res = (await client.callTool({
      name: "query_behavior",
      arguments: { query: "anything" },
    })) as { content: Array<{ text: string }> };
    expect(res.content[0]?.text).toContain("qa-memory is empty");
    expect(res.content[0]?.text).not.toContain("No behaviors match");
  });

  it("query_risk surfaces the empty-state hint when nothing is remembered", async () => {
    const client = await emptyClient();
    const res = (await client.callTool({
      name: "query_risk",
      arguments: { query: "anything" },
    })) as { content: Array<{ text: string }> };
    expect(res.content[0]?.text).toContain("qa-memory is empty");
  });
});
