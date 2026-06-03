// Guided surface (Block B): MCP prompts that teach discovery without a UI.
// These appear in the client's prompt menu. They orient a fresh user (and the
// agent) on what qa-memory is and which tool to reach for — no dedicated UI,
// works for technical and non-technical users alike.
import type { Database } from "better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getLabels } from "./i18n.js";
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
  return getLabels().emptyStateHint;
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
      const L = getLabels();
      const count = countBehaviors(db);
      const state = count === 0 ? L.emptyStateHint : L.gettingStartedSeeded(count);
      const text = [L.gettingStartedTools, "", L.gettingStartedAuthNote, "", state].join("\n");
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
      const L = getLabels();
      const count = countBehaviors(db);
      const text =
        count === 0
          ? `${L.emptyStateHint}\n\n${L.assessChangeEmpty(args.area)}`
          : L.assessChangeSteps(args.area);
      return userMsg(text);
    },
  );
}
