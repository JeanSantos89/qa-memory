"""DB layer: connection helper + migrations (mirror of TS package)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from qa_memory.db.migrations import MIGRATIONS, Migration, migrate

__all__ = ["MIGRATIONS", "Migration", "connect", "migrate"]


def connect(path: str | Path) -> sqlite3.Connection:
    """Open DB with foreign keys ON (+ WAL for file-backed); run pending migrations.

    Pass ":memory:" for an ephemeral DB (tests). For a file path, the parent dir
    is created if missing (mirrors the TS openDb — else a fresh clone with no
    `.qa-memory/` fails with "unable to open database file").
    """
    if str(path) != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA foreign_keys = ON")
    if str(path) != ":memory:":
        conn.execute("PRAGMA journal_mode = WAL")
    migrate(conn)
    return conn
