"""Two-pass extraction over chunks.

Pass 1 (summary): cheap ≤150-token summary per chunk + relevance flag.
Pass 2 (full): behavior/rule extraction ONLY on chunks flagged relevant.

Token budget bounds the whole run (default 50k). Every call accumulates
input+output tokens; once the budget can't cover another call, we stop and
report what was done. Prompts are caveman-terse to save tokens.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from qa_memory.pipeline.chunker import Chunk
from qa_memory.pipeline.llm import LLMClient, LLMResponse

DEFAULT_BUDGET = 50_000
SUMMARY_MAX_TOKENS = 200  # ≤150 target + JSON wrapper slack
EXTRACT_MAX_TOKENS = 1024

_SUMMARY_SYSTEM = (
    'QA KB triage. JSON: {"summary":str(<=150tok),"relevant":bool}. '
    "relevant=true→product behavior/rules/constraints; false→boilerplate/TOC/legal/nav."
)

_EXTRACT_SYSTEM = (
    'Extract behaviors. JSON: {"behaviors":[{"name":str,"description":str,'
    '"criticality":"P0"|"P1"|"P2"|"P3","rules":[str]}]}. '
    "Behavior=testable capability. rules=constraints. Empty list if none."
)


@dataclass
class TokenUsage:
    input_tokens: int = 0
    output_tokens: int = 0

    @property
    def total(self) -> int:
        return self.input_tokens + self.output_tokens

    def add(self, resp: LLMResponse) -> None:
        self.input_tokens += resp.input_tokens
        self.output_tokens += resp.output_tokens


@dataclass(frozen=True)
class ChunkSummary:
    chunk_index: int
    summary: str
    relevant: bool


@dataclass(frozen=True)
class ExtractedBehavior:
    name: str
    description: str
    criticality: str
    rules: list[str]


@dataclass
class ExtractionResult:
    behaviors: list[ExtractedBehavior] = field(default_factory=list)
    summaries: list[ChunkSummary] = field(default_factory=list)
    usage: TokenUsage = field(default_factory=TokenUsage)
    budget_exhausted: bool = False


def _parse_json(text: str) -> dict[str, object]:
    """Tolerant JSON parse — strip ```json fences the model sometimes adds."""
    s = text.strip()
    if s.startswith("```"):
        s = s.split("```", 2)[1] if s.count("```") >= 2 else s.strip("`")
        s = s.removeprefix("json").strip()
    start, end = s.find("{"), s.rfind("}")
    if start == -1 or end == -1:
        return {}
    try:
        parsed = json.loads(s[start : end + 1])
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


class TwoPassExtractor:
    def __init__(self, client: LLMClient, budget: int = DEFAULT_BUDGET) -> None:
        self.client = client
        self.budget = budget

    def _can_afford(self, usage: TokenUsage, max_out: int) -> bool:
        # Conservative: assume the next call costs its max output. Stops before overshoot.
        return usage.total + max_out <= self.budget

    def extract(self, chunks: list[Chunk]) -> ExtractionResult:
        result = ExtractionResult()

        # Single-chunk shortcut: skip Pass 1 entirely — treat as relevant.
        # Saves one LLM call for short inputs (notes, pasted text, short specs).
        if len(chunks) == 1:
            result.summaries.append(
                ChunkSummary(chunk_index=chunks[0].index, summary="", relevant=True)
            )
        else:
            # Pass 1 — summarize + flag relevance.
            for chunk in chunks:
                if not self._can_afford(result.usage, SUMMARY_MAX_TOKENS):
                    result.budget_exhausted = True
                    return result
                resp = self.client.complete(_SUMMARY_SYSTEM, chunk.text, SUMMARY_MAX_TOKENS)
                result.usage.add(resp)
                data = _parse_json(resp.text)
                result.summaries.append(
                    ChunkSummary(
                        chunk_index=chunk.index,
                        summary=str(data.get("summary", "")),
                        relevant=bool(data.get("relevant", False)),
                    )
                )

        by_index = {c.index: c for c in chunks}
        relevant = [s for s in result.summaries if s.relevant]

        # Pass 2 — full extraction on relevant chunks only.
        for summary in relevant:
            if not self._can_afford(result.usage, EXTRACT_MAX_TOKENS):
                result.budget_exhausted = True
                return result
            chunk = by_index[summary.chunk_index]
            resp = self.client.complete(_EXTRACT_SYSTEM, chunk.text, EXTRACT_MAX_TOKENS)
            result.usage.add(resp)
            data = _parse_json(resp.text)
            raw_behaviors = data.get("behaviors", [])
            if not isinstance(raw_behaviors, list):
                continue
            for raw in raw_behaviors:
                if not isinstance(raw, dict):
                    continue
                result.behaviors.append(
                    ExtractedBehavior(
                        name=str(raw.get("name", "")).strip(),
                        description=str(raw.get("description", "")).strip(),
                        criticality=str(raw.get("criticality", "P2")).strip(),
                        rules=[str(r).strip() for r in (raw.get("rules") or []) if str(r).strip()],
                    )
                )

        return result
