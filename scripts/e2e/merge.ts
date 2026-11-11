/**
 * Merge `bun run e2e --shard i/n` results into one run, then gate coverage on the union.
 *
 * Usage: bun scripts/e2e/merge.ts [--strict] [--min-route-coverage N] [--min-tool-coverage N]
 *          [--json path] [--summary-md path] shard-1.json shard-2.json ...
 *
 * A shard covers only its band, so it never gates strict; this does, once, on every shard's
 * calls, tools, node types and state values together. A missing, duplicate or unreadable
 * shard result fails the merge. Imports no package, so CI runs it without `bun install`.
 */
import {
  type CoverageManifest,
  coverageFrom,
  EMPTY_MANIFEST,
  emptyCoverage,
  loadManifest,
} from "./coverage";
import { loadQuarantine, type QuarantineEntry, quarantineProblems } from "./quarantine";
import {
  type E2eResult,
  evaluateGates,
  failsRun,
  type Options,
  printTotals,
  writeReports,
} from "./report";
import { coverageInputs, mergeObservations } from "./shard";

export type ShardFile = { path: string; result?: E2eResult; error?: string };

type MergeOptions = Pick<Options, "strict" | "minRouteCoverage" | "minToolCoverage">;

export function mergeShardResults(
  files: readonly ShardFile[],
  manifest: CoverageManifest,
  quarantine: readonly QuarantineEntry[],
  today: string,
  options: MergeOptions,
): E2eResult {
  const problems: string[] = [];
  const parts: E2eResult[] = [];
  for (const file of files) {
    if (!file.result) problems.push(`${file.path}: ${file.error ?? "no result"}`);
    else if (!file.result.shard) problems.push(`${file.path}: not a --shard result`);
    else parts.push(file.result);
  }
  parts.sort((a, b) => (a.shard?.index ?? 0) - (b.shard?.index ?? 0));
  const total = parts[0]?.shard?.total ?? files.length;
  for (let index = 1; index <= total; index++) {
    const count = parts.filter((part) => part.shard?.index === index).length;
    if (count !== 1) problems.push(`shard ${index}/${total}: ${count} results, want 1`);
  }
  if (parts.some((part) => part.shard?.total !== total)) {
    problems.push("shard results disagree on the shard count");
  }

  const scenarios = parts.flatMap((part) => part.scenarios);
  let coverage = emptyCoverage();
  let coverageError: string | undefined;
  let knownScenarios: string[] = [];
  try {
    const observations = mergeObservations(parts.map((part) => part.shard!.observations));
    knownScenarios = observations.knownScenarios;
    coverage = coverageFrom(
      observations.universe,
      coverageInputs(observations, scenarios, manifest),
    );
  } catch (error) {
    coverageError = `Coverage calculation failed: ${error instanceof Error ? error.message : String(error)}`;
    problems.push(coverageError);
  }
  const quarantineIssues = quarantineProblems(quarantine, new Set(knownScenarios), today);
  const gates = evaluateGates(coverage, coverageError, options);
  const shards = parts.map((part) => ({
    index: part.shard!.index,
    total: part.shard!.total,
    durationMs: part.durationMs,
    ok: part.ok,
    scenarios: part.scenarios.length,
  }));
  for (const shard of shards) {
    if (!shard.ok) problems.push(`shard ${shard.index}/${shard.total} failed`);
  }
  return {
    startedAt: parts.map((part) => part.startedAt).sort()[0] ?? new Date().toISOString(),
    durationMs: Math.max(0, ...shards.map((shard) => shard.durationMs)),
    scenarios,
    harness: [],
    coverage,
    quarantine: { entries: [...quarantine], problems: quarantineIssues },
    gates,
    shards,
    mergeProblems: problems,
    ok:
      problems.length === 0 &&
      !scenarios.some(failsRun) &&
      gates.passed &&
      quarantineIssues.length === 0,
  };
}

function parseArgs(args: string[]) {
  const options: MergeOptions & { jsonPath: string; summaryPath?: string; files: string[] } = {
    strict: false,
    minRouteCoverage: 0,
    minToolCoverage: 0,
    jsonPath: "./e2e-results.json",
    files: [],
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const value = () => {
      const next = args[++index];
      if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
      return next;
    };
    const percent = () => {
      const number = Number(value());
      if (!Number.isFinite(number) || number < 0 || number > 100) {
        throw new Error(`${arg} must be a number from 0 through 100`);
      }
      return number;
    };
    if (arg === "--strict") options.strict = true;
    else if (arg === "--min-route-coverage") options.minRouteCoverage = percent();
    else if (arg === "--min-tool-coverage") options.minToolCoverage = percent();
    else if (arg === "--json") options.jsonPath = value();
    else if (arg === "--summary-md") options.summaryPath = value();
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else options.files.push(arg);
  }
  if (options.files.length === 0) throw new Error("Pass at least one shard result file");
  return options;
}

async function readShard(path: string): Promise<ShardFile> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { path, error: "missing: the shard wrote no result" };
  try {
    return { path, result: (await file.json()) as E2eResult };
  } catch (error) {
    return { path, error: `unreadable: ${error instanceof Error ? error.message : error}` };
  }
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const manifest = options.strict
      ? await loadManifest(`${import.meta.dir}/coverage-manifest.json`)
      : EMPTY_MANIFEST;
    const result = mergeShardResults(
      await Promise.all(options.files.map(readShard)),
      manifest,
      await loadQuarantine(),
      new Date().toISOString().slice(0, 10),
      options,
    );
    await writeReports(result, options.jsonPath, options.summaryPath);
    for (const shard of result.shards ?? []) {
      console.log(
        `shard ${shard.index}/${shard.total}: ${shard.ok ? "PASS" : "FAIL"}, ${shard.scenarios} scenarios, ${(shard.durationMs / 1000).toFixed(1)}s`,
      );
    }
    printTotals(result);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
