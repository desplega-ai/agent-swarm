import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

/** The four native tool-mapping prompt templates and the native names each must render. */
const MAPPINGS: Record<string, string[]> = {
  "system.agent.tool_mapping.claude.lead": ["`Agent` → `send-task`", "`ListAgents` → `get-swarm`"],
  "system.agent.tool_mapping.claude.worker": ["`Agent`, `SendMessage` and `ListAgents`"],
  "system.agent.tool_mapping.codex.lead": ["`spawn_agent` → `send-task`", "`wait_agent` →"],
  "system.agent.tool_mapping.codex.worker": ["`spawn_agent`, `send_message`, `wait_agent`"],
};

export const promptToolMapping: Scenario = {
  name: "prompt-tool-mapping",
  order: 531,
  async run(ctx) {
    let response = await ctx.api("GET", "/api/prompt-templates/events");
    expectStatus(response, [200], "list template events");
    const events = new Map(
      asRecords(response.json, "events").map((event) => [String(event.eventType), event]),
    );

    for (const [eventType, expected] of Object.entries(MAPPINGS)) {
      const event = events.get(eventType);
      expect(event?.category === "system", `${eventType} is a registered system template`);

      response = await ctx.api("POST", "/api/prompt-templates/render", {
        body: { eventType, variables: {} },
      });
      expectStatus(response, [200], `render ${eventType}`);
      const text = String(asRecord(response.json).text);
      expect(
        text.includes("## Native tools in this swarm") && text.length <= 600,
        `${eventType} renders the section within 600 chars: ${text.length}`,
      );
      for (const needle of expected) {
        expect(text.includes(needle), `${eventType} names ${needle}: ${text.slice(0, 300)}`);
      }
    }
  },
};
