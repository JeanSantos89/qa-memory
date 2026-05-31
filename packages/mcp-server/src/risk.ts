// Risk scoring — pure, transparent, testable. No DB access here.
// Score is DERIVED from ingredients we already store:
//   1. base = worst criticality among the matched behaviors (P0 = highest stake)
//   2. uncertainty modifiers = how shaky our knowledge of those behaviors is
//   3. incident addend = what already BROKE here (the strongest QA signal),
//      weighted by severity + recency, capped so it lifts the floor without
//      swamping the score.
// Every contribution is echoed in `reasons` so the agent can see WHY, not just a number.
import type { Behavior } from "./repo/behaviors.js";
import type { Rule } from "./repo/rules.js";
import type { Incident } from "./repo/incidents.js";
import { type Labels, getLabels } from "./i18n.js";

// Confidence we want before treating an inferred rule as solid knowledge.
const CONFIRMED_RULE_CONFIDENCE = 0.7;

// Incident severity → its full (recent) weight.
const SEVERITY_WEIGHT: Record<string, number> = {
  P0: 0.3,
  P1: 0.2,
  P2: 0.1,
  P3: 0.05,
};
const SEVERITY_DEFAULT = 0.1; // unknown/custom severity → middle stake

// Recency decay: an incident inside the window weighs full; older ones half.
// Keeps "it broke last week" louder than "it broke two years ago" without a
// per-day curve nobody can read in reasons[].
const RECENCY_WINDOW_DAYS = 90;
const STALE_FACTOR = 0.5;
const DAY_MS = 24 * 60 * 60 * 1000;

// The incident addend can lift risk by at most this much, no matter how many
// incidents pile up — base criticality still dominates.
const INCIDENT_ADDEND_CAP = 0.3;

export type RiskLevel = "high" | "medium" | "low" | "unknown";

export interface RiskAssessment {
  score: number; // 0..1
  level: RiskLevel;
  reasons: string[];
}

const CRITICALITY_WEIGHT: Record<string, number> = {
  P0: 1.0,
  P1: 0.7,
  P2: 0.4,
  P3: 0.2,
};

function criticalityWeight(c: string): number {
  return CRITICALITY_WEIGHT[c] ?? 0.5; // custom/unknown → middle stake
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function levelFor(score: number): RiskLevel {
  if (score >= 0.8) return "high";
  if (score >= 0.5) return "medium";
  return "low";
}

function severityWeight(s: string | null): number {
  if (!s) return SEVERITY_DEFAULT;
  return SEVERITY_WEIGHT[s] ?? SEVERITY_DEFAULT;
}

// Weight one incident: severity, halved if it occurred before the recency
// window. Bad/missing dates are treated as recent (don't silently discount).
function incidentWeight(i: Incident, nowMs: number): number {
  const w = severityWeight(i.severity);
  const when = i.occurred_at ?? i.created_at;
  const t = Date.parse(when);
  if (Number.isNaN(t)) return w;
  const stale = nowMs - t > RECENCY_WINDOW_DAYS * DAY_MS;
  return stale ? w * STALE_FACTOR : w;
}

// behaviors = matched behaviors; rules = visible rules across those behaviors;
// incidents = recorded incidents across those behaviors. `now` anchors recency
// (passed in so this stays pure/testable).
export function computeRisk(
  behaviors: Behavior[],
  rules: Rule[],
  incidents: Incident[] = [],
  now: string = new Date().toISOString(),
  labels: Labels = getLabels(),
): RiskAssessment {
  if (behaviors.length === 0) {
    return {
      score: 0,
      level: "unknown",
      reasons: [labels.reasonNoCoverage],
    };
  }

  const reasons: string[] = [];

  // Base: the worst criticality at stake drives the floor.
  const worst = behaviors.reduce((acc, b) =>
    criticalityWeight(b.criticality) > criticalityWeight(acc.criticality) ? b : acc,
  );
  const base = criticalityWeight(worst.criticality);
  reasons.push(labels.reasonHighestCriticality(worst.criticality, worst.name));

  // Uncertainty modifiers — each compounds risk because we may be missing rules.
  let bonus = 0;

  const unconfirmed = behaviors.filter((b) => !b.confirmed_by_qa);
  if (unconfirmed.length > 0) {
    bonus += 0.1;
    reasons.push(labels.reasonUnconfirmed(unconfirmed.length));
  }

  const rulesByBehavior = new Map<string, Rule[]>();
  for (const r of rules) {
    const list = rulesByBehavior.get(r.behavior_id) ?? [];
    list.push(r);
    rulesByBehavior.set(r.behavior_id, list);
  }

  const noRules = behaviors.filter((b) => !rulesByBehavior.has(b.id));
  if (noRules.length > 0) {
    bonus += 0.1;
    reasons.push(labels.reasonNoRules(noRules.length));
  }

  const allInferred =
    rules.length > 0 &&
    rules.every((r) => !r.qa_override && r.confidence < CONFIRMED_RULE_CONFIDENCE);
  if (allInferred) {
    bonus += 0.1;
    reasons.push(labels.reasonAllInferred);
  }

  // Incident addend — what already broke here. Strongest QA signal, so it adds
  // ON TOP of the uncertainty bonus, weighted by severity + recency, capped.
  if (incidents.length > 0) {
    const nowMs = Date.parse(now);
    const raw = incidents.reduce((sum, i) => sum + incidentWeight(i, nowMs), 0);
    const addend = Math.min(raw, INCIDENT_ADDEND_CAP);
    if (addend > 0) {
      bonus += addend;
      reasons.push(
        labels.reasonIncidents(incidents.length, addend.toFixed(2), raw > INCIDENT_ADDEND_CAP),
      );
    }
  }

  const score = clamp01(base + bonus);
  return { score: Math.round(score * 100) / 100, level: levelFor(score), reasons };
}
