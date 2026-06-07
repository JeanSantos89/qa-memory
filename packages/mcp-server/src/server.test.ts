import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb } from "./db/index.js";
import { insertBehavior } from "./repo/behaviors.js";
import { insertRule } from "./repo/rules.js";
import { insertIncident } from "./repo/incidents.js";
import type { Embedder } from "./embedder.js";
import type { Ingester, IngestResult } from "./ingester.js";
import type { Assessor, ImpactAnalysis } from "./assessor.js";
import { createServer } from "./server.js";

const noEmbed: Embedder = { embed: () => Promise.resolve(null) };

// Records the last assess call so tests can assert routing.
function spyAssessor(result: ImpactAnalysis): Assessor & { last?: string; lastVector?: number[] | null } {
  const spy: Assessor & { last?: string; lastVector?: number[] | null } = {
    assess(change, vector) {
      spy.last = change;
      spy.lastVector = vector;
      return result;
    },
  };
  return spy;
}

const okAnalysis: ImpactAnalysis = {
  ok: true,
  breaks: [],
  watch: [],
  conflicts: [],
  relatedRules: [],
  tokens: 0,
};

// Records the last ingest call (any source) so tests can assert routing.
type IngestCall =
  | { kind: "text"; text: string; label: string; sourceType: string }
  | { kind: "path"; path: string; label?: string }
  | { kind: "url"; url: string; label?: string }
  | { kind: "jira"; key: string; label?: string }
  | { kind: "confluence"; pageIdOrUrl: string; label?: string };

function spyIngester(result: IngestResult): Ingester & { last?: IngestCall } {
  const spy: Ingester & { last?: IngestCall } = {
    ingestText(text, opts) {
      spy.last = { kind: "text", text, ...opts };
      return result;
    },
    ingestPath(path, opts) {
      spy.last = { kind: "path", path, ...opts };
      return result;
    },
    ingestUrl(url, opts) {
      spy.last = { kind: "url", url, ...opts };
      return result;
    },
    ingestJira(key, opts) {
      spy.last = { kind: "jira", key, ...opts };
      return result;
    },
    ingestConfluence(pageIdOrUrl, opts) {
      spy.last = { kind: "confluence", pageIdOrUrl, ...opts };
      return result;
    },
  };
  return spy;
}

