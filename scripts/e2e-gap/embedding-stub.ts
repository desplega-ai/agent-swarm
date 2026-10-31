// OpenAI-compatible embeddings stub for e2e gap tests. Usage:
//   bun scripts/e2e-gap/embedding-stub.ts <scenario> [run.ts args...]
// Starts the stub, runs `scripts/e2e/run.ts --only <scenario>` with the SUT pointed at it
// (EMBEDDING_API_BASE_URL, OPENAI_API_KEY=stub, EMBEDDING_MODEL=gap-model-a) and GAP_EMB_URL for the scenario.
// Vectors are deterministic per (model, text), so a re-embed into the same space reproduces them.
import { createHash } from "node:crypto";

const DIMS = 512;
const stats: { requests: number; inputs: number; byModel: Record<string, number> } = {
  requests: 0,
  inputs: 0,
  byModel: {},
};

function vector(model: string, text: string): number[] {
  const out: number[] = [];
  let seed = createHash("sha256").update(`${model}\n${text}`).digest();
  while (out.length < DIMS) {
    for (const byte of seed) out.push(byte / 127.5 - 1);
    seed = createHash("sha256").update(seed).digest();
  }
  const v = out.slice(0, DIMS);
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/__stats") return Response.json(stats);
    if (url.pathname.endsWith("/embeddings") && req.method === "POST") {
      const body = (await req.json()) as { model: string; input: string | string[] };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      stats.requests += 1;
      stats.inputs += inputs.length;
      stats.byModel[body.model] = (stats.byModel[body.model] ?? 0) + inputs.length;
      return Response.json({
        object: "list",
        model: body.model,
        data: inputs.map((text, index) => ({
          object: "embedding",
          index,
          embedding: vector(body.model, String(text)),
        })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

const [scenario, ...rest] = process.argv.slice(2);
const base = `http://127.0.0.1:${server.port}`;
const child = Bun.spawn(
  [
    "bun",
    "scripts/e2e/run.ts",
    "--only",
    scenario,
    "--sut-env",
    `EMBEDDING_API_BASE_URL=${base}/v1`,
    "--sut-env",
    "OPENAI_API_KEY=stub-key",
    "--sut-env",
    "EMBEDDING_MODEL=gap-model-a",
    ...rest,
  ],
  {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, GAP_EMB_URL: base },
  },
);
const code = await child.exited;
server.stop(true);
process.exit(code);
