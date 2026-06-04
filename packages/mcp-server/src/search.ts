// Behavior search — semantic when embeddings exist, lexical (LIKE) otherwise.
// query_behavior + query_risk both route through here, so upgrading retrieval
// here lifts both tools at once.
import type { Database } from "better-sqlite3";
import {
  type Behavior,
  behaviorsByIds,
  listBehaviorEmbeddings,
  listBehaviors,
  queryBehavior,
} from "./repo/behaviors.js";
import { listRuleEmbeddings } from "./repo/rules.js";
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

  // Rule-level semantic hits: surface behaviors whose rules match the query even
  // when the behavior name/description doesn't. Appended after behavior-level
  // results so behavior hits always rank first.
  if (out.length < limit) {
    const ruleEmbeddings = listRuleEmbeddings(db);
    if (ruleEmbeddings.length > 0) {
      const ruleHitIds = ruleEmbeddings
        .map(({ behavior_id, vector }) => ({
          behavior_id,
          score: cosineSimilarity(queryVec, unpackVector(vector)),
        }))
        .filter((r) => r.score >= SEMANTIC_FLOOR && !seen.has(r.behavior_id))
        .sort((a, b) => b.score - a.score)
        .map((r) => r.behavior_id);

      const unique = [...new Set(ruleHitIds)];
      if (unique.length > 0) {
        const extra = behaviorsByIds(db, unique);
        for (const b of extra) {
          if (out.length >= limit) break;
          if (!seen.has(b.id)) {
            seen.add(b.id);
            out.push(b);
          }
        }
      }
    }
  }

  return out;
}
