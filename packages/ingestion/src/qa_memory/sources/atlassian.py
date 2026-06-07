"""Atlassian sources — Jira issue and Confluence page via REST API.

Auth: Basic auth (email + API token), configured via env vars:
  ATLASSIAN_BASE_URL  e.g. https://yourcompany.atlassian.net
  ATLASSIAN_EMAIL     user email registered in Atlassian
  ATLASSIAN_API_TOKEN API token from https://id.atlassian.com/manage-profile/security/api-tokens

No new dependencies — stdlib urllib only (mirrors OllamaClient + UrlSource).
Sensitive config lives in env (never committed). See ADR 037.
"""

from __future__ import annotations

import base64
import json
import os
import re
from html.parser import HTMLParser
from typing import Any, ClassVar
from urllib.request import Request, urlopen

from qa_memory.sources.base import ExtractedDoc, Source, sha256_hex

# ---------------------------------------------------------------------------
# Shared auth / fetch helpers
# ---------------------------------------------------------------------------

def _basic_auth(email: str, token: str) -> str:
    return "Basic " + base64.b64encode(f"{email}:{token}".encode()).decode()


def _fetch_json(url: str, auth: str, timeout: int = 30) -> dict[str, Any]:
    req = Request(url, headers={"Authorization": auth, "Accept": "application/json"})
    with urlopen(req, timeout=timeout) as resp:  # noqa: S310
        return json.loads(resp.read().decode("utf-8"))  # type: ignore[no-any-return]


def _strip_html(html: str) -> str:
    """Minimal HTML→plain-text (same approach as UrlSource._html_to_text)."""
    _SKIP = {"script", "style", "head", "noscript", "template"}

    class _P(HTMLParser):
        def __init__(self) -> None:
            super().__init__()
            self._parts: list[str] = []
            self._depth = 0

        def handle_starttag(self, tag: str, attrs: object) -> None:
            if tag in _SKIP:
                self._depth += 1

        def handle_endtag(self, tag: str) -> None:
            if tag in _SKIP and self._depth > 0:
                self._depth -= 1

        def handle_data(self, data: str) -> None:
            if self._depth == 0 and data.strip():
                self._parts.append(data.strip())

    p = _P()
    p.feed(html)
    return "\n".join(p._parts)


def _atlassian_env() -> tuple[str, str, str]:
    """Return (base_url, email, api_token) from env or raise RuntimeError."""
    base = os.environ.get("ATLASSIAN_BASE_URL", "").rstrip("/")
    email = os.environ.get("ATLASSIAN_EMAIL", "")
    token = os.environ.get("ATLASSIAN_API_TOKEN", "")
    pairs = [
        ("ATLASSIAN_BASE_URL", base),
        ("ATLASSIAN_EMAIL", email),
        ("ATLASSIAN_API_TOKEN", token),
    ]
    missing = [k for k, v in pairs if not v]
    if missing:
        raise RuntimeError(f"missing env vars: {', '.join(missing)}")
    return base, email, token


# ---------------------------------------------------------------------------
# JiraSource
# ---------------------------------------------------------------------------

def _adf_to_text(node: object, depth: int = 0) -> str:
    """Recursively extract plain text from Atlassian Document Format (ADF) JSON."""
    if not isinstance(node, dict):
        return ""
    ntype = node.get("type", "")
    parts: list[str] = []
    if ntype == "text":
        return str(node.get("text", ""))
    for child in node.get("content", []) or []:
        text = _adf_to_text(child, depth + 1)
        if text:
            parts.append(text)
    sep = "\n" if ntype in {"paragraph", "heading", "listItem", "blockquote", "codeBlock"} else " "
    joined = sep.join(p for p in parts if p)
    if ntype in {"bulletList", "orderedList"}:
        lines = [f"- {item}" for item in parts if item]
        return "\n".join(lines)
    return joined


