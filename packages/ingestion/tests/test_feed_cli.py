"""Tests for `qa-memory feed` — no-LLM ingest path (item 5).

Uses a fake embedding model (monkeypatched) and a temp-file DB so the test
runs without torch/sentence-transformers or a real API key.
"""

from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from qa_memory.cli import app
from qa_memory.db import connect


class _FakeEmbed:
    name = "fake-embed"

    def encode(self, texts: list[str]) -> list[list[float]]:
        return [[float(len(t)), 0.0, 0.0] for t in texts]


@pytest.fixture()
def tmp_db(tmp_path, monkeypatch):
    db_path = str(tmp_path / "feed_test.db")
    monkeypatch.setenv("QA_MEMORY_DB", db_path)
    return db_path


def _run(payload: dict, tmp_db: str):  # type: ignore[return]
    runner = CliRunner()
    return runner.invoke(app, ["feed"], input=json.dumps(payload))


def test_feed_persists_behavior_rules_embeddings(monkeypatch, tmp_db) -> None:
    monkeypatch.setattr(
        "qa_memory.pipeline.embeddings.LocalEmbeddingModel", _FakeEmbed
    )
    payload = {
        "source": {"type": "jira", "label": "TEST-1", "source_ref": "TEST-1"},
        "behaviors": [
            {
                "name": "User login",
                "description": "User signs in with email and password",
                "criticality": "P1",
                "rules": [
                    {"rule_text": "Email is required", "confidence": 0.7},
                    {"rule_text": "Account locks after 5 failed attempts"},
                ],
            }
        ],
    }
    result = _run(payload, tmp_db)
    assert result.exit_code == 0, result.output
    assert "1 behaviors" in result.output
    assert "2 rules" in result.output
    assert "3 embeddings" in result.output  # 1 behavior + 2 rules

    conn = connect(tmp_db)
    assert conn.execute("SELECT COUNT(*) FROM sources").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM behaviors").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM rules").fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0] == 3


def test_feed_no_source_field(monkeypatch, tmp_db) -> None:
    monkeypatch.setattr(
        "qa_memory.pipeline.embeddings.LocalEmbeddingModel", _FakeEmbed
    )
    payload = {
        "behaviors": [
            {
                "name": "Checkout",
                "description": "User completes purchase",
                "criticality": "P0",
            }
        ]
    }
    result = _run(payload, tmp_db)
    assert result.exit_code == 0, result.output
    assert "1 behaviors" in result.output
    assert "0 rules" in result.output

    conn = connect(tmp_db)
    assert conn.execute("SELECT COUNT(*) FROM sources").fetchone()[0] == 0
    assert conn.execute("SELECT source_ids FROM behaviors").fetchone()[0] == "[]"


def test_feed_invalid_json_exits_nonzero(monkeypatch, tmp_db) -> None:
    runner = CliRunner()
    result = runner.invoke(app, ["feed"], input="not-json{{{")
    assert result.exit_code != 0


def test_feed_empty_behaviors_exits_nonzero(monkeypatch, tmp_db) -> None:
    runner = CliRunner()
    result = runner.invoke(app, ["feed"], input=json.dumps({"behaviors": []}))
    assert result.exit_code != 0
