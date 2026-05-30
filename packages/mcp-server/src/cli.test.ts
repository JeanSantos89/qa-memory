import { describe, it, expect, beforeEach } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "./db/index.js";
import { runCommand } from "./cli.js";
import { seedDb } from "./seed.js";

describe("CLI runCommand", () => {
  let db: Database;
  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("status reports db path and zeroed counts", () => {
    const out = runCommand(db, "/tmp/x.db", ["status"]);
    expect(out).toContain("db: /tmp/x.db");
    expect(out).toContain("behaviors: 0");
  });

  it("list behaviors is empty before seeding, populated after", () => {
    expect(runCommand(db, ":memory:", ["list", "behaviors"])).toContain("No behaviors yet");
    seedDb(db);
    const out = runCommand(db, ":memory:", ["list", "behaviors"]);
    expect(out).toContain("Sensitive data never reaches git");
  });

  it("seed is a no-op the second time", () => {
    expect(runCommand(db, ":memory:", ["seed"])).toMatch(/Seeded \d+ behaviors/);
    expect(runCommand(db, ":memory:", ["seed"])).toContain("nothing seeded");
  });

  it("unknown command prints usage", () => {
    expect(runCommand(db, ":memory:", ["bogus"])).toContain("Usage: qa-memory");
  });
});
