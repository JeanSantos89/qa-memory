import { describe, expect, it } from "vitest";
import type { Behavior } from "./repo/behaviors.js";
import type { Rule } from "./repo/rules.js";
import type { Incident } from "./repo/incidents.js";
import { computeRisk } from "./risk.js";
import { getLabels } from "./i18n.js";

const NOW = "2026-05-31T00:00:00.000Z";

function incident(over: Partial<Incident>): Incident {
  return {
    id: "i1",
    behavior_id: "b1",
    title: "broke",
    description: null,
    severity: "P1",
    source_type: "manual",
    source_ref: null,
    occurred_at: NOW,
    created_at: NOW,
    ...over,
  };
}

function behavior(over: Partial<Behavior>): Behavior {
  return {
    id: "b1",
    name: "B",
    description: "",
    criticality: "P2",
    status: "active",
    source_ids: [],
    confirmed_by_qa: true,
    qa_note: null,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

function rule(over: Partial<Rule>): Rule {
  return {
    id: "r1",
    behavior_id: "b1",
    rule_text: "",
    confidence: 1.0,
    source_excerpt: null,
    source_id: null,
    qa_override: true,
    override_reason: null,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

describe("computeRisk", () => {
  it("returns unknown when no behavior matches (no coverage)", () => {
    const r = computeRisk([], []);
    expect(r.level).toBe("unknown");
    expect(r.score).toBe(0);
  });

  it("P0 confirmed behavior with a QA rule scores high but with no uncertainty bonus", () => {
    const b = behavior({ id: "b1", criticality: "P0", confirmed_by_qa: true });
    const r = computeRisk([b], [rule({ behavior_id: "b1", qa_override: true })]);
    expect(r.score).toBe(1.0);
    expect(r.level).toBe("high");
    expect(r.reasons.some((x) => x.includes("knowledge gap"))).toBe(false);
  });

  it("compounds uncertainty: unconfirmed P2 with no rules outranks its base criticality", () => {
    const b = behavior({ id: "b1", criticality: "P2", confirmed_by_qa: false });
    const r = computeRisk([b], []); // base 0.4 + 0.1 unconfirmed + 0.1 no rules
    expect(r.score).toBeCloseTo(0.6, 5);
    expect(r.level).toBe("medium");
  });

  it("flags all-inferred low-confidence rules as a risk driver", () => {
    const b = behavior({ id: "b1", criticality: "P3", confirmed_by_qa: true });
    const r = computeRisk([b], [rule({ qa_override: false, confidence: 0.6 })]);
    expect(r.reasons.some((x) => x.includes("low-confidence"))).toBe(true);
  });

  it("a recent P1 incident lifts a low-base behavior and is echoed in reasons", () => {
    const b = behavior({ id: "b1", criticality: "P3", confirmed_by_qa: true });
    const base = computeRisk([b], [rule({ behavior_id: "b1" })], [], NOW).score; // 0.2
    const r = computeRisk(
      [b],
      [rule({ behavior_id: "b1" })],
      [incident({ severity: "P1", occurred_at: NOW })],
      NOW,
    );
    expect(r.score).toBeCloseTo(base + 0.2, 5);
    expect(r.reasons.some((x) => x.includes("already broke"))).toBe(true);
  });

  it("an old incident weighs half (recency decay)", () => {
    const b = behavior({ id: "b1", criticality: "P3", confirmed_by_qa: true });
    const old = "2025-01-01T00:00:00.000Z"; // > 90 days before NOW
    const r = computeRisk(
      [b],
      [rule({ behavior_id: "b1" })],
      [incident({ severity: "P1", occurred_at: old })],
      NOW,
    );
    expect(r.score).toBeCloseTo(0.2 + 0.1, 5); // P1 0.2 halved → 0.1
  });

  it("caps the incident addend no matter how many pile up", () => {
    const b = behavior({ id: "b1", criticality: "P3", confirmed_by_qa: true });
    const many = Array.from({ length: 10 }, (_, n) =>
      incident({ id: `i${n}`, severity: "P0", occurred_at: NOW }),
    );
    const r = computeRisk([b], [rule({ behavior_id: "b1" })], many, NOW);
    expect(r.score).toBeCloseTo(0.2 + 0.3, 5); // base 0.2 + capped 0.3
    expect(r.reasons.some((x) => x.includes("capped"))).toBe(true);
  });

  it("no incidents → no addend, no incident reason", () => {
    const b = behavior({ id: "b1", criticality: "P2", confirmed_by_qa: true });
    const r = computeRisk([b], [rule({ behavior_id: "b1" })], [], NOW);
    expect(r.reasons.some((x) => x.includes("already broke"))).toBe(false);
  });

  it("renders reasons in the requested language (pt-BR)", () => {
    const ptLabels = getLabels({ QA_MEMORY_LANG: "pt-BR" });
    const b = behavior({ id: "b1", criticality: "P0", confirmed_by_qa: false });
    const r = computeRisk(
      [b],
      [],
      [incident({ severity: "P1", occurred_at: NOW })],
      NOW,
      ptLabels,
    );
    expect(r.reasons.some((x) => x.includes("Maior criticidade"))).toBe(true);
    expect(r.reasons.some((x) => x.includes("já quebrou"))).toBe(true);
  });

  it("empty-coverage reason is localized too", () => {
    const ptLabels = getLabels({ QA_MEMORY_LANG: "pt-BR" });
    const r = computeRisk([], [], [], NOW, ptLabels);
    expect(r.reasons[0]).toContain("não tem cobertura");
  });
});
