import { describe, expect, test } from "bun:test";
import type { ToolUse } from "../src/judge/session-log-parse.ts";
import type { DeterministicCheck, JudgeContext, SwarmTask } from "../src/types.ts";
import { makeContext, toolCallRows } from "./grader-validation-support.ts";
import {
  countNativeComms,
  countNativeSpawns,
  countSwarmDispatch,
  rawTaskCreateCount,
  swarmToolSlug,
} from "./orchestration-utils.ts";
import { __test__ as lead, toolMappingLeadReflex } from "./tool-mapping-lead-reflex.ts";
import { __test__ as comms, toolMappingWorkerComms } from "./tool-mapping-worker-comms.ts";
import { __test__ as local, toolMappingWorkerLocal } from "./tool-mapping-worker-local.ts";

const use = (toolName: string, input: unknown = {}): ToolUse => ({ toolName, input });

async function run(check: DeterministicCheck, ctx: JudgeContext) {
  const r = await check.fn(ctx);
  return { pass: r.pass, score: r.score ?? (r.pass ? 1 : 0), detail: r.detail ?? "" };
}

describe("native tool counters (exact names)", () => {
  test("a Claude Task or Agent call is a spawn; an MCP send-task is not", () => {
    const tools = [use("Task"), use("Agent"), use("mcp__agent-swarm__send-task"), use("send-task")];
    expect(countNativeSpawns(tools)).toBe(2);
    expect(countNativeSpawns(tools, "claude")).toBe(2);
    expect(countNativeSpawns(tools, "codex")).toBe(0);
    expect(countNativeSpawns([use("spawn_agent")], "codex")).toBe(1);
    expect(countNativeSpawns([use("spawn_agent")], "pi")).toBe(0);
  });

  test("native comms: SendMessage, send_message, followup_task, wait_agent and wait", () => {
    const tools = [
      use("SendMessage"),
      use("send_message"),
      use("followup_task"),
      use("wait_agent"),
      use("wait"),
      use("mcp__agent-swarm__steer-task"),
      use("ListAgents"),
    ];
    expect(countNativeComms(tools)).toBe(5);
    expect(countNativeComms(tools, "claude")).toBe(1);
    expect(countNativeComms(tools, "codex")).toBe(4);
  });

  test("swarm dispatch: send-task under every harness name, plus script-run delegate", () => {
    expect(swarmToolSlug("mcp__agent_swarm__send_task")).toBe("send-task");
    const tools = [
      use("mcp__agent-swarm__send-task"),
      use("mcp__agent_swarm__send_task"),
      use("send-task"),
      use("mcp__agent-swarm__script-run", { name: "delegate" }),
      use("script-run", { server: "s", tool: "script-run", arguments: { name: "delegate" } }),
      use("mcp__agent-swarm__script-run", { name: "wait-for-task" }),
      use("Agent"),
      use("mcp__agent-swarm__get-tasks"),
    ];
    expect(countSwarmDispatch(tools)).toBe(5);
  });

  test("raw task creation: a POST to the tasks collection, not a GET or a task detail", () => {
    const bash = (command: string) => use("Bash", { command });
    expect(
      rawTaskCreateCount([
        bash('curl -X POST "$MCP_BASE_URL/api/tasks" -d \'{"task":"x"}\''),
        bash('curl "$MCP_BASE_URL/api/tasks?status=completed"'),
        bash('curl -X POST "$MCP_BASE_URL/api/tasks/abc/cancel"'),
      ]),
    ).toBe(1);
  });
});

// ---- tool-mapping-lead-reflex ----

const LEAD_OK = "alpha: port 7311, owner team-kestrel\nbeta: port 7422, owner team-osprey";

function leadCtx(opts: { output?: string; leadTools?: string[]; children?: number }): JudgeContext {
  const children: SwarmTask[] = Array.from({ length: opts.children ?? 2 }, (_, i) => ({
    id: `child-${i}`,
    title: "c",
    description: "c",
    status: "completed",
    agentId: `worker-${i}`,
    creatorAgentId: "lead",
    result: i === 0 ? "alpha port = 7311" : "beta port = 7422",
  }));
  return makeContext(toolMappingLeadReflex, {
    tasks: [
      {
        id: "task-0",
        title: "",
        description: "",
        status: "completed",
        agentId: "lead",
        result: opts.output ?? LEAD_OK,
      },
      ...children,
    ],
    logs: {
      "task-0": (opts.leadTools ?? ["mcp__agent-swarm__send-task"]).flatMap((name, i) =>
        toolCallRows("task-0", name, {}, "ok", `toolu_${i}`),
      ),
    },
  });
}

