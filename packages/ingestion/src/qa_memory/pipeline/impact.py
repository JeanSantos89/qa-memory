"""Impact analysis — the leap from searchable memory to a QA impact copilot.

Given a PROPOSED change in free text, this:
  1. retrieves the rules already in memory that relate to it (semantic over
     behavior embeddings + LIKE backfill — same hybrid intent as search.ts),
  2. asks the LLM to reason about that change AGAINST those rules,
  3. returns structured analysis: what may break, what to watch when testing,
     and which EXISTING rules the change conflicts with / affects.

query_risk only does retrieval + a derived score; it never reasons about
conflict. This module fills that gap. The LLM lives in Python (single source of
extraction/analysis truth, like the extractor), so analysis lives here too.

Every LLM call logs tokens (CLAUDE.md). Prompt is caveman-terse.
"""

from __future__ import annotations

import sqlite3
from array import array
from dataclasses import dataclass, field

from qa_memory.pipeline.embeddings import EMBEDDING_DIM, EmbeddingModel
from qa_memory.pipeline.extractor import TokenUsage, _parse_json
from qa_memory.pipeline.llm import LLMClient

# Mirror search.ts: below this cosine a behavior is treated as unrelated.
SEMANTIC_FLOOR = 0.25
RETRIEVAL_LIMIT = 10
ANALYSIS_MAX_TOKENS = 1024

_ANALYSIS_SYSTEM = (
    "QA impact analyst. Given a PROPOSED change and the EXISTING product rules "
    "in memory, reason about impact. Output JSON only: "
    '{"breaks": [str], "watch": [str], '
    '"conflicts": [{"rule": str, "why": str}]}. '
    "breaks = what may break. watch = what to pay attention to when testing. "
    "conflicts = existing rules the change contradicts/affects (rule = the rule "
    "text, why = how it conflicts). "
    "RULES: "
    "(1) If the change has MULTIPLE parts (e.g. joined by 'and'), analyze EVERY "
    "part separately — never drop one. "
    "(2) watch must NOT be empty for a real change: always name concrete test "
    "angles (edge cases, data/state, money/fraud, regressions). "
    "(3) Only list a conflict when the change genuinely contradicts or alters "
    "that rule — do not pad with weak/speculative links. "
    "(4) Quote the conflicting rule's actual text in `rule`, not a paraphrase. "
    "Empty lists ONLY when truly nothing applies. "
    "Reply in the language of the proposed change."
)


@dataclass(frozen=True)
class Conflict:
    rule: str
    why: str


@dataclass
class ImpactAnalysis:
    breaks: list[str] = field(default_factory=list)
    watch: list[str] = field(default_factory=list)
    conflicts: list[Conflict] = field(default_factory=list)
    related_rules: list[str] = field(default_factory=list)
    usage: TokenUsage = field(default_factory=TokenUsage)


@dataclass(frozen=True)
class _RelatedBehavior:
    behavior_id: str
    name: str
    description: str
    rules: list[str]


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return float(dot / (na * nb))


def _unpack(blob: bytes) -> list[float]:
    arr = array("f")
    arr.frombytes(blob)
    return [float(x) for x in arr]


def _rules_for(conn: sqlite3.Connection, behavior_id: str) -> list[str]:
    # Hide under_review rules (confidence < 0.5) — same contract as the MCP repo.
    rows = conn.execute(
        "SELECT rule_text FROM rules WHERE behavior_id = ? AND confidence >= 0.5",
        (behavior_id,),
    ).fetchall()
    return [str(r[0]) for r in rows]


