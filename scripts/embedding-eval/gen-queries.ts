// Build the three query sets:
//   synthetic-task / synthetic-search: LLM-written queries for sampled target rows
//   real-pretask: real task text -> positively rated pre-task recalls
//   chunk-detail / chunk-gist: queries for long docs (chunking experiment)
//
// Usage: bun scripts/embedding-eval/gen-queries.ts
import { type EvalQuery, type Memory, pool, readJson, rng, shuffle, writeJson } from "./common";
import { chatJson, llmUsage } from "./llm";

const memories = await readJson<Memory[]>("memories.json");
const byId = new Map(memories.map((m) => [m.id, m]));
const rand = rng(20260925);

// ---------------------------------------------------------------------------
// 1. Synthetic known-item queries: 100 targets per source.
// ---------------------------------------------------------------------------
const SYNTH_SYSTEM = `You help build a retrieval benchmark for the long-term memory of AI coding agents.
You receive ONE memory that an agent stored earlier. Write two queries for which this memory is the best match.

1. "task": a realistic task assignment (1-4 sentences) that a lead agent or a human could send to a worker agent, where recalling this memory would materially help. Write the task itself, not a question about the memory.
2. "search": a short query (4-12 words) the agent would type into a memory-search tool to find this memory.

Rules:
- Paraphrase. Do not copy sentences or distinctive multi-word phrases from the memory.
- Mention a product, repo, tool, or identifier only when a real task would naturally mention it.
- If the memory has no specific content that a later task could need, return {"skip": true}.
Return only JSON: {"task": "...", "search": "..."} or {"skip": true}.`;

const PER_SOURCE = 100;
const targets: Memory[] = [];
for (const source of ["manual", "file_index", "session_summary", "task_completion"] as const) {
  const eligible = memories.filter(
    (m) => m.source === source && m.content.length >= 200 && m.content.length <= 24_000,
  );
  targets.push(...shuffle(eligible, rand).slice(0, PER_SOURCE));
}

// Rows with identical content count as the same item.
const idsByContent = new Map<string, string[]>();
for (const m of memories) {
  const list = idsByContent.get(m.content) ?? [];
  list.push(m.id);
  idsByContent.set(m.content, list);
}

const synthetic: EvalQuery[] = [];
await pool(targets, 8, async (target) => {
  const out = await chatJson<{ task?: string; search?: string; skip?: boolean }>(
    SYNTH_SYSTEM,
    `Memory title: ${target.name}\n\nMemory content:\n${target.content.slice(0, 6000)}`,
  );
  if (!out || out.skip || !out.task || !out.search) return;
  const positives = idsByContent.get(target.content) ?? [target.id];
  const base = { agentId: target.agentId, cutoff: null, positives };
  const meta = { targetId: target.id, source: target.source, length: target.content.length };
  synthetic.push({ id: `st-${target.id}`, set: "synthetic-task", text: out.task, ...base, meta });
  synthetic.push({
    id: `ss-${target.id}`,
    set: "synthetic-search",
    text: out.search,
    ...base,
    meta,
  });
});

// ---------------------------------------------------------------------------
// 2. Real pre-task recall queries.
// ---------------------------------------------------------------------------
type RawReal = {
  taskId: string;
  agentId: string;
  task: string;
  recalledAt: string;
  retrieved: string[];
  positives: string[];
};
const rawReal = await readJson<RawReal[]>("real-queries-raw.json");
const real: EvalQuery[] = [];
for (const q of rawReal) {
  // Keep positives that still exist and existed when the recall ran.
  const positives = q.positives.filter((id) => {
    const m = byId.get(id);
    return m && m.createdAt < q.recalledAt;
  });
  if (positives.length === 0) continue;
  real.push({
    id: `rp-${q.taskId}`,
    set: "real-pretask",
    text: q.task,
    agentId: q.agentId,
    cutoff: q.recalledAt,
    positives,
    meta: { taskLength: q.task.length, retrieved: q.retrieved },
  });
}

// ---------------------------------------------------------------------------
// 3. Chunking experiment: long task_completion docs (stored unchunked today).
// ---------------------------------------------------------------------------
const CHUNK_SYSTEM = `You help build a retrieval benchmark for the long-term memory of AI coding agents.
You receive a long document an agent stored (title, opening, and one PASSAGE from deeper inside it).
Write two realistic task assignments (1-3 sentences each) that a lead agent could send to a worker agent:

1. "detail": a task that needs the specific facts in the PASSAGE (not the general topic of the document).
2. "gist": a task that needs the document as a whole (its overall topic and outcome).

Rules: paraphrase, do not copy distinctive phrases, write the task itself (not a question about the document).
If the PASSAGE has no specific facts a later task could need, set "detail" to null.
Return only JSON: {"detail": "..." | null, "gist": "..."}.`;

const DOC_COUNT = 200;
const longDocs = shuffle(
  memories.filter(
    (m) => m.source === "task_completion" && m.content.length > 4000 && m.content.length <= 24_000,
  ),
  rand,
).slice(0, DOC_COUNT);

function pickPassage(content: string): { start: number; text: string } {
  const start = Math.floor(content.length * (0.3 + rand() * 0.55));
  const lineStart = content.lastIndexOf("\n", start) + 1;
  return { start: lineStart, text: content.slice(lineStart, lineStart + 1200) };
}

// Pick passages up front so the seeded PRNG stays deterministic.
const passages = new Map(longDocs.map((d) => [d.id, pickPassage(d.content)]));
const chunkQueries: EvalQuery[] = [];
await pool(longDocs, 8, async (doc) => {
  const passage = passages.get(doc.id)!;
  const out = await chatJson<{ detail?: string | null; gist?: string }>(
    CHUNK_SYSTEM,
    `Title: ${doc.name}\n\nOpening:\n${doc.content.slice(0, 1500)}\n\nPASSAGE:\n${passage.text}`,
  );
  if (!out?.gist) return;
  const base = { agentId: doc.agentId, cutoff: null, positives: [doc.id] };
  const meta = { docId: doc.id, length: doc.content.length, passageStart: passage.start };
  chunkQueries.push({ id: `cg-${doc.id}`, set: "chunk-gist", text: out.gist, ...base, meta });
  if (out.detail) {
    chunkQueries.push({ id: `cd-${doc.id}`, set: "chunk-detail", text: out.detail, ...base, meta });
  }
});

await writeJson("queries.json", [...synthetic, ...real]);
await writeJson("chunk-queries.json", chunkQueries);
await writeJson(
  "chunk-docs.json",
  longDocs.map((d) => d.id),
);

const count = (qs: EvalQuery[]) =>
  qs.reduce<Record<string, number>>((acc, q) => {
    acc[q.set] = (acc[q.set] ?? 0) + 1;
    return acc;
  }, {});
console.log(
  JSON.stringify({ ...count(synthetic), ...count(real), ...count(chunkQueries), llmUsage }),
);
