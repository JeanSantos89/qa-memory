// Areas data access. An area maps a file_pattern (glob) to the behaviors that
// live behind those files — the missing link for "I'm about to touch
// checkout/*.ts, what does that risk?". The QA passes a PATH; areas resolve it
// to behavior ids before any semantic guessing.
//
// Glob matching is done with a small native matcher (no dep — CLAUDE.md: check
// existing deps first; minimatch is NOT in the tree and a full glob lib is
// overkill for file_pattern matching). Supports: `*` (within a path segment),
// `**` (across segments), `?` (one char). Matching is anchored (whole path).
import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";

export interface Area {
  id: string;
  file_pattern: string;
  behavior_ids: string[];
  notes: string | null;
  created_at: string;
}

interface AreaRow {
  id: string;
  file_pattern: string;
  behavior_ids: string;
  notes: string | null;
  created_at: string;
}

function hydrate(row: AreaRow): Area {
  return {
    id: row.id,
    file_pattern: row.file_pattern,
    behavior_ids: JSON.parse(row.behavior_ids) as string[],
    notes: row.notes,
    created_at: row.created_at,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

// Compiles a glob into an anchored RegExp. Path separators are normalized to
// "/" so a Windows path and a POSIX pattern still meet. `**` crosses segments,
// `*` stays within one, `?` is one non-separator char. `{a,b,c}` expands to
// alternation. Leading `!` negates (returns a pattern that never matches the
// path, signaling the caller to invert; callers should use matchesGlob which
// handles negation transparently).
export function globToRegExp(pattern: string): { re: RegExp; negated: boolean } {
  const negated = pattern.startsWith("!");
  const src = negated ? pattern.slice(1) : pattern;
  const normalized = src.replace(/\\/g, "/");

  function compile(s: string): string {
    let re = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!;
      if (c === "*") {
        if (s[i + 1] === "*") {
          re += ".*";
          i++;
          if (s[i + 1] === "/") i++;
        } else {
          re += "[^/]*";
        }
      } else if (c === "?") {
        re += "[^/]";
      } else if (c === "{") {
        // Expand {a,b,c} into (?:a|b|c). Supports nested patterns inside arms.
        const close = s.indexOf("}", i + 1);
        if (close === -1) {
          re += escapeRegex(c); // malformed brace — treat literally
        } else {
          const arms = s.slice(i + 1, close).split(",").map(compile);
          re += `(?:${arms.join("|")})`;
          i = close;
        }
      } else {
        re += escapeRegex(c);
      }
    }
    return re;
  }

  return { re: new RegExp(`^${compile(normalized)}$`), negated };
}

// True if filePath matches the glob (both normalized to "/"). Handles negation.
export function matchesGlob(pattern: string, filePath: string): boolean {
  const { re, negated } = globToRegExp(pattern);
  const match = re.test(filePath.replace(/\\/g, "/"));
  return negated ? !match : match;
}

export interface NewArea {
  file_pattern: string;
  behavior_ids: string[];
  notes?: string | null;
}

// Inserts an area, returns its id. Used by map_area + seeding + tests.
export function insertArea(
  db: Database,
  a: NewArea,
  now: string = new Date().toISOString(),
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO areas (id, file_pattern, behavior_ids, notes, created_at)
     VALUES (@id, @file_pattern, @behavior_ids, @notes, @created_at)`,
  ).run({
    id,
    file_pattern: a.file_pattern,
    behavior_ids: JSON.stringify(a.behavior_ids),
    notes: a.notes ?? null,
    created_at: now,
  });
  return id;
}

export function listAreas(db: Database): Area[] {
  const rows = db
    .prepare("SELECT * FROM areas ORDER BY created_at DESC")
    .all() as AreaRow[];
  return rows.map(hydrate);
}

// Resolves a file path to the union of behavior ids of every area whose glob
// matches it. Empty if no area matches (caller falls back to semantic search).
// Dedups while preserving first-seen order.
export function behaviorIdsForPath(db: Database, filePath: string): string[] {
  const seen = new Set<string>();
  for (const area of listAreas(db)) {
    if (matchesGlob(area.file_pattern, filePath)) {
      for (const id of area.behavior_ids) seen.add(id);
    }
  }
  return [...seen];
}
