// Build chunked representations of the chunking-experiment docs.
//
// Strategies (each doc becomes N rows; a doc counts as retrieved when any of
// its rows is retrieved):
//   whole            one row, full doc (what task_completion gets today)
//   prod-2000        src/be/chunking.ts chunkContent (2000 chars, 100 overlap, header split)
//   rec-1000         same algorithm, 1000 chars / 100 overlap
//   rec-4000         same algorithm, 4000 chars / 200 overlap
//   prod-2000-title  prod-2000 rows prefixed with the memory name
//   prod-2000-ctx    prod-2000 rows prefixed with LLM context (contextual retrieval)
//   whole+prod-2000  union of whole and prod-2000 rows (scorer-side, no new rows)
//
// Usage: bun scripts/embedding-eval/chunk.ts
import { chunkContent } from "../../src/be/chunking";
import { type Memory, pool, readJson, writeJson } from "./common";
import { chat, llmUsage } from "./llm";

type Params = { max: number; overlap: number; min: number };

// Parametrized copy of src/be/chunking.ts (verified identical at 2000/100 below).
function chunkWith(text: string, p: Params): string[] {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < p.min) return [];
  if (trimmed.length <= p.max) return [trimmed];
  const raw: { content: string; headings: string[] }[] = [];
  for (const section of splitByHeaders(trimmed)) {
    if (section.content.length <= p.max) raw.push(section);
    else
      for (const sub of recursiveSplit(section.content, 0, p))
        raw.push({ content: sub, headings: section.headings });
  }
  const filtered = raw.filter((c) => c.content.trim().length >= p.min);
  if (filtered.length === 0) return [trimmed];
  return filtered.map((c) =>
    c.headings.length > 0 ? `${c.headings.join(" > ")}\n\n${c.content}` : c.content,
  );
}

function splitByHeaders(text: string): { content: string; headings: string[] }[] {
  const sections: { content: string; headings: string[] }[] = [];
  let current: string[] = [];
  const stack: string[] = [];
  const flush = () => {
    const content = current.join("\n").trim();
    if (content) sections.push({ content, headings: [...stack] });
    current = [];
  };
  for (const line of text.split("\n")) {
    const m = line.match(/^(#{1,3})\s+(.+)$/);
    if (m) {
      if (current.length > 0) flush();
      const level = m[1]!.length;
      while (stack.length >= level) stack.pop();
      stack.push(`${"#".repeat(level)} ${m[2]!.trim()}`);
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) flush();
  return sections.length === 0 ? [{ content: text, headings: [] }] : sections;
}

const SEPARATORS = ["\n\n", "\n", ". ", " "];
function recursiveSplit(text: string, sep: number, p: Params): string[] {
  if (text.length <= p.max) return [text.trim()].filter((s) => s.length > 0);
  if (sep >= SEPARATORS.length) return hardSplit(text, p);
  const separator = SEPARATORS[sep]!;
  const parts = text.split(separator);
  if (parts.length <= 1) return recursiveSplit(text, sep + 1, p);
  const chunks: string[] = [];
  let current = "";
  for (const part of parts) {
    const candidate = current ? current + separator + part : part;
    if (candidate.length <= p.max) {
      current = candidate;
    } else {
      if (current) chunks.push(current.trim());
      if (part.length > p.max) {
        chunks.push(...recursiveSplit(part, sep + 1, p));
        current = "";
      } else {
        current = part;
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  if (chunks.length <= 1) return chunks;
  const out = [chunks[0]!];
  for (let i = 1; i < chunks.length; i++) {
    const overlap = chunks[i - 1]!.slice(-p.overlap);
    out.push(
      overlap.length + chunks[i]!.length <= p.max + p.overlap ? overlap + chunks[i]! : chunks[i]!,
    );
  }
  return out;
}

function hardSplit(text: string, p: Params): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + p.max, text.length);
    chunks.push(text.slice(start, end).trim());
    if (end === text.length) break; // termination guard (prod copy lacks it; see above)
    start = end - p.overlap;
    if (start >= text.length - p.min) break;
  }
  return chunks.filter((c) => c.length > 0);
}

const memories = await readJson<Memory[]>("memories.json");
const byId = new Map(memories.map((m) => [m.id, m]));
const docIds = await readJson<string[]>("chunk-docs.json");
// Before #1639, src/be/chunking.ts hardSplit never terminated, so chunkContent hung
// on any > max-char run with no space or newline. The eval keeps only docs whose
// longest such run fits the smallest chunk size, so every strategy sees the same docs.
const unbroken = /[^ \n]{1001,}/;
const docs = docIds.map((id) => byId.get(id)!).filter((d) => !unbroken.test(d.content));
await writeJson(
  "chunk-docs-used.json",
  docs.map((d) => d.id),
);

// Fidelity: the parametrized copy must match prod chunkContent exactly.
for (const d of docs) {
  const prod = chunkContent(d.content).map((c) => c.content);
  const ours = chunkWith(d.content, { max: 2000, overlap: 100, min: 50 });
  if (JSON.stringify(prod) !== JSON.stringify(ours)) throw new Error(`chunker mismatch on ${d.id}`);
}

const CONTEXT_PROMPT = (doc: string, chunk: string) => `<document>
${doc}
</document>
Here is the chunk we want to situate within the whole document
<chunk>
${chunk}
</chunk>
Please give a short succinct context to situate this chunk within the overall document for the purposes of improving search retrieval of the chunk. Answer only with the succinct context and nothing else.`;

type Row = { id: string; docId: string; strategy: string; text: string };
const rows: Row[] = [];
const add = (strategy: string, doc: Memory, texts: string[]) => {
  for (const [i, text] of texts.entries()) {
    rows.push({ id: `${strategy}:${doc.id}:${i}`, docId: doc.id, strategy, text });
  }
};

const ctxJobs: { doc: Memory; i: number; chunk: string }[] = [];
for (const doc of docs) {
  const prod = chunkContent(doc.content).map((c) => c.content);
  add("whole", doc, [doc.content]);
  add("prod-2000", doc, prod);
  add("rec-1000", doc, chunkWith(doc.content, { max: 1000, overlap: 100, min: 50 }));
  add("rec-4000", doc, chunkWith(doc.content, { max: 4000, overlap: 200, min: 50 }));
  add(
    "prod-2000-title",
    doc,
    prod.map((c) => `${doc.name}\n\n${c}`),
  );
  for (const [i, chunk] of prod.entries()) ctxJobs.push({ doc, i, chunk });
}

const contexts = await pool(ctxJobs, 12, async (job) =>
  chat(
    "You write retrieval context for document chunks.",
    CONTEXT_PROMPT(job.doc.content, job.chunk),
  ),
);
ctxJobs.forEach((job, k) => {
  const ctx = contexts[k]?.trim() ?? "";
  rows.push({
    id: `prod-2000-ctx:${job.doc.id}:${job.i}`,
    docId: job.doc.id,
    strategy: "prod-2000-ctx",
    text: ctx ? `${ctx}\n\n${job.chunk}` : job.chunk,
  });
});

await writeJson("chunks.json", rows);
const perStrategy = rows.reduce<Record<string, number>>((acc, r) => {
  acc[r.strategy] = (acc[r.strategy] ?? 0) + 1;
  return acc;
}, {});
console.log(
  JSON.stringify({
    docs: docs.length,
    excluded: docIds.length - docs.length,
    rowsPerStrategy: perStrategy,
    contextFailures: contexts.filter((c) => !c).length,
    llmUsage,
  }),
);
