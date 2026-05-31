"""CLI — `qa-memory` (ingestion side). Typer app.

Commands:
  ingest <pdf>        extract → chunk → two-pass → embed → persist into SQLite
  ingest-text <text>  ingest raw text (agent-fed content); '-' reads stdin
  ingest-file <path>  ingest a local file, routed by extension (.pdf else text)
  ingest-url <url>    fetch a public URL (stdlib, no auth) and ingest its text
  status              show DB path + row counts
  embed <text>        print the float32 embedding vector as JSON (for the MCP query path)
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

import typer

from qa_memory.config import resolve_db_path
from qa_memory.db import connect
from qa_memory.pipeline.embeddings import LocalEmbeddingModel
from qa_memory.pipeline.extractor import TwoPassExtractor
from qa_memory.pipeline.impact import analyze_impact
from qa_memory.pipeline.ingest import ingest_doc
from qa_memory.pipeline.llm import make_llm_client
from qa_memory.sources.base import ExtractedDoc
from qa_memory.sources.pdf import PdfSource
from qa_memory.sources.router import source_for_path
from qa_memory.sources.text import TextSource
from qa_memory.sources.url import UrlSource

app = typer.Typer(help="qa-memory ingestion CLI", no_args_is_help=True)


def _ingest_and_report(doc: ExtractedDoc, budget: int) -> None:
    """Shared tail: chunk → two-pass → embed → persist, then echo the report.
    Used by every ingest command so the pipeline wiring lives in one place."""
    conn = connect(resolve_db_path())
    extractor = TwoPassExtractor(make_llm_client(), budget=budget)
    report = ingest_doc(conn, doc, extractor, LocalEmbeddingModel())

    if report.skipped:
        typer.echo(f"skipped (already ingested): {doc.label} → source {report.source_id}")
        return
    typer.echo(
        f"ingested {doc.label}: "
        f"{report.behaviors} behaviors, {report.rules} rules, "
        f"{report.embeddings} embeddings, {report.tokens} tokens"
        + (" [budget exhausted]" if report.budget_exhausted else "")
    )


@app.command()
def ingest(
    pdf: Annotated[Path, typer.Argument(help="Path to the PDF to ingest")],
    budget: Annotated[int, typer.Option(help="Token budget for this run")] = 50_000,
) -> None:
    """Ingest a PDF: extract → chunk → two-pass → embed → persist."""
    if not pdf.exists():
        typer.secho(f"file not found: {pdf}", fg=typer.colors.RED, err=True)
        raise typer.Exit(1)

    _ingest_and_report(PdfSource(pdf).extract(), budget)


@app.command(name="ingest-text")
def ingest_text(
    text: Annotated[str, typer.Argument(help="Text to ingest; pass '-' to read from stdin")],
    label: Annotated[str, typer.Option(help="Human label for this source")] = "text",
    source_type: Annotated[
        str, typer.Option(help="Tag for sources.type, e.g. confluence|jira|conversation")
    ] = "conversation",
    budget: Annotated[int, typer.Option(help="Token budget for this run")] = 50_000,
) -> None:
    """Ingest raw text (agent-fed content / pasted notes): chunk → two-pass → embed → persist."""
    import sys

    raw = sys.stdin.read() if text == "-" else text
    if not raw.strip():
        typer.secho("empty text", fg=typer.colors.RED, err=True)
        raise typer.Exit(1)

    doc = TextSource(raw, label=label, source_type=source_type).extract()
    _ingest_and_report(doc, budget)


@app.command(name="ingest-file")
def ingest_file(
    path: Annotated[Path, typer.Argument(help="Local file (.pdf parsed, else text)")],
    label: Annotated[str | None, typer.Option(help="Human label (defaults to filename)")] = None,
    budget: Annotated[int, typer.Option(help="Token budget for this run")] = 50_000,
) -> None:
    """Ingest a local file, routing by extension: .pdf → PDF parse, else text."""
    try:
        source = source_for_path(path, label=label)
    except FileNotFoundError:
        typer.secho(f"file not found: {path}", fg=typer.colors.RED, err=True)
        raise typer.Exit(1) from None
    _ingest_and_report(source.extract(), budget)


@app.command(name="ingest-url")
def ingest_url(
    url: Annotated[str, typer.Argument(help="Public URL to fetch and ingest")],
    label: Annotated[str | None, typer.Option(help="Human label (defaults to the URL)")] = None,
    budget: Annotated[int, typer.Option(help="Token budget for this run")] = 50_000,
) -> None:
    """Fetch a public URL server-side (stdlib, no auth) and ingest its text.

    For private pages, fetch with your own tools and use ingest-text instead."""
    import urllib.error

    try:
        doc = UrlSource(url, label=label).extract()
    except (urllib.error.URLError, OSError) as exc:
        typer.secho(f"fetch failed: {exc}", fg=typer.colors.RED, err=True)
        raise typer.Exit(1) from None
    if not doc.text.strip():
        typer.secho(f"no text extracted from {url}", fg=typer.colors.RED, err=True)
        raise typer.Exit(1)
    _ingest_and_report(doc, budget)


@app.command()
def assess(
    change: Annotated[
        str, typer.Argument(help="Proposed change to analyze; pass '-' to read from stdin")
    ],
) -> None:
    """Analyze the impact of a proposed change against rules already in memory.

    Retrieves related rules → LLM reasons about impact → prints JSON to stdout:
    {"breaks":[...], "watch":[...], "conflicts":[{"rule","why"}], "tokens":N,
     "related_rules":[...]}. Stdout carries ONLY the JSON (noise goes to stderr)
    so the MCP server can parse it from a subprocess. Mirrors `embed`.

    stdin may be either the raw change text, OR a JSON object
    {"change": str, "vector"?: [float]}. When `vector` is present (the MCP
    server embeds with its WARM embedder), the cold model load is skipped
    (ADR 026).
    """
    import sys

    stdin_raw = sys.stdin.read() if change == "-" else change

    # Accept plain text OR {"change", "vector"?} JSON.
    text = stdin_raw
    vector: list[float] | None = None
    stripped = stdin_raw.strip()
    if stripped.startswith("{"):
        try:
            payload = json.loads(stripped)
            text = str(payload.get("change", ""))
            raw_vec = payload.get("vector")
            if isinstance(raw_vec, list):
                vector = [float(x) for x in raw_vec]
        except (json.JSONDecodeError, TypeError, ValueError):
            text = stdin_raw  # not JSON after all — treat as raw change text

    if not text.strip():
        typer.secho("empty change", fg=typer.colors.RED, err=True)
        raise typer.Exit(1)

    conn = connect(resolve_db_path())
    # Warm vector supplied → skip the cold embedding model entirely.
    embed_model = None if vector is not None else LocalEmbeddingModel()
    result = analyze_impact(
        conn, text, make_llm_client(), embed_model, precomputed_vector=vector
    )
    typer.echo(
        json.dumps(
            {
                "breaks": result.breaks,
                "watch": result.watch,
                "conflicts": [{"rule": c.rule, "why": c.why} for c in result.conflicts],
                "related_rules": result.related_rules,
                "tokens": result.usage.total,
            }
        )
    )


@app.command()
def status() -> None:
    """Show DB path + row counts."""
    db_path = resolve_db_path()
    conn = connect(db_path)
    typer.echo(f"db: {db_path}")
    for table in ("sources", "behaviors", "rules", "embeddings"):
        count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        typer.echo(f"  {table}: {count}")


@app.command()
def embed(
    text: Annotated[str, typer.Argument(help="Text to embed")],
) -> None:
    """Print the embedding vector for TEXT as a JSON float array.

    Stdout carries ONLY the JSON (model/progress noise goes to stderr) so the
    MCP server can parse it from a subprocess. Mirrors the model used at ingest.
    """
    from qa_memory.pipeline.embeddings import LocalEmbeddingModel

    vector = LocalEmbeddingModel().encode([text])[0]
    typer.echo(json.dumps(vector))


@app.command(name="embed-serve")
def embed_serve() -> None:
    """Warm embedding server: load the model once, answer line-delimited JSON
    requests on stdin with one JSON response per line on stdout.

    Kills the ~9s-per-query model reload that the one-shot `embed` pays. The MCP
    server keeps this process alive (PersistentEmbedder). See pipeline/embed_serve.
    """
    from qa_memory.pipeline.embed_serve import main as serve_main

    serve_main()


if __name__ == "__main__":
    app()
