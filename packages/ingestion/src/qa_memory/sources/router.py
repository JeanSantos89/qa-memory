"""Source router — pick a Source from a local file path by extension.

.pdf → PdfSource (parsed via pymupdf). .txt/.md/.markdown/.text and anything
else readable as UTF-8 → TextSource over the file's contents. Keeps the
extension→source decision in one place (Bloco 8)."""

from __future__ import annotations

from pathlib import Path

from qa_memory.sources.base import Source
from qa_memory.sources.pdf import PdfSource
from qa_memory.sources.text import TextSource

_PDF_EXTS = {".pdf"}


def source_for_path(path: str | Path, label: str | None = None) -> Source:
    """Return the Source that handles this file, chosen by extension.

    Raises FileNotFoundError if the path doesn't exist (fail loud, don't fetch
    nothing silently)."""
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(str(p))

    if p.suffix.lower() in _PDF_EXTS:
        return PdfSource(p, label=label)

    # Everything else: read as text. source_type stays "file"; tells the schema
    # this came from a local file rather than a pasted conversation.
    text = p.read_text(encoding="utf-8", errors="replace")
    return TextSource(text, label=label or p.name, source_ref=str(p), source_type="file")
