import { describe, expect, test } from "bun:test";
import type { JudgeContext, JudgeWorkerContext, SwarmTask } from "../src/types.ts";
import { __test__ as chain } from "./delegation-chain.ts";
import { __test__ as scripts } from "./script-authoring.ts";
import { __test__ as structured } from "./structured-output-adherence.ts";
import { __test__ as routing } from "./tool-routing.ts";
import { __test__ as workflows } from "./workflow-authoring.ts";

function toolUseRow(taskId: string, toolName: string, input: unknown): Record<string, unknown> {
  return {
    id: `${taskId}-${toolName}`,
    taskId,
    content: JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: `toolu_${toolName}`, name: toolName, input }],
      },
    }),
  };
}

function ctx(opts: {
  tasks?: SwarmTask[];
  api?: Record<string, unknown>;
  logs?: Record<string, Record<string, unknown>[]>;
  files?: Record<string, string>;
  workers?: JudgeWorkerContext[];
}): JudgeContext {
  const workers =
    opts.workers ??
    Array.from({ length: 4 }, (_, index) => ({
      index,
      agentId: index === 3 ? "lead" : `worker-${index}`,
      isLead: index === 3,
      role: index === 3 ? "lead" : "worker",
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      readFile: async (path: string) => opts.files?.[`w${index}:${path}`] ?? null,
    }));
  return {
    tasks: opts.tasks ?? [],
    transcript: "",
    exec: workers[0]!.exec,
    readFile: workers[0]!.readFile,
    workers,
    apiGet: async (path) => {
      const logMatch = path.match(/^\/api\/tasks\/([^/]+)\/session-logs/);
      if (logMatch) return { logs: opts.logs?.[logMatch[1]!] ?? [] };
      return opts.api?.[path] ?? {};
    },
  };
}