def retrieve_related(
    conn: sqlite3.Connection,
    change: str,
    embed_model: EmbeddingModel | None,
    limit: int = RETRIEVAL_LIMIT,
    precomputed_vector: list[float] | None = None,
) -> list[_RelatedBehavior]:
    """Find behaviors related to the proposed change: semantic over behavior
    embeddings (cosine >= floor), backfilled with LIKE matches. Mirrors
    search.ts so analysis sees the same candidates the query tools would.

    If `precomputed_vector` is given (the MCP server embeds the change with its
    WARM embedder, ADR 020/026), the cold model load here is skipped entirely —
    `embed_model` may then be None. Otherwise the change is embedded locally.
    """
    q = change.strip()
    if not q:
        return []

    # Lexical (LIKE) candidates — active behaviors only.
    like = f"%{q}%"
    lexical_rows = conn.execute(
        """SELECT id, name, description FROM behaviors
             WHERE status != 'deprecated'
               AND (name LIKE ? OR description LIKE ?)
             LIMIT ?""",
        (like, like, limit),
    ).fetchall()

    # Semantic candidates — rank latest behavior embedding by cosine.
    ordered_ids: list[str] = []
    meta: dict[str, tuple[str, str]] = {}
    if precomputed_vector is not None:
        query_vec = precomputed_vector
    elif embed_model is not None:
        query_vec = embed_model.encode([q])[0]
    else:
        query_vec = []
    if len(query_vec) == EMBEDDING_DIM:
        emb_rows = conn.execute(
            """SELECT e.entity_id, e.vector, b.name, b.description
                 FROM embeddings e
                 JOIN behaviors b ON b.id = e.entity_id
                WHERE e.entity_type = 'behavior' AND b.status != 'deprecated'"""
        ).fetchall()
        scored = []
        for entity_id, blob, name, desc in emb_rows:
            score = _cosine(query_vec, _unpack(blob))
            if score >= SEMANTIC_FLOOR:
                scored.append((score, str(entity_id), str(name), str(desc)))
        scored.sort(key=lambda t: t[0], reverse=True)
        for _score, bid, name, desc in scored:
            ordered_ids.append(bid)
            meta[bid] = (name, desc)

    # Backfill with lexical matches not already surfaced semantically.
    for bid, name, desc in lexical_rows:
        if str(bid) not in meta:
            ordered_ids.append(str(bid))
            meta[str(bid)] = (str(name), str(desc))

    out: list[_RelatedBehavior] = []
    for bid in ordered_ids[:limit]:
        name, desc = meta[bid]
        out.append(_RelatedBehavior(bid, name, desc, _rules_for(conn, bid)))
    return out


def _build_user_prompt(change: str, related: list[_RelatedBehavior]) -> str:
    if not related:
        rules_block = "(memory has no related rules yet)"
    else:
        lines = []
        for b in related:
            lines.append(f"- {b.name}: {b.description}")
            for r in b.rules:
                lines.append(f"    rule: {r}")
        rules_block = "\n".join(lines)
    return f"PROPOSED CHANGE:\n{change}\n\nEXISTING RULES IN MEMORY:\n{rules_block}"


def analyze_impact(
    conn: sqlite3.Connection,
    change: str,
    client: LLMClient,
    embed_model: EmbeddingModel | None,
    limit: int = RETRIEVAL_LIMIT,
    precomputed_vector: list[float] | None = None,
) -> ImpactAnalysis:
    """Retrieve related rules → ask the LLM to reason about impact → parse.

    Deps injected (client + embed_model are Protocols) → unit-testable with
    fakes, no network/torch/key. Pass `precomputed_vector` to reuse a warm
    embedding and skip the cold model load (ADR 026).
    """
    related = retrieve_related(conn, change, embed_model, limit, precomputed_vector)
    related_rules = [r for b in related for r in b.rules]

    resp = client.complete(
        _ANALYSIS_SYSTEM, _build_user_prompt(change, related), ANALYSIS_MAX_TOKENS
    )
    usage = TokenUsage()
    usage.add(resp)
    data = _parse_json(resp.text)

    def _str_list(key: str) -> list[str]:
        raw = data.get(key, [])
        if not isinstance(raw, list):
            return []
        return [str(x).strip() for x in raw if str(x).strip()]

    conflicts: list[Conflict] = []
    raw_conflicts = data.get("conflicts", [])
    if isinstance(raw_conflicts, list):
        for raw in raw_conflicts:
            if isinstance(raw, dict):
                rule = str(raw.get("rule", "")).strip()
                why = str(raw.get("why", "")).strip()
                if rule or why:
                    conflicts.append(Conflict(rule=rule, why=why))

    return ImpactAnalysis(
        breaks=_str_list("breaks"),
        watch=_str_list("watch"),
        conflicts=conflicts,
        related_rules=related_rules,
        usage=usage,
    )
