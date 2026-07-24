import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDb, getDb, initDb } from "../be/db";
import { createEdgeHandler } from "../be/edge-handlers-db";
import { listTraceForRun } from "../be/routing-trace-db";
import { createRoutingEngine, type RoutingScriptRunner } from "../routing/engine";
import type { RoutingCtx } from "../routing/types";

const TEST_DB_PATH = "./test-routing-engine.sqlite";

function removeDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB_PATH + suffix);
    } catch {
      // Missing test DB files are expected.
    }
  }
}

function ctx(taskType: string, overrides: Partial<RoutingCtx> = {}): RoutingCtx {
  return {
    via: "creation",
    task: {
      description: `route ${taskType}`,
      source: "mcp",
      taskType,
      tags: ["engine-test"],
      priority: 50,
    },
    candidates: [],
    continuity: { parent: null, chainDepth: 0 },
    ...overrides,
  };
}

function handler(args: {
  name: string;
  taskType: string;
  flavor?: "route" | "guard";
  mode?: "soft" | "hard";
  priority?: number;
  timeoutMs?: number;
  matcher?: Record<string, unknown>;
}) {
  return createEdgeHandler({
    name: args.name,
    edge: "task.before_assign",
    scriptName: args.name,
    flavor: args.flavor ?? "route",
    mode: args.mode ?? "hard",
    priority: args.priority,
    timeoutMs: args.timeoutMs,
    matcher: { taskType: args.taskType, ...args.matcher },
  });
}

beforeAll(() => {
  removeDbFiles();
  initDb(TEST_DB_PATH);
});

afterEach(() => {
  getDb().run("DELETE FROM edge_handlers");
  getDb().run("DELETE FROM routing_trace");
});

afterAll(() => {
  closeDb();
  removeDbFiles();
});

