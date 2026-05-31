import json

import pytest

from qa_memory.pipeline.llm import (
    AnthropicClient,
    GeminiClient,
    OllamaClient,
    make_llm_client,
)


def test_factory_defaults_to_anthropic(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("QA_MEMORY_LLM", raising=False)
    assert isinstance(make_llm_client(), AnthropicClient)


def test_factory_selects_gemini_with_model_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("QA_MEMORY_LLM", "gemini")
    monkeypatch.setenv("QA_MEMORY_LLM_MODEL", "gemini-2.5-flash-lite")
    client = make_llm_client()
    assert isinstance(client, GeminiClient)
    assert client.model == "gemini-2.5-flash-lite"


def test_factory_selects_ollama_with_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("QA_MEMORY_LLM", "ollama")
    monkeypatch.setenv("QA_MEMORY_LLM_BASE_URL", "http://box:1234/")
    client = make_llm_client()
    assert isinstance(client, OllamaClient)
    assert client.base_url == "http://box:1234"  # trailing slash trimmed


def test_factory_rejects_unknown_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("QA_MEMORY_LLM", "openai")
    with pytest.raises(ValueError, match="unknown QA_MEMORY_LLM provider"):
        make_llm_client()


class _FakeUsage:
    prompt_token_count = 12
    candidates_token_count = 34


class _FakeResp:
    text = '{"behaviors": []}'
    usage_metadata = _FakeUsage()


class _FakeModels:
    def __init__(self) -> None:
        self.kwargs: dict[str, object] = {}

    def generate_content(self, **kwargs: object) -> _FakeResp:
        self.kwargs = kwargs
        return _FakeResp()


class _FakeGenaiClient:
    def __init__(self) -> None:
        self.models = _FakeModels()


def test_gemini_maps_usage_metadata_to_tokens() -> None:
    client = GeminiClient(model="gemini-2.5-flash")
    client._client = _FakeGenaiClient()  # skip real SDK client creation
    resp = client.complete("sys", "user text", max_tokens=256)
    assert resp.text == '{"behaviors": []}'
    assert resp.input_tokens == 12
    assert resp.output_tokens == 34


class _FakeHttpResp:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_FakeHttpResp":
        return self

    def __exit__(self, *args: object) -> None:
        return None


def test_ollama_maps_eval_counts_to_tokens(monkeypatch: pytest.MonkeyPatch) -> None:
    body = json.dumps(
        {
            "message": {"content": '{"behaviors": []}'},
            "prompt_eval_count": 18,
            "eval_count": 42,
        }
    ).encode()
    import urllib.request

    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: _FakeHttpResp(body))
    resp = OllamaClient(model="llama3.1").complete("sys", "user text", max_tokens=256)
    assert resp.text == '{"behaviors": []}'
    assert resp.input_tokens == 18
    assert resp.output_tokens == 42
