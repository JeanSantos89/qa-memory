"""Persistence layer (Python side, mirrors mcp-server repo intent).

Writes ingested docs into SQLite: sources, behaviors, rules, embeddings.
Checksum guard lives here (find_source_by_checksum) so the orchestrator can
skip reprocessing identical docs.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import UTC, datetime

from qa_memory.pipeline.extractor import ExtractedBehavior
from qa_memory.sources.base import ExtractedDoc


def _now() -> str:
    return datetime.now(UTC).isoformat()


def find_source_by_checksum(conn: sqlite3.Connection, checksum: str) -> str | None:
    """Return the source id for an already-ingested checksum, else None."""
    row = conn.execute(
        "SELECT id FROM sources WHERE checksum = ? LIMIT 1", (checksum,)
    ).fetchone()
    return str(row[0]) if row else None


def insert_source(
    conn: sqlite3.Connection,
    doc: ExtractedDoc,
    sync_status: str = "success",
    now: str | None = None,
) -> str:
    """Insert a source row, return its id."""
    now = now or _now()
    source_id = str(uuid.uuid4())
    conn.execute(
        """INSERT INTO sources
             (id, type, label, source_ref, last_synced, sync_status, sync_error,
              checksum, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            source_id,
            doc.source_type,
            doc.label,
            doc.source_ref,
            now,
            sync_status,
            None,
            doc.checksum,
            now,
            now,
        ),
    )
    return source_id


def insert_behavior(
    conn: sqlite3.Connection,
    behavior: ExtractedBehavior,
    source_id: str,
    now: str | None = None,
) -> str:
    """Insert an extracted behavior (inferred → confirmed_by_qa=0), return its id."""
    now = now or _now()
    behavior_id = str(uuid.uuid4())
    conn.execute(
        """INSERT INTO behaviors
             (id, name, description, criticality, status, source_ids,
              confirmed_by_qa, qa_note, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, 0, NULL, ?, ?)""",
        (
            behavior_id,
            behavior.name,
            behavior.description,
            behavior.criticality,
            json.dumps([source_id]),
            now,
            now,
        ),
    )
    return behavior_id


# PDF/doc via LLM → mid of the 0.5–0.8 band (docs/SCHEMA.md confidence model).
PDF_RULE_CONFIDENCE = 0.6


def insert_rule(
    conn: sqlite3.Connection,
    behavior_id: str,
    rule_text: str,
    source_id: str,
    confidence: float = PDF_RULE_CONFIDENCE,
    now: str | None = None,
) -> str:
    """Insert a rule for a behavior, return its id."""
    now = now or _now()
    rule_id = str(uuid.uuid4())
    conn.execute(
        """INSERT INTO rules
             (id, behavior_id, rule_text, confidence, source_excerpt, source_id,
              qa_override, override_reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?, 0, NULL, ?, ?)""",
        (rule_id, behavior_id, rule_text, confidence, source_id, now, now),
    )
    return rule_id


def insert_embedding(
    conn: sqlite3.Connection,
    entity_type: str,
    entity_id: str,
    content: str,
    vector: bytes,
    model: str,
    now: str | None = None,
) -> str:
    """Insert an embedding row (vector already serialized to a BLOB), return its id."""
    now = now or _now()
    embedding_id = str(uuid.uuid4())
    conn.execute(
        """INSERT INTO embeddings
             (id, entity_type, entity_id, content, vector, model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (embedding_id, entity_type, entity_id, content, vector, model, now),
    )
    return embedding_id
