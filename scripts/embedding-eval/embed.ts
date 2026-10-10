// Embed corpus / query / chunk texts with each model config, with a resumable
// on-disk cache. Vectors are stored at the model's full width; the scorer
// derives shorter widths by truncation + re-normalization (Matryoshka).
//
// Cache file: DATA_DIR/emb/<config>.bin, records of
//   [20-byte sha1][u32 dims][dims x f32]
// Manifest:   DATA_DIR/manifest/<config>.<set>.json = [{ id, hash }]
//
// Usage: bun scripts/embedding-eval/embed.ts <config,...> <set,...>
//   sets: corpus, corpus-named, queries, chunk-queries, chunks, prodcheck
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import {
  cleanForEmbedding,
  DATA_DIR,
  type EvalQuery,
  type Memory,
  pool,
  readJson,
  sha1,
  writeJson,
} from "./common";

type Role = "doc" | "query";
type Config = {
  provider: "openai" | "gemini" | "openrouter";
  model: string;
  /** Request-time width. Omitted = model default (full width). */
  dimensions?: number;
  /** Gemini native task types. When set, doc and query vectors differ. */
  taskTypes?: { doc: string; query: string };
  batchItems: number;
  batchChars: number;
  concurrency: number;
};

const GEMINI_TASKS = { doc: "RETRIEVAL_DOCUMENT", query: "RETRIEVAL_QUERY" };
export const CONFIGS: Record<string, Config> = {
  "oai-3s": {
    provider: "openai",
    model: "text-embedding-3-small",
    batchItems: 256,
    batchChars: 400_000,
    concurrency: 4,
  },
  "oai-3s-512api": {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 512,
    batchItems: 256,
    batchChars: 400_000,
    concurrency: 4,
  },
  "oai-3l": {
    provider: "openai",
    model: "text-embedding-3-large",
    batchItems: 256,
    batchChars: 400_000,
    concurrency: 4,
  },
  "gem-001": {
    provider: "gemini",
    model: "gemini-embedding-001",
    taskTypes: GEMINI_TASKS,
    batchItems: 100,
    batchChars: 300_000,
    concurrency: 3,
  },
  "gem-001-768api": {
    provider: "gemini",
    model: "gemini-embedding-001",
    taskTypes: GEMINI_TASKS,
    dimensions: 768,
    batchItems: 100,
    batchChars: 300_000,
    concurrency: 3,
  },
  "gem-2": {
    provider: "gemini",
    model: "gemini-embedding-2",
    taskTypes: GEMINI_TASKS,
    batchItems: 100,
    batchChars: 300_000,
    concurrency: 3,
  },
  "gem-2-768api": {
    provider: "gemini",
    model: "gemini-embedding-2",
    taskTypes: GEMINI_TASKS,
    dimensions: 768,
    batchItems: 100,
    batchChars: 300_000,
    concurrency: 3,
  },
  // Prod drop-in path: OpenAI-compatible /embeddings, so no task types.
  "gem-2-or": {
    provider: "openrouter",
    model: "google/gemini-embedding-2",
    batchItems: 100,
    batchChars: 300_000,
    concurrency: 4,
  },
  "qwen3-8b": {
    provider: "openrouter",
    model: "qwen/qwen3-embedding-8b",
    batchItems: 64,
    batchChars: 200_000,
    concurrency: 4,
  },
  "voyage-4": {
    provider: "openrouter",
    model: "voyageai/voyage-4",
    batchItems: 64,
    batchChars: 200_000,
    concurrency: 4,
  },
};

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
export function loadCache(config: string): Map<string, Float32Array> {
  const map = new Map<string, Float32Array>();
  const path = `${DATA_DIR}/emb/${config}.bin`;
  if (!existsSync(path)) return map;
  const buf = readFileSync(path);
  let off = 0;
  while (off + 24 <= buf.length) {
    const hash = buf.subarray(off, off + 20).toString("hex");
    const dims = buf.readUInt32LE(off + 20);
    const end = off + 24 + dims * 4;
    if (end > buf.length) break; // torn final record from an interrupted run
    const vec = new Float32Array(buf.buffer.slice(buf.byteOffset + off + 24, buf.byteOffset + end));
    map.set(hash, vec);
    off = end;
  }
  return map;
}

