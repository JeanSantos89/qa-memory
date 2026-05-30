"""Bloco 3.4 — ingest orchestrator + persistence + config.

Fakes for LLM + embedding model → no network, no torch, no API key.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from qa_memory.config import DEFAULT_DB_PATH, resolve_db_path
from qa_memory.db import connect
from qa_memory.pipeline.extractor import SUMMARY_MAX_TOKENS, TwoPassExtractor
from qa_memory.pipeline.ingest import ingest_doc
from qa_memory.pipeline.llm import LLMResponse
from qa_memory.sources.base import ExtractedDoc


class FakeLLM:
    """Pass 1 → relevant summary; pass 2 → one behavior with two rules."""

    def complete(self, system: str, user: str, max_tokens: int) -> LLMResponse:
        if max_tokens == SUMMARY_MAX_TOKENS:
            return LLMResponse('{"summary": "s", "relevant": true}', 10, 5)
        body = (
            '{"behaviors": [{"name": "Login", "description": "User signs in", '
            '"criticality": "P1", "rules": ["email required", "lockout after 5 fails"]}]}'
        )
        return LLMResponse(body, 20, 30)


class FakeEmbed:
    name = "fake-embed"

    def encode(self, texts: list[str]) -> list[list[float]]:
        return [[float(len(t)), 0.1, -0.2] for t in texts]


def _doc(text: str = "Para one.\n\nPara two.", checksum: str = "abc123") -> ExtractedDoc:
    return ExtractedDoc(
        source_type="pdf", label="doc.pdf", source_ref="/tmp/doc.pdf",
        text=text, checksum=checksum,
    )


def _conn() -> sqlite3.Connection:
    return connect(":memory:")


def test_ingest_persists_source_behavior_rules_embedding() -> None:
    conn = _conn()
    extractor = TwoPassExtractor(FakeLLM())
    report = ingest_doc(conn, _doc(), extractor, FakeEmbed())

    assert report.skipped is False
    assert report.behaviors == 1
    assert report.rules == 2
    assert report.embeddings == 1
    assert report.tokens > 0

    assert conn.execute("SELECT COUNT(*) FROM sources").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM behaviors").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM rules").fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0] == 1


def test_behavior_links_source_and_embedding_stored_as_blob() -> None:
    conn = _conn()
    ingest_doc(conn, _doc(), TwoPassExtractor(FakeLLM()), FakeEmbed())

    src_id = conn.execute("SELECT id FROM sources").fetchone()[0]
    source_ids = conn.execute("SELECT source_ids FROM behaviors").fetchone()[0]
    assert src_id in source_ids  # JSON array carries the source id

    et, eid, vec, model = conn.execute(
        "SELECT entity_type, entity_id, vector, model FROM embeddings"
    ).fetchone()
    beh_id = conn.execute("SELECT id FROM behaviors").fetchone()[0]
    assert et == "behavior"
    assert eid == beh_id
    assert isinstance(vec, bytes) and len(vec) == 12  # 3 float32
    assert model == "fake-embed"


def test_same_checksum_is_skipped_no_duplicate_rows() -> None:
    conn = _conn()
    first = ingest_doc(conn, _doc(), TwoPassExtractor(FakeLLM()), FakeEmbed())
    second = ingest_doc(conn, _doc(), TwoPassExtractor(FakeLLM()), FakeEmbed())

    assert second.skipped is True
    assert second.source_id == first.source_id
    assert conn.execute("SELECT COUNT(*) FROM sources").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM behaviors").fetchone()[0] == 1


def test_resolve_db_path_default_and_env_override(tmp_path: Path) -> None:
    default = resolve_db_path({})
    assert default.as_posix().endswith(DEFAULT_DB_PATH)

    custom = tmp_path / "custom.db"
    assert resolve_db_path({"QA_MEMORY_DB": str(custom)}) == custom.resolve()
