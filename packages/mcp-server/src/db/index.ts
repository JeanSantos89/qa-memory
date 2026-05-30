// DB open helper. Enables foreign keys + WAL; runs pending migrations.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "./migrations.js";

export type { Migration } from "./migrations.js";
export { migrate, MIGRATIONS } from "./migrations.js";

// path ":memory:" → ephemeral DB (tests). Otherwise file path (parent dir created).
export function openDb(path: string): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  if (path !== ":memory:") db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}
