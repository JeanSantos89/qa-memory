"""AtlassianSource tests — auth, text formatting, and page-ID extraction are
exercised directly; live network calls are not made in tests."""

from __future__ import annotations

import json
from io import BytesIO
from unittest.mock import MagicMock, patch

import pytest

from qa_memory.sources.atlassian import (
    ConfluenceSource,
    JiraSource,
    _adf_to_text,
    _atlassian_env,
    _basic_auth,
    _extract_page_id,
    _strip_html,
)


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------


def test_basic_auth_encodes_correctly() -> None:
    auth = _basic_auth("user@example.com", "tok123")
    import base64
    decoded = base64.b64decode(auth.replace("Basic ", "")).decode()
    assert decoded == "user@example.com:tok123"


def test_strip_html_removes_script_and_style() -> None:
    html = "<html><head><style>.x{}</style></head><body><script>x()</script><p>Hello world</p></body></html>"
    text = _strip_html(html)
    assert "Hello world" in text
    assert "x()" not in text
    assert ".x{}" not in text


def test_adf_to_text_paragraph() -> None:
    adf = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": "Free cancellation up to 5 min."}],
            }
        ],
    }
    assert "Free cancellation up to 5 min." in _adf_to_text(adf)


def test_adf_to_text_empty_node() -> None:
    assert _adf_to_text({}) == ""
    assert _adf_to_text(None) == ""  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# _atlassian_env
# ---------------------------------------------------------------------------


