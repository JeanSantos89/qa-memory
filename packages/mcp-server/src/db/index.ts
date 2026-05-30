// DB open helper. Enables foreign keys + WAL; runs pending migrations.
import Database from "better-sqlite3";
import { migrate } from "./migrations.js";

export type { Migration } from "./migrations.js";
export { migrate, MIGRATIONS } from "./migrations.js";

// path ":memory:" → ephemeral DB (tests). Otherwise file path.
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  if (path !== ":memory:") db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}