async function connectedClient(
  ingester: Ingester = spyIngester({ ok: true, message: "ok" }),
  assessor: Assessor = spyAssessor(okAnalysis),
) {
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
  const server = createServer(db, noEmbed, ingester, assessor);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// Empty DB — exercises the guided/empty-state surface (Block B).
async function emptyClient() {
  const db = openDb(":memory:");
  const server = createServer(db, noEmbed, spyIngester({ ok: true, message: "ok" }), spyAssessor(okAnalysis));
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

describe("record_incident tool over MCP", () => {
  it("is listed", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("record_incident");
  });

  it("records an incident against the single matching behavior", async () => {
    const client = await connectedClient();
    const res = (await client.callTool({
      name: "record_incident",
      arguments: { behavior: "authenticate", title: "Lockout bypassed via API", severity: "P0", source_ref: "PROJ-123" },
    })) as { content: Array<{ text: string }>; structuredContent?: { ok: boolean; incident_id: string } };
    expect(res.structuredContent?.ok).toBe(true);
    expect(res.structuredContent?.incident_id).toBeTruthy();
    expect(res.content[0]?.text).toContain("Lockout bypassed via API");
  });

  it("refuses when the behavior text matches nothing", async () => {
    const client = await connectedClient();
    const res = (await client.callTool({
      name: "record_incident",
      arguments: { behavior: "zzz-nope", title: "x" },
    })) as { structuredContent?: { ok: boolean } };
    expect(res.structuredContent?.ok).toBe(false);
  });

  it("a recorded incident raises the risk score and shows up in query_risk", async () => {
    const db = openDb(":memory:");
    const bid = insertBehavior(db, {
      name: "Coupon redemption",
      description: "Applies a discount coupon at checkout",
      criticality: "P3",
      confirmed_by_qa: true,
    });
    insertRule(db, { behavior_id: bid, rule_text: "One coupon per order", confidence: 1.0, qa_override: true });
    insertIncident(db, { behavior_id: bid, title: "Double coupon stacking", severity: "P1" });
    const server = createServer(db, noEmbed, spyIngester({ ok: true, message: "ok" }), spyAssessor(okAnalysis));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const res = (await client.callTool({
      name: "query_risk",
      arguments: { query: "coupon" },
    })) as {
      content: Array<{ text: string }>;
      structuredContent?: { reasons: string[]; incidents: Array<{ title: string }> };
    };
    expect(res.content[0]?.text).toContain("broke: Double coupon stacking");
    expect(res.structuredContent?.reasons.some((r) => r.includes("already broke"))).toBe(true);
    expect(res.structuredContent?.incidents[0]?.title).toBe("Double coupon stacking");
  });
});

describe("map_area + query_risk by path", () => {
  it("map_area is listed", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("map_area");
  });

  it("maps a glob to a behavior, then query_risk resolves a matching path via the area", async () => {
    const client = await connectedClient(); // seeds "Login auth" (P0) + a rule
    const mapped = (await client.callTool({
      name: "map_area",
      arguments: { file_pattern: "auth/**/*.ts", behaviors: ["authenticate"] },
    })) as { structuredContent?: { ok: boolean; behavior_ids: string[] } };
    expect(mapped.structuredContent?.ok).toBe(true);

    const res = (await client.callTool({
      name: "query_risk",
      arguments: { query: "auth/login/page.ts" },
    })) as {
      content: Array<{ text: string }>;
      structuredContent?: { level: string; resolvedVia: string };
    };
    expect(res.content[0]?.text).toContain("resolved via mapped area");
    expect(res.content[0]?.text).toContain("Login auth");
    expect(res.structuredContent?.resolvedVia).toBe("area");
    expect(res.structuredContent?.level).toBe("high");
  });

  it("map_area refuses when a behavior text matches nothing", async () => {
    const client = await connectedClient();
    const res = (await client.callTool({
      name: "map_area",
      arguments: { file_pattern: "x/*.ts", behaviors: ["zzz-nope"] },
    })) as { structuredContent?: { ok: boolean } };
    expect(res.structuredContent?.ok).toBe(false);
  });

  it("a path with no mapped area falls back to semantic/text search", async () => {
    const client = await connectedClient();
    const res = (await client.callTool({
      name: "query_risk",
      arguments: { query: "unmapped/path.ts" }, // path-like, no area, no lexical hit
    })) as { structuredContent?: { resolvedVia: string; level: string } };
    expect(res.structuredContent?.resolvedVia).toBe("search");
    expect(res.structuredContent?.level).toBe("unknown");
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
      kind: "text",
      text: "Checkout locks the cart on payment",
      label: "Checkout",
      sourceType: "confluence",
    });
  });

  it("routes a `path` to ingestPath", async () => {
    const spy = spyIngester({ ok: true, message: "ingested spec.pdf: 2 behaviors" });
    const client = await connectedClient(spy);
    const res = (await client.callTool({
      name: "add_to_memory",
      arguments: { path: "/docs/spec.pdf", label: "Spec" },
    })) as { structuredContent?: { ok: boolean } };
    expect(res.structuredContent?.ok).toBe(true);
    expect(spy.last).toEqual({ kind: "path", path: "/docs/spec.pdf", label: "Spec" });
  });

  it("routes a `url` to ingestUrl", async () => {
    const spy = spyIngester({ ok: true, message: "ingested page: 1 behavior" });
    const client = await connectedClient(spy);
    const res = (await client.callTool({
      name: "add_to_memory",
      arguments: { url: "https://example.com/policy" },
    })) as { structuredContent?: { ok: boolean } };
    expect(res.structuredContent?.ok).toBe(true);
    expect(spy.last).toEqual({ kind: "url", url: "https://example.com/policy", label: undefined });
  });

  it("refuses when more than one source is given", async () => {
    const client = await connectedClient();
    const res = (await client.callTool({
      name: "add_to_memory",
      arguments: { text: "x", url: "https://example.com" },
    })) as { content: Array<{ text: string }>; structuredContent?: { ok: boolean } };
    expect(res.structuredContent?.ok).toBe(false);
    expect(res.content[0]?.text).toContain("exactly ONE");
  });

  it("refuses when no source is given", async () => {
    const client = await connectedClient();
    const res = (await client.callTool({
      name: "add_to_memory",
      arguments: {},
    })) as { structuredContent?: { ok: boolean } };
    expect(res.structuredContent?.ok).toBe(false);
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

describe("analyze_impact tool over MCP", () => {
  it("is listed", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("analyze_impact");
  });

  it("routes the change to the assessor and renders breaks/watch/conflicts", async () => {
    const spy = spyAssessor({
      ok: true,
      breaks: ["the no-free-cancel guarantee"],
      watch: ["the 5-minute window edge"],
      conflicts: [{ rule: "no free cancel after accept", why: "directly reversed" }],
      relatedRules: ["no free cancel after accept"],
      tokens: 120,
    });
    const client = await connectedClient(undefined, spy);
    const res = (await client.callTool({
      name: "analyze_impact",
      arguments: { change: "allow free cancel 5 min after accept" },
    })) as {
      content: Array<{ text: string }>;
      structuredContent?: { ok: boolean; conflicts: Array<{ rule: string }>; tokens: number };
    };

    expect(spy.last).toBe("allow free cancel 5 min after accept");
    expect(res.content[0]?.text).toContain("MAY BREAK");
    expect(res.content[0]?.text).toContain("the no-free-cancel guarantee");
    expect(res.content[0]?.text).toContain("no free cancel after accept");
    expect(res.structuredContent?.ok).toBe(true);
    expect(res.structuredContent?.conflicts[0]?.rule).toBe("no free cancel after accept");
    expect(res.structuredContent?.tokens).toBe(120);
  });

  it("forwards the warm embedding vector to the assessor (ADR 026)", async () => {
    const spy = spyAssessor(okAnalysis);
    const vecEmbedder: Embedder = { embed: () => Promise.resolve([0.1, 0.2, 0.3]) };
    const db = openDb(":memory:");
    const server = createServer(db, vecEmbedder, spyIngester({ ok: true, message: "ok" }), spy);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);

    await client.callTool({ name: "analyze_impact", arguments: { change: "x" } });
    expect(spy.lastVector).toEqual([0.1, 0.2, 0.3]);
  });

  it("surfaces analysis failure (e.g. LLM/subprocess error) without throwing", async () => {
    const client = await connectedClient(undefined, spyAssessor({
      ok: false,
      breaks: [],
      watch: [],
      conflicts: [],
      relatedRules: [],
      tokens: 0,
      message: "ollama daemon not reachable",
    }));
    const res = (await client.callTool({
      name: "analyze_impact",
      arguments: { change: "something" },
    })) as { content: Array<{ text: string }>; structuredContent?: { ok: boolean } };
    expect(res.structuredContent?.ok).toBe(false);
    expect(res.content[0]?.text).toContain("Could not analyze");
  });

  it("rejects an empty change", async () => {
    const client = await connectedClient();
    const res = (await client.callTool({
      name: "analyze_impact",
      arguments: { change: "  " },
    })) as { structuredContent?: { ok: boolean } };
    expect(res.structuredContent?.ok).toBe(false);
  });

  it("surfaces the cross-language degrade note when present (Bloco 11)", async () => {
    const spy = spyAssessor({
      ...okAnalysis,
      note: "Cross-language retrieval limited: try a stronger QA_MEMORY_LLM_MODEL.",
    });
    const client = await connectedClient(undefined, spy);
    const res = (await client.callTool({
      name: "analyze_impact",
      arguments: { change: "regras de cancelamento" },
    })) as {
      content: Array<{ text: string }>;
      structuredContent?: { note?: string | null };
    };
    expect(res.content[0]?.text).toContain("Note:");
    expect(res.content[0]?.text).toContain("Cross-language retrieval limited");
    expect(res.structuredContent?.note).toContain("QA_MEMORY_LLM_MODEL");
  });
});

