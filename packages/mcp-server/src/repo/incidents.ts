// Incidents data access. Incidents belong to behaviors: the history of what
// already broke. "What broke here before" is the strongest signal a QA has,
// so incidents feed the risk score (see risk.ts) — every one that moves the
// number is echoed in reasons[]. Mirrors rules.ts.
import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";

// Severity ladder mirrors behavior criticality (SCHEMA: P0|P1|P2|P3).
export type Severity = "P0" | "P1" | "P2" | "P3" | string;

export interface Incident {
  id: string;
  behavior_id: string;
  title: string;
  description: string | null;
  severity: Severity | null;
  source_type: string | null;
  source_ref: string | null;
  occurred_at: string | null;
  created_at: string;
}

interface IncidentRow {
  id: string;
  behavior_id: string;
  title: string;
  description: string | null;
  severity: string | null;
  source_type: string | null;
  source_ref: string | null;
  occurred_at: string | null;
  created_at: string;
}

function hydrate(row: IncidentRow): Incident {
  return {
    id: row.id,
    behavior_id: row.behavior_id,
    title: row.title,
    description: row.description,
    severity: row.severity,
    source_type: row.source_type,
    source_ref: row.source_ref,
    occurred_at: row.occurred_at,
    created_at: row.created_at,
  };
}

export interface NewIncident {
  behavior_id: string;
  title: string;
  description?: string | null;
  severity?: Severity | null;
  source_type?: string | null;
  source_ref?: string | null;
  occurred_at?: string | null;
}

// Inserts an incident, returns its id. Used by record_incident + seeding + tests.
export function insertIncident(
  db: Database,
  i: NewIncident,
  now: string = new Date().toISOString(),
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO incidents
       (id, behavior_id, title, description, severity, source_type, source_ref, occurred_at, created_at)
     VALUES (@id, @behavior_id, @title, @description, @severity, @source_type, @source_ref, @occurred_at, @created_at)`,
  ).run({
    id,
    behavior_id: i.behavior_id,
    title: i.title,
    description: i.description ?? null,
    severity: i.severity ?? null,
    source_type: i.source_type ?? null,
    source_ref: i.source_ref ?? null,
    occurred_at: i.occurred_at ?? now,
    created_at: now,
  });
  return id;
}

// Returns incidents for the given behaviors, most recent occurrence first.
// Empty input → empty result. No confidence gate: an incident is a fact, not
// an inference.
export function listIncidentsForBehaviors(
  db: Database,
  behaviorIds: string[],
): Incident[] {
  if (behaviorIds.length === 0) return [];
  const placeholders = behaviorIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT * FROM incidents
       WHERE behavior_id IN (${placeholders})
       ORDER BY occurred_at DESC, created_at DESC`,
    )
    .all(...behaviorIds) as IncidentRow[];
  return rows.map(hydrate);
}
