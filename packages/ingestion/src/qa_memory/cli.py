"""CLI — `qa-memory` (ingestion side). Typer app.

Commands:
  ingest <pdf>   extract → chunk → two-pass → embed → persist into SQLite
  status         show DB path + row counts
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from qa_memory.config import resolve_db_path
from qa_memory.db import connect
from qa_memory.pipeline.embeddings import LocalEmbeddingModel
from qa_memory.pipeline.extractor import TwoPassExtractor
from qa_memory.pipeline.ingest import ingest_doc
from qa_memory.pipeline.llm import AnthropicClient
from qa_memory.sources.pdf import PdfSource

app = typer.Typer(help="qa-memory ingestion CLI", no_args_is_help=True)


@app.command()
def ingest(
    pdf: Annotated[Path, typer.Argument(help="Path to the PDF to ingest")],
    budget: Annotated[int, typer.Option(help="Token budget for this run")] = 50_000,
) -> None:
    """Ingest a PDF: extract → chunk → two-pass → embed → persist."""
    if not pdf.exists():
        typer.secho(f"file not found: {pdf}", fg=typer.colors.RED, err=True)
        raise typer.Exit(1)

    doc = PdfSource(pdf).extract()
    conn = connect(resolve_db_path())
    extractor = TwoPassExtractor(AnthropicClient(), budget=budget)
    report = ingest_doc(conn, doc, extractor, LocalEmbeddingModel())

    if report.skipped:
        typer.echo(f"skipped (already ingested): {pdf.name} → source {report.source_id}")
        return
    typer.echo(
        f"ingested {pdf.name}: "
        f"{report.behaviors} behaviors, {report.rules} rules, "
        f"{report.embeddings} embeddings, {report.tokens} tokens"
        + (" [budget exhausted]" if report.budget_exhausted else "")
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


if __name__ == "__main__":
    app()
