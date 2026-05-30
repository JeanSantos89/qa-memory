// qa-memory CLI — local inspection of the knowledge DB.
// Commands: status | list behaviors | seed
import { fileURLToPath } from "node:url";
import type { Database } from "better-sqlite3";
import { resolveDbPath } from "./config.js";
import { openDb } from "./db/index.js";
import { listBehaviors } from "./repo/behaviors.js";
import { seedDb } from "./seed.js";
import { VERSION } from "./version.js";

const TABLES = ["behaviors", "rules", "areas", "incidents", "sources", "embeddings"];

function count(db: Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

// Renders command output as a string (testable without spawning a process).
export function runCommand(db: Database, dbPath: string, argv: string[]): string {
  const cmd = argv[0];

  if (cmd === "status") {
    return [
      `qa-memory ${VERSION}`,
      `db: ${dbPath}`,
      ...TABLES.map((t) => `  ${t}: ${count(db, t)}`),
    ].join("\n");
  }

  if (cmd === "list" && argv[1] === "behaviors") {
    const behaviors = listBehaviors(db);
    if (behaviors.length === 0) return "No behaviors yet. Run `qa-memory seed` for dogfood data.";
    return behaviors
      .map((b) => `${b.criticality} ${b.name}${b.confirmed_by_qa ? " ✓" : ""}`)
      .join("\n");
  }

  if (cmd === "seed") {
    const n = seedDb(db);
    return n === 0 ? "DB already has behaviors; nothing seeded." : `Seeded ${n} behaviors.`;
  }

  return [
    "Usage: qa-memory <command>",
    "  status           show DB path + row counts",
    "  list behaviors   list known behaviors",
    "  seed             insert dogfood behaviors (no-op if any exist)",
  ].join("\n");
}

function main(): void {
  const dbPath = resolveDbPath();
  const db = openDb(dbPath);
  process.stdout.write(runCommand(db, dbPath, process.argv.slice(2)) + "\n");
}

// Run only when invoked directly (not on import, e.g. during tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
