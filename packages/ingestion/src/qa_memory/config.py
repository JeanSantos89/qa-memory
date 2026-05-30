"""Runtime config. DB path resolution (mirror of mcp-server config.ts).

Default DB lives in the git-ignored instance dir `.qa-memory/`.
"""

from __future__ import annotations

import os
from pathlib import Path

DEFAULT_DB_PATH = ".qa-memory/qa-memory.db"


def resolve_db_path(env: dict[str, str] | None = None) -> Path:
    """Env override → QA_MEMORY_DB. Absolute or relative to cwd."""
    environ = os.environ if env is None else env
    raw = (environ.get("QA_MEMORY_DB") or "").strip()
    return Path(raw).resolve() if raw else Path(DEFAULT_DB_PATH).resolve()
