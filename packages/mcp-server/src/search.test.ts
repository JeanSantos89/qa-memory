import { describe, expect, it } from "vitest";
import { openDb } from "./db/index.js";
import { insertBehavior } from "./repo/behaviors.js";
import type { Embedder } from "./embedder.js";
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
