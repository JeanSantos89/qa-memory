// Guided surface (Block B): MCP prompts that teach discovery without a UI.
// These appear in the client's prompt menu. They orient a fresh user (and the
// agent) on what qa-memory is and which tool to reach for — no dedicated UI,
// works for technical and non-technical users alike.
import type { Database } from "better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { countBehaviors } from "./repo/behaviors.js";

type PromptText = {
  messages: { role: "user" | "assistant"; content: { type: "text"; text: string } }[];
};

function userMsg(text: string): PromptText {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

// One source of truth for the empty-state lesson — reused by tools when the DB
// is empty so the first query teaches instead of just saying "no match".
export function emptyStateHint(): string {
  return [
    "qa-memory is empty — nothing has been remembered yet.",
    "",
    "Feed it knowledge first, then query:",
    "  • add_to_memory — paste a spec, notes, or a page you fetched; it is extracted into behaviors + rules.",
    "  • update_rule — state a rule in your own words (QA voice), e.g. \"checkout must lock the cart on payment\".",
    "",
    "Once something is in, query_behavior and query_risk start returning real answers.",
  ].join("\n");
}

export function registerPrompts(server: McpServer, db: Database): void {
  // Onboarding: what this is + the first move, branching on empty vs seeded.
  server.registerPrompt(
    "getting_started",
    {
      title: "Getting started with qa-memory",
      description: "Learn what qa-memory is and the first thing to do.",
    },
    () => {
      const count = countBehaviors(db);
      const state =
        count === 0
          ? emptyStateHint()
          : `qa-memory currently knows ${count} behavior${count === 1 ? "" : "s"}. ` +
            "Use query_behavior to recall product understanding, or query_risk before deciding test depth for a change.";
      const text = [
        "You are working with qa-memory — a QA knowledge layer that stores PRODUCT UNDERSTANDING (behaviors + rules), not test cases.",
        "",
        "Tools:",
        "  • add_to_memory — remember raw text (specs, notes, fetched pages).",
        "  • update_rule — pin a rule in QA voice (authoritative).",
        "  • query_behavior — recall what the product does.",
        "  • query_risk — derive a risk score for an area before testing it.",
        "",
        "For auth'd sources (Jira/Confluence/Drive), fetch with your own connected tools first, then pass the text to add_to_memory.",
        "",
        state,
      ].join("\n");
      return userMsg(text);
    },
  );

  // Guided flow: assess a change before testing it.
  server.registerPrompt(
    "assess_change",
    {
      title: "Assess a change before testing",
      description: "Given an area or feature about to change, walk through the risk and what to test.",
      argsSchema: { area: z.string().describe("The area, feature, or file about to change") },
    },
    (args: { area: string }) => {
      const count = countBehaviors(db);
      const text =
        count === 0
          ? `${emptyStateHint()}\n\nThen come back and assess "${args.area}".`
          : [
              `A change is coming to: "${args.area}".`,
              "",
              "Do this:",
              `  1. Call query_risk with "${args.area}" to get the derived risk score, matched behaviors, and their rules.`,
              "  2. Read the reasons behind the score — they tell you where the danger is.",
              "  3. If a rule is missing or wrong, fix it with update_rule (QA voice) so the memory improves.",
              "  4. Focus test depth on the highest-criticality behaviors surfaced.",
            ].join("\n");
      return userMsg(text);
    },
  );
}
