import { readdirSync } from "node:fs";
import { resolve } from "node:path";

// Duration-balanced shards. Playwright's `--shard` splits by test count, and this suite's test
// durations vary 40x (overflow.spec.ts: 165 tests of about 1.5 s; entity-refresh.spec.ts: 7 of
// 20 to 45 s), so count-balanced shards ran 89 s to 239 s. Instead, every shard packs the spec
// files by shard-weights.json (seconds per file, from a CI run) with the same greedy rule and
// runs only its own files. Each shard computes the same plan from the same inputs.
// shortcut: static weights; rerun reporter/shard-weights.ts when the shards drift apart.

const packageRoot = resolve(import.meta.dir, "..");

export interface ShardPlan {
  files: string[];
  seconds: number;
}

export function planShards(
  files: string[],
  weights: Record<string, number>,
  total: number,
): ShardPlan[] {
  const known = Object.values(weights).sort((left, right) => left - right);
  // A spec file with no weight yet (new since the last refresh) counts as a median one.
  const fallback = known.length > 0 ? (known[Math.floor(known.length / 2)] ?? 1) : 1;
  const weighted = files
    .map((file) => ({ file, seconds: weights[file] ?? fallback }))
    .sort((left, right) => right.seconds - left.seconds || left.file.localeCompare(right.file));
  const shards: ShardPlan[] = Array.from({ length: total }, () => ({ files: [], seconds: 0 }));
  for (const { file, seconds } of weighted) {
    // Lightest shard first; ties go to the lowest index, so the plan is deterministic.
    const target = shards.reduce((best, shard) => (shard.seconds < best.seconds ? shard : best));
    target.files.push(file);
    target.seconds += seconds;
  }
  for (const shard of shards) shard.files.sort();
  return shards;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces `--shard=i/n` (or `--shard i/n`) with this shard's spec files, as anchored path
 * filters. Returns the arguments unchanged when there is no shard flag or no weights file.
 */
export async function balanceShardArgs(args: string[]): Promise<string[]> {
  const index = args.findIndex((arg) => arg === "--shard" || arg.startsWith("--shard="));
  if (index === -1) return args;
  const value = args[index] === "--shard" ? args[index + 1] : args[index]?.slice("--shard=".length);
  const match = /^(\d+)\/(\d+)$/.exec(value ?? "");
  const weightsFile = Bun.file(resolve(packageRoot, "shard-weights.json"));
  if (!match || !(await weightsFile.exists())) return args;
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (current < 1 || current > total) throw new Error(`Invalid shard ${value}`);

  const files = readdirSync(resolve(packageRoot, "specs"))
    .filter((name) => name.endsWith(".spec.ts"))
    .map((name) => `specs/${name}`)
    .sort();
  const plan = planShards(files, (await weightsFile.json()) as Record<string, number>, total);
  const shard = plan[current - 1];
  if (!shard || shard.files.length === 0) throw new Error(`Shard ${value} has no spec files`);
  console.log(
    `[ui-e2e] shard ${current}/${total} by duration: ${shard.files.length} files, about ${shard.seconds} s of tests (${plan.map((s) => s.seconds).join(" / ")})`,
  );

  // The reporters label results with this shard: Playwright's own config.shard stays unset.
  process.env.UI_E2E_SHARD = `${current}/${total}`;
  const rest = args.filter((_, position) =>
    args[index] === "--shard" ? position !== index && position !== index + 1 : position !== index,
  );
  return [...rest, ...shard.files.map((file) => `${escapeRegExp(file)}$`)];
}
