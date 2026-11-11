import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlags } from "./cli.ts";

// Rebuilds shard-weights.json (seconds of test time per spec file) from a CI run's summaries:
//   gh run download <run-id> -p 'ui-e2e-results-*' -D /tmp/ui-e2e-results
//   node --experimental-strip-types reporter/shard-weights.ts --summaries /tmp/ui-e2e-results --out shard-weights.json
// boot/run.ts packs spec files into shards by these weights. Retries count, so a flaky file
// weighs what it costs.

const values = parseFlags(process.argv.slice(2), { required: ["summaries", "out"] });
const summaries = values.get("summaries") as string;
const out = values.get("out") as string;

const weights = new Map<string, number>();
for (const entry of readdirSync(summaries, { withFileTypes: true, recursive: true })) {
  if (!entry.isFile() || entry.name !== "summary.json") continue;
  const summary = JSON.parse(readFileSync(join(entry.parentPath, entry.name), "utf8")) as {
    results?: Array<{ file: string; durationMs: number }>;
  };
  for (const result of summary.results ?? []) {
    weights.set(result.file, (weights.get(result.file) ?? 0) + result.durationMs / 1000);
  }
}

const sorted = Object.fromEntries(
  [...weights]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, seconds]) => [file, Math.max(1, Math.round(seconds))]),
);
writeFileSync(out, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`shard weights: ${weights.size} spec files written to ${out}`);
