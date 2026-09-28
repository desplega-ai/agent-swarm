// Single-query embed latency per model (what pre-task recall and memory-search pay).
// 20 sequential calls per model with realistic short queries, from this machine.
//
// Usage: bun scripts/embedding-eval/latency.ts
import { type EvalQuery, readJson } from "./common";

const queries = (await readJson<EvalQuery[]>("queries.json"))
  .filter((q) => q.set === "synthetic-task")
  .slice(0, 20)
  .map((q) => q.text);

type Target = {
  name: string;
  url: string;
  headers: Record<string, string>;
  body: (t: string) => unknown;
};
const openai = (model: string, dims?: number): Target => ({
  name: `${model}${dims ? `@${dims}` : ""}`,
  url: "https://api.openai.com/v1/embeddings",
  headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  body: (t) => ({
    model,
    input: t,
    encoding_format: "float",
    ...(dims ? { dimensions: dims } : {}),
  }),
});
const openrouter = (model: string): Target => ({
  name: `openrouter:${model}`,
  url: "https://openrouter.ai/api/v1/embeddings",
  headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
  body: (t) => ({ model, input: t, encoding_format: "float" }),
});
const gemini = (model: string): Target => ({
  name: `gemini:${model}`,
  url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`,
  headers: { "x-goog-api-key": process.env.GOOGLE_API_KEY ?? "" },
  body: (t) => ({ content: { parts: [{ text: t }] }, taskType: "RETRIEVAL_QUERY" }),
});

const targets = [
  openai("text-embedding-3-small", 512),
  openai("text-embedding-3-large"),
  openrouter("openai/text-embedding-3-small"),
  gemini("gemini-embedding-001"),
  gemini("gemini-embedding-2"),
  openrouter("google/gemini-embedding-2"),
  openrouter("qwen/qwen3-embedding-8b"),
  openrouter("voyageai/voyage-4"),
];

const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)]!;
for (const t of targets) {
  const ms: number[] = [];
  for (const q of queries) {
    const start = performance.now();
    const res = await fetch(t.url, {
      method: "POST",
      headers: { ...t.headers, "content-type": "application/json" },
      body: JSON.stringify(t.body(q)),
    });
    await res.arrayBuffer();
    if (res.ok) ms.push(performance.now() - start);
  }
  console.log(
    `| ${t.name} | ${ms.length} | ${pct(ms, 0.5).toFixed(0)} | ${pct(ms, 0.9).toFixed(0)} |`,
  );
}
