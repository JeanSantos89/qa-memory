"""URL source — fetch a public web page server-side and extract its text.

stdlib-only (urllib, html.parser) — no new dependency, mirroring OllamaClient's
urllib use (CLAUDE.md: no dep without need). Auth stays the agent's job: for
private pages the agent fetches with its own tools and passes text to the text
source. This handles the token-free public case."""

from __future__ import annotations

from html.parser import HTMLParser
from typing import ClassVar

from qa_memory.sources.base import ExtractedDoc, Source, sha256_hex

# Tags whose text content is noise, not document content.
_SKIP_TAGS = {"script", "style", "head", "noscript", "template"}


class _TextExtractor(HTMLParser):
    """Collects visible text, dropping script/style and collapsing whitespace."""

    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: object) -> None:
        if tag in _SKIP_TAGS:
            self._skip_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0:
            stripped = data.strip()
            if stripped:
                self._parts.append(stripped)

    def text(self) -> str:
        return "\n".join(self._parts)


def _html_to_text(html: str) -> str:
    parser = _TextExtractor()
    parser.feed(html)
    return parser.text()


class UrlSource(Source):
    type: ClassVar[str] = "url"

    def __init__(self, url: str, label: str | None = None, timeout: int = 30) -> None:
        self.url = url
        self.label = label or url
        self.timeout = timeout

    def extract(self) -> ExtractedDoc:
        import urllib.request  # lazy — keeps non-URL paths light, mirrors OllamaClient

        req = urllib.request.Request(self.url, headers={"User-Agent": "qa-memory/1.0"})
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:  # noqa: S310 (public fetch)
            raw = resp.read()
            ctype = resp.headers.get_content_type()
        decoded = raw.decode("utf-8", errors="replace")
        text = (_html_to_text(decoded) if "html" in ctype else decoded).strip()
        return ExtractedDoc(
            source_type=self.type,
            label=self.label,
            source_ref=self.url,
            text=text,
            checksum=sha256_hex(raw),
        )
