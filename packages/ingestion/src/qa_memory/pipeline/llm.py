"""LLM client abstraction. Real impls wrap anthropic / gemini; tests inject a fake.

Every call returns token counts — CLAUDE.md: every LLM call logs tokens (in+out).
Keeping the clients behind a Protocol means the extractor never imports a vendor
SDK directly, so unit tests run with zero network + zero API key. Provider is
chosen at the edge (CLI) via `make_llm_client()` reading QA_MEMORY_LLM.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Protocol

# Cheapest model per provider for batch extraction (CLAUDE.md token strategy).
HAIKU_MODEL = "claude-haiku-4-5-20251001"
GEMINI_MODEL = "gemini-2.5-flash"
OLLAMA_MODEL = "llama3.1"
OLLAMA_BASE_URL = "http://localhost:11434"


@dataclass(frozen=True)
class LLMResponse:
    text: str
    input_tokens: int
    output_tokens: int


class LLMClient(Protocol):
    def complete(self, system: str, user: str, max_tokens: int) -> LLMResponse: ...


class AnthropicClient:
    """Thin wrapper over the anthropic SDK. Lazy import → no dep at module load."""

    def __init__(self, model: str = HAIKU_MODEL, api_key: str | None = None) -> None:
        self.model = model
        self._api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        self._client: object | None = None

    def _ensure_client(self) -> object:
        if self._client is None:
            from anthropic import Anthropic

            self._client = Anthropic(api_key=self._api_key)
        return self._client

    def complete(self, system: str, user: str, max_tokens: int) -> LLMResponse:
        client = self._ensure_client()
        resp = client.messages.create(  # type: ignore[attr-defined]
            model=self.model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        text = "".join(
            block.text for block in resp.content if getattr(block, "type", None) == "text"
        )
        return LLMResponse(
            text=text,
            input_tokens=resp.usage.input_tokens,
            output_tokens=resp.usage.output_tokens,
        )


class GeminiClient:
    """Thin wrapper over the google-genai SDK. Lazy import → no dep at module load.

    Asks the model for JSON directly (response_mime_type) since both extraction
    prompts demand JSON output. Token counts come from usage_metadata, honoring
    the CLAUDE.md log-every-call rule the same way AnthropicClient does.
    """

    def __init__(self, model: str = GEMINI_MODEL, api_key: str | None = None) -> None:
        self.model = model
        # google-genai also reads GEMINI_API_KEY/GOOGLE_API_KEY from env on its own.
        self._api_key = api_key or os.environ.get("GEMINI_API_KEY")
        self._client: object | None = None

    def _ensure_client(self) -> object:
        if self._client is None:
            from google import genai

            self._client = genai.Client(api_key=self._api_key)
        return self._client

    def complete(self, system: str, user: str, max_tokens: int) -> LLMResponse:
        from google.genai import types

        client = self._ensure_client()
        resp = client.models.generate_content(  # type: ignore[attr-defined]
            model=self.model,
            contents=user,
            config=types.GenerateContentConfig(
                system_instruction=system,
                max_output_tokens=max_tokens,
                response_mime_type="application/json",
            ),
        )
        usage = resp.usage_metadata
        return LLMResponse(
            text=resp.text or "",
            input_tokens=getattr(usage, "prompt_token_count", 0) or 0,
            output_tokens=getattr(usage, "candidates_token_count", 0) or 0,
        )


class OllamaClient:
    """Local Llama (or any Ollama-served model) over the native /api/chat HTTP API.

    Uses stdlib urllib only — no SDK dep (CLAUDE.md: no new dep without need).
    No API key: talks to a local Ollama daemon. Forces JSON output (format=json)
    since both extraction prompts demand JSON. Token counts come from Ollama's
    prompt_eval_count / eval_count (CLAUDE.md log-every-call rule).
    """

    def __init__(self, model: str = OLLAMA_MODEL, base_url: str | None = None) -> None:
        self.model = model
        raw = base_url or os.environ.get("QA_MEMORY_LLM_BASE_URL") or OLLAMA_BASE_URL
        self.base_url = raw.rstrip("/")

    def complete(self, system: str, user: str, max_tokens: int) -> LLMResponse:
        import json
        import urllib.request

        payload = json.dumps(
            {
                "model": self.model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "stream": False,
                "format": "json",
                "options": {"num_predict": max_tokens},
            }
        ).encode()
        req = urllib.request.Request(
            f"{self.base_url}/api/chat",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.loads(resp.read())
        message = data.get("message") or {}
        return LLMResponse(
            text=str(message.get("content", "")),
            input_tokens=int(data.get("prompt_eval_count", 0) or 0),
            output_tokens=int(data.get("eval_count", 0) or 0),
        )


def make_llm_client() -> LLMClient:
    """Pick the LLM client from env. QA_MEMORY_LLM = anthropic (default) | gemini | ollama.

    Optional QA_MEMORY_LLM_MODEL overrides the per-provider default model;
    QA_MEMORY_LLM_BASE_URL points ollama at a non-default daemon. Anthropic stays
    the default to honor the spec; gemini / local-llama (ollama) are opt-in.
    """
    provider = os.environ.get("QA_MEMORY_LLM", "anthropic").strip().lower()
    model = os.environ.get("QA_MEMORY_LLM_MODEL", "").strip() or None
    if provider == "gemini":
        return GeminiClient(model=model or GEMINI_MODEL)
    if provider in ("ollama", "llama"):
        return OllamaClient(model=model or OLLAMA_MODEL)
    if provider == "anthropic":
        return AnthropicClient(model=model or HAIKU_MODEL)
    raise ValueError(
        f"unknown QA_MEMORY_LLM provider: {provider!r} (use anthropic|gemini|ollama)"
    )
