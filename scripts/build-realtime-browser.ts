import { resolve } from "node:path";

const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "../src/realtime/browser.ts")],
  target: "browser",
  format: "esm",
  minify: true,
});
if (!result.success) throw new AggregateError(result.logs, "Realtime browser build failed");
const output = `${await result.outputs[0]!.text()}\n`;
const target = resolve(import.meta.dir, "../src/realtime/browser.generated.txt");
if (process.argv.includes("--check")) {
  if (!(await Bun.file(target).exists()) || (await Bun.file(target).text()) !== output) {
    throw new Error("Realtime browser bundle is stale. Run bun run build:realtime-browser.");
  }
} else {
  await Bun.write(target, output);
}
