import { describe, it, expect, beforeEach } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "./db/index.js";
import { seedDb } from "./seed.js";
import { countBehaviors, queryBehavior } from "./repo/behaviors.js";

describe("seedDb", () => {
  let db: Database;
  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("inserts dogfood behaviors and is a no-op when populated", () => {
    const n = seedDb(db);
    expect(n).toBeGreaterThan(0);
    expect(countBehaviors(db)).toBe(n);
    expect(seedDb(db)).toBe(0);
  });

  it("seeded behaviors are queryable", () => {
    seedDb(db);
    expect(queryBehavior(db, "Sensitive data").length).toBe(1);
  });
});
