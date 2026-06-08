import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./db/index.js";
import { insertBehavior } from "./repo/behaviors.js";
import { insertRule } from "./repo/rules.js";
import type { Embedder } from "./embedder.js";
import type { Translator } from "./translator.js";
import { searchBehaviors } from "./search.js";

function pack(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

// Insert a behavior + its embedding directly (no Python pipeline in tests).
function seedWithVector(db: ReturnType<typeof openDb>, name: string, vec: number[]): string {
  const id = insertBehavior(db, { name, description: name, criticality: "P1" });
  db.prepare(
    `INSERT INTO embeddings (id, entity_type, entity_id, content, vector, model, created_at)
     VALUES (?, 'behavior', ?, ?, ?, 'fake', '2026-01-01')`,
  ).run(`e-${id}`, id, name, pack(vec));
  return id;
}

// Fake embedder returns a fixed query vector → ranking is deterministic.
const fixed = (vec: number[]): Embedder => ({ embed: () => Promise.resolve(vec) });
const broken: Embedder = { embed: () => Promise.resolve(null) };

describe("searchBehaviors (hybrid)", () => {
  it("ranks by cosine: query vector closest to checkout wins", async () => {
    const db = openDb(":memory:");
    seedWithVector(db, "Checkout", [1, 0, 0]);
    seedWithVector(db, "Reporting", [0, 1, 0]);
    const results = await searchBehaviors(db, fixed([0.9, 0.1, 0]), "anything");
    expect(results[0]?.name).toBe("Checkout");
  });

  it("filters out unrelated behaviors below the semantic floor", async () => {
    const db = openDb(":memory:");
    seedWithVector(db, "Checkout", [1, 0, 0]);
    seedWithVector(db, "Reporting", [0, 1, 0]);
    const results = await searchBehaviors(db, fixed([1, 0, 0]), "zzz-no-lexical-match");
    expect(results.map((b) => b.name)).toEqual(["Checkout"]);
  });

  it("falls back to LIKE when there are no embeddings", async () => {
    const db = openDb(":memory:");
    insertBehavior(db, { name: "Password reset", description: "reset via email", criticality: "P1" });
    const results = await searchBehaviors(db, fixed([1, 0, 0]), "reset");
    expect(results.map((b) => b.name)).toEqual(["Password reset"]);
  });

  it("falls back to LIKE when the embedder is unavailable", async () => {
    const db = openDb(":memory:");
    seedWithVector(db, "Checkout flow", [1, 0, 0]);
    const results = await searchBehaviors(db, broken, "checkout");
    expect(results.map((b) => b.name)).toEqual(["Checkout flow"]);
  });
});

describe("searchBehaviors — rule-level semantic hits", () => {
  // Seeds a behavior WITHOUT a behavior embedding, but WITH a rule embedding.
  // The behavior should still surface when the query vector matches the rule.
  function seedBehaviorWithRuleVector(
    db: ReturnType<typeof openDb>,
    behaviorName: string,
    ruleText: string,
    ruleVec: number[],
  ): string {
    const bid = insertBehavior(db, { name: behaviorName, description: behaviorName, criticality: "P1" });
    const rid = insertRule(db, { behavior_id: bid, rule_text: ruleText, confidence: 1.0, qa_override: true });
    db.prepare(
      `INSERT INTO embeddings (id, entity_type, entity_id, content, vector, model, created_at)
       VALUES (?, 'rule', ?, ?, ?, 'fake', '2026-01-01')`,
    ).run(`e-${rid}`, rid, ruleText, pack(ruleVec));
    return bid;
  }

  it("surfaces behavior via rule embedding when behavior has no embedding", async () => {
    const db = openDb(":memory:");
    // Behavior name doesn't match query; rule does (via vector)
    const bid = seedBehaviorWithRuleVector(db, "Cancelamento", "cancelamento gratis apos aceite", [1, 0, 0]);
    // Another behavior with behavior-level embedding but unrelated direction
    seedWithVector(db, "Exportacao", [0, 1, 0]);

    const results = await searchBehaviors(db, fixed([0.95, 0.05, 0]), "zzz-no-lexical");
    expect(results.some((b) => b.id === bid)).toBe(true);
  });

  it("behavior-level hits rank before rule-level hits", async () => {
    const db = openDb(":memory:");
    seedWithVector(db, "Auth", [1, 0, 0]); // behavior-level hit
    seedBehaviorWithRuleVector(db, "Pagamento", "regra de pagamento", [0.9, 0.1, 0]); // rule-level hit

    const results = await searchBehaviors(db, fixed([1, 0, 0]), "zzz");
    expect(results[0]?.name).toBe("Auth");
  });
});

describe("QA_MEMORY_SEMANTIC_FLOOR env override", () => {
  afterEach(() => { delete process.env.QA_MEMORY_SEMANTIC_FLOOR; });

  it("higher floor filters out low-cosine results", async () => {
    const db = openDb(":memory:");
    seedWithVector(db, "Checkout", [1, 0, 0]);
    // cosine([0.3,0.95,0],[1,0,0]) ≈ 0.30 — passes default floor 0.25, blocked by 0.5
    process.env.QA_MEMORY_SEMANTIC_FLOOR = "0.5";
    const results = await searchBehaviors(db, fixed([0.3, 0.95, 0]), "zzz-no-lexical-match");
    expect(results).toHaveLength(0);
  });

  it("invalid env value falls back to default 0.25", async () => {
    const db = openDb(":memory:");
    seedWithVector(db, "Checkout", [1, 0, 0]);
    process.env.QA_MEMORY_SEMANTIC_FLOOR = "not-a-number";
    const results = await searchBehaviors(db, fixed([0.9, 0.1, 0]), "zzz-no-lexical-match");
    expect(results.map((b) => b.name)).toEqual(["Checkout"]);
  });
});

describe("searchBehaviors — cross-language translator fallback", () => {
  function fakeTranslator(translation: string | null): Translator {
    return { translate: () => ({ translation, note: null }) };
  }

  it("retries with translated query when original returns 0 results", async () => {
    const db = openDb(":memory:");
    // DB has EN behavior; query is PT
    seedWithVector(db, "Order cancellation", [1, 0, 0]);
    // PT query → no LIKE match, vector for "cancelamento" points same way
    // Fake translator converts "cancelamento" → "cancellation"
    const embedder: Embedder = {
      embed: (text) =>
        // EN query → [1,0,0]; PT query → [0,0,1] (no cosine match)
        Promise.resolve(text === "cancellation" ? [1, 0, 0] : [0, 0, 1]),
    };
    const results = await searchBehaviors(db, embedder, "cancelamento", 10, fakeTranslator("cancellation"));
    expect(results.map((b) => b.name)).toContain("Order cancellation");
  });

  it("does not retry when original query already returns results", async () => {
    const db = openDb(":memory:");
    seedWithVector(db, "Checkout", [1, 0, 0]);
    let translated = false;
    const translator: Translator = {
      translate: () => { translated = true; return { translation: "checkout", note: null }; },
    };
    await searchBehaviors(db, fixed([1, 0, 0]), "checkout", 10, translator);
    expect(translated).toBe(false);
  });

  it("does not retry when translator returns null translation", async () => {
    const db = openDb(":memory:");
    insertBehavior(db, { name: "Login", description: "login flow", criticality: "P1" });
    // no embeddings → LIKE path; query "xyz" returns nothing
    const results = await searchBehaviors(db, fixed([1, 0, 0]), "xyz", 10, fakeTranslator(null));
    expect(results).toHaveLength(0);
  });
});
