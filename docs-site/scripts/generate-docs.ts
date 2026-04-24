/**
 * Generates API reference pages from the OpenAPI spec, grouped by tag.
 * Run: bun scripts/generate-docs.ts
 *
 * Reads ../openapi.json and creates:
 * - content/docs/api-reference/index.mdx (overview with version)
 * - content/docs/api-reference/<tag>.mdx (one per tag group)
 * - content/docs/api-reference/meta.json (auto-generated sidebar)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const specPath = resolve(__dirname, "../../openapi.json");
const outputDir = resolve(__dirname, "../content/docs/api-reference");

const spec = JSON.parse(readFileSync(specPath, "utf-8"));

const version: string = spec.info?.version ?? "unknown";
const serverUrl: string = spec.servers?.[0]?.url ?? "http://localhost:3013";

// --- Group operations by tag ---

interface Operation {
  path: string;
  method: string;
  summary: string;
}

const tagGroups = new Map<string, Operation[]>();

for (const [path, methods] of Object.entries(spec.paths ?? {})) {
  for (const [method, op] of Object.entries(methods as Record<string, unknown>)) {
    if (typeof op !== "object" || op === null) continue;
    const opObj = op as { tags?: string[]; summary?: string };
    const tags = opObj.tags?.length ? opObj.tags : ["Other"];
    for (const tag of tags) {
      if (!tagGroups.has(tag)) tagGroups.set(tag, []);
      tagGroups.get(tag)!.push({
        path,
        method,
        summary: opObj.summary ?? "",
      });
    }
  }
}

// Sort tags alphabetically, sort operations within each tag
const sortedTags = [...tagGroups.keys()].sort();
for (const tag of sortedTags) {
  tagGroups
    .get(tag)!
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

// --- Slug helper ---

function slugify(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// --- Clean output directory (remove old generated .mdx files) ---

mkdirSync(outputDir, { recursive: true });

if (existsSync(outputDir)) {
  for (const file of readdirSync(outputDir)) {
    if (file.endsWith(".mdx")) {
      rmSync(resolve(outputDir, file));
    }
  }
}

// --- Tag descriptions for SEO ---

const tagDescriptions: Record<string, string> = {
  "Active Sessions": "Query and manage active agent sessions — heartbeat data, context usage, and live session state",
  "Agents": "CRUD operations for agent profiles — create, update, configure, and manage swarm agents",
  "API Keys": "Manage access credentials — generate, rotate, and revoke API keys for agent authentication",
  "ApprovalRequests": "Human-in-the-loop workflow API — create approval requests and handle human decisions",
  "Config": "System configuration management — read and update swarm-wide and per-agent configuration",
  "Debug": "Debug endpoints and database inspection — SQL query interface and system diagnostics",
  "Ecosystem": "MCP server management — register, list, and manage Model Context Protocol services",
  "Events": "Event stream endpoints — real-time updates via SSE for task and agent events",
  "Health": "Health check endpoints for monitoring and service discovery",
  "Inbox": "Message inbox operations — retrieve and manage incoming messages for agents",
  "Linear": "Linear integration API — bidirectional sync between Agent Swarm and Linear issues",
  "Memories": "Agent memory management — persistent learning storage and recall queries",
  "Messages": "Inter-agent communication — send and receive messages within the swarm",
  "Migrations": "Database migration control — run and manage schema migrations",
  "Schedules": "Scheduled task management — create cron, interval, and delayed tasks",
  "Services": "Service discovery and registration — HTTP service endpoints for inter-agent communication",
  "Sessions": "Session lifecycle management — create, pause, resume, and terminate agent sessions",
  "Skills": "Skill system API — create, install, publish, and manage reusable agent skills",
  "Studies": "Persistent study/task management — long-running research and analysis tasks",
  "System": "System-level operations — configuration, state, and maintenance endpoints",
  "Tasks": "Task management core API — create, update, delegate, and monitor tasks",
  "Tracker Links": "External tracker integration — link tasks to Linear, GitHub, and other issue trackers",
  "User": "User registry and identity resolution — manage users across Slack, GitHub, GitLab platforms",
  "Workflows": "Workflow orchestration API — create, trigger, and manage DAG-based automation",
};

// --- Generate index page ---

const totalOps = [...tagGroups.values()].reduce((sum, ops) => sum + ops.length, 0);

const tagList = sortedTags
  .map((tag) => {
    const slug = slugify(tag);
    const count = tagGroups.get(tag)!.length;
    return `- [${tag}](/docs/api-reference/${slug}) — ${count} endpoint${count !== 1 ? "s" : ""}`;
  })
  .join("\n");

const indexMdx = `---
title: API Reference
description: REST API reference for Agent Swarm v${version}
---

{/* This file was generated by scripts/generate-docs.ts. Do not edit manually. */}

## Agent Swarm API v${version}

Base URL: \`${serverUrl}\`

${totalOps} endpoints across ${sortedTags.length} categories.

### Categories

${tagList}
`;

writeFileSync(resolve(outputDir, "index.mdx"), indexMdx);

// --- Generate per-tag pages ---

for (const tag of sortedTags) {
  const slug = slugify(tag);
  const ops = tagGroups.get(tag)!;
  const opsJson = JSON.stringify(ops.map((o) => ({ path: o.path, method: o.method })));
  const description = tagDescriptions[tag] ?? `${tag} API reference endpoints`;

  const tagMdx = `---
title: "${tag}"
description: "${description}"
full: true
---

{/* This file was generated by scripts/generate-docs.ts. Do not edit manually. */}

<APIPage document={"../openapi.json"} operations={${opsJson}} />
`;

  writeFileSync(resolve(outputDir, `${slug}.mdx`), tagMdx);
}

// --- Generate meta.json ---

const pages = ["index", ...sortedTags.map(slugify)];

const metaJson = {
  title: `API Reference v${version}`,
  description: "REST API reference for Agent Swarm",
  root: true,
  pages,
};

writeFileSync(resolve(outputDir, "meta.json"), `${JSON.stringify(metaJson, null, 2)}\n`);

console.log(
  `Generated API reference: ${sortedTags.length} tag pages + index (${totalOps} operations, v${version})`,
);
