// MCP server wiring. Registers the query_behavior tool over the behaviors repo.
import type { Database } from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { behaviorsByIds, countBehaviors, queryBehavior } from "./repo/behaviors.js";
import { behaviorIdsForPath, insertArea } from "./repo/areas.js";
import { emptyStateHint, registerPrompts } from "./prompts.js";
import {
  getRuleById,
  insertRule,
  listRulesForBehaviors,
  overrideRule,
} from "./repo/rules.js";
import { insertIncident, listIncidentsForBehaviors } from "./repo/incidents.js";
import { type Embedder, PersistentEmbedder } from "./embedder.js";
import { type Ingester, PythonIngester } from "./ingester.js";
import { type Assessor, PythonAssessor } from "./assessor.js";
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
      const results = await searchBehaviors(db, embedder, args.query);
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
        behaviors = await searchBehaviors(db, embedder, args.query);
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
    (args: {
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
        },
      };
    },
  );

  registerPrompts(server, db);

  return server;
}
