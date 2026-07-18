/**
 * Extension-system spike: measure end-to-end latency of a minimal script
 * through the scripts-runtime sandbox (Bun.spawn + ulimit preamble + stdin
 * config + eval harness). Answers the research doc's open question of whether
 * a synchronous `tool.before_call` hook can afford a per-call sandbox spawn.
 *
 * Run: AGENT_SWARM_API_KEY=123123 bun scripts/spike-script-spawn-latency.ts
 */
import { runScript } from "../src/scripts-runtime/loader";

const WARMUP = 2;
const RUNS = 10;
const source = `export default async function run() { return { ok: true }; }`;

async function once(): Promise<number> {
  const start = performance.now();
  const out = await runScript({
    source,
    args: {},
    fsMode: "none",
    agentId: "spike-latency",
    timeoutMs: 10_000,
  });
  const elapsed = performance.now() - start;
  if (out.exitCode !== 0 || out.error) {
    throw new Error(`script failed: exit=${out.exitCode} err=${out.error} stderr=${out.stderr}`);
  }
  return elapsed;
}

for (let i = 0; i < WARMUP; i++) await once();

const samples: number[] = [];
for (let i = 0; i < RUNS; i++) samples.push(await once());
samples.sort((a, b) => a - b);

const p = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
console.log(`scripts-runtime spawn latency over ${RUNS} runs (after ${WARMUP} warmup):`);
console.log(`  min=${samples[0]?.toFixed(0)}ms p50=${p(0.5)?.toFixed(0)}ms p95=${p(0.95)?.toFixed(0)}ms max=${samples[samples.length - 1]?.toFixed(0)}ms`);
