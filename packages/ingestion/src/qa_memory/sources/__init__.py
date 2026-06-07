"""Source extractors: turn external docs into normalized text + metadata."""

from __future__ import annotations

from qa_memory.sources.atlassian import ConfluenceSource, JiraSource
from qa_memory.sources.base import ExtractedDoc, Source
from qa_memory.sources.pdf import PdfSource
from qa_memory.sources.router import source_for_path
from qa_memory.sources.text import TextSource
from qa_memory.sources.url import UrlSource

__all__ = [
    "ConfluenceSource",
    "ExtractedDoc",
    "JiraSource",
    "PdfSource",
    "Source",
    "TextSource",
    "UrlSource",
    "source_for_path",
]
