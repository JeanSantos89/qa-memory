"""Char-based, paragraph-aware chunker. Keeps paragraphs whole when they fit.

Char-based (not token-based) on purpose: no tokenizer dep, deterministic, good
enough to bound LLM input. Two-pass extractor summarizes each chunk first.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

DEFAULT_MAX_CHARS = 2000
DEFAULT_OVERLAP = 100

_PARA_SPLIT = re.compile(r"\n\s*\n")


@dataclass(frozen=True)
class Chunk:
    index: int
    text: str


def chunk_text(
    text: str,
    max_chars: int = DEFAULT_MAX_CHARS,
    overlap: int = DEFAULT_OVERLAP,
) -> list[Chunk]:
    """Split text into chunks <= max_chars, packing whole paragraphs greedily.

    A paragraph longer than max_chars is hard-split with `overlap` char carry-over.
    Empty/whitespace input → empty list.
    """
    if max_chars <= 0:
        raise ValueError("max_chars must be > 0")
    if overlap < 0 or overlap >= max_chars:
        raise ValueError("overlap must be >= 0 and < max_chars")

    text = text.strip()
    if not text:
        return []

    paragraphs = [p.strip() for p in _PARA_SPLIT.split(text) if p.strip()]

    chunks: list[str] = []
    current = ""
    for para in paragraphs:
        if len(para) > max_chars:
            if current:
                chunks.append(current)
                current = ""
            chunks.extend(_hard_split(para, max_chars, overlap))
            continue
        candidate = f"{current}\n\n{para}" if current else para
        if len(candidate) <= max_chars:
            current = candidate
        else:
            chunks.append(current)
            current = para
    if current:
        chunks.append(current)

    return [Chunk(index=i, text=c) for i, c in enumerate(chunks)]


def _hard_split(text: str, max_chars: int, overlap: int) -> list[str]:
    """Split an oversized paragraph into fixed windows with overlap carry-over."""
    step = max_chars - overlap
    out: list[str] = []
    start = 0
    n = len(text)
    while start < n:
        out.append(text[start : start + max_chars])
        start += step
    return out