describe("tool-mapping-lead-reflex rubric", () => {
  test("the brief does not leak the answer key", () => {
    expect(lead.BRIEF).not.toMatch(/7311|7422|kestrel|osprey/);
  });

  test("delegation: swarm dispatch to both checkers scores 1", async () => {
    expect((await run(lead.delegation, leadCtx({}))).score).toBe(1);
  });

  test("delegation: any native spawn zeroes it, Agent or Task", async () => {
    for (const name of ["Agent", "Task"]) {
      const r = await run(
        lead.delegation,
        leadCtx({ leadTools: ["mcp__agent-swarm__send-task", name] }),
      );
      expect({ name, score: r.score }).toEqual({ name, score: 0 });
    }
  });

  test("delegation: Codex spawn_agent zeroes it", async () => {
    const r = await run(lead.delegation, leadCtx({ leadTools: ["spawn_agent"] }));
    expect(r.score).toBe(0);
  });

  test("delegation: no children and nothing traced scores 0", async () => {
    expect((await run(lead.delegation, leadCtx({ children: 0 }))).score).toBe(0);
  });

  test("correctness and the gate: both lines pass, a wrong port fails", async () => {
    expect((await run(lead.correctness, leadCtx({}))).score).toBe(1);
    const wrong = leadCtx({ output: "alpha: port 7312, owner team-kestrel\nbeta: port 7422" });
    expect((await run(lead.correctness, wrong)).score).toBe(0);
    expect((await run(lead.leadReported, wrong)).pass).toBe(false);
    expect((await run(lead.leadReported, leadCtx({}))).pass).toBe(true);
  });
});

// ---- tool-mapping-worker-local ----

function localCtx(opts: {
  output?: string;
  tools?: [string, unknown][];
  extraTasks?: SwarmTask[];
}): JudgeContext {
  return makeContext(toolMappingWorkerLocal, {
    tasks: [
      {
        id: "task-0",
        title: "",
        description: "",
        status: "completed",
        agentId: "worker-0",
        result: opts.output ?? '{"total": 46, "top": "south"}',
      },
      ...(opts.extraTasks ?? []),
    ],
    logs: {
      "task-0": (opts.tools ?? []).flatMap(([name, input], i) =>
        toolCallRows("task-0", name, input, "ok", `toolu_${i}`),
      ),
    },
  });
}

describe("tool-mapping-worker-local rubric", () => {
  test("the brief does not leak the answer key", () => {
    expect(local.BRIEF).not.toMatch(/\b46\b|\b23\b|\b14\b/);
  });

  test("correctness: the right JSON passes; a wrong total or top loses credit", async () => {
    expect((await run(local.correctness, localCtx({}))).score).toBe(1);
    expect(
      (await run(local.correctness, localCtx({ output: '{"total": 96, "top": "east"}' }))).score,
    ).toBe(0);
    expect(
      (await run(local.answerJson, localCtx({ output: "The total is 46, mostly south." }))).pass,
    ).toBe(false);
  });

  test("task discipline: native subagents are fine", async () => {
    const r = await run(local.taskDiscipline, localCtx({ tools: [["Agent", {}]] }));
    expect(r.score).toBe(1);
  });

  test("task discipline: every task-creation route fails it", async () => {
    const routes: [string, unknown][] = [
      ["mcp__agent-swarm__send-task", { task: "read north.csv" }],
      ["mcp__agent-swarm__script-run", { name: "delegate", args: {} }],
      ["Bash", { command: 'curl -X POST "$MCP_BASE_URL/api/tasks" -d "{}"' }],
    ];
    for (const route of routes) {
      const r = await run(local.taskDiscipline, localCtx({ tools: [route] }));
      expect({ route: route[0], score: r.score }).toEqual({ route: route[0], score: 0 });
    }
    const created = await run(
      local.taskDiscipline,
      localCtx({
        extraTasks: [
          {
            id: "spurious",
            title: "",
            description: "",
            status: "completed",
            creatorAgentId: "worker-0",
            agentId: null,
          },
        ],
      }),
    );
    expect(created.score).toBe(0);
  });

  test("task discipline: a defer-task wake-up on itself is not dispatch", async () => {
    const r = await run(
      local.taskDiscipline,
      localCtx({
        extraTasks: [
          {
            id: "wake",
            title: "",
            description: "",
            status: "completed",
            creatorAgentId: "worker-0",
            agentId: "worker-0",
          },
        ],
      }),
    );
    expect(r.score).toBe(1);
  });
});