describe("task.before_assign routing engine", () => {
  test("matcher gating skips script spawn and trace writes when nothing matches", async () => {
    handler({
      name: "never-spawn",
      taskType: "matcher",
      matcher: {
        via: "delegation",
        source: "slack",
        slackChannelId: "C-OTHER",
        vcsRepo: "other/repo",
        agentId: crypto.randomUUID(),
        filter: "(payload) => payload.task.tags.includes('missing')",
      },
    });
    let spawns = 0;
    const run = createRoutingEngine(async () => {
      spawns += 1;
      return { result: {}, stdout: "" };
    });

    const decision = await run(ctx("matcher"));

    expect(spawns).toBe(0);
    expect(decision.trace).toEqual([]);
    expect(listTraceForRun(decision.routingRunId)).toEqual([]);
  });

  test("runs guards before routes, then priority and name order", async () => {
    handler({ name: "route-first-priority", taskType: "ordering", priority: 1 });
    handler({
      name: "guard-later-priority",
      taskType: "ordering",
      flavor: "guard",
      priority: 100,
    });
    const calls: string[] = [];
    const run = createRoutingEngine(async ({ scriptName }) => {
      calls.push(scriptName);
      return { result: {}, stdout: "" };
    });

    await run(ctx("ordering"));

    expect(calls).toEqual(["guard-later-priority", "route-first-priority"]);
  });

  test("first hard decisive result stops the chain", async () => {
    const assigned = crypto.randomUUID();
    handler({ name: "decisive-first", taskType: "hard-stop", priority: 1 });
    handler({ name: "must-not-run", taskType: "hard-stop", priority: 2 });
    const calls: string[] = [];
    const run = createRoutingEngine(async ({ scriptName }) => {
      calls.push(scriptName);
      return {
        result: scriptName === "decisive-first" ? { assignTo: assigned } : {},
        stdout: "",
      };
    });

    const decision = await run(ctx("hard-stop"));

    expect(decision.final).toEqual({ assignTo: assigned });
    expect(calls).toEqual(["decisive-first"]);
    expect(decision.trace[0]?.decisive).toBe(true);
  });

  test("soft decisive result becomes a suggestion and the chain continues", async () => {
    const suggested = crypto.randomUUID();
    const final = crypto.randomUUID();
    handler({ name: "soft-suggest", taskType: "soft-chain", mode: "soft", priority: 1 });
    handler({ name: "hard-final", taskType: "soft-chain", priority: 2 });
    const run = createRoutingEngine(async ({ scriptName }) => ({
      result: scriptName === "soft-suggest" ? { assignTo: suggested } : { assignTo: final },
      stdout: "",
    }));

    const decision = await run(ctx("soft-chain"));

    expect(decision.suggestions).toEqual([
      { handlerName: "soft-suggest", assignTo: suggested, block: undefined },
    ]);
    expect(decision.final).toEqual({ assignTo: final });
    expect(decision.trace).toHaveLength(2);
  });

  test("composes mutation fields, tag unions, directives, and notes in order", async () => {
    handler({ name: "compose-a", taskType: "compose", mode: "soft", priority: 1 });
    handler({ name: "compose-b", taskType: "compose", mode: "soft", priority: 2 });
    const run = createRoutingEngine(async ({ scriptName }) => ({
      result:
        scriptName === "compose-a"
          ? {
              mutate: { tags: ["a", "shared"], priority: 20, modelTier: "regular" },
              promptDirectives: ["first"],
              note: "note-a",
            }
          : {
              mutate: { tags: ["shared", "b"], priority: 80, modelTier: "smart" },
              promptDirectives: ["second", "third"],
              note: "note-b",
            },
      stdout: "",
    }));

    const decision = await run(ctx("compose"));

    expect(decision.mutations).toEqual({
      tags: ["a", "shared", "b"],
      priority: 80,
      modelTier: "smart",
    });
    expect(decision.promptDirectives).toEqual(["first", "second", "third"]);
    expect(decision.notes).toEqual(["note-a", "note-b"]);
  });

  test("route failures fail open and persist an error before continuing", async () => {
    const assigned = crypto.randomUUID();
    handler({ name: "route-throws", taskType: "route-failure", priority: 1 });
    handler({ name: "route-recovers", taskType: "route-failure", priority: 2 });
    const run = createRoutingEngine(async ({ scriptName }) => {
      if (scriptName === "route-throws") throw new Error("route exploded");
      return { result: { assignTo: assigned }, stdout: "" };
    });

    const decision = await run(ctx("route-failure"));
    const traces = listTraceForRun(decision.routingRunId);

    expect(decision.final).toEqual({ assignTo: assigned });
    expect(traces).toHaveLength(2);
    expect(traces[0]?.error).toContain("route exploded");
    expect(traces[1]?.decisive).toBe(true);
  });

  test("guard failures fail closed with a block", async () => {
    handler({
      name: "guard-throws",
      taskType: "guard-failure",
      flavor: "guard",
      priority: 1,
    });
    handler({ name: "route-never", taskType: "guard-failure", priority: 1 });
    const calls: string[] = [];
    const run = createRoutingEngine(async ({ scriptName }) => {
      calls.push(scriptName);
      throw new Error("guard unavailable");
    });

    const decision = await run(ctx("guard-failure"));

    expect(decision.final?.block?.reason).toContain("guard guard-throws failed: guard unavailable");
    expect(calls).toEqual(["guard-throws"]);
    expect(decision.trace[0]?.decisive).toBe(true);
  });

  test("timeout errors use the flavor failure semantics and configured timeout", async () => {
    handler({
      name: "timeout-route",
      taskType: "timeout",
      timeoutMs: 5,
      priority: 1,
    });
    handler({ name: "timeout-fallback", taskType: "timeout", mode: "soft", priority: 2 });
    const observedTimeouts: number[] = [];
    const runner: RoutingScriptRunner = async ({ scriptName, timeoutMs }) => {
      observedTimeouts.push(timeoutMs ?? 0);
      if (scriptName === "timeout-route") {
        await Bun.sleep((timeoutMs ?? 0) + 1);
        throw new Error(`Script timed out after ${timeoutMs}ms`);
      }
      return { result: {}, stdout: "" };
    };

    const decision = await createRoutingEngine(runner)(ctx("timeout"));

    expect(observedTimeouts).toEqual([5, 5000]);
    expect(decision.trace).toHaveLength(2);
    expect(decision.trace[0]?.error).toContain("timed out");
  });

  test("trace rows share routingRunId and record dryRun", async () => {
    handler({ name: "trace-a", taskType: "trace", mode: "soft", priority: 1 });
    handler({ name: "trace-b", taskType: "trace", mode: "soft", priority: 2 });
    const run = createRoutingEngine(async () => ({ result: {}, stdout: "" }));

    const decision = await run(ctx("trace"), { dryRun: true });
    const traces = listTraceForRun(decision.routingRunId);

    expect(traces).toHaveLength(2);
    expect(new Set(traces.map((trace) => trace.routingRunId))).toEqual(
      new Set([decision.routingRunId]),
    );
    expect(traces.every((trace) => trace.dryRun)).toBe(true);
  });
});
