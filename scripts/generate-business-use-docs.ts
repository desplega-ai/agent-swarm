#!/usr/bin/env bun
/**
 * Generates BUSINESS_USE.md with Mermaid flow diagrams for all instrumented flows.
 *
 * Usage: bun run scripts/generate-business-use-docs.ts
 *
 * This script queries the business-use backend for registered nodes and generates
 * documentation with Mermaid graphs showing the flow structure and validators.
 */

const BU_URL = process.env.BUSINESS_USE_URL || "http://localhost:13370";
const BU_API_KEY = process.env.BUSINESS_USE_API_KEY;

if (!BU_API_KEY) {
  console.error("BUSINESS_USE_API_KEY not set. Run with env vars or from a directory with .env");
  process.exit(1);
}

interface Node {
  id: string;
  flow: string;
  type: string;
  description?: string;
  dep_ids?: string[];
  validator?: { engine: string; script: string };
  filter?: { engine: string; script: string };
}

async function fetchNodes(): Promise<Node[]> {
  const res = await fetch(`${BU_URL}/v1/nodes`, {
    headers: { "X-API-Key": BU_API_KEY! },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch nodes: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function groupByFlow(nodes: Node[]): Record<string, Node[]> {
  const groups: Record<string, Node[]> = {};
  for (const node of nodes) {
    if (!groups[node.flow]) groups[node.flow] = [];
    groups[node.flow].push(node);
  }
  return groups;
}

function generateTaskMermaid(nodes: Node[]): string {
  // Hand-crafted task flow that shows logical paths (not just dep graph)
  return `\`\`\`mermaid
flowchart TD
    created([created])
    started([started])
    cancelled_pending([cancelled_pending])
    cancelled_in_progress([cancelled_in_progress])
    paused([paused])
    resumed([resumed])
    completed([completed])
    failed([failed])
    worker_received([worker_received])
    worker_process_spawned([worker_process_spawned])
    worker_process_finished([worker_process_finished])

    created --> started
    created --> cancelled_pending

    started --> completed
    started --> failed
    started --> cancelled_in_progress
    started --> paused
    started --> worker_received

    paused --> resumed

    resumed --> completed
    resumed --> failed
    resumed --> cancelled_in_progress

    worker_received --> worker_process_spawned
    worker_process_spawned --> worker_process_finished

    classDef act fill:#4a9eff,stroke:#2670c4,color:#fff
    classDef assert fill:#34d399,stroke:#059669,color:#fff
    classDef worker fill:#f59e0b,stroke:#d97706,color:#fff

    class created act
    class started,cancelled_pending,cancelled_in_progress,completed,failed,paused,resumed assert
    class worker_received,worker_process_spawned act
    class worker_process_finished assert
\`\`\``;
}

function generateAgentMermaid(nodes: Node[]): string {
  return `\`\`\`mermaid
flowchart TD
    registered([registered])
    reconnected([reconnected])

    registered --> reconnected

    classDef act fill:#4a9eff,stroke:#2670c4,color:#fff
    classDef assert fill:#34d399,stroke:#059669,color:#fff

    class registered act
    class reconnected assert
\`\`\``;
}

function generateApiMermaid(nodes: Node[]): string {
  return `\`\`\`mermaid
flowchart TD
    listen([listen])
    scheduler_started([scheduler_started])

    listen --> scheduler_started

    classDef act fill:#4a9eff,stroke:#2670c4,color:#fff
    classDef assert fill:#34d399,stroke:#059669,color:#fff

    class listen act
    class scheduler_started assert
\`\`\``;
}

function generateNodeTable(nodes: Node[]): string {
  const rows = nodes
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => {
      const deps = n.dep_ids?.join(", ") || "—";
      const validatorScript = n.validator?.script?.trim().replace(/\n/g, " ") || "—";
      const validator = validatorScript.length > 60 ? `${validatorScript.slice(0, 57)}...` : validatorScript;
      return `| \`${n.id}\` | ${n.type} | ${deps} | ${validator} |`;
    });

  return `| Node | Type | Dependencies | Validator |
|------|------|-------------|-----------|
${rows.join("\n")}`;
}

function generateFlowSection(flow: string, nodes: Node[]): string {
  const mermaidGenerators: Record<string, (nodes: Node[]) => string> = {
    task: generateTaskMermaid,
    agent: generateAgentMermaid,
    api: generateApiMermaid,
  };

  const runIdMap: Record<string, string> = {
    task: "taskId (UUID)",
    agent: "agentId (UUID)",
    api: "per-boot ID (`run_${Date.now()}`)",
  };

  const descMap: Record<string, string> = {
    task: "Tracks every task through its lifecycle — from creation to terminal state. Events are emitted from both the API server (state transitions) and Docker workers (process execution).",
    agent: "Tracks agent registration and reconnection to the swarm.",
    api: "Tracks API server boot and subsystem initialization.",
  };

  const mermaid = mermaidGenerators[flow]?.(nodes) || "_(no graph available)_";

  return `### Flow: \`${flow}\`

> **runId:** ${runIdMap[flow] || "varies"}
> ${descMap[flow] || ""}

${mermaid}

${generateNodeTable(nodes)}`;
}

async function main() {
  console.log("Fetching nodes from business-use backend...");
  const nodes = await fetchNodes();
  console.log(`Found ${nodes.length} nodes across ${new Set(nodes.map((n) => n.flow)).size} flows`);

  const groups = groupByFlow(nodes);
  const flowOrder = ["task", "agent", "api"];
  const sortedFlows = flowOrder.filter((f) => groups[f]);

  // Add any flows not in the predefined order
  for (const flow of Object.keys(groups)) {
    if (!sortedFlows.includes(flow)) sortedFlows.push(flow);
  }

  const timestamp = new Date().toISOString().replace(/T/, " ").replace(/\..+/, " UTC");

  const md = `# Business-Use Flow Instrumentation

<!-- AUTO-GENERATED by scripts/generate-business-use-docs.ts — do not edit manually -->
<!-- Last generated: ${timestamp} -->

This document describes the business-use event flows instrumented in agent-swarm.
Events are tracked via the [\`@desplega.ai/business-use\`](https://github.com/desplega-ai/business-use) SDK.

**Legend:**
- 🔵 **act** — action event (no validator, tracks that something happened)
- 🟢 **assert** — assertion event (has a validator that checks invariants)

## Flows

${sortedFlows.map((flow) => generateFlowSection(flow, groups[flow])).join("\n\n---\n\n")}

---

## Verification

\`\`\`bash
# Start the business-use backend
uvx business-use-core@latest server dev

# List all runs for a flow
uvx business-use-core@latest flow runs --flow task

# Evaluate a specific task run
uvx business-use-core@latest flow eval <taskId> task --show-graph --verbose

# Evaluate an agent lifecycle
uvx business-use-core@latest flow eval <agentId> agent --show-graph --verbose

# Show the flow graph definition
uvx business-use-core@latest flow graph task
\`\`\`

## Instrumentation Locations

| File | Side | Events |
|------|------|--------|
| \`src/http/tasks.ts\` | API | created, cancelled_pending, cancelled_in_progress, completed, failed, paused, resumed |
| \`src/http/poll.ts\` | API | started |
| \`src/http/agents.ts\` | API | registered, reconnected |
| \`src/tools/store-progress.ts\` | API | completed, failed (MCP path) |
| \`src/http/index.ts\` | API | listen |
| \`src/scheduler/scheduler.ts\` | API | scheduler_started |
| \`src/commands/runner.ts\` | Worker | worker_received, worker_process_spawned, worker_process_finished |
`;

  const outPath = `${import.meta.dir}/../BUSINESS_USE.md`;
  await Bun.write(outPath, md);
  console.log(`Written to ${outPath}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
