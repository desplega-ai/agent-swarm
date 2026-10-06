// Pooled LLM relevance judging for real pre-task recall queries.
//
// The prod rating labels only exist for memories the incumbent pipeline
// (3-small@512 hybrid) already surfaced, so they favor the incumbent. Here we
// pool the top-5 of several configs per query (TREC-style), judge every pooled
// (task, memory) pair with a model from a vendor that is not under test, and
// score each config on the same judged pool.
//
// Usage: bun scripts/embedding-eval/judge.ts
import { existsSync } from "node:fs";
import {
  DATA_DIR,
  type EvalQuery,
  type Memory,
  pool,
  readJson,
  rng,
  shuffle,
  writeJson,
} from "./common";
import { chatJson, llmUsage } from "./llm";

const JUDGE = "anthropic/claude-haiku-4.5";
const QUERY_COUNT = 120;
const K = 5;
const BASELINE = "oai-3s@512";
const POOL_CONFIGS = [
  "oai-3s@512",
  "oai-3s@1536",
  "oai-3l@3072",
  "gem-001@3072",
  "gem-2@768",
  "gem-2-or@768",
  "qwen3-8b@4096",
  "voyage-4@1024",
  "nomic-v15@512",
  "nomic-v15-noprefix@512",
  "gemma-300m@512",
];
const MODES = ["vec", "hybrid"] as const;

const SYSTEM = `You judge search results for the long-term memory of AI coding agents.
An agent is about to start the TASK below. The system recalled one stored MEMORY for it.
Rate how useful the memory is for doing this task:
2 = directly useful: it contains facts, decisions, procedures, or context the agent would use for this task
1 = related: same project or topic, but the agent would not really need it
0 = not useful
Return only JSON: {"score": 0|1|2}`;

type Rankings = Record<string, Record<string, Record<string, string[]>>>;
const rankings = await readJson<Rankings>("rankings-real.json");
const queries = (await readJson<EvalQuery[]>("queries.json")).filter(
  (q) => q.set === "real-pretask",
);
const memories = new Map((await readJson<Memory[]>("memories.json")).map((m) => [m.id, m]));
const configs = POOL_CONFIGS.filter((c) => rankings[c]);
const sample = shuffle(queries, rng(42)).slice(0, QUERY_COUNT);

const judgmentsFile = "judgments.json";
const judgments: Record<string, number> = existsSync(`${DATA_DIR}/${judgmentsFile}`)
  ? await readJson(judgmentsFile)
  : {};
const pairKey = (q: string, m: string) => `${q}|${m}`;

const jobs: { q: EvalQuery; memoryId: string }[] = [];
for (const q of sample) {
  const pooled = new Set<string>();
  for (const c of configs)
    for (const mode of MODES)
      for (const id of rankings[c]![mode]![q.id]!.slice(0, K)) pooled.add(id);
  for (const memoryId of pooled)
    if (!(pairKey(q.id, memoryId) in judgments)) jobs.push({ q, memoryId });
}

let done = 0;
await pool(jobs, 12, async ({ q, memoryId }) => {
  const m = memories.get(memoryId)!;
  const out = await chatJson<{ score?: number }>(
    SYSTEM,
    `TASK:\n${q.text.slice(0, 4000)}\n\nMEMORY (title: ${m.name}):\n${m.content.slice(0, 2500)}`,
    JUDGE,
  );
  if (typeof out?.score === "number") judgments[pairKey(q.id, memoryId)] = out.score;
  if (++done % 500 === 0) {
    console.error(`[judge] ${done}/${jobs.length}`);
    await writeJson(judgmentsFile, judgments);
  }
});
await writeJson(judgmentsFile, judgments);

// ---------------------------------------------------------------------------
// Score every config on the judged pool.
// ---------------------------------------------------------------------------
function perQuery(config: string, mode: (typeof MODES)[number]) {
  return sample.map((q) => {
    const top = rankings[config]![mode]![q.id]!.slice(0, K);
    const rels = top.map((id) => judgments[pairKey(q.id, id)] ?? 0);
    const pooledRels = Object.entries(judgments)
      .filter(([k]) => k.startsWith(`${q.id}|`))
      .map(([, v]) => v)
      .sort((a, b) => b - a)
      .slice(0, K);
    const dcg = (xs: number[]) => xs.reduce((s, r, i) => s + (2 ** r - 1) / Math.log2(i + 2), 0);
    const ideal = dcg(pooledRels);
    return {
      p5useful: rels.filter((r) => r === 2).length / K,
      p5related: rels.filter((r) => r >= 1).length / K,
      anyUseful: rels.some((r) => r === 2) ? 1 : 0,
      ndcg5: ideal > 0 ? dcg(rels) / ideal : 0,
    };
  });
}

function bootstrap(a: number[], b: number[], n = 2000): [number, number, number] {
  const d = a.map((x, i) => x - b[i]!);
  const rand = rng(7);
  const means: number[] = [];
  for (let r = 0; r < n; r++) {
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[Math.floor(rand() * d.length)]!;
    means.push(s / d.length);
  }
  means.sort((x, y) => x - y);
  const mean = d.reduce((s, x) => s + x, 0) / d.length;
  return [mean, means[Math.floor(n * 0.025)]!, means[Math.floor(n * 0.975)]!];
}

const result: Record<string, unknown> = {
  queries: sample.length,
  judged: Object.keys(judgments).length,
  judge: JUDGE,
};
const lines: string[] = [];
for (const mode of MODES) {
  lines.push(
    `\n### real pre-task, LLM-judged pool, ${mode} (n=${sample.length}, delta vs ${BASELINE}, * = 95% CI excludes 0)\n`,
  );
  lines.push("| config | P@5 useful | P@5 related+ | any useful in top-5 | nDCG@5 |");
  lines.push("|---|---|---|---|---|");
  const base = perQuery(BASELINE, mode);
  for (const c of configs) {
    const rows = perQuery(c, mode);
    const cell = (metric: keyof (typeof rows)[number]) => {
      const vals = rows.map((r) => r[metric]);
      const mean = vals.reduce((s, x) => s + x, 0) / vals.length;
      const [d, lo, hi] = bootstrap(
        vals,
        base.map((r) => r[metric]),
      );
      const sig = lo > 0 || hi < 0 ? "*" : "";
      result[`${c}/${mode}/${metric}`] = { mean, delta: [d, lo, hi] };
      return `${mean.toFixed(3)} (${d >= 0 ? "+" : ""}${d.toFixed(3)}${sig})`;
    };
    lines.push(
      `| ${c} | ${cell("p5useful")} | ${cell("p5related")} | ${cell("anyUseful")} | ${cell("ndcg5")} |`,
    );
  }
}
const outDir = process.env.EMBED_EVAL_OUT ?? `${import.meta.dir}/results`;
await Bun.write(`${outDir}/judged.json`, JSON.stringify(result, null, 1));
console.log(lines.join("\n"));
console.error(JSON.stringify({ judgeJobs: jobs.length, llmUsage }));