describe("review_memory tool over MCP (curation queue)", () => {
  // DB with a mix: one QA-confirmed rule, one inferred, one under_review.
  async function clientWithPending() {
    const db = openDb(":memory:");
    const bid = insertBehavior(db, {
      name: "Coupon redemption",
      description: "Applies a discount coupon at checkout",
      criticality: "P1",
    });
    insertRule(db, { behavior_id: bid, rule_text: "QA pinned rule", confidence: 1.0, qa_override: true });
    insertRule(db, { behavior_id: bid, rule_text: "One coupon per order", confidence: 0.6 });
    insertRule(db, { behavior_id: bid, rule_text: "Maybe stackable", confidence: 0.3 });
    const server = createServer(db, noEmbed, spyIngester({ ok: true, message: "ok" }), spyAssessor(okAnalysis));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client;
  }

  it("is listed", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("review_memory");
  });

  it("surfaces inferred + under_review rules with ids, flags under_review, excludes QA-confirmed", async () => {
    const client = await clientWithPending();
    const res = (await client.callTool({
      name: "review_memory",
      arguments: {},
    })) as {
      content: Array<{ text: string }>;
      structuredContent?: {
        count: number;
        total: number;
        pending: Array<{ rule: { rule_text: string; id: string }; under_review: boolean }>;
      };
    };
    const text = res.content[0]?.text ?? "";
    expect(text).toContain("awaiting QA confirmation");
    expect(text).toContain("One coupon per order");
    expect(text).toContain("Maybe stackable");
    expect(text).toContain("UNDER REVIEW");
    expect(text).not.toContain("QA pinned rule");
    // weakest first; under_review flagged; both carry an id for update_rule.
    expect(res.structuredContent?.count).toBe(2);
    expect(res.structuredContent?.pending[0]?.rule.rule_text).toBe("Maybe stackable");
    expect(res.structuredContent?.pending[0]?.under_review).toBe(true);
    expect(res.structuredContent?.pending[0]?.rule.id).toBeTruthy();
  });

  it("reports a clean queue when every rule is QA-confirmed", async () => {
    const client = await connectedClient(); // seeds only a qa_override rule
    const res = (await client.callTool({
      name: "review_memory",
      arguments: {},
    })) as { content: Array<{ text: string }>; structuredContent?: { count: number } };
    expect(res.structuredContent?.count).toBe(0);
    expect(res.content[0]?.text).toContain("Nothing awaiting confirmation");
  });

  it("promoting a pending rule via update_rule removes it from the queue", async () => {
    const client = await clientWithPending();
    const before = (await client.callTool({
      name: "review_memory",
      arguments: {},
    })) as { structuredContent?: { pending: Array<{ rule: { id: string; rule_text: string } }> } };
    const target = before.structuredContent?.pending.find((p) => p.rule.rule_text === "One coupon per order");
    expect(target?.rule.id).toBeTruthy();

    await client.callTool({
      name: "update_rule",
      arguments: { rule_id: target!.rule.id, rule_text: "One coupon per order", reason: "QA confirmed" },
    });

    const after = (await client.callTool({
      name: "review_memory",
      arguments: {},
    })) as { structuredContent?: { count: number; pending: Array<{ rule: { rule_text: string } }> } };
    expect(after.structuredContent?.pending.map((p) => p.rule.rule_text)).not.toContain("One coupon per order");
    expect(after.structuredContent?.count).toBe(1); // only the under_review one remains
  });
});

