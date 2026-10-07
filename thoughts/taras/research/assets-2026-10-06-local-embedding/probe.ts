// Spike probe: load node-llama-cpp + a GGUF embedding model, measure cold start, latency, RSS.
// Env: LLAMA_PKG (specifier or absolute path), MODEL_PATH, THREADS (optional), MODE (label).
import { readFileSync } from "node:fs";

const pkg = process.env.LLAMA_PKG ?? "node-llama-cpp";
const modelPath = process.env.MODEL_PATH!;
const threads = process.env.THREADS ? Number(process.env.THREADS) : undefined;
const out: Record<string, unknown> = { mode: process.env.MODE ?? "plain", arch: process.arch, bun: Bun.version };
const rss = () => Math.round(process.memoryUsage().rss / 1048576);
const hwm = () => {
  try {
    const m = readFileSync("/proc/self/status", "utf8").match(/VmHWM:\s+(\d+) kB/);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
};
const ms = (t: number) => Math.round(performance.now() - t);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

try {
  out.rss_start_mb = rss();
  const os = await import("node:os");
  let cpuMax: string | null = null;
  try { cpuMax = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(); } catch {}
  out.cpu = { availableParallelism: os.availableParallelism(), osCpus: os.cpus().length, hardwareConcurrency: navigator.hardwareConcurrency, cgroupCpuMax: cpuMax, threadsOpt: threads ?? null };
  let t = performance.now();
  const mod = await import(pkg);
  out.import_ms = ms(t);
  t = performance.now();
  // build: "never" => fail instead of falling back to a cmake source build.
  const llama = await mod.getLlama({ gpu: false, build: "never", logLevel: "warn", ...(threads ? { maxThreads: threads } : {}) });
  out.getLlama_ms = ms(t);
  out.llama = { gpu: llama.gpu, buildType: llama.buildType, cpuMathCores: llama.cpuMathCores, maxThreads: llama.maxThreads };
  out.rss_after_llama_mb = rss();

  t = performance.now();
  const model = await llama.loadModel({ modelPath });
  out.load_model_ms = ms(t);
  out.model = { trainContextSize: model.trainContextSize, embeddingVectorSize: model.embeddingVectorSize };
  t = performance.now();
  const batchOpt = process.env.BATCH ? Number(process.env.BATCH) : undefined;
  const ctx = await model.createEmbeddingContext({
    ...(threads ? { threads } : {}),
    ...(batchOpt ? { contextSize: batchOpt, batchSize: batchOpt } : {}),
  });
  out.ctx = { batchOpt: batchOpt ?? null, contextSize: (ctx as any)._llamaContext?.contextSize, batchSize: (ctx as any)._llamaContext?.batchSize };
  out.create_ctx_ms = ms(t);
  out.rss_after_model_mb = rss();

  t = performance.now();
  const first = await ctx.getEmbeddingFor("search_query: agent swarm onboarding probe");
  out.first_embed_ms = ms(t);
  out.dims = first.vector.length;

  // Matryoshka truncation to 512 + L2 renormalize, as the provider would do.
  const trunc = Float32Array.from(first.vector.slice(0, 512));
  let n = 0;
  for (const x of trunc) n += x * x;
  n = Math.sqrt(n);
  out.norm_full = Math.sqrt(first.vector.reduce((s: number, x: number) => s + x * x, 0)).toFixed(4);
  out.norm_512_before_renorm = n.toFixed(4);

  const sentences = [
    "The worker claimed the task and pushed a fix for the heartbeat sweep race.",
    "Migration 192 adds the comb review space tables and audit columns.",
    "The lead agent delegated the UI polish to a second worker over Slack.",
    "Embedding dimension mismatch caused the vector search to fall back to FTS.",
    "The compiled Bun binary cannot read migrations from the virtual filesystem.",
    "A deferred BEGIN that reads before it writes fails with SQLITE_BUSY_SNAPSHOT.",
  ];
  const makeText = (targetTokens: number, salt: number) => {
    let s = "search_document: ";
    let i = salt;
    while (model.tokenize(s).length < targetTokens) s += sentences[i++ % sentences.length] + " ";
    return s;
  };
  const sizes: Record<string, unknown> = {};
  for (const target of [32, 128, 512, 1024, 1900]) {
    if (target >= (batchOpt ?? model.trainContextSize) - 8) continue;
    const lat: number[] = [];
    let tokens = 0;
    const reps = target >= 1024 ? 3 : 6;
    for (let r = 0; r < reps; r++) {
      const text = makeText(target, r);
      tokens = model.tokenize(text).length;
      const t0 = performance.now();
      await ctx.getEmbeddingFor(text);
      lat.push(performance.now() - t0);
    }
    sizes[`~${target}tok`] = { tokens, p50_ms: Math.round(median(lat)), max_ms: Math.round(Math.max(...lat)) };
  }
  out.latency = sizes;

  // 8 concurrent requests of ~128 tokens: does the context queue or parallelize?
  const batch = Array.from({ length: 8 }, (_, i) => makeText(128, i));
  t = performance.now();
  await Promise.all(batch.map((b) => ctx.getEmbeddingFor(b)));
  out.concurrent8_128tok_total_ms = ms(t);

  // Over-context input: what happens?
  try {
    await ctx.getEmbeddingFor(makeText(model.trainContextSize + 200, 0));
    out.over_context = "accepted";
  } catch (e) {
    out.over_context = `throws: ${(e as Error).message.slice(0, 120)}`;
  }

  out.rss_end_mb = rss();
  out.rss_peak_mb = hwm();
  t = performance.now();
  await ctx.dispose();
  await model.dispose();
  await llama.dispose();
  out.dispose_ms = ms(t);
  out.rss_after_dispose_mb = rss();
  out.ok = true;
} catch (e) {
  out.ok = false;
  out.error = String((e as Error)?.stack ?? e).slice(0, 1500);
}
console.log("RESULT " + JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
