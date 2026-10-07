const { getLlama } = await import(process.env.LLAMA_PKG!);
const llama = await getLlama({ logLevel: "error" });
const model = await llama.loadModel({ modelPath: process.env.MODEL_PATH! });
const texts: string[] = await Bun.file("texts.json").json();
const base: number[][] = await Bun.file(process.env.BASE!).json();
const cos = (a: readonly number[], b: readonly number[]) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; x += a[i]! ** 2; y += b[i]! ** 2; } return d / Math.sqrt(x * y); };
const def = await model.createEmbeddingContext();
console.log("default ctx: contextSize", (def as any)._llamaContext?.contextSize, "batchSize", (def as any)._llamaContext?.batchSize);
await def.dispose();
const ctx = await model.createEmbeddingContext({ contextSize: 2048, batchSize: 2048 });
console.log("explicit ctx: contextSize", (ctx as any)._llamaContext?.contextSize, "batchSize", (ctx as any)._llamaContext?.batchSize);
const out: number[][] = [];
for (let i = 0; i < texts.length; i++) {
  const v = (await ctx.getEmbeddingFor(texts[i]!)).vector;
  console.log(i, "tokens", model.tokenize(texts[i]!).length, "cos vs default-batch run", cos(v, base[i]!).toFixed(4));
  out.push([...v]);
}
await Bun.write(process.env.BASE! + ".b2048", JSON.stringify(out));
await ctx.dispose(); await model.dispose(); await llama.dispose();