describe("find_duplicate_rules tool over MCP (dedup signal)", () => {
  async function clientWithDuplicates() {
    const db = openDb(":memory:");
    const bid = insertBehavior(db, { name: "Coupon redemption", description: "d", criticality: "P1" });
    insertRule(db, { behavior_id: bid, rule_text: "One coupon per order" });
    insertRule(db, { behavior_id: bid, rule_text: "one coupon, per order!" }); // dup after normalize
    insertRule(db, { behavior_id: bid, rule_text: "Free shipping over 100" }); // unrelated
    const server = createServer(db, noEmbed, spyIngester({ ok: true, message: "ok" }), spyAssessor(okAnalysis));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client;
  }

  it("is listed", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("find_duplicate_rules");
  });

  it("surfaces a duplicate cluster with rule ids", async () => {
    const client = await clientWithDuplicates();
    const res = (await client.callTool({
      name: "find_duplicate_rules",
      arguments: {},
    })) as {
      content: Array<{ text: string }>;
      structuredContent?: { count: number; clusters: Array<Array<{ rule: { rule_text: string; id: string } }>> };
    };
    expect(res.structuredContent?.count).toBe(1);
    expect(res.structuredContent?.clusters[0]).toHaveLength(2);
    expect(res.content[0]?.text).toContain("duplicate cluster");
    expect(res.content[0]?.text).toContain("One coupon per order");
    expect(res.structuredContent?.clusters[0]?.[0]?.rule.id).toBeTruthy();
  });

  it("reports a clean memory when nothing duplicates", async () => {
    const client = await connectedClient(); // single rule
    const res = (await client.callTool({
      name: "find_duplicate_rules",
      arguments: {},
    })) as { content: Array<{ text: string }>; structuredContent?: { count: number } };
    expect(res.structuredContent?.count).toBe(0);
    expect(res.content[0]?.text).toContain("No duplicate rules");
  });
});

