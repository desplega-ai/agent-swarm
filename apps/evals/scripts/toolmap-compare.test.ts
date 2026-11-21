import { describe, expect, test } from "bun:test";
import type { SessionLogRow } from "../src/swarm/client.ts";
import type { SwarmTask } from "../src/types.ts";
import {
  type AttemptFacts,
  type AttemptInput,
  attemptFacts,
  cellRows,
  evaluateGates,
  renderReport,
} from "./toolmap-compare.ts";

const ROSTER = [
  { agentId: "w0", isLead: false },
  { agentId: "w1", isLead: false },
  { agentId: "lead", isLead: true },
];

/** A Claude stream-json tool_use row for one task. */
function toolRow(taskId: string, name: string, input: unknown = {}): SessionLogRow {
  return {
    id: crypto.randomUUID(),
    taskId,
    sessionId: "s",
    iteration: 0,
    cli: "claude",
    lineNumber: 0,
    createdAt: "2026-11-21T00:00:00Z",
    content: JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: crypto.randomUUID(), name, input }] },
    }),
  };
}

const task = (id: string, agentId: string, creatorAgentId?: string): SwarmTask => ({
  id,
  title: "",
  description: "",
  status: "completed",
  agentId,
  ...(creatorAgentId ? { creatorAgentId } : {}),
});

function input(over: Partial<AttemptInput>): AttemptInput {
  return {
    arm: "control",
    harness: "claude",
    scenarioId: "tool-mapping-lead-reflex",
    excluded: false,
    passed: true,
    score: 1,
    totalTokens: 1000,
    tasksMs: 60_000,
    roster: ROSTER,
    tasks: [task("lead-task", "lead"), task("c0", "w0", "lead"), task("c1", "w1", "lead")],
    logRows: [],
    ...over,
  };
}

describe("attemptFacts", () => {
  test("a Claude Task call by the lead counts as a native spawn; an MCP send-task does not", () => {
    const f = attemptFacts(
      input({
        logRows: [
          toolRow("lead-task", "Task", { prompt: "check alpha" }),
          toolRow("lead-task", "mcp__agent-swarm__send-task", { task: "check beta" }),
        ],
      }),
    );
    expect(f.leadNativeSpawns).toBe(1);
    expect(f.leadSwarmDispatch).toBe(1);
  });

  test("worker calls never count as lead calls", () => {
    const f = attemptFacts(input({ logRows: [toolRow("c0", "Agent")] }));
    expect(f.leadNativeSpawns).toBe(0);
  });

  test("worker-created tasks beyond the scenario's expected count are spurious", () => {
    const tasks = [task("t0", "w0"), task("T", "w1", "w0")];
    expect(
      attemptFacts(
        input({ scenarioId: "tool-mapping-worker-comms", tasks, roster: ROSTER.slice(0, 2) }),
      ).spuriousWorkerTasks,
    ).toBe(0);
    expect(
      attemptFacts(
        input({ scenarioId: "tool-mapping-worker-local", tasks, roster: ROSTER.slice(0, 2) }),
      ).spuriousWorkerTasks,
    ).toBe(1);
  });

  test("worker comms: steer-task and native SendMessage are counted apart", () => {
    const f = attemptFacts(
      input({
        scenarioId: "tool-mapping-worker-comms",
        roster: ROSTER.slice(0, 2),
        tasks: [task("t0", "w0"), task("T", "w1", "w0")],
        logRows: [
          toolRow("t0", "mcp__agent-swarm__steer-task", { taskId: "T" }),
          toolRow("t0", "SendMessage", { to: "x" }),
        ],
      }),
    );
    expect(f.hasLead).toBe(false);
    expect(f.leadNativeSpawns).toBeNull();
    expect(f.workerSteers).toBe(1);
    expect(f.workerNativeComms).toBe(1);
  });
});

/** n attempts per arm: control spawns natively in `controlSpawns` of them, treatment never. */
function arms(opts: {
  n?: number;
  controlSpawns?: number;
  treatmentSpawns?: number;
  treatmentTokens?: number;
  treatmentScore?: number;
}): AttemptFacts[] {
  const n = opts.n ?? 18;
  const make = (arm: "control" | "treatment", i: number, spawns: number): AttemptFacts => ({
    arm,
    harness: "claude",
    scenarioId: "tool-mapping-lead-reflex",
    excluded: false,
    passed: true,
    score: arm === "treatment" ? (opts.treatmentScore ?? 1) : 1,
    hasLead: true,
    leadNativeSpawns: i < spawns ? 1 : 0,
    leadSwarmDispatch: 2,
    spuriousWorkerTasks: 0,
    workerNativeComms: 0,
    workerSteers: 0,
    totalTokens: arm === "treatment" ? (opts.treatmentTokens ?? 1000) : 1000,
    tasksMs: 60_000,
  });
  const comms = (arm: "control" | "treatment"): AttemptFacts[] =>
    Array.from({ length: 6 }, () => ({
      ...make(arm, 99, 0),
      scenarioId: "tool-mapping-worker-comms",
      hasLead: false,
      leadNativeSpawns: null,
      leadSwarmDispatch: null,
      workerSteers: 1,
    }));
  return [
    ...Array.from({ length: n }, (_, i) => make("control", i, opts.controlSpawns ?? 6)),
    ...Array.from({ length: n }, (_, i) => make("treatment", i, opts.treatmentSpawns ?? 0)),
    ...comms("control"),
    ...comms("treatment"),
  ];
}

const status = (gates: ReturnType<typeof evaluateGates>, prefix: string) =>
  gates.find((g) => g.id.startsWith(prefix))?.status;

describe("evaluateGates", () => {
  test("a clean treatment passes every gate", () => {
    const gates = evaluateGates(arms({}));
    expect(gates.filter((g) => g.status !== "PASS")).toEqual([]);
  });

  test("G0 fails without headroom in control", () => {
    expect(status(evaluateGates(arms({ controlSpawns: 1 })), "G0")).toBe("FAIL");
  });

  test("G1 fails when treatment still spawns natively", () => {
    expect(status(evaluateGates(arms({ treatmentSpawns: 3 })), "G1")).toBe("FAIL");
  });

  test("G5 fails on a token blow-up, G4 on a score drop", () => {
    expect(status(evaluateGates(arms({ treatmentTokens: 1300 })), "G5")).toBe("FAIL");
    expect(status(evaluateGates(arms({ treatmentScore: 0.5 })), "G4")).toBe("FAIL");
  });

  test("a gate with no attempts behind it reads NO DATA, never PASS", () => {
    const leadOnly = arms({}).filter((f) => f.scenarioId !== "tool-mapping-worker-comms");
    expect(status(evaluateGates(leadOnly), "G7")).toBe("NO DATA");
  });

  test("excluded attempts are left out", () => {
    const facts = arms({}).map((f) => (f.arm === "treatment" ? { ...f, excluded: true } : f));
    expect(status(evaluateGates(facts), "G1")).toBe("NO DATA");
  });

  test("the report renders both tables", () => {
    const facts = arms({});
    const md = renderReport({
      control: "ctl",
      treatment: "trt",
      gates: evaluateGates(facts),
      cells: cellRows(facts),
    });
    expect(md).toContain("| claude | G0 headroom | PASS |");
    expect(md).toContain("tool-mapping-worker-comms");
  });
});
