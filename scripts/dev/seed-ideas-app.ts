#!/usr/bin/env bun
import { getApiKey } from "../../src/utils/api-key";

const seedPath = new URL("./ideas-app.seed.json", import.meta.url);

// Minimal stand-in when the authored seed JSON is missing. Uses the current
// pages+defaultPage shape (legacy singular `page` is rejected by the server).
const fallbackDefinition = {
  models: {
    idea: {
      columns: {
        title: { kind: "string", required: true },
        status: { kind: "enum", enum: ["open", "in_progress", "done"], default: "open" },
        votes: { kind: "number", default: 0 },
        notes: { kind: "string" },
      },
    },
  },
  queries: {
    allIdeas: { model: "idea", sort: { column: "createdAt", dir: "desc" } },
  },
  pages: {
    main: {
      root: "root",
      elements: {
        root: { type: "Container", props: {}, children: ["heading", "description"] },
        heading: { type: "Heading", props: { text: "Ideas", level: "h1" } },
        description: { type: "Text", props: { content: "Ideas tracker seed loaded." } },
      },
    },
  },
  defaultPage: "main",
};

let definition: Record<string, unknown> = fallbackDefinition;
if (await Bun.file(seedPath).exists()) {
  definition = (await Bun.file(seedPath).json()) as Record<string, unknown>;
}

const baseUrl = (process.env.MCP_BASE_URL ?? "http://localhost:3013").replace(/\/$/, "");
const response = await fetch(`${baseUrl}/api/apps`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${getApiKey()}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    name: "Ideas",
    description: "A lightweight ideas tracker",
    definition,
  }),
});

const body = await response.text();
if (!response.ok) throw new Error(`Failed to seed ideas app (${response.status}): ${body}`);
console.log(body);