describe("retire_rule tool over MCP (supersede, migration 002)", () => {
  async function clientWithDuplicates() {
    const db = openDb(":memory:");
    const bid = insertBehavior(db, { name: "Coupon redemption", description: "d", criticality: "P1" });
    const id1 = insertRule(db, { behavior_id: bid, rule_text: "One coupon per order" });
    insertRule(db, { behavior_id: bid, rule_text: "one coupon, per order!" }); // dup
    const server = createServer(db, noEmbed, spyIngester({ ok: true, message: "ok" }), spyAssessor(okAnalysis));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return { client, id1 };
  }

  it("is listed", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("retire_rule");
  });

  it("retires a rule by id and drops it from dedup", async () => {
    const { client, id1 } = await clientWithDuplicates();
    const res = (await client.callTool({
      name: "retire_rule",
      arguments: { rule_id: id1, reason: "duplicate of canonical" },
    })) as { content: Array<{ text: string }>; structuredContent?: { ok: boolean; rule: { status: string } } };
    expect(res.structuredContent?.ok).toBe(true);
    expect(res.structuredContent?.rule.status).toBe("superseded");

    const dup = (await client.callTool({
      name: "find_duplicate_rules",
      arguments: {},
    })) as { structuredContent?: { count: number } };
    expect(dup.structuredContent?.count).toBe(0); // only one active rule left
  });

  it("refuses an unknown rule id", async () => {
    const client = await connectedClient();
    const res = (await client.callTool({
      name: "retire_rule",
      arguments: { rule_id: "nope", reason: "x" },
    })) as { structuredContent?: { ok: boolean } };
    expect(res.structuredContent?.ok).toBe(false);
  });

  it("requires a reason", async () => {
    const { client, id1 } = await clientWithDuplicates();
    const res = (await client.callTool({
      name: "retire_rule",
      arguments: { rule_id: id1, reason: "  " },
    })) as { structuredContent?: { ok: boolean } };
    expect(res.structuredContent?.ok).toBe(false);
  });
});

describe("find_duplicate_behaviors tool over MCP (behavior dedup)", () => {
  async function clientWithDupBehaviors() {
    const db = openDb(":memory:");
    insertBehavior(db, { name: "Login auth", description: "User authenticates with email and password", criticality: "P1" });
    insertBehavior(db, { name: "Login auth", description: "User authenticates with email and password", criticality: "P1" });
    insertBehavior(db, { name: "Checkout payment", description: "User pays at checkout with credit card", criticality: "P0" });
    const server = createServer(db, noEmbed, spyIngester({ ok: true, message: "ok" }), spyAssessor(okAnalysis));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client;
  }

  it("is listed", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("find_duplicate_behaviors");
  });

  it("surfaces a duplicate cluster with behavior ids", async () => {
    const client = await clientWithDupBehaviors();
    const res = (await client.callTool({
      name: "find_duplicate_behaviors",
      arguments: {},
    })) as {
      content: Array<{ text: string }>;
      structuredContent?: { count: number; clusters: Array<Array<{ behavior: { name: string; id: string } }>> };
    };
    expect(res.structuredContent?.count).toBe(1);
    expect(res.structuredContent?.clusters[0]).toHaveLength(2);
    expect(res.content[0]?.text).toContain("duplicate behavior");
    expect(res.content[0]?.text).toContain("Login auth");
    expect(res.structuredContent?.clusters[0]?.[0]?.behavior.id).toBeTruthy();
  });

  it("reports clean memory when no behavior duplicates exist", async () => {
    const client = await connectedClient();
    const res = (await client.callTool({
      name: "find_duplicate_behaviors",
      arguments: {},
    })) as { content: Array<{ text: string }>; structuredContent?: { count: number } };
    expect(res.structuredContent?.count).toBe(0);
    expect(res.content[0]?.text).toContain("No duplicate behaviors");
  });
});

