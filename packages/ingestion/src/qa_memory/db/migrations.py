"""SQLite migrations — mirror of packages/mcp-server (TS).

Schema doc: docs/SCHEMA.md. Any change here → mirror in TS + update SCHEMA.md (same commit).
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    sql: str


_INITIAL_SQL = """
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
"""

MIGRATIONS: list[Migration] = [
    Migration(version=1, name="initial_schema", sql=_INITIAL_SQL),
]


def migrate(conn: sqlite3.Connection) -> int:
    """Apply pending migrations. Returns count applied."""
    conn.execute(
        """CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL
        )"""
    )
    row = conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()
    current = row[0] or 0

    applied = 0
    for m in MIGRATIONS:
        if m.version <= current:
            continue
        now = datetime.now(UTC).isoformat()
        try:
            conn.executescript(m.sql)
            conn.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
                (m.version, m.name, now),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        applied += 1
    return applied
