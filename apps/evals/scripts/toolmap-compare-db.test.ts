/**
 * toolmap-compare against a real evals DB: runs, attempts and artifacts written
 * through the same queries and serializers the runner uses, then read by the
 * CLI entry (`main`). Covers the arm/status/cell boundary and the continuation
 * (spawned-task) logs the counters need.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPERIMENT_SCENARIO_IDS } from "../scenarios/suite.ts";
import { getDb, initDb, resetDbForTests } from "../src/db/client.ts";
import {
  createRun,
  insertArtifact,
  insertAttempt,
  setRunStatus,
  updateAttempt,
} from "../src/db/queries.ts";
import { collectSpawnedLogs, serializeSpawnedLogs } from "../src/runner/spawned-logs.ts";
import type { SessionLogRow } from "../src/swarm/client.ts";
import type { RunStatus, SwarmTask } from "../src/types.ts";
import { main } from "./toolmap-compare.ts";

const CONFIG = "claude-fixture";
const ENV_KEYS = ["EVALS_DB_SYNC_URL", "EVALS_DB_AUTH_TOKEN", "EVALS_DB_PATH"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let dir = "";

// main prints the report; keep the test output readable.
const quiet = [spyOn(console, "log"), spyOn(console, "error")];

beforeEach(async () => {
  for (const spy of quiet) spy.mockImplementation(() => {});
  resetDbForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  dir = mkdtempSync(join(tmpdir(), "toolmap-compare-"));
  process.env.EVALS_DB_PATH = join(dir, "evals.db");
  await initDb();
});

afterEach(() => {
  for (const spy of quiet) spy.mockRestore();
  resetDbForTests();
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

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

const SEND = "mcp__agent-swarm__send-task";
const STEER = "mcp__agent-swarm__steer-task";

interface AttemptSpec {
  upfront: SwarmTask[];
  spawned: SwarmTask[];
  logs: Record<string, SessionLogRow[]>;
  roster: { agentId: string; isLead: boolean }[];
}

/**
 * A correct attempt per scenario. Every call the gates hinge on sits in a
 * runtime-spawned task (lead wake-up, worker follow-up after deferral), so a
 * reader of the upfront logs alone sees none of it.
 */
function spec(
  scenarioId: string,
  arm: "control" | "treatment",
  over: { leadWakeTool?: string; workerFollowUpTool?: string } = {},
): AttemptSpec {
  const t = (id: string, agentId: string, extra: Partial<SwarmTask> = {}): SwarmTask => ({
    id,
    title: "",
    description: "",
    status: "completed",
    agentId,
    origin: "run",
    ...extra,
  });
  if (scenarioId === "tool-mapping-lead-reflex") {
    return {
      upfront: [t("L", "lead")],
      spawned: [
        t("C", "w0", { creatorAgentId: "lead" }),
        t("LF", "lead", { taskType: "follow-up" }),
      ],
      logs: {
        L: [toolRow("L", SEND, { task: "check" })],
        LF: [toolRow("LF", over.leadWakeTool ?? (arm === "control" ? "Agent" : SEND))],
        C: [toolRow("C", "Read")],
      },
      roster: [
        { agentId: "w0", isLead: false },
        { agentId: "lead", isLead: true },
      ],
    };
  }
  const roster = [
    { agentId: "w0", isLead: false },
    { agentId: "w1", isLead: false },
  ];
  if (scenarioId === "tool-mapping-worker-comms") {
    return {
      upfront: [t("W", "w0")],
      spawned: [t("T", "w1", { creatorAgentId: "w0" }), t("WF", "w0", { taskType: "follow-up" })],
      logs: {
        W: [toolRow("W", "mcp__agent-swarm__send-task", { task: "sub" })],
        WF: [toolRow("WF", over.workerFollowUpTool ?? STEER, { taskId: "T" })],
      },
      roster,
    };
  }
  return { upfront: [t("W", "w0")], spawned: [], logs: { W: [toolRow("W", "Read")] }, roster };
}