describe("deprecate_behavior tool over MCP (behavior lifecycle)", () => {
  async function clientWithDupBehaviors() {
    const db = openDb(":memory:");
    const id1 = insertBehavior(db, { name: "Login old", description: "Legacy login flow using username", criticality: "P2" });
    insertBehavior(db, { name: "Login auth", description: "Modern login with email and MFA", criticality: "P1" });
    const server = createServer(db, noEmbed, spyIngester({ ok: true, message: "ok" }), spyAssessor(okAnalysis));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return { client, id1 };
  }

  it("is listed", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("deprecate_behavior");
  });

  it("deprecates behavior by id and removes it from query results", async () => {
    const { client, id1 } = await clientWithDupBehaviors();
    const res = (await client.callTool({
      name: "deprecate_behavior",
      arguments: { behavior_id: id1, reason: "duplicate of Login auth" },
    })) as {
      content: Array<{ text: string }>;
      structuredContent?: { ok: boolean; behavior: { status: string; name: string } };
    };
    expect(res.structuredContent?.ok).toBe(true);
    expect(res.structuredContent?.behavior.status).toBe("deprecated");

    const qb = (await client.callTool({
      name: "query_behavior",
      arguments: { query: "Login old" },
    })) as { structuredContent?: { count: number } };
    expect(qb.structuredContent?.count).toBe(0);
  });

  it("refuses unknown behavior id", async () => {
    const client = await connectedClient();
    const res = (await client.callTool({
      name: "deprecate_behavior",
      arguments: { behavior_id: "no-such", reason: "reason" },
    })) as { structuredContent?: { ok: boolean } };
    expect(res.structuredContent?.ok).toBe(false);
  });

  it("requires a reason", async () => {
    const { client, id1 } = await clientWithDupBehaviors();
    const res = (await client.callTool({
      name: "deprecate_behavior",
      arguments: { behavior_id: id1, reason: "  " },
    })) as { structuredContent?: { ok: boolean } };
    expect(res.structuredContent?.ok).toBe(false);
  });
});

describe("confirm_behavior tool over MCP", () => {
  it("is listed", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("confirm_behavior");
  });

  it("confirms a behavior and removes the uncertainty penalty", async () => {
    const db = openDb(":memory:");
    const bid = insertBehavior(db, {
      name: "Coupon apply",
      description: "Applies a discount at checkout",
      criticality: "P1",
    });
    insertRule(db, { behavior_id: bid, rule_text: "One coupon per order", confidence: 0.9, qa_override: true });
    const server = createServer(db, noEmbed, spyIngester({ ok: true, message: "ok" }), spyAssessor(okAnalysis));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const res = (await client.callTool({
      name: "confirm_behavior",
      arguments: { behavior_id: bid, note: "Verified in sprint 42" },
    })) as { content: Array<{ text: string }>; structuredContent?: { ok: boolean; behavior: { confirmed_by_qa: boolean; qa_note: string } } };
    expect(res.structuredContent?.ok).toBe(true);
    expect(res.structuredContent?.behavior.confirmed_by_qa).toBe(true);
    expect(res.structuredContent?.behavior.qa_note).toBe("Verified in sprint 42");
    expect(res.content[0]?.text).toContain("Coupon apply");
  });

  it("refuses an unknown behavior id", async () => {
    const client = await connectedClient();
    const res = (await client.callTool({
      name: "confirm_behavior",
      arguments: { behavior_id: "no-such-id" },
    })) as { structuredContent?: { ok: boolean } };
    expect(res.structuredContent?.ok).toBe(false);
  });
});

