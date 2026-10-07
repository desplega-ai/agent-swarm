/**
 * Native vs quickjs script executor bench. Runs the real executor classes.
 *
 *   bun experiments/quickjs-executor/bench.ts            # N=30, CONC=16
 *   N=50 CONC=8 bun experiments/quickjs-executor/bench.ts
 *
 * For prod-like native numbers, point the native executor at prebuilt
 * runtime bundles (see the Dockerfile `scripts-runtime` step):
 *   SCRIPT_RUNTIME_DIR=/path/to/scripts-runtime bun experiments/quickjs-executor/bench.ts
 *
 * Results and analysis: thoughts/taras/research/2026-10-07-quickjs-script-executor.md
 */
import { NativeScriptExecutor } from "../../src/scripts-runtime/executors/native";
import { QuickJSScriptExecutor } from "../../src/scripts-runtime/executors/quickjs";
import type { ScriptExecutor } from "../../src/scripts-runtime/executors/types";
import { DEFAULT_SCRIPT_RESOURCES } from "../../src/scripts-runtime/executors/types";

const N = Number(process.env.N ?? 30);
const CONC = Number(process.env.CONC ?? 16);

// Stands in for the swarm API that ctx.swarm.* and fetch calls reach.
const server = Bun.serve({
  port: 0,
  fetch: () =>
    Response.json({ items: Array.from({ length: 20 }, (_, i) => ({ id: i, name: `t${i}` })) }),
});
const apiUrl = `http://127.0.0.1:${server.port}/api/tasks`;

const SCRIPTS: Record<string, { source: string; args: unknown; heavy?: boolean }> = {
  trivial: {
    source: "export default async (args: { a: number; b: number }) => ({ sum: args.a + args.b });",
    args: { a: 1, b: 2 },
  },
  "3 http calls": {
    source: `export default async (args: { url: string }) => {
  let n = 0;
  for (let i = 0; i < 3; i++) n += ((await (await fetch(args.url)).json()) as any).items.length;
  return { n };
};`,
    args: { url: apiUrl },
  },
  "zod argsSchema": {
    source: `import { z } from "zod";
export const argsSchema = z.object({ email: z.string().email(), n: z.number().int() });
export default async (args: z.infer<typeof argsSchema>) => args;`,
    args: { email: "a@b.co", n: 3 },
  },
  "cpu loop (5M)": {
    source: `export default async () => {
  let acc = 0;
  for (let i = 0; i < 5_000_000; i++) acc = (acc + Math.sqrt(i) * 31) % 1_000_003;
  return { acc };
};`,
    args: null,
    heavy: true,
  },
  "json 50k rows": {
    source: `export default async () => {
  const rows = Array.from({ length: 50_000 }, (_, i) => ({ id: i, team: "t" + (i % 50), cost: (i * 7) % 113 }));
  const parsed = JSON.parse(JSON.stringify(rows));
  const byTeam: Record<string, number> = {};
  for (const r of parsed) byTeam[r.team] = (byTeam[r.team] ?? 0) + r.cost;
  return { teams: Object.keys(byTeam).length };
};`,
    args: null,
    heavy: true,
  },
};

const configPayload = {
  system: {
    apiKey: { value: "bench-key", isSecret: true as const },
    agentId: { value: crypto.randomUUID(), isSecret: false as const },
    mcpBaseUrl: { value: `http://127.0.0.1:${server.port}`, isSecret: false as const },
  },
  user: {},
};

async function run(executor: ScriptExecutor, name: string) {
  const script = SCRIPTS[name];
  if (!script) throw new Error(`unknown script ${name}`);
  const output = await executor.run({
    source: script.source,
    args: script.args,
    configPayload,
    resources: DEFAULT_SCRIPT_RESOURCES,
    fsMode: "none",
    network: "open",
  });
  if (output.exitCode !== 0) throw new Error(`${executor.name} ${name}: ${output.stderr}`);
  return output.result;
}

function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
}

async function latency(executor: ScriptExecutor, name: string, iterations: number) {
  await run(executor, name);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await run(executor, name);
    samples.push(performance.now() - start);
  }
  return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
}

async function throughput(executor: ScriptExecutor, name: string, total: number) {
  let next = 0;
  const start = performance.now();
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (next < total) {
        next++;
        await run(executor, name);
      }
    }),
  );
  return total / ((performance.now() - start) / 1000);
}

/** Largest gap of a 5 ms interval in this (API) process while the script runs. */
async function loopStall(executor: ScriptExecutor, name: string) {
  let last = performance.now();
  let worst = 0;
  const interval = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 5);
    last = now;
  }, 5);
  await run(executor, name);
  await Bun.sleep(15);
  clearInterval(interval);
  return worst;
}

const fmt = (value: number) => (value < 10 ? value.toFixed(2) : value.toFixed(0)).padStart(7);
const native = new NativeScriptExecutor();
const quickjs = new QuickJSScriptExecutor();

for (const name of Object.keys(SCRIPTS)) {
  const a = JSON.stringify(await run(native, name));
  const b = JSON.stringify(await run(quickjs, name));
  if (a !== b) console.log(`!! result mismatch for ${name}: native=${a} quickjs=${b}`);
}

console.log(
  `bun ${Bun.version} ${process.platform}/${process.arch} | native harness: ${process.env.SCRIPT_RUNTIME_DIR ? "prebuilt bundles" : "TS sources"}\n`,
);
console.log("latency, ms              native p50    p95 | quickjs p50    p95 | speedup");
for (const [name, script] of Object.entries(SCRIPTS)) {
  const iterations = script.heavy ? Math.min(N, 8) : N;
  const n = await latency(native, name, iterations);
  const q = await latency(quickjs, name, iterations);
  console.log(
    `  ${name.padEnd(20)} ${fmt(n.p50)} ${fmt(n.p95)} |  ${fmt(q.p50)} ${fmt(q.p95)} | ${(n.p50 / q.p50).toFixed(1)}x`,
  );
}

console.log(`\nthroughput, runs/s (${CONC} concurrent)   native | quickjs`);
for (const name of ["trivial", "3 http calls", "zod argsSchema"]) {
  console.log(
    `  ${name.padEnd(36)} ${fmt(await throughput(native, name, N * 3))} | ${fmt(await throughput(quickjs, name, N * 3))}`,
  );
}

console.log("\nAPI event-loop stall, ms               native | quickjs");
for (const name of ["trivial", "cpu loop (5M)", "json 50k rows"]) {
  console.log(
    `  ${name.padEnd(36)} ${fmt(await loopStall(native, name))} | ${fmt(await loopStall(quickjs, name))}`,
  );
}

server.stop(true);
process.exit(0);
