// Impact-analysis bridge. The reasoning (retrieve related rules + LLM analysis)
// lives in the Python package; the MCP tool shells out to its `assess` CLI so
// there's a single source of analysis truth (ADR 021, mirrors ingester.ts).
// Injected behind an interface → tests run without the Python subprocess/LLM.
import { spawnSync } from "node:child_process";

export interface ImpactConflict {
  rule: string;
  why: string;
}

export interface ImpactAnalysis {
  ok: boolean;
  breaks: string[];
  watch: string[];
  conflicts: ImpactConflict[];
  relatedRules: string[];
  tokens: number;
  // Set when ok=false: the subprocess/parse error.
  message?: string;
}

export interface Assessor {
  // `vector` (optional) is the change already embedded by the warm MCP embedder;
  // passing it lets Python skip its cold embedding load (ADR 026).
  assess(change: string, vector?: number[] | null): ImpactAnalysis;
}

// Default: `uv run qa-memory assess`. Override via QA_MEMORY_ASSESS_CMD
// (space-separated) for hosts where uv is not on PATH (documented gotcha).
function assessCommand(env: NodeJS.ProcessEnv): string[] {
  const raw = env.QA_MEMORY_ASSESS_CMD?.trim();
  if (raw) return raw.split(/\s+/);
  return ["uv", "run", "qa-memory", "assess"];
}

// uv needs the ingestion package's dir as cwd (else "program not found").
// Mirrors PythonIngester/PythonEmbedder; honors QA_MEMORY_INGESTION_DIR.
function defaultCwd(env: NodeJS.ProcessEnv): string | undefined {
  return env.QA_MEMORY_INGESTION_DIR?.trim() || undefined;
}

function failed(message: string): ImpactAnalysis {
  return { ok: false, breaks: [], watch: [], conflicts: [], relatedRules: [], tokens: 0, message };
}

export class PythonAssessor implements Assessor {
  private readonly cwd?: string;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    cwd?: string,
  ) {
    this.cwd = cwd ?? defaultCwd(env);
  }

  assess(change: string, vector?: number[] | null): ImpactAnalysis {
    const [cmd, ...base] = assessCommand(this.env);
    if (!cmd) return failed("no assess command configured");
    // stdin ('-') carries the change. When a warm vector is available we send
    // {change, vector} JSON so Python skips its cold embedding load; otherwise
    // plain text (Python accepts both).
    const input =
      vector && vector.length > 0 ? JSON.stringify({ change, vector }) : change;
    const res = spawnSync(cmd, [...base, "-"], {
      input,
      cwd: this.cwd,
      encoding: "utf8",
      timeout: 300_000,
    });
    if (res.status !== 0) {
      return failed((res.stderr || res.stdout || "assess failed").trim());
    }
    try {
      const data = JSON.parse((res.stdout || "{}").trim()) as {
        breaks?: string[];
        watch?: string[];
        conflicts?: ImpactConflict[];
        related_rules?: string[];
        tokens?: number;
      };
      return {
        ok: true,
        breaks: data.breaks ?? [],
        watch: data.watch ?? [],
        conflicts: data.conflicts ?? [],
        relatedRules: data.related_rules ?? [],
        tokens: data.tokens ?? 0,
      };
    } catch {
      return failed(`could not parse assess output: ${(res.stdout || "").trim()}`);
    }
  }
}
