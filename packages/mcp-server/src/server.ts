// MCP server wiring. Registers the query_behavior tool over the behaviors repo.
import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  behaviorsByIds,
  confirmBehavior,
  countBehaviors,
  DEFAULT_BEHAVIOR_DUP_THRESHOLD,
  deprecateBehavior,
  findDuplicateBehaviors,
  queryBehavior,
} from "./repo/behaviors.js";
import { behaviorIdsForPath, insertArea } from "./repo/areas.js";
import { emptyStateHint, registerPrompts } from "./prompts.js";
import {
  DEFAULT_DUP_THRESHOLD,
  findDuplicateRules,
  getRuleById,
  insertRule,
  listRulesForBehaviors,
  listUnconfirmedRules,
  overrideRule,
  retireRule,
} from "./repo/rules.js";
import { insertIncident, listIncidentsForBehaviors } from "./repo/incidents.js";
import { type Embedder, PersistentEmbedder } from "./embedder.js";
import { type Ingester, PythonIngester } from "./ingester.js";
import { type Assessor, PythonAssessor } from "./assessor.js";
import { type Translator, PythonTranslator } from "./translator.js";
import { feedKnowledge, packVector } from "./feed.js";
import { searchBehaviors } from "./search.js";
import { computeRisk } from "./risk.js";
import { getLabels } from "./i18n.js";
import { VERSION } from "./version.js";

// Heuristic: does this query look like a file path (so we should try area
// resolution) rather than free-text? A slash, a backslash, or a leading-dot
// extension (e.g. checkout/page.ts, src\app, *.tsx) signals a path.
function looksLikePath(q: string): boolean {
  return /[\\/]/.test(q) || /\.[a-z0-9]+$/i.test(q.trim());
}

