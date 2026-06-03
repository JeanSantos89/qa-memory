import json

from qa_memory.pipeline.chunker import Chunk
from qa_memory.pipeline.extractor import (
    SUMMARY_MAX_TOKENS,
    TwoPassExtractor,
)
from qa_memory.pipeline.llm import LLMResponse


class FakeClient:
    """Scripts responses by call order; records tokens it claims to use."""

    def __init__(self, responses: list[LLMResponse]) -> None:
        self._responses = list(responses)
        self.calls: list[tuple[str, str, int]] = []

    def complete(self, system: str, user: str, max_tokens: int) -> LLMResponse:
        self.calls.append((system, user, max_tokens))
        return self._responses.pop(0)


def _summary(relevant: bool, summary: str = "s", io: tuple[int, int] = (10, 5)) -> LLMResponse:
    return LLMResponse(
        text=json.dumps({"summary": summary, "relevant": relevant}),
        input_tokens=io[0],
        output_tokens=io[1],
    )


def _extract(
    behaviors: list[dict[str, object]], io: tuple[int, int] = (20, 30)
) -> LLMResponse:
    return LLMResponse(
        text=json.dumps({"behaviors": behaviors}),
        input_tokens=io[0],
        output_tokens=io[1],
    )


def test_two_pass_only_extracts_relevant_chunks() -> None:
    chunks = [Chunk(0, "boilerplate"), Chunk(1, "login locks after 3 fails")]
    client = FakeClient(
        [
            _summary(relevant=False),
            _summary(relevant=True),
            _extract([{"name": "Login lockout", "description": "locks", "criticality": "P1",
                       "rules": ["lock after 3 fails"]}]),
        ]
    )
    result = TwoPassExtractor(client).extract(chunks)

    # 2 summary calls + 1 extraction call (only relevant chunk)
    assert len(client.calls) == 3
    assert len(result.summaries) == 2
    assert [s.relevant for s in result.summaries] == [False, True]
    assert len(result.behaviors) == 1
    b = result.behaviors[0]
    assert b.name == "Login lockout"
    assert b.rules == ["lock after 3 fails"]


def test_token_usage_accumulates() -> None:
    # Single chunk: Pass 1 skipped → only extract call counts toward usage.
    chunks = [Chunk(0, "x")]
    client = FakeClient([_extract([], io=(20, 30))])
    result = TwoPassExtractor(client).extract(chunks)
    assert result.usage.input_tokens == 20
    assert result.usage.output_tokens == 30
    assert result.usage.total == 50


def test_token_usage_accumulates_multi_chunk() -> None:
    # Multi-chunk: Pass 1 + Pass 2 both accumulate.
    chunks = [Chunk(0, "a"), Chunk(1, "b")]
    client = FakeClient([_summary(relevant=True, io=(10, 5)), _summary(relevant=False, io=(10, 5)), _extract([], io=(20, 30))])
    result = TwoPassExtractor(client).extract(chunks)
    assert result.usage.input_tokens == 40
    assert result.usage.output_tokens == 40
    assert result.usage.total == 80


def test_budget_stops_before_overshoot() -> None:
    chunks = [Chunk(0, "a"), Chunk(1, "b")]
    # budget only covers one summary call's reserved cost
    client = FakeClient([_summary(relevant=True), _summary(relevant=True)])
    result = TwoPassExtractor(client, budget=SUMMARY_MAX_TOKENS).extract(chunks)
    assert result.budget_exhausted is True
    assert len(client.calls) == 1  # second summary refused


def test_tolerates_fenced_json() -> None:
    # Two chunks so Pass 1 runs and fenced-JSON parsing is exercised.
    chunks = [Chunk(0, "x"), Chunk(1, "y")]
    fenced = LLMResponse(
        text='```json\n{"summary": "ok", "relevant": true}\n```',
        input_tokens=1,
        output_tokens=1,
    )
    client = FakeClient([fenced, _summary(relevant=False), _extract([])])
    result = TwoPassExtractor(client).extract(chunks)
    assert result.summaries[0].summary == "ok"
    assert result.summaries[0].relevant is True


def test_malformed_json_degrades_gracefully() -> None:
    # Two chunks so Pass 1 runs and malformed-JSON degradation is exercised.
    chunks = [Chunk(0, "x"), Chunk(1, "y")]
    junk = LLMResponse(text="not json at all", input_tokens=1, output_tokens=1)
    client = FakeClient([junk, _summary(relevant=False)])
    result = TwoPassExtractor(client).extract(chunks)
    assert result.summaries[0].relevant is False
    assert result.behaviors == []


def test_single_chunk_skips_pass1() -> None:
    # Single chunk bypasses summarization and goes straight to extraction.
    chunks = [Chunk(0, "login locks after 3 fails")]
    client = FakeClient([_extract([{"name": "Login lockout", "description": "locks",
                                    "criticality": "P1", "rules": ["lock after 3"]}])])
    result = TwoPassExtractor(client).extract(chunks)
    assert len(client.calls) == 1  # no summary call
    assert result.summaries[0].relevant is True
    assert result.summaries[0].summary == ""
    assert len(result.behaviors) == 1