class JiraSource(Source):
    """Fetch a Jira issue by key and convert to plain text for extraction."""

    type: ClassVar[str] = "jira"

    def __init__(
        self,
        issue_key: str,
        base_url: str | None = None,
        email: str | None = None,
        api_token: str | None = None,
        label: str | None = None,
        timeout: int = 30,
    ) -> None:
        env_base, env_email, env_token = _atlassian_env()
        self.issue_key = issue_key.strip().upper()
        self.base_url = (base_url or env_base).rstrip("/")
        self.email = email or env_email
        self.api_token = api_token or env_token
        self.label = label or self.issue_key
        self.timeout = timeout

    def extract(self) -> ExtractedDoc:
        auth = _basic_auth(self.email, self.api_token)
        url = f"{self.base_url}/rest/api/3/issue/{self.issue_key}?expand=renderedFields"
        data = _fetch_json(url, auth, self.timeout)

        fields = data.get("fields") or {}
        rendered = data.get("renderedFields") or {}

        summary = fields.get("summary") or self.issue_key
        status = (fields.get("status") or {}).get("name") or ""
        issue_type = (fields.get("issuetype") or {}).get("name") or ""
        priority = (fields.get("priority") or {}).get("name") or ""
        labels = ", ".join(fields.get("labels") or [])
        assignee = ((fields.get("assignee") or {}).get("displayName") or "")
        reporter = ((fields.get("reporter") or {}).get("displayName") or "")

        # Description: prefer rendered HTML (simpler than ADF parsing), fall back to ADF.
        desc_html = (rendered.get("description") or "").strip()
        if desc_html:
            description = _strip_html(desc_html)
        else:
            raw_desc = fields.get("description")
            description = _adf_to_text(raw_desc) if isinstance(raw_desc, dict) else ""

        # Comments: rendered HTML
        comment_nodes = (rendered.get("comment") or {}).get("comments") or []
        comments: list[str] = []
        for c in comment_nodes:
            author = (c.get("author") or {}).get("displayName") or "?"
            body_html = (c.get("body") or "").strip()
            body = _strip_html(body_html) if body_html else ""
            if body:
                comments.append(f"{author}: {body}")

        lines = [
            f"[JIRA] {self.issue_key}: {summary}",
        ]
        if issue_type:
            lines.append(f"Type: {issue_type}")
        if status:
            lines.append(f"Status: {status}")
        if priority:
            lines.append(f"Priority: {priority}")
        if labels:
            lines.append(f"Labels: {labels}")
        if assignee:
            lines.append(f"Assignee: {assignee}")
        if reporter:
            lines.append(f"Reporter: {reporter}")
        if description:
            lines.append(f"\nDescription:\n{description}")
        if comments:
            lines.append("\nComments:\n" + "\n\n".join(comments))

        text = "\n".join(lines)
        raw = text.encode("utf-8")
        return ExtractedDoc(
            source_type=self.type,
            label=self.label,
            source_ref=self.issue_key,
            text=text,
            checksum=sha256_hex(raw),
        )


# ---------------------------------------------------------------------------
# ConfluenceSource
# ---------------------------------------------------------------------------

_PAGE_ID_RE = re.compile(r"/pages/(\d+)")


def _extract_page_id(page_id_or_url: str) -> str:
    """Return a numeric Confluence page ID from a raw ID or a full URL."""
    m = _PAGE_ID_RE.search(page_id_or_url)
    if m:
        return m.group(1)
    stripped = page_id_or_url.strip()
    if stripped.isdigit():
        return stripped
    raise ValueError(
        f"Cannot extract page ID from {page_id_or_url!r}. "
        "Pass a numeric ID or a full Confluence page URL."
    )


class ConfluenceSource(Source):
    """Fetch a Confluence page by ID (or URL) and convert body to plain text."""

    type: ClassVar[str] = "confluence"

    def __init__(
        self,
        page_id_or_url: str,
        base_url: str | None = None,
        email: str | None = None,
        api_token: str | None = None,
        label: str | None = None,
        timeout: int = 30,
    ) -> None:
        env_base, env_email, env_token = _atlassian_env()
        self.page_id = _extract_page_id(page_id_or_url)
        self.base_url = (base_url or env_base).rstrip("/")
        self.email = email or env_email
        self.api_token = api_token or env_token
        self.label = label
        self.timeout = timeout

    def extract(self) -> ExtractedDoc:
        auth = _basic_auth(self.email, self.api_token)
        url = f"{self.base_url}/wiki/rest/api/content/{self.page_id}?expand=body.export_view,space"
        data = _fetch_json(url, auth, self.timeout)

        title = data.get("title") or self.page_id
        space_key = (data.get("space") or {}).get("key") or ""
        body_html = (((data.get("body") or {}).get("export_view") or {}).get("value") or "").strip()
        body_text = _strip_html(body_html) if body_html else ""

        lines = [f"[CONFLUENCE] {title}"]
        if space_key:
            lines.append(f"Space: {space_key}")
        if body_text:
            lines.append(f"\n{body_text}")

        text = "\n".join(lines)
        raw = text.encode("utf-8")
        return ExtractedDoc(
            source_type=self.type,
            label=self.label or title,
            source_ref=self.page_id,
            text=text,
            checksum=sha256_hex(raw),
        )
