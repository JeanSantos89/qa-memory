// No-LLM feed path: persist behaviors + rules + local embeddings from a
// structured JSON payload, WITHOUT the Python two-pass extractor. The caller
// (an agent, or a script) is the extractor — it produces the structured
// knowledge; this just writes it. Local embeddings are still generated (via the
// injected Embedder → sentence-transformers, not an LLM) so semantic search
// works; if the embedder is unavailable, behaviors are still stored and search
// falls back to LIKE.
//
// Neutral by design: holds no product data, only the shape. Real knowledge
// flows in at runtime via stdin and lands in the git-ignored .qa-memory/ DB.
import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { insertBehavior } from "./repo/behaviors.js";
import { insertRule } from "./repo/rules.js";
import type { Embedder } from "./embedder.js";

// Label stored on embedding rows (informational; search does not filter by it).
// Matches the model the Python pipeline uses, so vectors share one space.
const EMBED_MODEL = "all-MiniLM-L6-v2";

export interface FeedRule {
  rule_text: string;
  confidence?: number; // default 0.6 (agent inference, above the 0.5 under_review floor)
  source_excerpt?: string | null;
  qa_override?: boolean; // default false — these are inferences, not QA-confirmed
  override_reason?: string | null;
}

export interface FeedBehavior {
  name: string;
  description: string;
  criticality: string; // P0|P1|P2|P3|custom
  confirmed_by_qa?: boolean; // default false
  qa_note?: string | null;
  rules?: FeedRule[];
}

export interface FeedInput {
  // Optional provenance row so curation can tell where knowledge came from.
  source?: { type?: string; label?: string; source_ref?: string };
  behaviors: FeedBehavior[];
}

export interface FeedReport {
  source_id: string | null;
  behaviors: number;
  rules: number;
  embeddings: number;
  embedder_available: boolean;
}

// float32 little-endian BLOB — mirrors Python `array('f').tobytes()` /
// unpackVector in embeddings.ts.
function packVector(v: number[]): Buffer {
  const f = new Float32Array(v);
  return Buffer.from(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength));
}

// Embeds, then persists. Embedding (a subprocess round-trip) is async and must
// happen BEFORE the synchronous better-sqlite3 transaction — so we collect all
// vectors first, then write atomically.
export async function feedKnowledge(
  db: Database,
  input: FeedInput,
  embedder: Embedder | null,
  now: string = new Date().toISOString(),
): Promise<FeedReport> {
  if (!input || !Array.isArray(input.behaviors) || input.behaviors.length === 0) {
    throw new Error("feed: input.behaviors must be a non-empty array");
  }
  for (const b of input.behaviors) {
    if (!b.name || !b.description || !b.criticality) {
      throw new Error("feed: each behavior needs name, description, criticality");
    }
  }

  // Content embedded per behavior — mirrors the Python pipeline (name\ndescription).
  const contents = input.behaviors.map((b) => `${b.name}\n${b.description}`);
  const vectors: (number[] | null)[] = [];
  let embedderAvailable = embedder !== null;
  for (const content of contents) {
    const vec = embedder ? await embedder.embed(content) : null;
    if (vec === null) embedderAvailable = false;
    vectors.push(vec);
  }

  // Pre-generate rule IDs and embed their texts before the synchronous transaction.
  // Embedding is async (subprocess); better-sqlite3 transactions are synchronous.
  interface PreRule {
    feedRule: FeedRule;
    id: string;
    vector: number[] | null;
  }
  const preRules: PreRule[][] = [];
  for (const b of input.behaviors) {
    const bRules: PreRule[] = [];
    for (const r of b.rules ?? []) {
      const id = randomUUID();
      const vec = embedder && r.rule_text ? await embedder.embed(r.rule_text) : null;
      bRules.push({ feedRule: r, id, vector: vec });
    }
    preRules.push(bRules);
  }

  let rules = 0;
  let embeddings = 0;
  let sourceId: string | null = null;

  const tx = db.transaction(() => {
    if (input.source) {
      sourceId = randomUUID();
      db.prepare(
        `INSERT INTO sources (id, type, label, source_ref, sync_status, created_at, updated_at)
         VALUES (@id, @type, @label, @source_ref, 'success', @now, @now)`,
      ).run({
        id: sourceId,
        type: input.source.type ?? "conversation",
        label: input.source.label ?? "agent-extracted",
        source_ref: input.source.source_ref ?? "agent",
        now,
      });
    }

    input.behaviors.forEach((b, i) => {
      const behaviorId = insertBehavior(
        db,
        {
          name: b.name,
          description: b.description,
          criticality: b.criticality,
          confirmed_by_qa: b.confirmed_by_qa ?? false,
          qa_note: b.qa_note ?? null,
          source_ids: sourceId ? [sourceId] : [],
        },
        now,
      );

      for (const pr of preRules[i] ?? []) {
        if (!pr.feedRule.rule_text) continue;
        insertRule(
          db,
          {
            id: pr.id,
            behavior_id: behaviorId,
            rule_text: pr.feedRule.rule_text,
            confidence: pr.feedRule.confidence ?? 0.6,
            source_excerpt: pr.feedRule.source_excerpt ?? null,
            source_id: sourceId,
            qa_override: pr.feedRule.qa_override ?? false,
            override_reason: pr.feedRule.override_reason ?? null,
          },
          now,
        );
        if (pr.vector) {
          db.prepare(
            `INSERT INTO embeddings (id, entity_type, entity_id, content, vector, model, created_at)
             VALUES (?, 'rule', ?, ?, ?, ?, ?)`,
          ).run(randomUUID(), pr.id, pr.feedRule.rule_text, packVector(pr.vector), EMBED_MODEL, now);
          embeddings++;
        }
        rules++;
      }

      const vec = vectors[i];
      if (vec) {
        db.prepare(
          `INSERT INTO embeddings (id, entity_type, entity_id, content, vector, model, created_at)
           VALUES (?, 'behavior', ?, ?, ?, ?, ?)`,
        ).run(randomUUID(), behaviorId, contents[i], packVector(vec), EMBED_MODEL, now);
        embeddings++;
      }
    });
  });
  tx();

  return {
    source_id: sourceId,
    behaviors: input.behaviors.length,
    rules,
    embeddings,
    embedder_available: embedderAvailable,
  };
}