def test_atlassian_env_missing_vars_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ATLASSIAN_BASE_URL", raising=False)
    monkeypatch.delenv("ATLASSIAN_EMAIL", raising=False)
    monkeypatch.delenv("ATLASSIAN_API_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="missing env vars"):
        _atlassian_env()


def test_atlassian_env_returns_values(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ATLASSIAN_BASE_URL", "https://co.atlassian.net")
    monkeypatch.setenv("ATLASSIAN_EMAIL", "qa@co.com")
    monkeypatch.setenv("ATLASSIAN_API_TOKEN", "token99")
    base, email, token = _atlassian_env()
    assert base == "https://co.atlassian.net"
    assert email == "qa@co.com"
    assert token == "token99"


# ---------------------------------------------------------------------------
# _extract_page_id
# ---------------------------------------------------------------------------


def test_extract_page_id_from_numeric_string() -> None:
    assert _extract_page_id("123456") == "123456"


def test_extract_page_id_from_url() -> None:
    url = "https://co.atlassian.net/wiki/spaces/PROJ/pages/789012/My+Page"
    assert _extract_page_id(url) == "789012"


def test_extract_page_id_invalid_raises() -> None:
    with pytest.raises(ValueError, match="Cannot extract page ID"):
        _extract_page_id("not-a-number-or-url")


# ---------------------------------------------------------------------------
# JiraSource
# ---------------------------------------------------------------------------

_JIRA_RESPONSE = {
    "key": "PROJ-123",
    "fields": {
        "summary": "Allow free cancellation after acceptance",
        "status": {"name": "In Progress"},
        "issuetype": {"name": "Story"},
        "priority": {"name": "High"},
        "labels": ["payments", "cancellation"],
        "assignee": {"displayName": "Alice"},
        "reporter": {"displayName": "Bob"},
        "description": None,
    },
    "renderedFields": {
        "description": "<p>Cancellation must be free within 5 minutes of acceptance.</p>",
        "comment": {
            "comments": [
                {
                    "author": {"displayName": "Carol"},
                    "body": "<p>Edge case: what if the restaurant cancels?</p>",
                }
            ]
        },
    },
}


def _make_jira_source(monkeypatch: pytest.MonkeyPatch) -> JiraSource:
    monkeypatch.setenv("ATLASSIAN_BASE_URL", "https://co.atlassian.net")
    monkeypatch.setenv("ATLASSIAN_EMAIL", "qa@co.com")
    monkeypatch.setenv("ATLASSIAN_API_TOKEN", "tok")
    return JiraSource("PROJ-123")


def _patch_urlopen(response_data: dict) -> MagicMock:  # type: ignore[type-arg]
    mock_resp = MagicMock()
    mock_resp.read.return_value = json.dumps(response_data).encode()
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    return mock_resp


def test_jira_source_type() -> None:
    assert JiraSource.type == "jira"


def test_jira_source_extract_text(monkeypatch: pytest.MonkeyPatch) -> None:
    src = _make_jira_source(monkeypatch)
    mock_resp = _patch_urlopen(_JIRA_RESPONSE)
    with patch("qa_memory.sources.atlassian.urlopen", return_value=mock_resp):
        doc = src.extract()

    assert doc.source_type == "jira"
    assert doc.source_ref == "PROJ-123"
    assert "PROJ-123" in doc.text
    assert "Allow free cancellation after acceptance" in doc.text
    assert "In Progress" in doc.text
    assert "payments" in doc.text
    assert "Cancellation must be free within 5 minutes" in doc.text
    assert "Carol" in doc.text
    assert "Edge case" in doc.text


def test_jira_source_label_defaults_to_key(monkeypatch: pytest.MonkeyPatch) -> None:
    src = _make_jira_source(monkeypatch)
    assert src.label == "PROJ-123"


def test_jira_source_label_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ATLASSIAN_BASE_URL", "https://co.atlassian.net")
    monkeypatch.setenv("ATLASSIAN_EMAIL", "qa@co.com")
    monkeypatch.setenv("ATLASSIAN_API_TOKEN", "tok")
    src = JiraSource("PROJ-123", label="Cancellation story")
    assert src.label == "Cancellation story"


def test_jira_source_checksum_is_stable(monkeypatch: pytest.MonkeyPatch) -> None:
    src = _make_jira_source(monkeypatch)
    mock_resp = _patch_urlopen(_JIRA_RESPONSE)
    with patch("qa_memory.sources.atlassian.urlopen", return_value=mock_resp):
        doc1 = src.extract()
    mock_resp2 = _patch_urlopen(_JIRA_RESPONSE)
    with patch("qa_memory.sources.atlassian.urlopen", return_value=mock_resp2):
        doc2 = src.extract()
    assert doc1.checksum == doc2.checksum


# ---------------------------------------------------------------------------
# ConfluenceSource
# ---------------------------------------------------------------------------

_CONFLUENCE_RESPONSE = {
    "title": "Cancellation policy",
    "space": {"key": "PROJ"},
    "body": {
        "export_view": {
            "value": "<p>Orders may be cancelled free of charge within 5 minutes of acceptance.</p>"
        }
    },
}


def _make_confluence_source(monkeypatch: pytest.MonkeyPatch, page: str = "123456") -> ConfluenceSource:
    monkeypatch.setenv("ATLASSIAN_BASE_URL", "https://co.atlassian.net")
    monkeypatch.setenv("ATLASSIAN_EMAIL", "qa@co.com")
    monkeypatch.setenv("ATLASSIAN_API_TOKEN", "tok")
    return ConfluenceSource(page)


def test_confluence_source_type() -> None:
    assert ConfluenceSource.type == "confluence"


def test_confluence_source_extract_text(monkeypatch: pytest.MonkeyPatch) -> None:
    src = _make_confluence_source(monkeypatch)
    mock_resp = _patch_urlopen(_CONFLUENCE_RESPONSE)
    with patch("qa_memory.sources.atlassian.urlopen", return_value=mock_resp):
        doc = src.extract()

    assert doc.source_type == "confluence"
    assert doc.source_ref == "123456"
    assert "Cancellation policy" in doc.text
    assert "PROJ" in doc.text
    assert "5 minutes of acceptance" in doc.text


def test_confluence_source_label_defaults_to_title(monkeypatch: pytest.MonkeyPatch) -> None:
    src = _make_confluence_source(monkeypatch)
    mock_resp = _patch_urlopen(_CONFLUENCE_RESPONSE)
    with patch("qa_memory.sources.atlassian.urlopen", return_value=mock_resp):
        doc = src.extract()
    assert doc.label == "Cancellation policy"


def test_confluence_source_label_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ATLASSIAN_BASE_URL", "https://co.atlassian.net")
    monkeypatch.setenv("ATLASSIAN_EMAIL", "qa@co.com")
    monkeypatch.setenv("ATLASSIAN_API_TOKEN", "tok")
    src = ConfluenceSource("123456", label="My override")
    mock_resp = _patch_urlopen(_CONFLUENCE_RESPONSE)
    with patch("qa_memory.sources.atlassian.urlopen", return_value=mock_resp):
        doc = src.extract()
    assert doc.label == "My override"


def test_confluence_source_accepts_url(monkeypatch: pytest.MonkeyPatch) -> None:
    url = "https://co.atlassian.net/wiki/spaces/PROJ/pages/789012/Policy"
    src = _make_confluence_source(monkeypatch, page=url)
    assert src.page_id == "789012"