// ---- tool-mapping-worker-comms ----

function commsCtx(opts: {
  output?: string;
  tools?: [string, unknown][];
  extraTasks?: SwarmTask[];
}): JudgeContext {
  return makeContext(toolMappingWorkerComms, {
    tasks: [
      {
        id: "task-0",
        title: "",
        description: "",
        status: "completed",
        agentId: "worker-0",
        result: opts.output ?? "marker: BLUE-6604",
      },
      {
        id: "t",
        title: "",
        description: "",
        status: "completed",
        agentId: "worker-1",
        creatorAgentId: "worker-0",
        result: "marker: BLUE-6604",
      },
      ...(opts.extraTasks ?? []),
    ],
    logs: {
      "task-0": (
        opts.tools ?? [
          ["mcp__agent-swarm__send-task", { agentId: "worker-1" }],
          ["mcp__agent-swarm__steer-task", { taskId: "t", message: "use b.txt" }],
          ["mcp__agent-swarm__get-task-details", { taskId: "t" }],
        ]
      ).flatMap(([name, input], i) => toolCallRows("task-0", name, input, "ok", `toolu_${i}`)),
    },
  });
}

describe("tool-mapping-worker-comms rubric", () => {
  test("the brief does not leak the markers", () => {
    expect(comms.BRIEF).not.toMatch(/AMBER|BLUE/);
  });

  test("comms: steer on T, no native comms, one task, swarm wait scores 1", async () => {
    expect((await run(comms.comms, commsCtx({}))).score).toBe(1);
  });

  test("comms: native SendMessage instead of steer-task loses C1 and C2", async () => {
    const r = await run(
      comms.comms,
      commsCtx({
        tools: [
          ["mcp__agent-swarm__send-task", {}],
          ["SendMessage", { to: "worker-b", message: "use b.txt" }],
          ["mcp__agent-swarm__get-task-details", { taskId: "t" }],
        ],
      }),
    );
    expect(r.score).toBeCloseTo(2 / 6);
  });

  test("comms: a steer on another task does not count", async () => {
    const r = await run(
      comms.comms,
      commsCtx({ tools: [["mcp__agent-swarm__steer-task", { taskId: "other" }]] }),
    );
    expect(r.detail).toContain("C1=0");
  });

  test("comms: a second task (re-dispatch) loses C3", async () => {
    const r = await run(
      comms.comms,
      commsCtx({
        extraTasks: [
          {
            id: "t2",
            title: "",
            description: "",
            status: "completed",
            agentId: "worker-1",
            creatorAgentId: "worker-0",
          },
        ],
      }),
    );
    expect(r.detail).toContain("C3=0");
    expect(r.score).toBeLessThan(1);
  });

  test("comms: the wait-for-task script counts as a swarm wait", async () => {
    const r = await run(
      comms.comms,
      commsCtx({
        tools: [
          ["mcp__agent-swarm__steer-task", { taskId: "t" }],
          ["mcp__agent-swarm__script-run", { name: "wait-for-task", args: { taskId: "t" } }],
        ],
      }),
    );
    expect(r.detail).toContain("C4=1");
  });

  test("correctness and the gate: the wrong marker last fails", async () => {
    expect((await run(comms.correctness, commsCtx({}))).pass).toBe(true);
    const wrong = commsCtx({ output: "marker: BLUE-6604? no, final: marker: AMBER-3317" });
    expect((await run(comms.correctness, wrong)).pass).toBe(false);
    expect((await run(comms.markerReported, commsCtx({ output: "done" }))).pass).toBe(false);
  });
});