describe("orchestration substrate scenario rubrics", () => {
  test("workflow-authoring scores a connected DAG with supported trigger schema", async () => {
    const c = ctx({
      tasks: [{ id: "seed", title: "t", description: "d", status: "completed" }],
      logs: { seed: [toolUseRow("seed", "mcp__agent-swarm__create-workflow", {})] },
      api: {
        "/api/workflows?fields=full": [
          {
            id: "wf",
            name: "PR review",
            enabled: true,
            triggerSchema: {
              type: "object",
              required: ["repository", "pullRequest"],
              properties: { repository: { type: "string" }, pullRequest: { type: "number" } },
            },
            definition: {
              nodes: [
                {
                  id: "start",
                  type: "validate",
                  next: "lint",
                  config: { payload: "{{trigger.repository}}" },
                },
                {
                  id: "lint",
                  type: "swarm-script",
                  next: "review",
                  config: { scriptName: "lint-check" },
                },
                {
                  id: "review",
                  type: "agent-task",
                  next: "notify",
                  inputs: { lint: "lint.result" },
                  config: { template: "{{lint.result}}", outputSchema: { type: "object" } },
                },
                {
                  id: "notify",
                  type: "notify",
                  inputs: { review: "review.taskOutput" },
                  config: {},
                },
              ],
            },
          },
        ],
      },
    });
    expect((await workflows.workflowDagCheck.fn(c)).score).toBe(1);
    expect((await workflows.triggerSchemaCheck.fn(c)).score).toBe(1);
  });

  test("script-authoring rewards script-upsert plus named script-run using ctx.swarm", async () => {
    const c = ctx({
      tasks: [{ id: "seed", title: "t", description: "d", status: "completed" }],
      logs: {
        seed: [
          toolUseRow("seed", "mcp__agent-swarm__script-upsert", { name: "task-summary" }),
          toolUseRow("seed", "mcp__agent-swarm__script-run", {
            name: "task-summary",
            args: { taskIds: ["seed"] },
          }),
          toolUseRow("seed", "mcp__agent-swarm__script-run", {
            name: "task-summary",
            args: { taskIds: [] },
          }),
        ],
      },
      api: {
        "/api/scripts?includeScratch=false": {
          scripts: [{ id: "script-id", name: "task-summary", typeChecked: true, isScratch: false }],
        },
        "/api/scripts/script-id": {
          script: {
            id: "script-id",
            name: "task-summary",
            source:
              "export default async function main(args, ctx) { const task = await ctx.swarm.task_getDetails({ taskId: args.taskIds[0] }); return { total: 1, completionRate: 1, highestPriorityCompletedTitle: task.task.title }; }",
          },
        },
        "/api/script-runs?limit=25": {
          runs: [
            {
              scriptName: "task-summary",
              status: "completed",
              output: { total: 1, completionRate: 1, highestPriorityCompletedTitle: "t" },
            },
          ],
        },
      },
    });
    expect((await scripts.sdkUsageCheck.fn(c)).score).toBe(1);
    expect((await scripts.scriptCorrectnessCheck.fn(c)).score).toBe(1);
    expect((await scripts.reusabilityCheck.fn(c)).score).toBe(1);
  });

  test("delegation-chain requires child dependsOn links and final facts", async () => {
    const tasks: SwarmTask[] = [
      { id: "lead-task", title: "lead", description: "d", status: "completed", agentId: "lead" },
      {
        id: "a",
        title: "a",
        description: "count completed",
        status: "completed",
        agentId: "worker-0",
        creatorAgentId: "lead",
        result: "completed: 21",
      },
      {
        id: "b",
        title: "b",
        description: "top priority after completed: 21",
        status: "completed",
        agentId: "worker-1",
        creatorAgentId: "lead",
        dependsOn: ["a"],
        result: "Rotate the payments service API keys",
      },
      {
        id: "c",
        title: "c",
        description: "check anomaly from top list",
        status: "completed",
        agentId: "worker-2",
        creatorAgentId: "lead",
        dependsOn: ["b"],
        result: "Deploy the checkout redesign to production is anomalous",
      },
    ];
    const c = ctx({
      tasks,
      logs: {
        "lead-task": [toolUseRow("lead-task", "mcp__agent-swarm__send-task", {})],
        a: [toolUseRow("a", "mcp__agent-swarm__get-tasks", { status: "completed" })],
        b: [toolUseRow("b", "mcp__agent-swarm__get-tasks", { status: "completed" })],
        c: [toolUseRow("c", "mcp__agent-swarm__get-tasks", { status: "completed" })],
      },
      files: {
        [`w${chain.LEAD_WORKER}:${chain.REPORT_FILE}`]:
          "completed: 21\nRotate the payments service API keys\nDeploy the checkout redesign to production",
      },
    });
    expect((await chain.chainStructureCheck.fn(c)).score).toBeGreaterThanOrEqual(0.9);
    expect((await chain.chainCorrectnessCheck.fn(c)).score).toBe(1);
  });

  test("tool-routing rewards memory, KV, filtered task lookup, and follow-up creation", async () => {
    const c = ctx({
      tasks: [
        {
          id: "seed",
          title: "alpha",
          description: "Project Alpha",
          status: "completed",
          result: '{"alphaSummary":"ok"}',
        },
        {
          id: "follow",
          title: "next",
          description: "next phase follow-up",
          status: "completed",
          parentTaskId: "seed",
        },
      ],
      logs: {
        seed: [
          toolUseRow("seed", "mcp__agent-swarm__memory-search", { query: "Project Alpha" }),
          toolUseRow("seed", "mcp__agent-swarm__kv-set", { key: "alpha/checkpoint" }),
          toolUseRow("seed", "mcp__agent-swarm__get-tasks", {
            status: "completed",
            tags: ["alpha"],
          }),
          toolUseRow("seed", "mcp__agent-swarm__send-task", { task: "next phase" }),
          toolUseRow("seed", "mcp__agent-swarm__store-progress", { output: "{}" }),
        ],
      },
      api: { "/api/kv": { entries: [{ key: "alpha/checkpoint", value: { ok: true } }] } },
    });
    expect((await routing.routingCheck.fn(c)).score).toBe(1);
    expect((await routing.routingCorrectnessCheck.fn(c)).score).toBe(1);
  });

  test("structured-output-adherence distinguishes JSON schema match from prose", async () => {
    const good = ctx({
      tasks: [
        {
          id: "seed",
          title: "t",
          description: "d",
          status: "completed",
          result: JSON.stringify({
            summary: "Hold for approval",
            risks: ["owner approval missing"],
            nextAction: "needs-review",
            confidence: 0.82,
          }),
        },
      ],
    });
    const bad = ctx({
      tasks: [
        { id: "seed", title: "t", description: "d", status: "completed", result: "Done: hold" },
      ],
    });
    expect((await structured.schemaAdherenceCheck.fn(good)).score).toBe(1);
    expect((await structured.schemaAdherenceCheck.fn(bad)).score).toBe(0);
  });
});