export function appendCache(config: string, entries: [string, Float32Array][]): void {
  const parts: Buffer[] = [];
  for (const [hash, vec] of entries) {
    const head = Buffer.alloc(24);
    Buffer.from(hash, "hex").copy(head, 0);
    head.writeUInt32LE(vec.length, 20);
    parts.push(head, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
  }
  appendFileSync(`${DATA_DIR}/emb/${config}.bin`, Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------
class BadRequest extends Error {}

async function callProvider(cfg: Config, role: Role, texts: string[]): Promise<Float32Array[]> {
  let url: string;
  let headers: Record<string, string>;
  let body: unknown;
  if (cfg.provider === "gemini") {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:batchEmbedContents`;
    headers = { "x-goog-api-key": process.env.GOOGLE_API_KEY ?? "" };
    body = {
      requests: texts.map((text) => ({
        model: `models/${cfg.model}`,
        content: { parts: [{ text }] },
        ...(cfg.taskTypes ? { taskType: cfg.taskTypes[role] } : {}),
        ...(cfg.dimensions ? { outputDimensionality: cfg.dimensions } : {}),
      })),
    };
  } else {
    const openai = cfg.provider === "openai";
    url = openai
      ? "https://api.openai.com/v1/embeddings"
      : "https://openrouter.ai/api/v1/embeddings";
    const key = openai ? process.env.OPENAI_API_KEY : process.env.OPENROUTER_API_KEY;
    headers = { authorization: `Bearer ${key}` };
    body = {
      model: cfg.model,
      input: texts,
      encoding_format: "float",
      ...(cfg.dimensions ? { dimensions: cfg.dimensions } : {}),
    };
  }

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      if (attempt >= 8) throw err;
      await Bun.sleep(1000 * 2 ** Math.min(attempt, 6));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 8) throw new Error(`${cfg.model}: HTTP ${res.status} after retries`);
      await Bun.sleep(1000 * 2 ** Math.min(attempt, 6));
      continue;
    }
    const json = (await res.json()) as {
      embeddings?: { values: number[] }[];
      data?: { embedding: number[]; index: number }[];
      error?: unknown;
    };
    if (res.status >= 400)
      throw new BadRequest(`${res.status} ${JSON.stringify(json.error).slice(0, 300)}`);
    if (json.embeddings) return json.embeddings.map((e) => Float32Array.from(e.values));
    if (json.data) {
      const sorted = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (sorted.length !== texts.length) {
        throw new BadRequest(`expected ${texts.length} vectors, got ${sorted.length}`);
      }
      return sorted.map((d) => Float32Array.from(d.embedding));
    }
    // OpenRouter sometimes returns 200 with an error body.
    if (attempt >= 8)
      throw new Error(`${cfg.model}: unexpected body ${JSON.stringify(json).slice(0, 300)}`);
    await Bun.sleep(1000 * 2 ** Math.min(attempt, 6));
  }
}

/** Embed a batch; on a 400 split the batch to isolate the bad input (it gets no vector). */
async function embedBatch(
  cfg: Config,
  role: Role,
  texts: string[],
): Promise<(Float32Array | null)[]> {
  try {
    return await callProvider(cfg, role, texts);
  } catch (err) {
    if (!(err instanceof BadRequest)) throw err;
    if (texts.length === 1) {
      console.error(
        `[embed] ${cfg.model} rejected one input (${texts[0]!.length} chars): ${err.message}`,
      );
      return [null];
    }
    const mid = Math.floor(texts.length / 2);
    return [
      ...(await embedBatch(cfg, role, texts.slice(0, mid))),
      ...(await embedBatch(cfg, role, texts.slice(mid))),
    ];
  }
}

export const failures: Record<string, number> = {};

async function embedAll(configName: string, role: Role, items: { id: string; text: string }[]) {
  const cfg = CONFIGS[configName]!;
  const cache = loadCache(configName);
  const keyed = items.map((it) => ({
    ...it,
    hash: sha1(`${cfg.taskTypes ? role : "any"}\u0000${it.text}`),
  }));
  const todo = [
    ...new Map(keyed.filter((k) => !cache.has(k.hash)).map((k) => [k.hash, k])).values(),
  ];

  const batches: (typeof todo)[] = [];
  let current: typeof todo = [];
  let chars = 0;
  for (const item of todo) {
    if (
      current.length >= cfg.batchItems ||
      (current.length > 0 && chars + item.text.length > cfg.batchChars)
    ) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += item.text.length;
  }
  if (current.length > 0) batches.push(current);

  let done = 0;
  await pool(batches, cfg.concurrency, async (batch) => {
    const vectors = await embedBatch(
      cfg,
      role,
      batch.map((b) => b.text),
    );
    const entries: [string, Float32Array][] = [];
    batch.forEach((b, i) => {
      const v = vectors[i];
      if (v) entries.push([b.hash, v]);
      else failures[configName] = (failures[configName] ?? 0) + 1;
    });
    appendCache(configName, entries);
    done += batch.length;
    if (batches.length > 10 && done % 2000 < batch.length) {
      console.error(`[embed] ${configName} ${role}: ${done}/${todo.length}`);
    }
  });
  return keyed.map(({ id, hash }) => ({ id, hash }));
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------
export async function itemsFor(
  set: string,
): Promise<{ role: Role; items: { id: string; text: string }[] }> {
  if (set === "corpus" || set === "corpus-named") {
    const memories = await readJson<Memory[]>("memories.json");
    const text = (m: Memory) =>
      cleanForEmbedding(set === "corpus-named" ? `${m.name}\n\n${m.content}` : m.content);
    return { role: "doc", items: memories.map((m) => ({ id: m.id, text: text(m) })) };
  }
  if (set === "queries" || set === "chunk-queries") {
    const queries = await readJson<EvalQuery[]>(`${set}.json`);
    return {
      role: "query",
      items: queries.map((q) => ({ id: q.id, text: cleanForEmbedding(q.text) })),
    };
  }
  if (set === "chunks") {
    const chunks = await readJson<{ id: string; text: string }[]>("chunks.json");
    return {
      role: "doc",
      items: chunks.map((c) => ({ id: c.id, text: cleanForEmbedding(c.text) })),
    };
  }
  if (set === "prodcheck") {
    const memories = await readJson<Memory[]>("memories.json");
    const byId = new Map(memories.map((m) => [m.id, m]));
    const sample = await readJson<{ id: string }[]>("prod-vectors.json");
    return {
      role: "doc",
      items: sample.map((s) => ({ id: s.id, text: cleanForEmbedding(byId.get(s.id)!.content) })),
    };
  }
  throw new Error(`unknown set ${set}`);
}

if (import.meta.main) {
  const [configArg, setArg] = process.argv.slice(2);
  if (!configArg || !setArg) throw new Error("usage: embed.ts <config,...> <set,...>");
  mkdirSync(`${DATA_DIR}/emb`, { recursive: true });
  mkdirSync(`${DATA_DIR}/manifest`, { recursive: true });
  const sets = setArg.split(",");
  await Promise.all(
    configArg.split(",").map(async (config) => {
      if (!CONFIGS[config]) throw new Error(`unknown config ${config}`);
      for (const set of sets) {
        const { role, items } = await itemsFor(set);
        const started = performance.now();
        const manifest = await embedAll(config, role, items);
        await writeJson(`manifest/${config}.${set}.json`, manifest);
        console.error(
          `[embed] ${config} ${set}: ${items.length} items in ${((performance.now() - started) / 1000).toFixed(1)}s`,
        );
      }
    }),
  );
  console.log(JSON.stringify({ failures }));
}
