"""Warm embedding server — load the model ONCE, answer many queries.

The one-shot `embed` CLI pays ~9s (import torch + load model) on every call
because each query is a fresh subprocess (measured: ~20s cold, encode itself
~0.02s). The MCP query path calls it per query → unusable. This serves a long-
lived process instead: read one request per line on stdin, write one JSON
response per line on stdout. The TS side (PersistentEmbedder) keeps it alive.

Protocol (line-delimited JSON, stdout carries ONLY responses; logs go stderr):
  request:  {"text": "..."}            or  {"texts": ["...", "..."]}
  response: {"ok": true, "vectors": [[...], ...]}
            {"ok": false, "error": "..."}
A blank line or EOF ends the loop.
"""

from __future__ import annotations

import json
import sys
from typing import IO, TextIO

from qa_memory.pipeline.embeddings import EmbeddingModel, LocalEmbeddingModel


def _handle(model: EmbeddingModel, line: str) -> str:
    """One request line → one response line (JSON). Never raises."""
    try:
        req = json.loads(line.lstrip("﻿"))  # tolerate a UTF-8 BOM on the line
        if "texts" in req:
            texts = list(req["texts"])
        elif "text" in req:
            texts = [req["text"]]
        else:
            return json.dumps({"ok": False, "error": "request needs 'text' or 'texts'"})
        vectors = model.encode(texts)
        return json.dumps({"ok": True, "vectors": vectors})
    except (json.JSONDecodeError, TypeError, ValueError, KeyError) as exc:
        return json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"})


def serve(
    model: EmbeddingModel,
    stdin: IO[str],
    stdout: TextIO,
) -> None:
    """Read requests until blank line / EOF, writing one response per request."""
    for raw in stdin:
        line = raw.strip()
        if not line:
            break
        stdout.write(_handle(model, line) + "\n")
        stdout.flush()


def main() -> None:
    # Touch the model once up front so the first real query is already warm,
    # and emit a readiness marker on stderr (stdout stays response-only).
    model = LocalEmbeddingModel()
    model.encode(["warmup"])
    sys.stderr.write("qa-memory embed-serve ready\n")
    sys.stderr.flush()
    serve(model, sys.stdin, sys.stdout)
