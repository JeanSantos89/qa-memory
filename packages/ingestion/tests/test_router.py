from pathlib import Path

import pytest

from qa_memory.sources.pdf import PdfSource
from qa_memory.sources.router import source_for_path
from qa_memory.sources.text import TextSource


def test_pdf_extension_routes_to_pdf_source(tmp_path: Path) -> None:
    p = tmp_path / "spec.pdf"
    p.write_bytes(b"%PDF-1.4 dummy")  # not parsed here, just routed
    assert isinstance(source_for_path(p), PdfSource)


def test_text_extension_routes_to_text_source_with_file_tag(tmp_path: Path) -> None:
    p = tmp_path / "notes.md"
    p.write_text("# Rule\nLogin locks after 3 fails", encoding="utf-8")
    source = source_for_path(p)
    assert isinstance(source, TextSource)
    doc = source.extract()
    assert doc.source_type == "file"
    assert doc.source_ref == str(p)
    assert "Login locks" in doc.text


def test_unknown_extension_still_read_as_text(tmp_path: Path) -> None:
    p = tmp_path / "data.log"
    p.write_text("payment failed at step 2", encoding="utf-8")
    assert isinstance(source_for_path(p), TextSource)


def test_missing_path_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        source_for_path(tmp_path / "nope.txt")
