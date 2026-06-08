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
import type { Translator } from "./translator.js";
import { cosineSimilarity, unpackVector } from "./embeddings.js";

// Below this cosine score a behavior is treated as unrelated. Override via
// QA_MEMORY_SEMANTIC_FLOOR env var (e.g. "0.3" for stricter matching).
// Read each call so tests and runtime config changes take effect without restart.
function semanticFloor(): number {
  const raw = process.env.QA_MEMORY_SEMANTIC_FLOOR;
  if (raw) {
    const v = parseFloat(raw);
    if (!isNaN(v) && v >= 0 && v <= 1) return v;
  }
  return 0.25;
}

// Hybrid search: semantic hits (ranked by cosine) first, then any LIKE matches
// not already surfaced, capped at `limit`. Falls back to pure LIKE when there
// are no embeddings or the embedder is unavailable — so seeded/un-ingested DBs
// still work exactly as before.
// Cross-language fallback: when the original query returns 0 results, we try
// the translated query (PT→EN or EN→PT). Only called when translator is provided
// AND the first pass returned nothing — so happy-path queries pay zero latency.
// Defined here (not inside searchBehaviors) to avoid a recursive default-arg loop.
async function searchWithTranslation(
  db: Database,
  embedder: Embedder,
  translation: string,
  limit: number,
): Promise<Behavior[]> {
  return searchBehaviors(db, embedder, translation, limit);
}

export async function searchBehaviors(
  db: Database,
  embedder: Embedder,
  query: string,
  limit = 10,
  translator?: Translator,
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
    .filter((r) => r.score >= semanticFloor())
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
        .filter((r) => r.score >= semanticFloor() && !seen.has(r.behavior_id))
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

  // Cross-language fallback: when the whole result set is empty and we have a
  // translator, try the translated query. A PT query against an EN-stored DB
  // (or vice-versa) can return nothing because all-MiniLM is EN-centric AND LIKE
  // never crosses languages — same root cause as ADR 027, now fixed here too.
  if (out.length === 0 && translator) {
    const { translation } = translator.translate(q);
    if (translation && translation.toLowerCase() !== q.toLowerCase()) {
      return searchWithTranslation(db, embedder, translation, limit);
    }
  }

  return out;
}
