// Ingestion bridge. The extraction pipeline (LLM two-pass + local embeddings)
// lives in the Python package; the MCP tool shells out to its `ingest-text`
// CLI so there's a single source of extraction truth (ADR 014/015). Injected
// behind an interface → tests run without the Python subprocess/API key.
import { spawnSync } from "node:child_process";

export interface IngestResult {
  ok: boolean;
  message: string;
}

export interface Ingester {
  ingestText(text: string, opts: { label: string; sourceType: string }): IngestResult;
}

// Default: `uv run qa-memory ingest-text`. Override via QA_MEMORY_INGEST_CMD
// (space-separated) for hosts where uv is not on PATH (documented gotcha).
function ingestCommand(env: NodeJS.ProcessEnv): string[] {
  const raw = env.QA_MEMORY_INGEST_CMD?.trim();
  if (raw) return raw.split(/\s+/);
  return ["uv", "run", "qa-memory", "ingest-text"];
}

// uv needs the ingestion package's dir as cwd (else "program not found").
// Mirrors PythonEmbedder/PersistentEmbedder; honors QA_MEMORY_INGESTION_DIR.
function defaultCwd(env: NodeJS.ProcessEnv): string | undefined {
  return env.QA_MEMORY_INGESTION_DIR?.trim() || undefined;
}

export class PythonIngester implements Ingester {
  private readonly cwd?: string;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    cwd?: string,
  ) {
    this.cwd = cwd ?? defaultCwd(env);
  }

  ingestText(text: string, opts: { label: string; sourceType: string }): IngestResult {
    const [cmd, ...base] = ingestCommand(this.env);
    if (!cmd) return { ok: false, message: "no ingest command configured" };
    // Text goes over stdin ('-') to dodge argv length/escaping limits.
    const res = spawnSync(
      cmd,
      [...base, "-", "--label", opts.label, "--source-type", opts.sourceType],
      { input: text, cwd: this.cwd, encoding: "utf8", timeout: 180_000 },
    );
    if (res.status === 0) {
      return { ok: true, message: (res.stdout || "ingested").trim() };
    }
    const err = (res.stderr || res.stdout || "ingestion failed").trim();
    return { ok: false, message: err };
  }
}
