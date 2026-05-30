import sqlite3

import pytest

from qa_memory.db import connect
from qa_memory.db.migrations import MIGRATIONS, migrate

TABLES = ["behaviors", "rules", "areas", "incidents", "sources", "embeddings"]


def _table_names(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    return [r[0] for r in rows]


def test_creates_every_target_table() -> None:
    conn = sqlite3.connect(":memory:")
    migrate(conn)
    names = _table_names(conn)
    for t in TABLES:
        assert t in names


def test_records_applied_migrations() -> None:
    conn = sqlite3.connect(":memory:")
    applied = migrate(conn)
    assert applied == len(MIGRATIONS)
    rows = conn.execute("SELECT version FROM schema_migrations").fetchall()
    assert len(rows) == len(MIGRATIONS)


def test_idempotent() -> None:
    conn = sqlite3.connect(":memory:")
    migrate(conn)
    assert migrate(conn) == 0


def test_enforces_foreign_keys() -> None:
    conn = connect(":memory:")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO rules (id, behavior_id, rule_text, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?)",
            ("r1", "missing", "x", "2026-01-01", "2026-01-01"),
        )


def test_behavior_defaults() -> None:
    conn = connect(":memory:")
    conn.execute(
        "INSERT INTO behaviors (id, name, description, criticality, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        ("b1", "n", "d", "P1", "2026-01-01", "2026-01-01"),
    )
    row = conn.execute(
        "SELECT status, source_ids, confirmed_by_qa FROM behaviors WHERE id=?", ("b1",)
    ).fetchone()
    assert row == ("active", "[]", 0)
