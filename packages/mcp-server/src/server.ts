// MCP server wiring. Registers the query_behavior tool over the behaviors repo.
import type { Database } from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { countBehaviors, queryBehavior } from "./repo/behaviors.js";
import { emptyStateHint, registerPrompts } from "./prompts.js";
import {
  getRuleById,
  insertRule,
  listRulesForBehaviors,
  overrideRule,
} from "./repo/rules.js";
import { type Embedder, PersistentEmbedder } from "./embedder.js";
import { type Ingester, PythonIngester } from "./ingester.js";
import { searchBehaviors } from "./search.js";
import { computeRisk } from "./risk.js";
import { VERSION } from "./version.js";

// embedder + ingester are injectable so tests run without the Python
// subprocess/model/API key.
export function createServer(
  db: Database,
  embedder: Embedder = new PersistentEmbedder(),
  ingester: Ingester = new PythonIngester(),
): McpServer {
  const server = new McpServer({ name: "qa-memory", version: VERSION });

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
            : `No behaviors match "${args.query}".`
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
      const behaviors = await searchBehaviors(db, embedder, args.query);
      const rules = listRulesForBehaviors(
        db,
        behaviors.map((b) => b.id),
      );
      const risk = computeRisk(behaviors, rules);

      const header = `Risk: ${risk.level.toUpperCase()} (${risk.score.toFixed(2)}) for "${args.query}"`;
      const why = risk.reasons.map((r) => `  • ${r}`).join("\n");
      const behaviorLines = behaviors
        .map((b) => {
          const own = rules.filter((r) => r.behavior_id === b.id);
          const ruleText =
            own.length === 0
              ? "    (no known rules)"
              : own
                  .map(
                    (r) =>
                      `    - ${r.rule_text} [${r.qa_override ? "QA" : "inferred"} ${r.confidence.toFixed(2)}]`,
                  )
                  .join("\n");
          return `${b.criticality} ${b.name}${b.confirmed_by_qa ? " ✓" : ""}\n${ruleText}`;
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
        structuredContent: { ...risk, behaviors, rules },
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
    "add_to_memory",
    {
      title: "Remember text into qa-memory",
      description:
        "Ingest raw text (a fetched page, pasted notes, anything in hand) into the QA knowledge base: " +
        "it is extracted into behaviors + rules and embedded for search. " +
        "Hand it text you already have — for auth'd sources (Jira/Confluence/Drive), fetch with your own tools first, then pass the text here. " +
        "Requires the Python ingestion package + ANTHROPIC_API_KEY on the server.",
      inputSchema: {
        text: z.string().describe("The text to remember"),
        label: z.string().optional().describe("Short human label for this source (e.g. 'Checkout spec')"),
        source_type: z
          .string()
          .optional()
          .describe("Where it came from: confluence|jira|google_doc|conversation (default conversation)"),
      },
    },
    (args: { text: string; label?: string; source_type?: string }) => {
      if (!args.text.trim()) {
        return {
          content: [{ type: "text" as const, text: "Nothing to remember — text was empty." }],
          structuredContent: { ok: false },
        };
      }
      const result = ingester.ingestText(args.text, {
        label: args.label ?? "text",
        sourceType: args.source_type ?? "conversation",
      });
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

  registerPrompts(server, db);

  return server;
}
