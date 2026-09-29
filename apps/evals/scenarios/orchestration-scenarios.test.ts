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

/** A tool_use row followed by its tool_result row (Claude stream-json shape). */
function toolCallRows(
  taskId: string,
  toolName: string,
  input: unknown,
  result: unknown,
  callId: string,
): Record<string, unknown>[] {
  return [
    {
      id: `${callId}-use`,
      taskId,
      content: JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: callId, name: toolName, input }] },
      }),
    },
    {
      id: `${callId}-result`,
      taskId,
      content: JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: callId,
              content: typeof result === "string" ? result : JSON.stringify(result),
            },
          ],
        },
      }),
    },
  ];
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

  test("workflow-authoring resolves {{ref.x}} against inputs keys, not source paths", async () => {
    // Shape Sonnet 5 and 5.5 both produced in the 2026-09-28 pilot: renamed
    // input keys (pr <- trigger.pullRequest) and a three-node DAG.
    const nodes = [
      {
        id: "check",
        type: "swarm-script",
        next: "verdict",
        inputs: { pr: "trigger.pullRequest" },
        config: { scriptName: "gh-pr-snapshot", args: { number: "{{pr.number}}" } },
      },
      {
        id: "verdict",
        type: "agent-task",
        next: "notify",
        inputs: { snapshot: "check", pr: "trigger.pullRequest" },
        config: { template: "{{pr.number}} {{snapshot}}", outputSchema: { type: "object" } },
      },
      { id: "notify", type: "agent-task", inputs: { verdict: "verdict" }, config: {} },
    ];
    const wf = (n: unknown[]) =>
      ctx({
        tasks: [{ id: "seed", title: "t", description: "d", status: "completed" }],
        logs: { seed: [toolUseRow("seed", "mcp__agent-swarm__create-workflow", {})] },
        api: { "/api/workflows?fields=full": [{ id: "wf", name: "w", definition: { nodes: n } }] },
      });
    expect((await workflows.workflowDagCheck.fn(wf(nodes))).score).toBe(1);
    // A placeholder with no matching inputs key still fails the inputs criterion.
    const unmapped = nodes.map((n) =>
      n.id === "verdict" ? { ...n, inputs: { snapshot: "check" } } : n,
    );
    expect((await workflows.workflowDagCheck.fn(wf(unmapped))).score).toBeCloseTo(7 / 9);
  });

  test("script-authoring rewards script-upsert plus named script-run using ctx.swarm", async () => {
    const c = ctx({
      tasks: [
        { id: "seed", title: "t", description: "d", status: "completed", agentId: "worker-0" },
      ],
      logs: {
        seed: [
          toolUseRow("seed", "mcp__agent-swarm__script-upsert", { name: "task-summary" }),
          ...toolCallRows(
            "seed",
            "mcp__agent-swarm__script-run",
            { name: "task-summary", args: { taskIds: ["seed"] } },
            {
              success: true,
              status: 200,
              data: {
                result: { total: 1, completionRate: 1, highestPriorityCompletedTitle: "t" },
                exitCode: 0,
              },
            },
            "toolu_run1",
          ),
          toolUseRow("seed", "mcp__agent-swarm__script-run", {
            name: "task-summary",
            args: { taskIds: [] },
          }),
        ],
      },
      api: {
        "/api/scripts?includeScratch=false": {
          scripts: [
            {
              id: "script-id",
              name: "task-summary",
              scope: "agent",
              scopeId: "worker-0",
              createdByAgentId: "worker-0",
              typeChecked: true,
              isScratch: false,
            },
          ],
        },
        "/api/scripts/script-id": {
          script: {
            id: "script-id",
            name: "task-summary",
            source:
              "export default async function main(args, ctx) { const task = await ctx.swarm.task_getDetails({ taskId: args.taskIds[0] }); return { total: 1, completionRate: 1, highestPriorityCompletedTitle: task.task.title }; }",
          },
        },
      },
    });
    expect((await scripts.scriptCreatedGate.fn(c)).pass).toBe(true);
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
        result: "completed: 10",
      },
      {
        id: "b",
        title: "b",
        description: "top priority after completed: 10",
        status: "completed",
        agentId: "worker-1",
        creatorAgentId: "lead",
        dependsOn: ["a"],
        result: "Cut over the ledger service to the new region",
      },
      {
        id: "c",
        title: "c",
        description: "check anomaly from top list",
        status: "completed",
        agentId: "worker-2",
        creatorAgentId: "lead",
        dependsOn: ["b"],
        result: "Roll out the new pricing engine to EU customers is anomalous",
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
          "completed: 10\nCut over the ledger service to the new region\nRoll out the new pricing engine to EU customers",
      },
    });
    expect((await chain.chainStructureCheck.fn(c)).score).toBeGreaterThanOrEqual(0.9);
    expect((await chain.chainCorrectnessCheck.fn(c)).score).toBe(1);
  });

  function phaseChainWorkers(agentByPhase: [string, string, string]): JudgeWorkerContext[] {
    return [
      {
        index: 0,
        agentId: agentByPhase[0],
        name: chain.PHASE_NAMES[0],
        isLead: false,
        role: "worker",
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        readFile: async () => null,
      },
      {
        index: 1,
        agentId: agentByPhase[1],
        name: chain.PHASE_NAMES[1],
        isLead: false,
        role: "worker",
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        readFile: async () => null,
      },
      {
        index: 2,
        agentId: agentByPhase[2],
        name: chain.PHASE_NAMES[2],
        isLead: false,
        role: "worker",
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        readFile: async () => null,
      },
      {
        index: 3,
        agentId: "lead",
        name: "Lead",
        isLead: true,
        role: "lead",
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        readFile: async () => null,
      },
    ];
  }

  function chainTasks(agentByHop: [string, string, string]): SwarmTask[] {
    return [
      { id: "lead-task", title: "lead", description: "d", status: "completed", agentId: "lead" },
      {
        id: "a",
        title: "a",
        description: "count completed",
        status: "completed",
        agentId: agentByHop[0],
        creatorAgentId: "lead",
        result: "completed: 10",
      },
      {
        id: "b",
        title: "b",
        description: "top priority after completed: 10",
        status: "completed",
        agentId: agentByHop[1],
        creatorAgentId: "lead",
        dependsOn: ["a"],
        result: "Cut over the ledger service to the new region",
      },
      {
        id: "c",
        title: "c",
        description: "check anomaly from top list",
        status: "completed",
        agentId: agentByHop[2],
        creatorAgentId: "lead",
        dependsOn: ["b"],
        result: "Roll out the new pricing engine to EU customers is anomalous",
      },
    ];
  }

  test("dispatch-structure scores 1 when each hop lands on its named phase worker, on-topic, with real tool use", async () => {
    const c = ctx({
      tasks: chainTasks(["worker-0", "worker-1", "worker-2"]),
      logs: {
        a: [toolUseRow("a", "mcp__agent-swarm__get-tasks", { status: "completed" })],
        b: [toolUseRow("b", "mcp__agent-swarm__get-tasks", { status: "completed" })],
        c: [toolUseRow("c", "mcp__agent-swarm__get-tasks", { status: "completed" })],
      },
      workers: phaseChainWorkers(["worker-0", "worker-1", "worker-2"]),
    });
    const result = await chain.dispatchStructureCheck.fn(c);
    expect(result.score).toBe(1);
    expect(result.detail).toContain("shape=linear-3");
    expect(result.detail).toContain("identity=3/3");
  });

  test("dispatch-structure catches worker misrouting that the outcome-based check misses", async () => {
    // Same linear-3 chain, same on-topic descriptions, same per-hop tool use as
    // the passing case above — chainStructureCheck (child count / dependsOn /
    // flow-fact keywords) sees an identical paper trail. Only the hop 0 <-> hop 2
    // agent assignment is swapped: the "count completed" work landed on the
    // phase-three worker and the "anomaly" work landed on the phase-one worker.
    const tasks = chainTasks(["worker-2", "worker-1", "worker-0"]);
    const logs = {
      a: [toolUseRow("a", "mcp__agent-swarm__get-tasks", { status: "completed" })],
      b: [toolUseRow("b", "mcp__agent-swarm__get-tasks", { status: "completed" })],
      c: [toolUseRow("c", "mcp__agent-swarm__get-tasks", { status: "completed" })],
    };
    const workers = phaseChainWorkers(["worker-0", "worker-1", "worker-2"]);
    const c = ctx({ tasks, logs, workers });

    const outcome = await chain.chainStructureCheck.fn(c);
    const structure = await chain.dispatchStructureCheck.fn(c);
    expect(outcome.score).toBeGreaterThanOrEqual(0.9); // outcome check stays blind to misrouting
    expect(structure.score).toBeLessThan(1); // structural axis catches it
    expect(structure.detail).toContain("identity=1/3");
    expect(structure.detail).toContain("hop0=wrong-worker");
    expect(structure.detail).toContain("hop2=wrong-worker");
  });

  test("tool-routing rewards memory, KV, filtered task lookup, and follow-up creation", async () => {
    const c = ctx({
      tasks: [
        {
          id: "seed",
          title: "alpha",
          description: "Project Alpha",
          status: "completed",
          result: '{"alphaSummary":"12 completed; top: Rotate the payments service API keys"}',
          agentId: "worker-0",
        },
        {
          id: "follow",
          title: "next",
          description: "Phase two, starting from: Rotate the payments service API keys",
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
      api: {
        "/api/kv/_/task%3Aagent%3Aworker-0": {
          entries: [{ key: "alpha/checkpoint", value: { completed: 12 } }],
        },
      },
    });
    expect((await routing.routingCheck.fn(c)).score).toBe(1);
    expect((await routing.routingCorrectnessCheck.fn(c)).score).toBe(1);
  });

  test("tool-routing hop-order scores 1 when the causal sequence is respected", async () => {
    const c = ctx({
      tasks: [{ id: "seed", title: "alpha", description: "Project Alpha", status: "completed" }],
      logs: {
        seed: [
          toolUseRow("seed", "mcp__agent-swarm__memory-search", { query: "Project Alpha" }),
          toolUseRow("seed", "mcp__agent-swarm__kv-set", { key: "alpha/checkpoint" }),
          toolUseRow("seed", "mcp__agent-swarm__get-tasks", { status: "completed" }),
          toolUseRow("seed", "mcp__agent-swarm__send-task", { task: "next phase" }),
          toolUseRow("seed", "mcp__agent-swarm__store-progress", { output: "{}" }),
        ],
      },
    });
    expect((await routing.routingSequenceCheck.fn(c)).score).toBe(1);
  });

  test("tool-routing hop-order penalizes a scrambled sequence (dispatch before lookup)", async () => {
    const c = ctx({
      tasks: [{ id: "seed", title: "alpha", description: "Project Alpha", status: "completed" }],
      logs: {
        // send-task fires FIRST, before the memory recall / kv checkpoint / task
        // lookup it should have been informed by — same tool categories as the
        // passing case above (routingCheck's presence score is unaffected), but
        // out of causal order.
        seed: [
          toolUseRow("seed", "mcp__agent-swarm__send-task", { task: "next phase" }),
          toolUseRow("seed", "mcp__agent-swarm__memory-search", { query: "Project Alpha" }),
          toolUseRow("seed", "mcp__agent-swarm__kv-set", { key: "alpha/checkpoint" }),
          toolUseRow("seed", "mcp__agent-swarm__get-tasks", { status: "completed" }),
          toolUseRow("seed", "mcp__agent-swarm__store-progress", { output: "{}" }),
        ],
      },
    });
    const result = await routing.routingSequenceCheck.fn(c);
    // memory<send-task broken, send-task<store-progress holds.
    expect(result.score).toBeCloseTo(0.5, 5);
  });

  test("tool-routing hop-order is a partial order: kv/lookup placement does not matter", async () => {
    const c = ctx({
      tasks: [{ id: "seed", title: "alpha", description: "Project Alpha", status: "completed" }],
      logs: {
        seed: [
          toolUseRow("seed", "mcp__agent-swarm__get-tasks", { status: "completed" }),
          toolUseRow("seed", "mcp__agent-swarm__memory-search", { query: "Project Alpha" }),
          toolUseRow("seed", "mcp__agent-swarm__send-task", { task: "next phase" }),
          toolUseRow("seed", "mcp__agent-swarm__kv-set", { key: "alpha/checkpoint" }),
          toolUseRow("seed", "mcp__agent-swarm__store-progress", { output: "{}" }),
        ],
      },
    });
    expect((await routing.routingSequenceCheck.fn(c)).score).toBe(1);
  });

  test("tool-routing structured-output gate requires the outputSchema JSON", async () => {
    const withResult = (result: string) =>
      ctx({ tasks: [{ id: "seed", title: "t", description: "d", status: "completed", result }] });
    const good = JSON.stringify({
      alphaSummary: "two completed alpha tasks",
      checkpointKey: "alpha/checkpoint",
      followUpCreated: true,
    });
    expect((await routing.structuredOutputGate.fn(withResult(good))).pass).toBe(true);
    expect((await routing.structuredOutputGate.fn(withResult("Done, see KV"))).pass).toBe(false);
    expect(
      (
        await routing.structuredOutputGate.fn(
          withResult(
            JSON.stringify({ alphaSummary: "x", checkpointKey: "k", followUpCreated: "yes" }),
          ),
        )
      ).pass,
    ).toBe(false);
  });

  test("structured-output-adherence grades shape and the rule-derived answer key", async () => {
    const risk = (description: string, severity: string, mitigated: boolean) => ({
      description,
      severity,
      mitigated,
    });
    const answer = {
      services: [
        {
          name: "billing",
          decision: "ship",
          blockers: [],
          risks: [risk("migration", "high", true)],
        },
        {
          name: "search",
          decision: "hold",
          blockers: ["ranking-regression tests failing"],
          risks: [],
        },
        {
          name: "notifications",
          decision: "hold",
          blockers: ["owner approval missing; waiver expired"],
          risks: [],
        },
        {
          name: "checkout",
          decision: "needs-review",
          blockers: ["cache invalidation (high)"],
          risks: [risk("cache", "high", false)],
        },
      ],
      shippableCount: 1,
      confidence: 0.8,
    };
    const task = (result: string) =>
      ctx({ tasks: [{ id: "seed", title: "t", description: "d", status: "completed", result }] });
    const good = task(JSON.stringify(answer));
    // Well-formed but wrong: trusts the expired waiver and ignores the unmitigated risk.
    const wrong = task(
      JSON.stringify({
        ...answer,
        services: answer.services.map((s) =>
          s.name === "notifications" || s.name === "checkout"
            ? { ...s, decision: "ship", blockers: [] }
            : s,
        ),
        shippableCount: 3,
      }),
    );
    const prose = task("Done: hold");
    expect((await structured.schemaAdherenceCheck.fn(good)).score).toBe(1);
    expect((await structured.decisionAnswerCheck.fn(good)).score).toBe(1);
    expect((await structured.schemaAdherenceCheck.fn(wrong)).score).toBe(1);
    expect((await structured.decisionAnswerCheck.fn(wrong)).pass).toBe(false);
    expect((await structured.schemaAdherenceCheck.fn(prose)).score).toBe(0);
  });
});

