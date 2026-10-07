// Embed eval sets with a local GGUF model through node-llama-cpp. It writes the
// same cache and manifest files as embed.ts, so score.py and judge.ts read them
// unchanged. Vectors are stored raw at full width (not normalized).
//
// node-llama-cpp is not a repo dependency. Install it in a scratch directory
// and pass its entry file:
//   LLAMA_PKG=/abs/node_modules/node-llama-cpp/dist/index.js \
//   EMBED_EVAL_MODELS_DIR=/abs/models \
//   bun scripts/embedding-eval/embed-local.ts <config> <set,...>
import { mkdirSync } from "node:fs";
import { DATA_DIR, pool, sha1, writeJson } from "./common";
import { appendCache, itemsFor, loadCache } from "./embed";

type LocalConfig = {
  file: string;
  /** Task prefixes from the model card. Omitted = the text is embedded as is. */
  prefix?: { doc: string; query: string };
};

export const LOCAL_CONFIGS: Record<string, LocalConfig> = {
  "nomic-v15": {
    file: "nomic-v15-q8.gguf",
    prefix: { doc: "search_document: ", query: "search_query: " },
  },
  "nomic-v15-noprefix": { file: "nomic-v15-q8.gguf" },
  "gemma-300m": {
    file: "embeddinggemma-300m-q8.gguf",
    prefix: { doc: "title: none | text: ", query: "task: search result | query: " },
  },
  "gemma-300m-noprefix": { file: "embeddinggemma-300m-q8.gguf" },
};

const [configName, setArg] = process.argv.slice(2);
const cfg = LOCAL_CONFIGS[configName ?? ""];
if (!cfg || !setArg) throw new Error("usage: embed-local.ts <config> <set,...>");
const llamaPkg = process.env.LLAMA_PKG;
const modelsDir = process.env.EMBED_EVAL_MODELS_DIR;
if (!llamaPkg || !modelsDir) throw new Error("LLAMA_PKG and EMBED_EVAL_MODELS_DIR are required");
const contexts = Number(process.env.EMBED_LOCAL_CONTEXTS ?? 4);

mkdirSync(`${DATA_DIR}/emb`, { recursive: true });
mkdirSync(`${DATA_DIR}/manifest`, { recursive: true });

const { getLlama } = await import(llamaPkg);
const llama = await getLlama({ logLevel: "error" });
const model = await llama.loadModel({ modelPath: `${modelsDir}/${cfg.file}` });
// Leave room for the BOS/EOS tokens the embedding context adds.
const maxTokens = model.trainContextSize - 8;
// batchSize must cover the whole input. The node-llama-cpp default is 512, and
// an encoder model then returns a wrong vector for any longer input, with no error.
const ctxs = await Promise.all(
  Array.from({ length: contexts }, () =>
    model.createEmbeddingContext({
      contextSize: model.trainContextSize,
      batchSize: model.trainContextSize,
    }),
  ),
);

const stats = { truncated: 0, failed: 0, tokens: 0 };
for (const set of setArg.split(",")) {
  const { role, items } = await itemsFor(set);
  const cache = loadCache(configName!);
  const keyed = items.map((it) => ({
    ...it,
    hash: sha1(`${cfg.prefix ? role : "any"}\u0000${it.text}`),
  }));
  const todo = [
    ...new Map(keyed.filter((k) => !cache.has(k.hash)).map((k) => [k.hash, k])).values(),
  ];
  const started = performance.now();
  let done = 0;
  let pending: [string, Float32Array][] = [];
  const free = [...ctxs];
  await pool(todo, contexts, async (item) => {
    const ctx = free.pop()!;
    try {
      let tokens = model.tokenize((cfg.prefix?.[role] ?? "") + item.text);
      if (tokens.length > maxTokens) {
        tokens = tokens.slice(0, maxTokens);
        stats.truncated++;
      }
      stats.tokens += tokens.length;
      const { vector } = await ctx.getEmbeddingFor(tokens);
      pending.push([item.hash, Float32Array.from(vector)]);
    } catch (err) {
      stats.failed++;
      if (stats.failed <= 3) console.error(`[embed-local] failed: ${(err as Error).message}`);
    } finally {
      free.push(ctx);
    }
    if (++done % 500 === 0) {
      appendCache(configName!, pending);
      pending = [];
      console.error(`[embed-local] ${configName} ${set}: ${done}/${todo.length}`);
    }
  });
  appendCache(configName!, pending);
  await writeJson(
    `manifest/${configName}.${set}.json`,
    keyed.map(({ id, hash }) => ({ id, hash })),
  );
  console.error(
    `[embed-local] ${configName} ${set}: ${items.length} items (${todo.length} new) in ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );
}
console.log(JSON.stringify({ config: configName, ...stats }));
for (const ctx of ctxs) await ctx.dispose();
await model.dispose();
await llama.dispose();