// embedder + ingester are injectable so tests run without the Python
// subprocess/model/API key.
export function createServer(
  db: Database,
  embedder: Embedder = new PersistentEmbedder(),
  ingester: Ingester = new PythonIngester(),
  assessor: Assessor = new PythonAssessor(),
  translator: Translator = new PythonTranslator(),
): McpServer {
  const server = new McpServer({ name: "qa-memory", version: VERSION });
  const L = getLabels(); // presentation labels, chosen by QA_MEMORY_LANG

  server.registerTool(
    "query_behavior",
    {
      title: "Query behaviors",
      description:
        "Search product behaviors by free text (matches name + description). Empty query returns all active behaviors.",
      inputSchema: { query: z.string().describe("Free-text search over behavior name + description") },
    },
    async (args: { query: string }) => {
      const results = await searchBehaviors(db, embedder, args.query, 10, translator);
      const text =
        results.length === 0
          ? countBehaviors(db) === 0
            ? emptyStateHint()
            : L.noBehaviorMatch(args.query)
          : results
              .map((b) => `${b.criticality} ${b.name}${b.confirmed_by_qa ? " ✓" : ""}\n  ${b.description}`)
              .join("\n\n");

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { count: results.length, behaviors: results },
      };
    },
  );

  server.registerTool(
    "query_risk",
    {
      title: "Assess risk for an area",
      description:
        "Given a free-text area/feature, return a derived risk score (0..1) + level, the matched behaviors, their rules, and the reasons behind the score. Use before deciding test depth for a change.",
      inputSchema: { query: z.string().describe("Free-text area, feature, or file to assess") },
    },
    async (args: { query: string }) => {
      // If the query looks like a file path, resolve it through mapped areas
      // first (the QA passes the path they're about to touch). Fall back to
      // semantic search when no area matches or the query isn't a path.
      let behaviors = looksLikePath(args.query)
        ? behaviorsByIds(db, behaviorIdsForPath(db, args.query))
        : [];
      let resolvedVia: "area" | "search" = "area";
      if (behaviors.length === 0) {
        behaviors = await searchBehaviors(db, embedder, args.query, 10, translator);
        resolvedVia = "search";
      }
      const behaviorIds = behaviors.map((b) => b.id);
      const rules = listRulesForBehaviors(db, behaviorIds);
      const incidents = listIncidentsForBehaviors(db, behaviorIds);
      const risk = computeRisk(behaviors, rules, incidents, undefined, L);

      const via = resolvedVia === "area" ? L.resolvedViaArea : "";
      const header = L.riskHeader(risk.level.toUpperCase(), risk.score.toFixed(2), args.query, via);
      const why = risk.reasons.map((r) => `  • ${r}`).join("\n");
      const behaviorLines = behaviors
        .map((b) => {
          const own = rules.filter((r) => r.behavior_id === b.id);
          const ruleText =
            own.length === 0
              ? `    ${L.noKnownRules}`
              : own
                  .map(
                    (r) =>
                      `    - ${r.rule_text} [${L.ruleTag(r.qa_override ? "qa" : "inferred", r.confidence.toFixed(2))}]`,
                  )
                  .join("\n");
          const ownIncidents = incidents.filter((i) => i.behavior_id === b.id);
          const incidentText =
            ownIncidents.length === 0
              ? ""
              : "\n" +
                ownIncidents
                  .map(
                    (i) =>
                      `    ⚠ ${L.brokeLabel(i.title, i.severity ? ` [${i.severity}]` : "", i.source_ref ? ` (${i.source_ref})` : "")}`,
                  )
                  .join("\n");
          return `${b.criticality} ${b.name}${b.confirmed_by_qa ? " ✓" : ""}\n${ruleText}${incidentText}`;
        })
        .join("\n\n");

      const text =
        behaviors.length === 0
          ? countBehaviors(db) === 0
            ? `${header}\n${why}\n\n${emptyStateHint()}`
            : `${header}\n${why}`
          : `${header}\n${why}\n\n${behaviorLines}`;

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { ...risk, behaviors, rules, incidents, resolvedVia },
      };
    },
  );

  server.registerTool(
    "map_area",
    {
      title: "Map a file pattern to behaviors",
      description:
        "Associate a file glob (e.g. \"checkout/**/*.ts\") with the behaviors that live behind those files. " +
        "Afterwards, query_risk can take a PATH and resolve the risk through this mapping instead of guessing from text. " +
        "Resolve each behavior from free text — unique match required (none or many → asks you to refine, never guesses).",
      inputSchema: {
        file_pattern: z.string().describe("Glob pattern over file paths, e.g. checkout/**/*.ts or *.tsx"),
        behaviors: z
          .array(z.string())
          .min(1)
          .describe("Free-text identifiers of the behaviors behind these files (each must match exactly one)"),
        notes: z.string().optional().describe("Optional note about this mapping"),
      },
    },
    (args: { file_pattern: string; behaviors: string[]; notes?: string }) => {
      const fail = (msg: string) => ({
        content: [{ type: "text" as const, text: msg }],
        structuredContent: { ok: false, reason: msg },
      });

      if (!args.file_pattern.trim()) return fail("Provide a `file_pattern` (glob over file paths).");

      // Resolve every behavior to a single match — never guess.
      const ids: string[] = [];
      for (const text of args.behaviors) {
        const matches = queryBehavior(db, text);
        if (matches.length === 0) {
          return fail(`No behavior matches "${text}". Create the behavior first.`);
        }
        if (matches.length > 1) {
          const list = matches.map((b) => `  • ${b.name} (${b.criticality})`).join("\n");
          return fail(`"${text}" matches ${matches.length} behaviors — refine the text:\n${list}`);
        }
        ids.push(matches[0]!.id);
      }

      const id = insertArea(db, {
        file_pattern: args.file_pattern,
        behavior_ids: ids,
        notes: args.notes ?? null,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Mapped "${args.file_pattern}" → ${ids.length} behavior(s). query_risk can now resolve paths matching this glob.`,
          },
        ],
        structuredContent: { ok: true, area_id: id, behavior_ids: ids },
      };
    },
  );

  server.registerTool(
    "update_rule",
    {
      title: "Define or override a rule (QA voice)",
      description:
        "Record a QA-authoritative rule in natural language. Pins it as confirmed (confidence 1.0, qa_override). " +
        "Pass `rule_id` to override an existing rule; otherwise pass `behavior` (free text) to attach a new rule to the single matching behavior. " +
        "If the behavior text matches none or many, the tool asks you to refine instead of guessing.",
      inputSchema: {
        rule_text: z.string().describe("The rule, in plain language — what the product must do"),
        reason: z.string().describe("Why QA is asserting/overriding this (audit trail)"),
        rule_id: z.string().optional().describe("Id of an existing rule to override"),
        behavior: z
          .string()
          .optional()
          .describe("Free text identifying the behavior to attach a new rule to"),
      },
    },
    (args: { rule_text: string; reason: string; rule_id?: string; behavior?: string }) => {
      const fail = (msg: string) => ({
        content: [{ type: "text" as const, text: msg }],
        structuredContent: { ok: false, reason: msg },
      });

      // Override path: target a specific existing rule.
      if (args.rule_id) {
        const updated = overrideRule(db, args.rule_id, args.rule_text, args.reason);
        if (!updated) return fail(`No rule with id "${args.rule_id}".`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Overrode rule ${updated.id} (now QA-confirmed, confidence 1.00).\n  ${updated.rule_text}`,
            },
          ],
          structuredContent: { ok: true, action: "override", rule: updated },
        };
      }

      // Create path: resolve the behavior from free text — must be unambiguous.
      if (!args.behavior) {
        return fail("Provide either `rule_id` (to override) or `behavior` (to attach a new rule).");
      }
      const matches = queryBehavior(db, args.behavior);
      if (matches.length === 0) {
        return fail(`No behavior matches "${args.behavior}". Create the behavior first.`);
      }
      if (matches.length > 1) {
        const list = matches.map((b) => `  • ${b.name} (${b.criticality})`).join("\n");
        return fail(
          `"${args.behavior}" matches ${matches.length} behaviors — refine the text:\n${list}`,
        );
      }

      const behavior = matches[0]!;
      const id = insertRule(db, {
        behavior_id: behavior.id,
        rule_text: args.rule_text,
        confidence: 1.0,
        qa_override: true,
        override_reason: args.reason,
      });
      const rule = getRuleById(db, id)!;
      return {
        content: [
          {
            type: "text" as const,
            text: `Added QA rule to "${behavior.name}" (confidence 1.00).\n  ${rule.rule_text}`,
          },
        ],
        structuredContent: { ok: true, action: "create", rule },
      };
    },
  );

  server.registerTool(
    "record_incident",
    {
      title: "Record an incident against a behavior",
      description:
        "Record something that BROKE — a bug, regression, or failure — against the single behavior it hit. " +
        "Incidents feed query_risk: 'what already broke here' raises the risk score (severity + recency weighted, capped, always shown in reasons). " +
        "Pass `behavior` (free text) to resolve the target behavior; if it matches none or many, the tool asks you to refine instead of guessing.",
      inputSchema: {
        behavior: z.string().describe("Free text identifying the behavior that broke"),
        title: z.string().describe("Short description of what broke"),
        severity: z
          .string()
          .optional()
          .describe("P0|P1|P2|P3 (P0 = worst). Drives how much the incident lifts risk."),
        description: z.string().optional().describe("Longer detail of the incident"),
        source_ref: z.string().optional().describe("Reference: ticket key, URL, CI run, etc."),
        occurred_at: z.string().optional().describe("ISO date the incident occurred (defaults to now)"),
      },
    },
    async (args: {
      behavior: string;
      title: string;
      severity?: string;
      description?: string;
      source_ref?: string;
      occurred_at?: string;
    }) => {
      const fail = (msg: string) => ({
        content: [{ type: "text" as const, text: msg }],
        structuredContent: { ok: false, reason: msg },
      });

      if (!args.title.trim()) return fail("An incident needs a `title` — what broke?");

      const matches = queryBehavior(db, args.behavior);
      if (matches.length === 0) {
        return fail(`No behavior matches "${args.behavior}". Create the behavior first.`);
      }
      if (matches.length > 1) {
        const list = matches.map((b) => `  • ${b.name} (${b.criticality})`).join("\n");
        return fail(
          `"${args.behavior}" matches ${matches.length} behaviors — refine the text:\n${list}`,
        );
      }

      const behavior = matches[0]!;
      const id = insertIncident(db, {
        behavior_id: behavior.id,
        title: args.title,
        severity: args.severity ?? null,
        description: args.description ?? null,
        source_type: "manual",
        source_ref: args.source_ref ?? null,
        occurred_at: args.occurred_at ?? null,
      });

      // Embed the incident so analyze_impact can find behaviors via incident
      // semantic similarity (the "blind to incident history" gap, Issue 6). The
      // warm embedder makes this ~10ms. Failure is silent — risk score still works.
      const incidentText = args.title + (args.description ? " " + args.description : "");
      const incVec = await embedder.embed(incidentText);
      if (incVec) {
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO embeddings (id, entity_type, entity_id, content, vector, model, created_at)
           VALUES (?, 'incident', ?, ?, ?, 'all-MiniLM-L6-v2', ?)`,
        ).run(randomUUID(), id, incidentText, packVector(incVec), now);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Recorded incident against "${behavior.name}"${args.severity ? ` [${args.severity}]` : ""}.\n  ${args.title}\nIt now lifts the risk score for this area (shown in query_risk reasons).`,
          },
        ],
        structuredContent: { ok: true, incident_id: id, behavior_id: behavior.id },
      };
    },
  );

  server.registerTool(
    "confirm_behavior",
    {
      title: "Confirm a behavior as QA-authoritative",
      description:
        "Mark a behavior as QA-confirmed (confirmed_by_qa = true). " +
        "Unconfirmed behaviors add an uncertainty penalty to the risk score — confirming them " +
        "removes that penalty and signals the knowledge is trusted. " +
        "Requires the behavior id (from query_behavior / find_duplicate_behaviors). " +
        "Optional note to record why it was confirmed.",
      inputSchema: {
        behavior_id: z.string().describe("Id of the behavior to confirm"),
        note: z.string().optional().describe("Optional QA note about this confirmation"),
      },
    },
    (args: { behavior_id: string; note?: string }) => {
      const fail = (msg: string) => ({
        content: [{ type: "text" as const, text: msg }],
        structuredContent: { ok: false, reason: msg },
      });
      const confirmed = confirmBehavior(db, args.behavior_id, args.note ?? null);
      if (!confirmed)
        return fail(
          `No active behavior with id "${args.behavior_id}" (unknown or already deprecated).`,
        );
      return {
        content: [
          {
            type: "text" as const,
            text: `Confirmed behavior "${confirmed.name}" (${confirmed.id}) ✓. Risk score uncertainty penalty removed.`,
          },
        ],
        structuredContent: { ok: true, behavior: confirmed },
      };
    },
  );

  server.registerTool(
    "review_memory",
    {
      title: "Review the memory curation queue",
      description:
        "List the rules awaiting QA confirmation — inferred rules the system extracted but no human has confirmed yet (qa_override=0). " +
        "INCLUDES under_review rules (confidence < 0.5) that are hidden from every other read, so they can be rescued or discarded. " +
        "This is the memory-keeper's worklist: surface candidates, confirm them with the user, then promote each via update_rule (pass its rule_id). " +
        "Read-only — it changes nothing.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max rules to return (default 50). Weakest confidence first."),
      },
    },
    (args: { limit?: number }) => {
      const all = listUnconfirmedRules(db);
      const pending = all.slice(0, args.limit ?? 50);

      if (pending.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                countBehaviors(db) === 0
                  ? emptyStateHint()
                  : L.reviewMemoryEmpty,
            },
          ],
          structuredContent: { count: 0, total: all.length, pending: [] },
        };
      }

      // Group by behavior, preserving the weakest-first order of first appearance.
      const order: string[] = [];
      const byBehavior = new Map<string, typeof pending>();
      for (const p of pending) {
        const key = p.rule.behavior_id;
        if (!byBehavior.has(key)) {
          byBehavior.set(key, []);
          order.push(key);
        }
        byBehavior.get(key)!.push(p);
      }

      const blocks = order
        .map((key) => {
          const group = byBehavior.get(key)!;
          const head = `${group[0]!.behavior_criticality} ${group[0]!.behavior_name}`;
          const lines = group
            .map((p) => {
              const flag = p.under_review ? `, ${L.reviewMemoryUnderReview}` : "";
              return `  - "${p.rule.rule_text}" [conf ${p.rule.confidence.toFixed(2)}${flag}, id ${p.rule.id}]`;
            })
            .join("\n");
          return `${head}\n${lines}`;
        })
        .join("\n\n");

      const truncated = all.length > pending.length ? pending.length : null;
      const header = L.reviewMemoryHeader(all.length, truncated);
      const footer = L.reviewMemoryFooter;

      return {
        content: [{ type: "text" as const, text: `${header}\n\n${blocks}\n\n${footer}` }],
        structuredContent: { count: pending.length, total: all.length, pending },
      };
    },
  );

  server.registerTool(
    "find_duplicate_rules",
    {
      title: "Find duplicate / near-duplicate rules",
      description:
        "Detect clusters of rules that say the same thing — the memory-keeper's dedup signal. " +
        "Two rules cluster when their normalized text is identical or their word overlap crosses the threshold; " +
        "clusters can span behaviors and include under_review rules. " +
        "Detection only — it NEVER merges or deletes. Surface the clusters, then let the user decide which to keep " +
        "(promote the canonical one via update_rule). Read-only.",
      inputSchema: {
        threshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(`Token-overlap cutoff 0..1 to treat two rules as duplicates (default ${DEFAULT_DUP_THRESHOLD}).`),
      },
    },
    (args: { threshold?: number }) => {
      const clusters = findDuplicateRules(db, args.threshold ?? DEFAULT_DUP_THRESHOLD);

      if (clusters.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                countBehaviors(db) === 0
                  ? emptyStateHint()
                  : "No duplicate rules found — memory looks deduplicated.",
            },
          ],
          structuredContent: { count: 0, clusters: [] },
        };
      }

      const blocks = clusters
        .map((group, i) => {
          const lines = group
            .map((d) => {
              const flag = d.rule.qa_override
                ? "QA"
                : d.rule.confidence < 0.5
                  ? `${d.rule.confidence.toFixed(2)}, UNDER REVIEW`
                  : d.rule.confidence.toFixed(2);
              return `  - "${d.rule.rule_text}" [${flag}, ${d.behavior_name}, id ${d.rule.id}]`;
            })
            .join("\n");
          return `Cluster ${i + 1} (${group.length} rules):\n${lines}`;
        })
        .join("\n\n");

      const footer =
        "Each cluster is a likely duplicate. Decide with the user which wording to keep, " +
        "promote the canonical rule via update_rule, and flag the rest for retirement.";

      return {
        content: [
          {
            type: "text" as const,
            text: `${clusters.length} duplicate cluster(s):\n\n${blocks}\n\n${footer}`,
          },
        ],
        structuredContent: { count: clusters.length, clusters },
      };
    },
  );

  server.registerTool(
    "retire_rule",
    {
      title: "Retire a redundant rule",
      description:
        "Retire a rule by id (status → superseded) — e.g. the non-canonical member of a duplicate cluster " +
        "after the user picked which wording to keep. The retired rule drops out of every read (query_risk, " +
        "review_memory, find_duplicate_rules); the reason is kept as the audit trail. " +
        "Use AFTER the user has chosen the canonical rule. Irreversible through the tools — confirm before calling.",
      inputSchema: {
        rule_id: z.string().describe("Id of the rule to retire (from find_duplicate_rules / review_memory)"),
        reason: z.string().describe("Why QA is retiring it (audit trail) — e.g. 'duplicate of <canonical>'"),
      },
    },
    (args: { rule_id: string; reason: string }) => {
      const fail = (msg: string) => ({
        content: [{ type: "text" as const, text: msg }],
        structuredContent: { ok: false, reason: msg },
      });
      if (!args.reason.trim()) return fail("A `reason` is required to retire a rule (audit trail).");
      const retired = retireRule(db, args.rule_id, args.reason);
      if (!retired) return fail(`No rule with id "${args.rule_id}".`);
      return {
        content: [
          {
            type: "text" as const,
            text: `Retired rule ${retired.id} (status: superseded). It no longer shows in risk, review, or dedup.\n  ${retired.rule_text}`,
          },
        ],
        structuredContent: { ok: true, rule: retired },
      };
    },
  );

  const FeedRuleSchema = z.object({
    rule_text: z.string().describe("The rule, in plain language"),
    confidence: z.number().min(0).max(1).optional().describe("0..1 (default 0.6 — agent inference)"),
    source_excerpt: z.string().optional().describe("Verbatim excerpt this rule was drawn from"),
    qa_override: z.boolean().optional().describe("True = QA-confirmed (default false = inference)"),
    override_reason: z.string().optional().describe("Reason when qa_override=true"),
  });

  const FeedBehaviorSchema = z.object({
    name: z.string().describe("Short behavior name"),
    description: z.string().describe("What the product does here"),
    criticality: z.string().describe("P0|P1|P2|P3"),
    confirmed_by_qa: z.boolean().optional(),
    qa_note: z.string().optional(),
    rules: z.array(FeedRuleSchema).optional(),
  });

  server.registerTool(
    "feed_to_memory",
    {
      title: "Feed structured knowledge (no LLM)",
      description:
        "Persist behaviors + rules directly from structured JSON — NO internal LLM call. " +
        "Use this instead of add_to_memory when YOU (the agent) are the extractor: " +
        "read the source (Jira task, Confluence page, notes), structure the knowledge yourself, " +
        "and call this tool. Local embeddings are still generated for semantic search. " +
        "Much cheaper than add_to_memory (zero extraction tokens).",
      inputSchema: {
        behaviors: z
          .array(FeedBehaviorSchema)
          .min(1)
          .describe("Behaviors + rules extracted from the source"),
        source: z
          .object({
            type: z.string().optional().describe("jira|confluence|google_doc|conversation|file"),
            label: z.string().optional().describe("Short human label, e.g. 'PROJ-123 — checkout'"),
            source_ref: z.string().optional().describe("Ticket key, URL, or path"),
          })
          .optional()
          .describe("Provenance of this knowledge (for curation trail)"),
      },
    },
    async (args: {
      behaviors: Array<{
        name: string;
        description: string;
        criticality: string;
        confirmed_by_qa?: boolean;
        qa_note?: string;
        rules?: Array<{
          rule_text: string;
          confidence?: number;
          source_excerpt?: string;
          qa_override?: boolean;
          override_reason?: string;
        }>;
      }>;
      source?: { type?: string; label?: string; source_ref?: string };
    }) => {
      const r = await feedKnowledge(db, args, embedder);
      const tail = r.embedder_available ? "" : " (embedder unavailable — LIKE-only search)";
      const text = `Fed ${r.behaviors} behavior(s), ${r.rules} rule(s), ${r.embeddings} embedding(s)${tail}.`;
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { ok: true, ...r },
      };
    },
  );

  server.registerTool(
    "add_to_memory",
    {
      title: "Remember a source into qa-memory",
      description:
        "Ingest knowledge into the QA knowledge base — it is extracted into behaviors + rules and embedded for search. " +
        "Give it exactly ONE of: `text` (a fetched page, pasted notes — for auth'd sources fetch with your own tools first), " +
        "`path` (a local file: .pdf is parsed, anything else read as text), or `url` (a PUBLIC page fetched server-side, no auth). " +
        "Requires the Python ingestion package + an LLM provider (QA_MEMORY_LLM) on the server.",
      inputSchema: {
        text: z.string().optional().describe("Raw text to remember"),
        path: z.string().optional().describe("Local file path to ingest (.pdf parsed, else read as text)"),
        url: z.string().optional().describe("Public URL to fetch and ingest (no auth — fetch private pages yourself, pass text)"),
        label: z.string().optional().describe("Short human label for this source (e.g. 'Checkout spec')"),
        source_type: z
          .string()
          .optional()
          .describe("For text only: where it came from — confluence|jira|google_doc|conversation (default conversation)"),
      },
    },
    (args: { text?: string; path?: string; url?: string; label?: string; source_type?: string }) => {
      const fail = (msg: string) => ({
        content: [{ type: "text" as const, text: msg }],
        structuredContent: { ok: false, message: msg },
      });

      // Exactly one source — refuse ambiguity instead of guessing precedence.
      const given = [
        args.text?.trim() ? "text" : null,
        args.path?.trim() ? "path" : null,
        args.url?.trim() ? "url" : null,
      ].filter(Boolean);
      if (given.length === 0) {
        return fail("Nothing to remember — provide one of `text`, `path`, or `url`.");
      }
      if (given.length > 1) {
        return fail(`Provide exactly ONE source — got ${given.join(" + ")}.`);
      }

      let result: { ok: boolean; message: string };
      if (args.path?.trim()) {
        result = ingester.ingestPath(args.path, { label: args.label });
      } else if (args.url?.trim()) {
        result = ingester.ingestUrl(args.url, { label: args.label });
      } else {
        result = ingester.ingestText(args.text!, {
          label: args.label ?? "text",
          sourceType: args.source_type ?? "conversation",
        });
      }
      return {
        content: [
          {
            type: "text" as const,
            text: result.ok ? `Remembered. ${result.message}` : `Could not ingest: ${result.message}`,
          },
        ],
        structuredContent: { ok: result.ok, message: result.message },
      };
    },
  );

  server.registerTool(
    "ingest_jira",
    {
      title: "Ingest a Jira issue into qa-memory",
      description:
        "Fetch a Jira issue by key (e.g. PROJ-123) and run it through the full extraction pipeline " +
        "(LLM two-pass → behaviors + rules → local embeddings). " +
        "Requires ATLASSIAN_BASE_URL, ATLASSIAN_EMAIL, and ATLASSIAN_API_TOKEN env vars on the server. " +
        "Use feed_to_memory instead if you have already read the issue and want zero LLM cost.",
      inputSchema: {
        key: z.string().describe("Jira issue key, e.g. PROJ-123"),
        label: z.string().optional().describe("Human label for this source (defaults to the issue key)"),
      },
    },
    (args: { key: string; label?: string }) => {
      if (!args.key.trim()) {
        return {
          content: [{ type: "text" as const, text: "Provide a `key` (e.g. PROJ-123)." }],
          structuredContent: { ok: false, message: "missing key" },
        };
      }
      const result = ingester.ingestJira(args.key.trim(), { label: args.label });
      return {
        content: [
          {
            type: "text" as const,
            text: result.ok
              ? `Ingested Jira issue ${args.key}. ${result.message}`
              : `Could not ingest ${args.key}: ${result.message}`,
          },
        ],
        structuredContent: { ok: result.ok, message: result.message },
      };
    },
  );

  server.registerTool(
    "ingest_confluence",
    {
      title: "Ingest a Confluence page into qa-memory",
      description:
        "Fetch a Confluence page by numeric ID or full URL and run it through the full extraction pipeline " +
        "(LLM two-pass → behaviors + rules → local embeddings). " +
        "Requires ATLASSIAN_BASE_URL, ATLASSIAN_EMAIL, and ATLASSIAN_API_TOKEN env vars on the server. " +
        "Use feed_to_memory instead if you have already read the page and want zero LLM cost.",
      inputSchema: {
        page: z
          .string()
          .describe("Confluence page numeric ID or full page URL (the ID is extracted automatically)"),
        label: z.string().optional().describe("Human label for this source (defaults to the page title)"),
      },
    },
    (args: { page: string; label?: string }) => {
      if (!args.page.trim()) {
        return {
          content: [{ type: "text" as const, text: "Provide a `page` (numeric ID or URL)." }],
          structuredContent: { ok: false, message: "missing page" },
        };
      }
      const result = ingester.ingestConfluence(args.page.trim(), { label: args.label });
      return {
        content: [
          {
            type: "text" as const,
            text: result.ok
              ? `Ingested Confluence page. ${result.message}`
              : `Could not ingest page: ${result.message}`,
          },
        ],
        structuredContent: { ok: result.ok, message: result.message },
      };
    },
  );

  server.registerTool(
    "analyze_impact",
    {
      title: "Analyze the impact of a proposed change",
      description:
        "Given a PROPOSED change in plain language (e.g. \"allow free cancellation up to 5 min after the restaurant accepts\"), " +
        "reason about its impact against the rules already in memory: what may BREAK, what to WATCH when testing, " +
        "and which EXISTING rules it CONFLICTS with. This is the step beyond query_risk (which only scores) — it reasons about conflict. " +
        "Requires the Python ingestion package + an LLM provider (QA_MEMORY_LLM) on the server.",
      inputSchema: {
        change: z.string().describe("The proposed change to analyze, in plain language"),
      },
    },
    async (args: { change: string }) => {
      if (!args.change.trim()) {
        return {
          content: [{ type: "text" as const, text: "Nothing to analyze — change was empty." }],
          structuredContent: { ok: false },
        };
      }
      // Embed the change with the WARM embedder and hand the vector to the
      // assessor so Python skips its cold embedding load (ADR 026). If the
      // embedder is unavailable (null), Python embeds it cold as before.
      const vector = await embedder.embed(args.change);
      const r = assessor.assess(args.change, vector);
      if (!r.ok) {
        return {
          content: [{ type: "text" as const, text: `Could not analyze: ${r.message}` }],
          structuredContent: { ok: false, message: r.message },
        };
      }

      const section = (title: string, items: string[]) =>
        items.length === 0
          ? `${title}\n  ${L.none}`
          : `${title}\n${items.map((i) => `  • ${i}`).join("\n")}`;
      const conflicts =
        r.conflicts.length === 0
          ? `${L.sectionConflicts}\n  ${L.none}`
          : `${L.sectionConflicts}\n` +
            r.conflicts.map((c) => `  ⚠ ${c.rule}\n    → ${c.why}`).join("\n");

      const text = [
        L.impactHeader(args.change),
        "",
        section(L.sectionMayBreak, r.breaks),
        "",
        section(L.sectionWatch, r.watch),
        "",
        conflicts,
        "",
        L.reasonedOver(r.relatedRules.length, r.tokens),
        // Cross-language retrieval degraded → tell the user recall was limited.
        ...(r.note ? [L.noteLabel(r.note)] : []),
      ].join("\n");

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          ok: true,
          breaks: r.breaks,
          watch: r.watch,
          conflicts: r.conflicts,
          relatedRules: r.relatedRules,
          tokens: r.tokens,
          note: r.note ?? null,
        },
      };
    },
  );

  server.registerTool(
    "find_duplicate_behaviors",
    {
      title: "Find duplicate / near-duplicate behaviors",
      description:
        "Detect clusters of behaviors that describe the same product area — the memory-keeper's dedup signal for behaviors. " +
        "Two behaviors cluster when their normalized (name + description) text is identical or their token-overlap crosses the threshold. " +
        "Detection only — it NEVER deprecates. Surface the clusters, then let the user decide which to keep " +
        "(deprecate the others via deprecate_behavior). Read-only.",
      inputSchema: {
        threshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            `Token-overlap cutoff 0..1 to treat two behaviors as duplicates (default ${DEFAULT_BEHAVIOR_DUP_THRESHOLD}).`,
          ),
      },
    },
    (args: { threshold?: number }) => {
      const clusters = findDuplicateBehaviors(db, args.threshold ?? DEFAULT_BEHAVIOR_DUP_THRESHOLD);

      if (clusters.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                countBehaviors(db) === 0
                  ? emptyStateHint()
                  : "No duplicate behaviors found — memory looks deduplicated.",
            },
          ],
          structuredContent: { count: 0, clusters: [] },
        };
      }

      const blocks = clusters
        .map((group, i) => {
          const lines = group
            .map(
              (d) =>
                `  - "${d.behavior.name}" [${d.behavior.criticality}${d.behavior.confirmed_by_qa ? ", QA✓" : ""}, id ${d.behavior.id}]\n    ${d.behavior.description}`,
            )
            .join("\n");
          return `Cluster ${i + 1} (${group.length} behaviors):\n${lines}`;
        })
        .join("\n\n");

      const footer =
        "Each cluster is a likely duplicate. Decide with the user which behavior to keep, " +
        "then call deprecate_behavior on the others (they drop out of all reads).";

      return {
        content: [
          {
            type: "text" as const,
            text: `${clusters.length} duplicate behavior cluster(s):\n\n${blocks}\n\n${footer}`,
          },
        ],
        structuredContent: { count: clusters.length, clusters },
      };
    },
  );

  server.registerTool(
    "deprecate_behavior",
    {
      title: "Deprecate a redundant behavior",
      description:
        "Deprecate a behavior by id (status → deprecated) — e.g. the non-canonical member of a duplicate cluster " +
        "after the user picked which behavior to keep. Deprecated behaviors drop out of every read " +
        "(query_behavior, query_risk, embeddings, dedup scans). " +
        "Use AFTER the user has chosen the canonical behavior. Irreversible through the tools — confirm before calling.",
      inputSchema: {
        behavior_id: z
          .string()
          .describe("Id of the behavior to deprecate (from find_duplicate_behaviors)"),
        reason: z
          .string()
          .describe("Why QA is deprecating it (audit trail) — e.g. 'duplicate of <canonical id>'"),
      },
    },
    (args: { behavior_id: string; reason: string }) => {
      const fail = (msg: string) => ({
        content: [{ type: "text" as const, text: msg }],
        structuredContent: { ok: false, reason: msg },
      });
      if (!args.reason.trim())
        return fail("A `reason` is required to deprecate a behavior (audit trail).");
      const deprecated = deprecateBehavior(db, args.behavior_id, args.reason);
      if (!deprecated)
        return fail(`No behavior with id "${args.behavior_id}".`);
      return {
        content: [
          {
            type: "text" as const,
            text: `Deprecated behavior "${deprecated.name}" (${deprecated.id}). It no longer shows in risk, search, or dedup.\n  Reason: ${args.reason}`,
          },
        ],
        structuredContent: { ok: true, behavior: deprecated },
      };
    },
  );

  registerPrompts(server, db);

  return server;
}
