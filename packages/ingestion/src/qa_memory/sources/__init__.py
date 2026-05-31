"""Source extractors: turn external docs into normalized text + metadata."""

from __future__ import annotations

from qa_memory.sources.base import ExtractedDoc, Source
from qa_memory.sources.pdf import PdfSource
from qa_memory.sources.router import source_for_path
from qa_memory.sources.text import TextSource
from qa_memory.sources.url import UrlSource

__all__ = [
    "ExtractedDoc",
    "PdfSource",
    "Source",
    "TextSource",
    "UrlSource",
    "source_for_path",
]
