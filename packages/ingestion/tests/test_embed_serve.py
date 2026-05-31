"""Warm embedding server — protocol tests with a fake model (no torch/model)."""

from __future__ import annotations

import io
import json

from qa_memory.pipeline.embed_serve import _handle, serve


class FakeModel:
    name = "fake"

    def encode(self, texts: list[str]) -> list[list[float]]:
        # Deterministic vector keyed on length so assertions are stable.
        return [[float(len(t)), 1.0] for t in texts]


def test_handle_single_text() -> None:
    out = json.loads(_handle(FakeModel(), json.dumps({"text": "abc"})))
    assert out == {"ok": True, "vectors": [[3.0, 1.0]]}


def test_handle_batch_texts() -> None:
    out = json.loads(_handle(FakeModel(), json.dumps({"texts": ["a", "bb"]})))
    assert out == {"ok": True, "vectors": [[1.0, 1.0], [2.0, 1.0]]}


def test_handle_missing_field_is_error_not_raise() -> None:
    out = json.loads(_handle(FakeModel(), json.dumps({"nope": 1})))
    assert out["ok"] is False
    assert "text" in out["error"]


def test_handle_bad_json_is_error_not_raise() -> None:
    out = json.loads(_handle(FakeModel(), "not json{"))
    assert out["ok"] is False


def test_handle_tolerates_utf8_bom() -> None:
    # PowerShell pipes (and some clients) prepend a BOM; it must not break parsing.
    out = json.loads(_handle(FakeModel(), "﻿" + json.dumps({"text": "ab"})))
    assert out == {"ok": True, "vectors": [[2.0, 1.0]]}


def test_serve_answers_one_line_per_request_then_stops_on_blank() -> None:
    stdin = io.StringIO('{"text": "ab"}\n{"text": "cde"}\n\n{"text": "ignored"}\n')
    stdout = io.StringIO()
    serve(FakeModel(), stdin, stdout)
    lines = [ln for ln in stdout.getvalue().splitlines() if ln]
    assert len(lines) == 2  # blank line ended the loop before the third
    assert json.loads(lines[0])["vectors"] == [[2.0, 1.0]]
    assert json.loads(lines[1])["vectors"] == [[3.0, 1.0]]


def test_serve_stops_on_eof() -> None:
    stdin = io.StringIO('{"text": "x"}\n')
    stdout = io.StringIO()
    serve(FakeModel(), stdin, stdout)
    assert len(stdout.getvalue().splitlines()) == 1
