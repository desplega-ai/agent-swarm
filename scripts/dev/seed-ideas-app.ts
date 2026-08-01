#!/usr/bin/env bun
import { getApiKey } from "../../src/utils/api-key";

const seedPath = new URL("../../apps/ui/APP_SEED.json", import.meta.url);

const fallbackPage = {
  root: "root",
  elements: {
    root: { type: "Container", props: {}, children: ["heading", "description"] },
    heading: { type: "Heading", props: { text: "Ideas", level: "h1" } },
    description: { type: "Text", props: { text: "Ideas tracker seed loaded." } },
  },
};

const baseDefinition = {
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
};

let definition: Record<string, unknown> = { ...baseDefinition, page: fallbackPage };
if (await Bun.file(seedPath).exists()) {
  const authored = (await Bun.file(seedPath).json()) as Record<string, unknown>;
  definition = authored.models && authored.page ? authored : { ...baseDefinition, page: authored };
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