async function seedRun(opts: {
  id: string;
  flag?: string;
  status?: RunStatus;
  scenarioIds?: readonly string[];
  attempts?: number;
  version?: number;
  attemptStatus?: "passed" | "error";
  /** Skip the spawned-logs artifact, as a run from before it existed. */
  noSpawnedArtifact?: boolean;
  specFor?: (scenarioId: string) => AttemptSpec;
}): Promise<void> {
  const db = getDb();
  const arm = opts.flag === "true" ? "treatment" : "control";
  const scenarioIds = [...(opts.scenarioIds ?? EXPERIMENT_SCENARIO_IDS)];
  await createRun(db, {
    id: opts.id,
    scenarioIds,
    configIds: [CONFIG],
    attemptsPerCell: opts.attempts ?? 1,
    concurrency: 1,
    ...(opts.flag !== undefined ? { workerEnv: { HARNESS_TOOL_MAPPINGS_ENABLED: opts.flag } } : {}),
  });
  for (const scenarioId of scenarioIds) {
    for (let i = 0; i < (opts.attempts ?? 1); i++) {
      const id = `${opts.id}-${scenarioId}-${i}`;
      await insertAttempt(db, {
        id,
        runId: opts.id,
        scenarioId,
        configId: CONFIG,
        attemptIndex: i,
        scenarioVersion: opts.version ?? 1,
      });
      const s = opts.specFor?.(scenarioId) ?? spec(scenarioId, arm);
      await updateAttempt(db, id, {
        status: opts.attemptStatus ?? "passed",
        passed: true,
        score: 1,
        taskIds: s.upfront.map((x) => x.id),
        tokensJson: JSON.stringify({
          model: null,
          inputTokens: 1000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
        timingsJson: JSON.stringify({ tasksMs: 60_000 }),
        workersJson: JSON.stringify(s.roster.map((m) => ({ ...m, provider: "claude" }))),
      });
      const tasks = [...s.upfront, ...s.spawned];
      await insertArtifact(db, {
        id: crypto.randomUUID(),
        attemptId: id,
        kind: "task",
        name: "tasks.json",
        content: JSON.stringify(tasks),
      });
      await insertArtifact(db, {
        id: crypto.randomUUID(),
        attemptId: id,
        kind: "raw-session-logs",
        name: "session-logs.jsonl",
        content: s.upfront
          .flatMap((x) => s.logs[x.id] ?? [])
          .map((r) => JSON.stringify(r))
          .join("\n"),
      });
      if (opts.noSpawnedArtifact) continue;
      // The runner's own capture + serializer, so the persisted shape is the real one.
      const spawned = await collectSpawnedLogs(
        tasks,
        new Set(s.upfront.map((x) => x.id)),
        async (taskId) => s.logs[taskId] ?? [],
      );
      await insertArtifact(db, {
        id: crypto.randomUUID(),
        attemptId: id,
        kind: "meta",
        name: "spawned-session-logs.json",
        content: serializeSpawnedLogs(spawned, (x) => x),
      });
    }
  }
  await setRunStatus(db, opts.id, opts.status ?? "done");
}

interface Report {
  problems: string[];
  gates: { harness: string; id: string; status: string }[];
}

async function compare(): Promise<{ code: number; report: Report }> {
  const code = await main(["--control", "ctl", "--treatment", "trt", "--out", dir]);
  const report = JSON.parse(readFileSync(join(dir, "toolmap-report.json"), "utf8")) as Report;
  return { code, report };
}

const gateStatus = (r: Report, id: string) => r.gates.find((g) => g.id === id)?.status;

describe("toolmap-compare over a stored run pair", () => {
  test("a complete pair passes, scoring calls made in wake-up and follow-up tasks", async () => {
    await seedRun({ id: "ctl", flag: "false" });
    await seedRun({ id: "trt", flag: "true" });
    const { code, report } = await compare();
    expect(report.problems).toEqual([]);
    // G0 sees the control lead's native Agent call only through its wake-up task's logs;
    // G7 sees the treatment worker's steer only through its post-deferral follow-up.
    expect(gateStatus(report, "G0 headroom")).toBe("PASS");
    expect(gateStatus(report, "G7 worker comms")).toBe("PASS");
    expect(report.gates.every((g) => g.status === "PASS")).toBe(true);
    expect(code).toBe(0);
  });

  test("a native spawn in a treatment lead wake-up fails G1", async () => {
    await seedRun({ id: "ctl", flag: "false" });
    await seedRun({
      id: "trt",
      flag: "true",
      specFor: (s) => spec(s, "treatment", { leadWakeTool: "Agent" }),
    });
    const { code, report } = await compare();
    expect(gateStatus(report, "G1 lead native spawn")).toBe("FAIL");
    expect(code).toBe(1);
  });

  test("native comms in a worker follow-up fails G7", async () => {
    await seedRun({ id: "ctl", flag: "false" });
    await seedRun({
      id: "trt",
      flag: "true",
      specFor: (s) => spec(s, "treatment", { workerFollowUpTool: "SendMessage" }),
    });
    const { code, report } = await compare();
    expect(gateStatus(report, "G7 worker comms")).toBe("FAIL");
    expect(code).toBe(1);
  });

  test("two empty finished runs fail closed with no gates", async () => {
    const db = getDb();
    for (const [id, flag] of [
      ["ctl", "false"],
      ["trt", "true"],
    ] as const) {
      await createRun(db, {
        id,
        scenarioIds: [],
        configIds: [],
        attemptsPerCell: 1,
        concurrency: 1,
        workerEnv: { HARNESS_TOOL_MAPPINGS_ENABLED: flag },
      });
      await setRunStatus(db, id, "done");
    }
    const { code, report } = await compare();
    expect(report.gates).toEqual([]);
    expect(report.problems.some((p) => p.startsWith("required scenario(s) missing"))).toBe(true);
    expect(code).toBe(1);
  });

  for (const [name, ctl, trt, expected] of [
    [
      "an unfinished arm",
      { flag: "false" },
      { flag: "true", status: "running" as const },
      "treatment run trt is running, not done",
    ],
    ["two arms on the same flag", { flag: "true" }, { flag: "true" }, "control run must set"],
    ["an unset control flag", {}, { flag: "true" }, "control run must set"],
    [
      "disjoint scenario cells",
      { flag: "false", scenarioIds: ["delegation-probe", ...EXPERIMENT_SCENARIO_IDS.slice(1)] },
      { flag: "true" },
      "the arms ran different scenarios",
    ],
    [
      "mismatched scenario versions",
      { flag: "false", version: 1 },
      { flag: "true", version: 2 },
      "ran scenario version 1 in control, 2 in treatment",
    ],
    [
      "a cell with every attempt excluded",
      { flag: "false" },
      { flag: "true", attemptStatus: "error" as const },
      "has every attempt excluded",
    ],
    [
      "attempts without continuation logs",
      { flag: "false" },
      { flag: "true", noSpawnedArtifact: true },
      "spawned-session-logs.json missing",
    ],
  ] as const) {
    test(`${name} fails closed with no gates`, async () => {
      await seedRun({ id: "ctl", ...ctl });
      await seedRun({ id: "trt", ...trt });
      const { code, report } = await compare();
      expect(report.gates).toEqual([]);
      expect(report.problems.some((p) => p.includes(expected))).toBe(true);
      expect(code).toBe(1);
    });
  }
});

test("the CLI process exits 1 on two empty runs", async () => {
  const db = getDb();
  for (const id of ["ctl", "trt"]) {
    await createRun(db, { id, scenarioIds: [], configIds: [], attemptsPerCell: 1, concurrency: 1 });
    await setRunStatus(db, id, "done");
  }
  resetDbForTests();
  const proc = Bun.spawn(
    [
      "bun",
      join(import.meta.dir, "toolmap-compare.ts"),
      "--control",
      "ctl",
      "--treatment",
      "trt",
      "--out",
      dir,
    ],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        EVALS_DB_PATH: join(dir, "evals.db"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toContain("no gates evaluated");
});
