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
  // Ingest a local file (routed by extension in Python: .pdf else text).
  ingestPath(path: string, opts: { label?: string }): IngestResult;
  // Fetch + ingest a public URL (server-side stdlib fetch, no auth).
  ingestUrl(url: string, opts: { label?: string }): IngestResult;
  // Fetch + ingest a Jira issue via REST API (requires ATLASSIAN_* env vars).
  ingestJira(key: string, opts: { label?: string }): IngestResult;
  // Fetch + ingest a Confluence page via REST API (requires ATLASSIAN_* env vars).
  ingestConfluence(pageIdOrUrl: string, opts: { label?: string }): IngestResult;
}

// Base command. Default: `uv run qa-memory`; the subcommand (ingest-text /
// ingest-file / ingest-url) is appended per call. Override the base via
// QA_MEMORY_INGEST_CMD (space-separated) for hosts where uv is not on PATH.
// The override may already include `ingest-text` (legacy) — that's stripped so
// the right subcommand is used.
function ingestBaseCommand(env: NodeJS.ProcessEnv): string[] {
  const raw = env.QA_MEMORY_INGEST_CMD?.trim();
  if (raw) {
    const parts = raw.split(/\s+/);
    if (parts[parts.length - 1] === "ingest-text") parts.pop();
    return parts;
  }
  return ["uv", "run", "qa-memory"];
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

  // Runs `<base> <subcommand> <args>` and normalizes the result. `input` is fed
  // over stdin (used by ingest-text to dodge argv limits).
  private run(subcommand: string, args: string[], input?: string): IngestResult {
    const [cmd, ...base] = ingestBaseCommand(this.env);
    if (!cmd) return { ok: false, message: "no ingest command configured" };
    const res = spawnSync(cmd, [...base, subcommand, ...args], {
      input,
      cwd: this.cwd,
      encoding: "utf8",
      timeout: 180_000,
    });
    if (res.status === 0) {
      return { ok: true, message: (res.stdout || "ingested").trim() };
    }
    const err = (res.stderr || res.stdout || "ingestion failed").trim();
    return { ok: false, message: err };
  }

  ingestText(text: string, opts: { label: string; sourceType: string }): IngestResult {
    // Text goes over stdin ('-') to dodge argv length/escaping limits.
    return this.run(
      "ingest-text",
      ["-", "--label", opts.label, "--source-type", opts.sourceType],
      text,
    );
  }

  ingestPath(path: string, opts: { label?: string }): IngestResult {
    const args = [path, ...(opts.label ? ["--label", opts.label] : [])];
    return this.run("ingest-file", args);
  }

  ingestUrl(url: string, opts: { label?: string }): IngestResult {
    const args = [url, ...(opts.label ? ["--label", opts.label] : [])];
    return this.run("ingest-url", args);
  }

  ingestJira(key: string, opts: { label?: string }): IngestResult {
    const args = [key, ...(opts.label ? ["--label", opts.label] : [])];
    return this.run("ingest-jira", args);
  }

  ingestConfluence(pageIdOrUrl: string, opts: { label?: string }): IngestResult {
    const args = [pageIdOrUrl, ...(opts.label ? ["--label", opts.label] : [])];
    return this.run("ingest-confluence", args);
  }
}