describe("record_incident async embedding (ADR 036)", () => {
  it("record_incident resolves successfully (async path does not throw)", async () => {
    // Verifies that the async embedding path in record_incident doesn't crash.
    // The embedder returns null (no embed infra in tests) — the handler must still
    // resolve OK and return a valid incident_id.
    const client = await connectedClient();
    const res = (await client.callTool({
      name: "record_incident",
      arguments: {
        behavior: "authenticate",
        title: "Login failed for all users",
        severity: "P0",
        source_ref: "incident-999",
      },
    })) as { structuredContent?: { ok: boolean; incident_id: string } };
    expect(res.structuredContent?.ok).toBe(true);
    expect(res.structuredContent?.incident_id).toBeTruthy();
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

describe("ingest_jira tool over MCP", () => {
  it("is listed", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("ingest_jira");
  });

  it("routes to ingestJira with the issue key", async () => {
    const spy = spyIngester({ ok: true, message: "ingested PROJ-42: 2 behaviors" });
    const client = await connectedClient(spy);
    const res = (await client.callTool({
      name: "ingest_jira",
      arguments: { key: "PROJ-42" },
    })) as { content: Array<{ text: string }>; structuredContent?: { ok: boolean } };

    expect(spy.last).toMatchObject({ kind: "jira", key: "PROJ-42" });
    expect(res.content[0]?.text).toContain("PROJ-42");
    expect(res.structuredContent?.ok).toBe(true);
  });

  it("passes optional label to ingestJira", async () => {
    const spy = spyIngester({ ok: true, message: "ok" });
    const client = await connectedClient(spy);
    await client.callTool({ name: "ingest_jira", arguments: { key: "PROJ-1", label: "My issue" } });
    expect(spy.last).toMatchObject({ kind: "jira", key: "PROJ-1", label: "My issue" });
  });

  it("reports failure when ingester returns ok=false", async () => {
    const spy = spyIngester({ ok: false, message: "missing env vars: ATLASSIAN_BASE_URL" });
    const client = await connectedClient(spy);
    const res = (await client.callTool({
      name: "ingest_jira",
      arguments: { key: "PROJ-99" },
    })) as { content: Array<{ text: string }>; structuredContent?: { ok: boolean } };

    expect(res.content[0]?.text).toContain("Could not ingest");
    expect(res.structuredContent?.ok).toBe(false);
  });
});

describe("ingest_confluence tool over MCP", () => {
  it("is listed", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("ingest_confluence");
  });

  it("routes to ingestConfluence with the page ID", async () => {
    const spy = spyIngester({ ok: true, message: "ingested Cancellation policy: 1 behavior" });
    const client = await connectedClient(spy);
    const res = (await client.callTool({
      name: "ingest_confluence",
      arguments: { page: "123456" },
    })) as { content: Array<{ text: string }>; structuredContent?: { ok: boolean } };

    expect(spy.last).toMatchObject({ kind: "confluence", pageIdOrUrl: "123456" });
    expect(res.content[0]?.text).toContain("Ingested Confluence page");
    expect(res.structuredContent?.ok).toBe(true);
  });

  it("accepts a full URL as the page argument", async () => {
    const spy = spyIngester({ ok: true, message: "ok" });
    const client = await connectedClient(spy);
    const url = "https://co.atlassian.net/wiki/spaces/PROJ/pages/789012/Policy";
    await client.callTool({ name: "ingest_confluence", arguments: { page: url } });
    expect(spy.last).toMatchObject({ kind: "confluence", pageIdOrUrl: url });
  });

  it("reports failure when ingester returns ok=false", async () => {
    const spy = spyIngester({ ok: false, message: "fetch failed: 403" });
    const client = await connectedClient(spy);
    const res = (await client.callTool({
      name: "ingest_confluence",
      arguments: { page: "999" },
    })) as { content: Array<{ text: string }>; structuredContent?: { ok: boolean } };

    expect(res.content[0]?.text).toContain("Could not ingest page");
    expect(res.structuredContent?.ok).toBe(false);
  });
});
