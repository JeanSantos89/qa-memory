"""ADR 021 — impact analysis (assess_change / analyze_impact tool, Python side).

Fakes for LLM + embedding model → no network, no torch, no API key.
"""

from __future__ import annotations

import json
import sqlite3

from qa_memory.db import connect
from qa_memory.pipeline.embeddings import EMBEDDING_DIM, pack_vector
from qa_memory.pipeline.impact import analyze_impact, retrieve_related
from qa_memory.pipeline.llm import LLMResponse


class FakeLLM:
    """Returns a scripted analysis; records the user prompt it saw."""

    def __init__(self, payload: dict[str, object], io: tuple[int, int] = (40, 60)) -> None:
        self._payload = payload
        self._io = io
        self.last_user: str | None = None

    def complete(self, system: str, user: str, max_tokens: int) -> LLMResponse:
        self.last_user = user
        return LLMResponse(json.dumps(self._payload), self._io[0], self._io[1])


class FakeEmbed:
    """384-dim vectors so the semantic retrieval path is exercised.

    Encodes a text to a one-hot-ish vector keyed by a marker char so we can make
    the query align with a specific seeded behavior.
    """

    name = "fake-embed"

    def __init__(self, slot_for: dict[str, int]) -> None:
        self._slot_for = slot_for

    def _vec(self, text: str) -> list[float]:
        v = [0.0] * EMBEDDING_DIM
        for marker, slot in self._slot_for.items():
            if marker in text:
                v[slot] = 1.0
        return v

    def encode(self, texts: list[str]) -> list[list[float]]:
        return [self._vec(t) for t in texts]


def _seed_behavior(
    conn: sqlite3.Connection,
    bid: str,
    name: str,
    desc: str,
    rules: list[tuple[str, float]],
    vector: list[float],
) -> None:
    conn.execute(
        """INSERT INTO behaviors
             (id, name, description, criticality, status, source_ids,
              confirmed_by_qa, created_at, updated_at)
           VALUES (?, ?, ?, 'P1', 'active', '[]', 0, 'now', 'now')""",
        (bid, name, desc),
    )
    for i, (text, conf) in enumerate(rules):
        conn.execute(
            """INSERT INTO rules
                 (id, behavior_id, rule_text, confidence, qa_override, created_at, updated_at)
               VALUES (?, ?, ?, ?, 0, 'now', 'now')""",
            (f"{bid}-r{i}", bid, text, conf),
        )
    conn.execute(
        """INSERT INTO embeddings (id, entity_type, entity_id, content, vector, model, created_at)
           VALUES (?, 'behavior', ?, ?, ?, 'fake-embed', 'now')""",
        (f"{bid}-e", bid, f"{name}\n{desc}", pack_vector(vector)),
    )
    conn.commit()


def _conn() -> sqlite3.Connection:
    return connect(":memory:")


def _vec(slot: int) -> list[float]:
    v = [0.0] * EMBEDDING_DIM
    v[slot] = 1.0
    return v


def test_retrieve_related_semantic_match() -> None:
    conn = _conn()
    _seed_behavior(conn, "b1", "Cancellation", "Order cancellation flow",
                   [("free cancel before accept", 0.9)], _vec(0))
    _seed_behavior(conn, "b2", "Payment", "Charges the card",
                   [("charge on confirm", 0.9)], _vec(5))

    embed = FakeEmbed({"cancel": 0})  # query aligns with b1's vector slot
    related = retrieve_related(conn, "change cancel rules", embed)

    assert [b.behavior_id for b in related] == ["b1"]
    assert related[0].rules == ["free cancel before accept"]


def test_retrieve_hides_under_review_rules() -> None:
    conn = _conn()
    _seed_behavior(conn, "b1", "Cancellation", "Order cancellation flow",
                   [("solid rule", 0.9), ("shaky rule", 0.3)], _vec(0))
    related = retrieve_related(conn, "cancel", FakeEmbed({"cancel": 0}))
    assert related[0].rules == ["solid rule"]  # confidence 0.3 hidden


def test_analyze_impact_parses_and_logs_tokens() -> None:
    conn = _conn()
    _seed_behavior(conn, "b1", "Cancellation", "Order cancellation flow",
                   [("no free cancel after restaurant accepts", 0.9)], _vec(0))
    llm = FakeLLM(
        {
            "breaks": ["existing no-free-cancel guarantee"],
            "watch": ["the 5-minute window edge"],
            "conflicts": [
                {"rule": "no free cancel after restaurant accepts", "why": "directly reversed"}
            ],
        }
    )
    result = analyze_impact(
        conn, "allow free cancel 5 min after accept", llm, FakeEmbed({"cancel": 0})
    )

    assert result.breaks == ["existing no-free-cancel guarantee"]
    assert result.watch == ["the 5-minute window edge"]
    assert len(result.conflicts) == 1
    assert result.conflicts[0].rule == "no free cancel after restaurant accepts"
    assert result.usage.total == 100  # 40 + 60
    # The related rule is fed into the prompt the LLM reasons over.
    assert "no free cancel after restaurant accepts" in (llm.last_user or "")
    assert result.related_rules == ["no free cancel after restaurant accepts"]


def test_retrieve_uses_precomputed_vector_and_skips_model() -> None:
    conn = _conn()
    _seed_behavior(conn, "b1", "Cancellation", "Order cancellation flow",
                   [("free cancel before accept", 0.9)], _vec(0))

    class BoomEmbed:
        """Fails if encode() is ever called — proves the warm vector path."""

        name = "boom"

        def encode(self, texts: list[str]) -> list[list[float]]:
            raise AssertionError("encode() must not be called when a vector is precomputed")

    # Warm vector aligned with b1's slot; embed_model is None entirely.
    related = retrieve_related(conn, "anything", None, precomputed_vector=_vec(0))
    assert [b.behavior_id for b in related] == ["b1"]

    # And with a model present, it is NOT used when a vector is given.
    related2 = retrieve_related(conn, "anything", BoomEmbed(), precomputed_vector=_vec(0))
    assert [b.behavior_id for b in related2] == ["b1"]


def test_analyze_impact_empty_memory_still_runs() -> None:
    conn = _conn()
    llm = FakeLLM({"breaks": [], "watch": ["nothing in memory yet"], "conflicts": []})
    result = analyze_impact(conn, "some change", llm, FakeEmbed({}))
    assert result.related_rules == []
    assert result.watch == ["nothing in memory yet"]
    assert "no related rules yet" in (llm.last_user or "")


def test_analyze_impact_malformed_json_degrades() -> None:
    conn = _conn()

    class JunkLLM:
        def complete(self, system: str, user: str, max_tokens: int) -> LLMResponse:
            return LLMResponse("not json", 1, 1)

    result = analyze_impact(conn, "x", JunkLLM(), FakeEmbed({}))
    assert result.breaks == []
    assert result.watch == []
    assert result.conflicts == []
