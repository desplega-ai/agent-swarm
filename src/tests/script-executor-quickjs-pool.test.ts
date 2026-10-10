import { describe, expect, test } from "bun:test";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

// Each child gets a fresh shared pool. Hold host calls open so queued runs
// cannot reuse an idle worker and hide the configured concurrency limit.
const probe = `
import { QuickJSScriptExecutor, quickJSWorkerCount } from "./src/scripts-runtime/executors/quickjs";
import { DEFAULT_SCRIPT_RESOURCES } from "./src/scripts-runtime/executors/types";
let release;
const gate = new Promise(resolve => { release = resolve; });
let started = 0;
let inFlight = 0;
let peak = 0;
const server = Bun.serve({ port: 0, async fetch() {
  started++;
  peak = Math.max(peak, ++inFlight);
  await gate;
  inFlight--;
  return new Response("ok");
}});
try {
  const executor = new QuickJSScriptExecutor();
  const input = {
    source: 'export default async (args) => (await fetch(args.url)).text();',
    args: { url: "http://127.0.0.1:" + server.port },
    configPayload: { system: {
      apiKey: { value: "pool-test", isSecret: true },
      agentId: { value: crypto.randomUUID(), isSecret: false },
      mcpBaseUrl: { value: "http://127.0.0.1:" + server.port, isSecret: false },
    }, user: {} },
    resources: DEFAULT_SCRIPT_RESOURCES,
    fsMode: "none", network: "open",
  };
  const jobs = Array.from({ length: 10 }, () => executor.run(input));
  const workers = quickJSWorkerCount();
  const deadline = Date.now() + 10_000;
  while (started < workers && Date.now() < deadline) await Bun.sleep(10);
  const heldPeak = peak;
  release();
  const outputs = await Promise.all(jobs);
  process.env.SCRIPT_QUICKJS_POOL_SIZE = "16";
  const later = await executor.run(input);
  console.log(JSON.stringify({ workers, heldPeak, results: outputs.map(o => o.result),
    errors: outputs.map(o => o.error), stderr: outputs[0].stderr,
    retainedWorkers: quickJSWorkerCount(), laterResult: later.result }));
} finally {
  release();
  server.stop(true);
}
`;

async function inspectPool(size?: string) {
  const env = { ...process.env };
  if (size === undefined) delete env.SCRIPT_QUICKJS_POOL_SIZE;
  else env.SCRIPT_QUICKJS_POOL_SIZE = size;
  const result = expectChildOk(
    await runChild([process.execPath, "--eval", probe], { env }),
    "QuickJS pool probe",
  );
  return JSON.parse(result.stdout.trim()) as {
    workers: number;
    heldPeak: number;
    results: string[];
    errors: Array<string | null>;
    stderr: string;
    retainedWorkers: number;
    laterResult: string;
  };
}

describe("QuickJS pool configuration", () => {
  for (const [size, expected] of [
    [undefined, 4],
    ["1", 1],
    ["2", 2],
    ["8", 8],
  ] as const) {
    test(
      `pool size ${size ?? "unset"} controls workers and queues excess runs`,
      async () => {
        const result = await inspectPool(size);
        expect(result.workers).toBe(expected);
        expect(result.heldPeak).toBe(expected);
        expect(result.results).toEqual(Array(10).fill("ok"));
        expect(result.errors).toEqual(Array(10).fill(null));
        expect(result.retainedWorkers).toBe(expected);
        expect(result.laterResult).toBe("ok");
      },
      CHILD_PROCESS_TEST_BUDGET_MS,
    );
  }

  for (const size of ["0", "33"]) {
    test(
      `invalid pool size ${size} fails before spawning workers`,
      async () => {
        const result = await inspectPool(size);
        expect(result.workers).toBe(0);
        expect(result.errors).toEqual(Array(10).fill("executor_error"));
        expect(result.stderr).toContain("SCRIPT_QUICKJS_POOL_SIZE");
        expect(result.stderr).toContain("integer between 1 and 32");
      },
      CHILD_PROCESS_TEST_BUDGET_MS,
    );
  }
});
