// Behavior search — semantic when embeddings exist, lexical (LIKE) otherwise.
// query_behavior + query_risk both route through here, so upgrading retrieval
// here lifts both tools at once.
import type { Database } from "better-sqlite3";
import {
  type Behavior,
  listBehaviorEmbeddings,
  listBehaviors,
  queryBehavior,
} from "./repo/behaviors.js";
import type { Embedder } from "./embedder.js";
import { cosineSimilarity, unpackVector } from "./embeddings.js";

// Below this cosine score a behavior is treated as unrelated (avoids dumping
// the whole DB on every query). Tuned conservatively; all-MiniLM scores
// related-but-not-identical text well above this.
const SEMANTIC_FLOOR = 0.25;

// Hybrid search: semantic hits (ranked by cosine) first, then any LIKE matches
// not already surfaced, capped at `limit`. Falls back to pure LIKE when there
// are no embeddings or the embedder is unavailable — so seeded/un-ingested DBs
// still work exactly as before.
export async function searchBehaviors(
  db: Database,
  embedder: Embedder,
  query: string,
  limit = 10,
): Promise<Behavior[]> {
  const q = query.trim();
  if (!q) return listBehaviors(db).slice(0, limit);

  const lexical = queryBehavior(db, q, limit);

  const embedded = listBehaviorEmbeddings(db);
  if (embedded.length === 0) return lexical;

  const queryVec = await embedder.embed(q);
  if (!queryVec) return lexical;

  const ranked = embedded
    .map(({ behavior, vector }) => ({
      behavior,
      score: cosineSimilarity(queryVec, unpackVector(vector)),
    }))
    .filter((r) => r.score >= SEMANTIC_FLOOR)
    .sort((a, b) => b.score - a.score);

  // Semantic order first; backfill with lexical matches not already present.
  const seen = new Set<string>();
  const out: Behavior[] = [];
  for (const r of ranked) {
    if (out.length >= limit) break;
    seen.add(r.behavior.id);
    out.push(r.behavior);
  }
  for (const b of lexical) {
    if (out.length >= limit) break;
    if (!seen.has(b.id)) {
      seen.add(b.id);
      out.push(b);
    }
  }
  return out;
}
