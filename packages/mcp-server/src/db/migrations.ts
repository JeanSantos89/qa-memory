// SQLite migrations — source of truth mirrored in packages/ingestion (Python).
// Schema doc: docs/SCHEMA.md. Any change here → mirror in Python + update SCHEMA.md (same commit).
import type { Database } from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const INITIAL_SQL = `
CREATE TABLE behaviors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  criticality TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  source_ids TEXT NOT NULL DEFAULT '[]',
  confirmed_by_qa INTEGER NOT NULL DEFAULT 0,
  qa_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  behavior_id TEXT NOT NULL REFERENCES behaviors(id),
  rule_text TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.7,
  source_excerpt TEXT,
  source_id TEXT,
  qa_override INTEGER NOT NULL DEFAULT 0,
  override_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE areas (
  id TEXT PRIMARY KEY,
  file_pattern TEXT NOT NULL,
  behavior_ids TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  behavior_id TEXT NOT NULL REFERENCES behaviors(id),
  title TEXT NOT NULL,
  description TEXT,
  severity TEXT,
  source_type TEXT,
  source_ref TEXT,
  occurred_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  last_synced TEXT,
  sync_status TEXT,
  sync_error TEXT,
  checksum TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE embeddings (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  content TEXT NOT NULL,
  vector BLOB NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_rules_behavior ON rules(behavior_id);
CREATE INDEX idx_incidents_behavior ON incidents(behavior_id);
CREATE INDEX idx_embeddings_entity ON embeddings(entity_type, entity_id);
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "initial_schema", sql: INITIAL_SQL },
];

// Applies pending migrations inside a transaction each. Returns count applied.
export function migrate(db: Database): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );`);

  const row = db
    .prepare("SELECT MAX(version) AS v FROM schema_migrations")
    .get() as { v: number | null };
  const current = row.v ?? 0;

  let applied = 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      db.exec(m.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(m.version, m.name, now);
    });
    tx();
    applied++;
  }
  return applied;
}
