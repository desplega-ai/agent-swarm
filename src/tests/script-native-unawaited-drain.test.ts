import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { NativeScriptExecutor } from "../scripts-runtime/executors/native";
import {
  DEFAULT_SCRIPT_RESOURCES,
  type ExecutorInput,
  UNAWAITED_WORK_DRAIN_MS,
} from "../scripts-runtime/executors/types";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";

// A native run used to stay open until every call the script started had
// settled, even after its default export resolved. A parent that raced a slow
// nested `ctx.swarm.script_run` against a 100 ms deadline therefore still ran
// to the 30 s wall, was classified `timeout`, and lost its result. These tests
// drive the real swarm-sdk against a stand-in API: the nested script_run
// request is held open for 40 s, like a child that sleeps 40 s.

const CHILD_HOLD_MS = 40_000;
// The production wall. Keeping it here makes the old behaviour fail this file
// the same way the measured runs failed: at 30 s, with error "timeout".
const WALL_CLOCK_MS = DEFAULT_SCRIPT_RESOURCES.wallClockMs;
const TEST_BUDGET_MS = WALL_CLOCK_MS + 15_000;

let server: ReturnType<typeof Bun.serve>;
const held = new Set<() => void>();
let scriptRunRequests = 0;
let kvWrites: Array<{ path: string; body: unknown }> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/api/scripts/run") {
        scriptRunRequests++;
        await new Promise<void>((resolve) => {
          const release = () => {
            clearTimeout(timer);
            held.delete(release);
            resolve();
          };
          const timer = setTimeout(release, CHILD_HOLD_MS);
          held.add(release);
        });
        return Response.json({ result: "child-finished" });
      }
      if (req.method === "PUT" && url.pathname.startsWith("/api/kv/")) {
        const body = await req.json();
        // Answer slowly so the write is still in flight when the script returns.
        await Bun.sleep(300);
        kvWrites.push({ path: url.pathname, body });
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  for (const release of [...held]) release();
  server.stop(true);
});

beforeEach(() => {
  scriptRunRequests = 0;
  kvWrites = [];
});

function input(source: string): ExecutorInput {
  return {
    source,
    args: {},
    configPayload: {
      system: {
        apiKey: { value: "drain-test-secret", isSecret: true },
        agentId: { value: "00000000-0000-4000-8000-000000000001", isSecret: false },
        mcpBaseUrl: { value: `http://127.0.0.1:${server.port}`, isSecret: false },
      },
      user: {},
    },
    resources: { ...DEFAULT_SCRIPT_RESOURCES, memoryMb: 2048, wallClockMs: WALL_CLOCK_MS },
    fsMode: "none",
    network: "open",
  };
}

const spawnTest = test.skipIf(SKIP_SANDBOX_SPAWN_TESTS);

describe("native run settles when the entry function resolves", () => {
  spawnTest(
    "a Promise.race deadline bounds a run whose nested script_run is still pending",
    async () => {
      const output = await new NativeScriptExecutor().run(
        input(`
          export default async (_args, ctx) => {
            const child = ctx.swarm
              .script_run({ source: "export default async () => { await Bun.sleep(40000); return 1; }", args: {} })
              .then(() => "child");
            const deadline = new Promise((resolve) => setTimeout(() => resolve("deadline"), 100));
            return { winner: await Promise.race([child, deadline]) };
          };
        `),
      );

      expect(scriptRunRequests).toBe(1);
      expect(output.error).toBeUndefined();
      expect(output.exitCode).toBe(0);
      expect(output.result).toEqual({ winner: "deadline" });
      expect(output.durationMs).toBeLessThan(5_000);
      expect(output.stderr).toContain("un-awaited calls were still pending");
    },
    TEST_BUDGET_MS,
  );

  spawnTest(
    "an un-awaited kv_set still lands, and a run with nothing pending exits without waiting",
    async () => {
      const output = await new NativeScriptExecutor().run(
        input(`
          export default async (_args, ctx) => {
            // Fired without await: the request is in flight when the script returns.
            void ctx.swarm.kv_set({ key: "fired-at-return", value: "a" });
            // Started later, still inside the drain window.
            void (async () => {
              await Bun.sleep(500);
              await ctx.swarm.kv_set({ key: "fired-after-500ms", value: "b" });
            })();
            return "returned";
          };
        `),
      );

      expect(output.error).toBeUndefined();
      expect(output.result).toBe("returned");
      expect(kvWrites.map((w) => w.path).sort()).toEqual([
        "/api/kv/fired-after-500ms",
        "/api/kv/fired-at-return",
      ]);
      // Both writes settled on their own, so the drain timer never fired.
      expect(output.stderr).not.toContain("un-awaited calls were still pending");
      expect(output.durationMs).toBeLessThan(UNAWAITED_WORK_DRAIN_MS + 2_000);
    },
    TEST_BUDGET_MS,
  );

  spawnTest(
    "an un-awaited call that starts after the drain window is stopped and reported",
    async () => {
      const output = await new NativeScriptExecutor().run(
        input(`
          export default async (_args, ctx) => {
            void (async () => {
              await Bun.sleep(${UNAWAITED_WORK_DRAIN_MS + 1_500});
              await ctx.swarm.kv_set({ key: "too-late", value: "c" });
            })();
            return "returned";
          };
        `),
      );

      expect(output.error).toBeUndefined();
      expect(output.result).toBe("returned");
      expect(kvWrites).toEqual([]);
      expect(output.stderr).toContain("un-awaited calls were still pending");
    },
    TEST_BUDGET_MS,
  );
});
