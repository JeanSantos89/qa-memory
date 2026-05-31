// Query-time embedding. The model lives in the Python package (sentence-
// transformers); we shell out to it so query vectors land in the exact same
// space as the stored ones. Injected behind an interface → tests use a fake,
// no torch/model download (mirrors the Python EmbeddingModel Protocol).
//
// embed() is async: a cold one-shot subprocess takes ~20s (import + model load;
// encode itself ~0.02s), so PersistentEmbedder keeps an `embed-serve` process
// warm and reads its stdout event-based — which only works off the event loop.
import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface Embedder {
  // Resolves to the embedding vector, or null if embedding is unavailable
  // (subprocess missing/failed) so callers can fall back to LIKE.
  embed(text: string): Promise<number[] | null>;
  // Optional: release a long-lived subprocess. No-op for stateless embedders.
  close?(): void;
}

// Default command: `uv run qa-memory embed`. Override the whole prefix via
// QA_MEMORY_EMBED_CMD (space-separated) for environments where uv is not on
// PATH (documented runtime gotcha).
function embedCommand(env: NodeJS.ProcessEnv): string[] {
  const raw = env.QA_MEMORY_EMBED_CMD?.trim();
  if (raw) return raw.split(/\s+/);
  return ["uv", "run", "qa-memory", "embed"];
}

// `embed` → `embed-serve`: same prefix, swap the trailing subcommand.
function serveCommand(env: NodeJS.ProcessEnv): string[] {
  const cmd = embedCommand(env);
  return cmd[cmd.length - 1] === "embed" ? [...cmd.slice(0, -1), "embed-serve"] : cmd;
}

// uv needs the ingestion package's dir as cwd (else "program not found").
// Default to QA_MEMORY_INGESTION_DIR; callers may also pass an explicit cwd.
function defaultCwd(env: NodeJS.ProcessEnv): string | undefined {
  return env.QA_MEMORY_INGESTION_DIR?.trim() || undefined;
}

function parseVector(parsed: unknown): number[] | null {
  if (Array.isArray(parsed) && parsed.every((x) => typeof x === "number")) {
    return parsed as number[];
  }
  return null;
}

// One-shot subprocess per query. Stateless, cold (~20s), but dependency-free
// and the reliable fallback when the warm server can't start.
export class PythonEmbedder implements Embedder {
  private readonly cwd?: string;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    cwd?: string,
  ) {
    this.cwd = cwd ?? defaultCwd(env);
  }

  embed(text: string): Promise<number[] | null> {
    const [cmd, ...args] = embedCommand(this.env);
    if (!cmd) return Promise.resolve(null);
    return new Promise((resolve) => {
      let out = "";
      let done = false;
      const finish = (v: number[] | null) => {
        if (!done) {
          done = true;
          resolve(v);
        }
      };
      const child = spawn(cmd, [...args, text], { cwd: this.cwd });
      const timer = setTimeout(() => {
        child.kill();
        finish(null);
      }, 60_000);
      child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
      child.on("error", () => {
        clearTimeout(timer);
        finish(null);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return finish(null);
        try {
          finish(parseVector(JSON.parse(out.trim())));
        } catch {
          finish(null);
        }
      });
    });
  }
}

type ServeChild = ChildProcessByStdio<Writable, Readable, null>;

// Keeps one `embed-serve` process warm: the model loads once, then every query
// is a sub-second round-trip (vs ~20s cold). Spawned lazily on first use; if it
// dies or can't start, falls back to a cold PythonEmbedder so retrieval never
// hard-fails. Requests are serialized (one in flight) — the line-delimited
// protocol of embed_serve pairs one response line per request line in order.
export class PersistentEmbedder implements Embedder {
  private child: ServeChild | null = null;
  private buf = "";
  private queue: Promise<unknown> = Promise.resolve();
  private readonly cwd?: string;
  private readonly oneShot: PythonEmbedder;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    cwd?: string,
  ) {
    this.cwd = cwd ?? defaultCwd(env);
    this.oneShot = new PythonEmbedder(env, this.cwd);
  }

  private start(): ServeChild | null {
    if (this.child && this.child.exitCode === null) return this.child;
    const [cmd, ...args] = serveCommand(this.env);
    if (!cmd) return null;
    try {
      const child = spawn(cmd, args, {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "inherit"],
      }) as ServeChild;
      child.on("error", () => {
        this.child = null;
      });
      child.on("close", () => {
        this.child = null;
      });
      this.child = child;
      this.buf = "";
      return child;
    } catch {
      this.child = null;
      return null;
    }
  }

  // Write one request, await one response line. Reads stdout via 'data' events
  // (cooperates with Node's stream) and resolves on the first newline.
  private request(child: ServeChild, text: string): Promise<number[] | null> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: number[] | null) => {
        if (done) return;
        done = true;
        child.stdout.removeListener("data", onData);
        child.removeListener("close", onClose);
        clearTimeout(timer);
        resolve(v);
      };
      const tryLine = () => {
        const nl = this.buf.indexOf("\n");
        if (nl === -1) return;
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        try {
          const parsed = JSON.parse(line) as { ok?: boolean; vectors?: unknown };
          const vec =
            parsed.ok && Array.isArray(parsed.vectors) ? parseVector(parsed.vectors[0]) : null;
          finish(vec);
        } catch {
          finish(null);
        }
      };
      const onData = (d: Buffer) => {
        this.buf += d.toString("utf8");
        tryLine();
      };
      const onClose = () => finish(null);
      const timer = setTimeout(() => finish(null), 60_000);
      child.stdout.on("data", onData);
      child.on("close", onClose);
      child.stdin.write(JSON.stringify({ text }) + "\n");
      tryLine(); // a prior chunk may already hold the line
    });
  }

  embed(text: string): Promise<number[] | null> {
    // Serialize: chain on the queue so request/response lines never interleave.
    const run = this.queue.then(async () => {
      const child = this.start();
      if (!child) return this.oneShot.embed(text);
      const vec = await this.request(child, text);
      // null can mean the server died mid-flight — fall back once so a single
      // crash doesn't drop the query.
      if (vec === null && (this.child === null || this.child.exitCode !== null)) {
        return this.oneShot.embed(text);
      }
      return vec;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  close(): void {
    if (this.child && this.child.exitCode === null) {
      try {
        this.child.stdin.end(); // blank/EOF ends embed_serve's loop cleanly
      } catch {
        /* ignore */
      }
    }
    this.child = null;
  }
}
