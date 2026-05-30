import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./migrations.js";
import { openDb } from "./index.js";

const TABLES = [
  "behaviors",
  "rules",
  "areas",
  "incidents",
  "sources",
  "embeddings",
];

function tableNames(db: Database.Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => (r as { name: string }).name);
}

describe("migrate", () => {
  it("creates every target table", () => {
    const db = new Database(":memory:");
    migrate(db);
    const names = tableNames(db);
    for (const t of TABLES) expect(names).toContain(t);
  });

  it("records applied migrations", () => {
    const db = new Database(":memory:");
    const applied = migrate(db);
    expect(applied).toBe(MIGRATIONS.length);
    const rows = db.prepare("SELECT version FROM schema_migrations").all();
    expect(rows.length).toBe(MIGRATIONS.length);
  });

  it("is idempotent — second run applies nothing", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(migrate(db)).toBe(0);
  });

  it("enforces foreign keys via openDb", () => {
    const db = openDb(":memory:");
    expect(() =>
      db
        .prepare(
          "INSERT INTO rules (id, behavior_id, rule_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("r1", "missing", "x", "2026-01-01", "2026-01-01"),
    ).toThrow(/FOREIGN KEY/);
  });

  it("applies column defaults on behaviors", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO behaviors (id, name, description, criticality, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("b1", "n", "d", "P1", "2026-01-01", "2026-01-01");
    const row = db
      .prepare("SELECT status, source_ids, confirmed_by_qa FROM behaviors WHERE id=?")
      .get("b1") as { status: string; source_ids: string; confirmed_by_qa: number };
    expect(row.status).toBe("active");
    expect(row.source_ids).toBe("[]");
    expect(row.confirmed_by_qa).toBe(0);
  });
});
