// qa-memory CLI — local inspection of the knowledge DB.
// Commands: status | list behaviors | seed | feed
import { fileURLToPath } from "node:url";
import type { Database } from "better-sqlite3";
import { resolveDbPath } from "./config.js";
import { openDb } from "./db/index.js";
import { PersistentEmbedder } from "./embedder.js";
import { type FeedInput, feedKnowledge } from "./feed.js";
import { getLabels } from "./i18n.js";
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

  const L = getLabels();

  if (cmd === "status") {
    return [
      `qa-memory ${VERSION}`,
      `db: ${dbPath}`,
      ...TABLES.map((t) => `  ${t}: ${count(db, t)}`),
    ].join("\n");
  }

  if (cmd === "list" && argv[1] === "behaviors") {
    const behaviors = listBehaviors(db);
    if (behaviors.length === 0) return L.noBehaviorsYet;
    return behaviors
      .map((b) => `${b.criticality} ${b.name}${b.confirmed_by_qa ? " ✓" : ""}`)
      .join("\n");
  }

  if (cmd === "seed") {
    const n = seedDb(db);
    return n === 0 ? L.alreadySeeded : L.seeded(n);
  }

  return L.usage;
}

// Reads all of stdin as UTF-8 text.
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// The `feed` command: structured JSON in → behaviors/rules/embeddings persisted.
// Returns the line to print on stdout. Throws on bad input (caller exits 1).
async function runFeed(db: Database): Promise<string> {
  const raw = await readStdin();
  let input: FeedInput;
  try {
    input = JSON.parse(raw.replace(/^﻿/, "")) as FeedInput; // tolerate UTF-8 BOM
  } catch (e) {
    throw new Error(getLabels().feedInvalidJson((e as Error).message));
  }
  const embedder = new PersistentEmbedder(process.env);
  try {
    const r = await feedKnowledge(db, input, embedder);
    const L = getLabels();
    const tail = r.embedder_available ? "" : ` ${L.embedderUnavailable}`;
    return `${L.fed(r.behaviors, r.rules, r.embeddings)}${tail}`;
  } finally {
    embedder.close?.();
  }
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  const db = openDb(dbPath);
  const argv = process.argv.slice(2);
  const out = argv[0] === "feed" ? await runFeed(db) : runCommand(db, dbPath, argv);
  process.stdout.write(out + "\n");
}

// Run only when invoked directly (not on import, e.g. during tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