// Phase 1 regression tests: each fixture reproduces a real stored failure from
// the evals replica (2026-09-28 audit) and pins the corrected score.
describe("phase 1 broken-check regressions", () => {
  const seededGlobals = Array.from({ length: 19 }, (_, i) => ({
    id: `global-${i}`,
    name: `seeded-${i}`,
    scope: "global",
    scopeId: null,
    createdByAgentId: null,
    typeChecked: true,
    isScratch: false,
  }));

  test("script-created ignores the 19 seeded global scripts (was '20 saved scripts')", async () => {
    const c = ctx({
      tasks: [{ id: "t", title: "t", description: "d", status: "completed", agentId: "worker-0" }],
      api: {
        "/api/scripts?includeScratch=false": {
          scripts: [
            ...seededGlobals,
            {
              id: "mine",
              name: "task-summary",
              scope: "agent",
              scopeId: "worker-0",
              createdByAgentId: "worker-0",
              typeChecked: true,
              isScratch: false,
            },
          ],
        },
      },
    });
    const gate = await scripts.scriptCreatedGate.fn(c);
    expect(gate.pass).toBe(true);
    expect(gate.detail).toBe("1 saved scripts");
  });

  test("script-created still fails when the worker saved nothing", async () => {
    const c = ctx({
      tasks: [{ id: "t", title: "t", description: "d", status: "completed", agentId: "worker-0" }],
      api: { "/api/scripts?includeScratch=false": { scripts: seededGlobals } },
    });
    expect((await scripts.scriptCreatedGate.fn(c)).pass).toBe(false);
  });

  test("script-run-output reads the script-run tool result, not /api/script-runs", async () => {
    // Real Codex shape: the MCP result nests the payload under structured_content,
    // and /api/script-runs (durable Script Workflows) is empty for this task.
    const c = ctx({
      tasks: [{ id: "t", title: "t", description: "d", status: "completed", agentId: "worker-0" }],
      logs: {
        t: [
          {
            id: "codex-run",
            taskId: "t",
            content: JSON.stringify({
              type: "item.completed",
              item: {
                type: "mcp_tool_call",
                server: "agent-swarm",
                tool: "script-run",
                arguments: { name: "task-summary", args: { taskIds: ["t"] } },
                status: "completed",
                result: {
                  content: [{ type: "text", text: "Script run completed." }],
                  structured_content: {
                    success: true,
                    status: 200,
                    data: {
                      result: { totalCount: 2, completionRate: 0.5, topPriorityTitle: "x" },
                      exitCode: 0,
                    },
                  },
                },
              },
            }),
          },
        ],
      },
      api: {
        "/api/scripts?includeScratch=false": {
          scripts: [
            {
              id: "mine",
              name: "task-summary",
              scope: "agent",
              createdByAgentId: "worker-0",
              isScratch: false,
            },
          ],
        },
        "/api/script-runs?limit=25": { runs: [] },
      },
    });
    expect((await scripts.scriptCorrectnessCheck.fn(c)).score).toBe(1);
  });

  test("script-run-output does not credit a failed run", async () => {
    const c = ctx({
      tasks: [{ id: "t", title: "t", description: "d", status: "completed", agentId: "worker-0" }],
      logs: {
        t: toolCallRows(
          "t",
          "mcp__agent-swarm__script-run",
          { name: "task-summary" },
          {
            success: true,
            data: { result: null, exitCode: 1, stderr: "TypeError" },
          },
          "toolu_fail",
        ),
      },
    });
    expect((await scripts.scriptCorrectnessCheck.fn(c)).score).toBe(0);
  });

  test("delegation-chain no longer zeroes a lead that polls its active children", async () => {
    const tasks: SwarmTask[] = [
      { id: "lead-task", title: "lead", description: "d", status: "completed", agentId: "lead" },
    ];
    const logs = {
      "lead-task": [
        toolUseRow("lead-task", "mcp__agent-swarm__get-tasks", { status: "in_progress" }),
        toolUseRow("lead-task", "get-tasks", {
          server: "agent-swarm",
          tool: "get-tasks",
          arguments: { tags: ["delegation-chain"] },
        }),
      ],
    };
    const detail = (await chain.chainStructureCheck.fn(ctx({ tasks, logs }))).detail;
    expect(detail).not.toContain("zeroed");
  });

  test("delegation-chain still zeroes a lead that reads the seeded history", async () => {
    for (const input of [{ status: "completed", limit: 100 }, { limit: 50 }]) {
      const tasks: SwarmTask[] = [
        { id: "lead-task", title: "lead", description: "d", status: "completed", agentId: "lead" },
      ];
      const logs = {
        "lead-task": [toolUseRow("lead-task", "mcp__agent-swarm__get-tasks", input)],
      };
      const res = await chain.chainStructureCheck.fn(ctx({ tasks, logs }));
      expect(res.score).toBe(0);
      expect(res.detail).toContain("zeroed");
    }
    const dbQuery = chain.readsSeededHistory({ toolName: "db-query", input: {} });
    expect(dbQuery).toBe(true);
  });

  test("tool-routing reads the worker's KV namespace, not the judge's (was kv=0)", async () => {
    const c = ctx({
      tasks: [
        {
          id: "t",
          title: "alpha",
          description: "Project Alpha",
          status: "completed",
          result: "Project Alpha: 12 completed, top is Rotate the payments service API keys",
          agentId: "worker-0",
          contextKey: "task:agent:worker-0",
        },
        {
          id: "f",
          title: "n",
          description: "phase two from Rotate the payments service API keys",
          status: "pending",
          parentTaskId: "t",
        },
      ],
      api: {
        // The judge's header-resolved namespace is empty; the worker's has the entry.
        "/api/kv": { entries: [] },
        "/api/kv/_/task%3Aagent%3Aworker-0": {
          entries: [{ key: "alpha/checkpoint", value: { phase: 1, completed: 12 } }],
        },
      },
    });
    const res = await routing.routingCorrectnessCheck.fn(c);
    expect(res.score).toBe(1);
    expect(res.detail).toContain("kv=1");
  });

  test("workflow-exists ignores seeded or leaked workflows (was '6 workflows found')", async () => {
    const seeded = Array.from({ length: 5 }, (_, i) => ({
      id: `seed-${i}`,
      name: `seeded-${i}`,
      createdByAgentId: "someone-else",
      createdAt: "2026-09-01T00:00:00.000Z",
    }));
    const c = ctx({
      tasks: [
        {
          id: "t",
          title: "t",
          description: "d",
          status: "completed",
          agentId: "worker-0",
          createdAt: "2026-09-28T10:00:00.000Z",
        },
      ],
      api: {
        "/api/workflows?fields=full": [
          ...seeded,
          { id: "old-anon", name: "leaked", createdAt: "2026-09-27T00:00:00.000Z" },
          {
            id: "mine",
            name: "PR review",
            createdByAgentId: "worker-0",
            createdAt: "2026-09-28T10:01:00.000Z",
          },
        ],
      },
    });
    const gate = await workflows.workflowExistsGate.fn(c);
    expect(gate.pass).toBe(true);
    expect(gate.detail).toBe("1 workflows found");
  });
  describe("delegation-chain reads facts from any lead task (defer wake-up)", () => {
    const facts =
      "completed: 10\nCut over the ledger service to the new region\nRoll out the new pricing engine to EU customers";
    const leadTask = (id: string, result: string): SwarmTask => ({
      id,
      title: id,
      description: "",
      status: "completed",
      agentId: "lead",
      result,
    });

    test("passes when the facts sit in a later lead wake-up task", async () => {
      const c = ctx({
        tasks: [
          leadTask("lead-1", "Deferred: waiting on the phase chain."),
          leadTask("lead-2", facts),
        ],
      });
      expect((await chain.finalReportGate.fn(c)).pass).toBe(true);
      const r = await chain.chainCorrectnessCheck.fn(c);
      expect(r.pass).toBe(true);
      expect(r.score).toBe(1);
    });

    test("fails when no lead task carries the facts", async () => {
      const c = ctx({
        tasks: [
          leadTask("lead-1", "Deferred: waiting on the phase chain."),
          leadTask("lead-2", "Chain finished."),
          { ...leadTask("w-1", facts), agentId: "worker-0" },
        ],
      });
      const r = await chain.chainCorrectnessCheck.fn(c);
      expect(r.pass).toBe(false);
      expect(r.score).toBe(0);
    });
  });
});
