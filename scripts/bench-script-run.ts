// Measure the HTTP script path sequentially on an isolated test API.
import { parseArgs } from "node:util";
import { getApiKey } from "../src/utils/api-key";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    n: { type: "string", default: "300" },
    warmup: { type: "string", default: "10" },
  },
  strict: true,
});
const n = Number(values.n);
const warmup = Number(values.warmup);
if (
  !values.url ||
  !Number.isSafeInteger(n) ||
  n < 1 ||
  !Number.isSafeInteger(warmup) ||
  warmup < 0
) {
  throw new Error(
    "Usage: bun scripts/bench-script-run.ts --url <test-api> [--n 300] [--warmup 10]",
  );
}
const url = new URL(values.url);
const apiKey = getApiKey();
if (!apiKey) throw new Error("Set AGENT_SWARM_API_KEY to the isolated test API key.");
const headers: Record<string, string> = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
};
async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, url), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return result;
}
const registered = await post("/api/agents", {
  name: `bench-script-${crypto.randomUUID()}`,
  role: "worker",
  status: "online",
});
if (typeof registered.id !== "string") throw new Error("Agent registration returned no ID.");
headers["X-Agent-ID"] = registered.id;
const rows = [];
for (const executor of ["native", "quickjs"]) {
  const samples: number[] = [];
  for (let index = -warmup; index < n; index++) {
    const started = performance.now();
    const output = await post("/api/scripts/run", {
      source: "export default async function () { return 42; }",
      executor,
    });
    const elapsed = performance.now() - started;
    if (output.exitCode !== 0 || output.result !== 42 || output.error || output.runtimeError) {
      throw new Error(`${executor} did not return a clean result of 42.`);
    }
    if (index >= 0) samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  rows.push({
    executor,
    n,
    warmup,
    p50Ms: samples[Math.ceil(n * 0.5) - 1],
    p95Ms: samples[Math.ceil(n * 0.95) - 1],
  });
}
console.log(JSON.stringify({ url: url.origin, results: rows }, null, 2));
