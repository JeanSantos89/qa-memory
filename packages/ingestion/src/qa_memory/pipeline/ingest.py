"""Ingest orchestrator — ties the pure pieces into one persisted run.

Flow: checksum guard → chunk → two-pass extract → embed behaviors → persist.
Identical doc (same checksum) → skipped, no LLM calls, no writes.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from qa_memory.db import repo
from qa_memory.pipeline.chunker import chunk_text
from qa_memory.pipeline.embeddings import EmbeddingModel, pack_vector
from qa_memory.pipeline.extractor import TwoPassExtractor
from qa_memory.sources.base import ExtractedDoc


@dataclass(frozen=True)
class IngestReport:
    source_id: str
    skipped: bool
    behaviors: int
    rules: int
    embeddings: int
    tokens: int
    budget_exhausted: bool


def ingest_doc(
    conn: sqlite3.Connection,
    doc: ExtractedDoc,
    extractor: TwoPassExtractor,
    embed_model: EmbeddingModel,
    now: str | None = None,
) -> IngestReport:
    """Run the full pipeline for one doc and persist the results.

    Returns a report (counts + tokens). Skips entirely if the checksum is known.
    """
    existing = repo.find_source_by_checksum(conn, doc.checksum)
    if existing is not None:
        return IngestReport(existing, True, 0, 0, 0, 0, False)

    chunks = chunk_text(doc.text)
    result = extractor.extract(chunks)

    source_id = repo.insert_source(conn, doc, "success", now)

    # Embed name+description per behavior in one batch (encode([]) short-circuits).
    contents = [f"{b.name}\n{b.description}" for b in result.behaviors]
    vectors = embed_model.encode(contents)

    n_rules = 0
    for behavior, content, vector in zip(result.behaviors, contents, vectors, strict=True):
        behavior_id = repo.insert_behavior(conn, behavior, source_id, now)
        for rule_text in behavior.rules:
            repo.insert_rule(conn, behavior_id, rule_text, source_id, now=now)
            n_rules += 1
        repo.insert_embedding(
            conn, "behavior", behavior_id, content, pack_vector(vector), embed_model.name, now
        )

    conn.commit()
    return IngestReport(
        source_id=source_id,
        skipped=False,
        behaviors=len(result.behaviors),
        rules=n_rules,
        embeddings=len(result.behaviors),
        tokens=result.usage.total,
        budget_exhausted=result.budget_exhausted,
    )
