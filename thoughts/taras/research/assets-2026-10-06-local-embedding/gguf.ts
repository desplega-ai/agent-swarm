// Embed a few texts via node-llama-cpp as string and as pre-tokenized input; dump vectors.
const { getLlama } = await import(process.env.LLAMA_PKG!);
const llama = await getLlama({ logLevel: "error" });
const model = await llama.loadModel({ modelPath: process.env.MODEL_PATH! });
const ctx = await model.createEmbeddingContext();
const texts: string[] = await Bun.file("texts.json").json();
const cos = (a: readonly number[], b: readonly number[]) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; x += a[i]! ** 2; y += b[i]! ** 2; } return d / Math.sqrt(x * y); };
const out: number[][] = [];
for (const t of texts) {
  const s = (await ctx.getEmbeddingFor(t)).vector;
  const toks = model.tokenize(t);
  const k = (await ctx.getEmbeddingFor(toks)).vector;
  console.log("string-vs-tokens cos", cos(s, k).toFixed(6), "tokens", toks.length, "first/last", toks[0], toks[toks.length - 1], "bos", model.tokens.bos, "eos", model.tokens.eos, "sep", model.tokens.sep);
  out.push([...k]);
}
await Bun.write(process.env.OUT!, JSON.stringify(out));
await ctx.dispose(); await model.dispose(); await llama.dispose();
