/**
 * Changed API lines that no e2e scenario runs, as a sticky PR comment. Comment only: nothing
 * here blocks a merge.
 *
 * Usage: bun scripts/e2e/diff-coverage.ts [--base ref] [--lcov-dir dir] [--out comment.md]
 *          [--json path] [--error reason]
 *
 * 1. Union every `<lcov-dir>/**\/*.info`: a line is covered when any API process hit it.
 * 2. `git diff -U0 <base>...HEAD`: the added lines per file.
 * 3. A changed line counts only when lcov lists it as executable. A file no API process
 *    loaded counts its changed code lines in full (a type-only file counts none).
 * 4. Scope: API and CLI files under src/, minus worker code, tests and coverage-exemptions.txt.
 *    CLI scenarios run the CLI under lcov too (scripts/e2e/cli.ts), so its lines count.
 *
 * A coverage problem never exits non-zero: the comment says what went wrong instead.
 * Imports no package, so CI runs it without `bun install`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const MARKER = "<!-- e2e-coverage -->";

/** Worker-side code (CLAUDE.md "Architecture invariants") and tests: the API never runs them. */
const NOT_API = [
  "src/commands/",
  "src/providers/",
  "src/hooks/",
  "src/prompts/",
  "src/claude.ts",
  "src/tests/",
];

/** The CLI entry and its operator commands: CLI scenarios run them, so they count. */
const CLI = [
  "src/cli.tsx",
  "src/commands/onboard.tsx",
  "src/commands/onboard/",
  "src/commands/setup.tsx",
  "src/commands/shared/",
  "src/commands/controller.ts",
  "src/commands/codex-login.ts",
  "src/commands/claude-managed-setup.ts",
  "src/commands/worker-token.ts",
  "src/commands/x.ts",
  "src/commands/e2b.ts",
  "src/commands/e2b-stack-wizard.tsx",
];

/** file -> line -> hits. */
export type LineHits = Map<string, Map<number, number>>;

export type FileResult = {
  path: string;
  changed: number;
  covered: number;
  uncovered: number[];
  /** False when no API process loaded the file at all. */
  loaded: boolean;
};

export type DiffCoverage = { files: FileResult[]; changed: number; covered: number };

/** Union lcov records into `into`: the max hit count per line, so any process's hit counts. */
export function parseLcov(text: string, into: LineHits = new Map()): LineHits {
  let lines: Map<number, number> | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const path = line.slice(3).replace(/^\.\//, "");
      lines = into.get(path) ?? new Map();
      into.set(path, lines);
    } else if (line.startsWith("DA:") && lines) {
      const [number, hits] = line.slice(3).split(",").map(Number);
      if (Number.isInteger(number) && Number.isFinite(hits)) {
        lines.set(number!, Math.max(lines.get(number!) ?? 0, hits!));
      }
    } else if (line === "end_of_record") lines = undefined;
  }
  return into;
}

/** Added line numbers per file from `git diff -U0`. Deleted files drop out. */
export function parseDiff(diff: string): Map<string, number[]> {
  const added = new Map<string, number[]>();
  let current: number[] | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4);
      current = target.startsWith("b/") ? [] : undefined;
      if (current) added.set(target.slice(2), current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let offset = 0; offset < count; offset++) current.push(start + offset);
    }
  }
  return added;
}

/** `path reason` per line; `#` starts a comment. A path ending in `/` exempts a directory. */
export function parseExemptions(text: string): string[] {
  const paths: string[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [path, ...reason] = line.split(/\s+/);
    if (reason.length === 0) {
      throw new Error(`coverage-exemptions.txt line ${index + 1}: give a reason after the path`);
    }
    paths.push(path!);
  }
  return paths;
}

function matches(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) =>
    prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix,
  );
}

export function inScope(path: string, exemptions: readonly string[]): boolean {
  return (
    path.startsWith("src/") &&
    /\.(ts|tsx|js|mjs)$/.test(path) &&
    !/\.d\.ts$|\.(test|spec)\.tsx?$/.test(path) &&
    (matches(path, CLI) || !matches(path, NOT_API)) &&
    !matches(path, exemptions)
  );
}

/**
 * Changed code lines of a file no API process loaded, or [] when it holds types only.
 * shortcut: a line counts unless blank or comment-only, so a multi-line type in a file with
 * runtime code counts too; upgrade if the comment shows type lines as uncovered noise.
 */
export function unloadedLines(path: string, source: string, added: readonly number[]): number[] {
  const loader = path.endsWith("x") ? "tsx" : "ts";
  const runtime = new Bun.Transpiler({ loader })
    .transformSync(source)
    .replace(/export\s*\{\s*\};?/g, "");
  if (!runtime.trim()) return [];
  const text = source.split("\n");
  return added.filter((number) => {
    const line = text[number - 1]?.trim() ?? "";
    return line !== "" && !/^(\/\/|\/\*|\*)/.test(line);
  });
}

export function diffCoverage(
  added: Map<string, number[]>,
  lcov: LineHits,
  exemptions: readonly string[],
  readSource: (path: string) => string,
): DiffCoverage {
  const files: FileResult[] = [];
  for (const [path, lines] of added) {
    if (!inScope(path, exemptions) || lines.length === 0) continue;
    const hits = lcov.get(path);
    if (hits) {
      const executable = lines.filter((line) => hits.has(line));
      if (executable.length === 0) continue;
      const uncovered = executable.filter((line) => hits.get(line) === 0);
      files.push({
        path,
        changed: executable.length,
        covered: executable.length - uncovered.length,
        uncovered,
        loaded: true,
      });
    } else {
      const uncovered = unloadedLines(path, readSource(path), lines);
      if (uncovered.length === 0) continue;
      files.push({ path, changed: uncovered.length, covered: 0, uncovered, loaded: false });
    }
  }
  files.sort((a, b) => b.uncovered.length - a.uncovered.length || a.path.localeCompare(b.path));
  return {
    files,
    changed: files.reduce((sum, file) => sum + file.changed, 0),
    covered: files.reduce((sum, file) => sum + file.covered, 0),
  };
}

/** [3, 4, 5, 9] -> "3-5, 9". */
export function lineRanges(lines: readonly number[]): string {
  const parts: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const start = lines[index]!;
    while (lines[index + 1] === lines[index]! + 1) index++;
    parts.push(start === lines[index] ? `${start}` : `${start}-${lines[index]}`);
  }
  return parts.join(", ");
}

const MAX_ROWS = 60;
const MAX_RANGES = 300;

export function renderComment(
  report: DiffCoverage | { error: string },
  lcovFiles: number,
  plainBoots = 0,
): string {
  const head = [MARKER, "## E2E coverage of changed API lines", ""];
  if ("error" in report) {
    return [
      ...head,
      `Coverage could not be computed: ${report.error}`,
      "",
      "The E2E Contract result does not depend on this. Comment only, nothing blocks.",
      "",
    ].join("\n");
  }
  if (report.changed === 0) {
    return `${MARKER}\nE2E coverage: this PR changes no executable API line (${lcovFiles} lcov file(s) read).\n`;
  }
  const percent = ((report.covered / report.changed) * 100).toFixed(1);
  const rows = report.files.slice(0, MAX_ROWS).map((file) => {
    const name = file.loaded ? `\`${file.path}\`` : `\`${file.path}\` (not loaded)`;
    let ranges = lineRanges(file.uncovered) || "none";
    if (ranges.length > MAX_RANGES)
      ranges = `${ranges.slice(0, MAX_RANGES).replace(/,[^,]*$/, "")}, ...`;
    return `| ${name} | ${file.covered}/${file.changed} | ${ranges} |`;
  });
  const more = report.files.length - rows.length;
  return [
    ...head,
    `**${report.covered} of ${report.changed} changed API lines run in an e2e scenario (${percent}%).** Comment only, nothing blocks.`,
    "",
    "| File | Covered | Uncovered lines |",
    "|---|---|---|",
    ...rows,
    ...(more > 0 ? [`| ${more} more file(s) | | |`] : []),
    "",
    ...(plainBoots > 0
      ? [
          `${plainBoots} API process(es) failed to boot under coverage and ran plain, so lines only they ran read as uncovered.`,
          "",
        ]
      : []),
    `<sub>From ${lcovFiles} lcov file(s), one per API process (\`bun run e2e --coverage\`). Line numbers are on the PR merged into its base. "Not loaded": no scenario imports the file. Exempt a path with a reason in \`scripts/e2e/coverage-exemptions.txt\`.</sub>`,
    "",
  ].join("\n");
}

function parseArgs(args: string[]) {
  const options = {
    base: "origin/main",
    lcovDir: "e2e-coverage",
    out: "e2e-coverage-comment.md",
    json: undefined as string | undefined,
    error: undefined as string | undefined,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const next = args[++index];
    if (next === undefined || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--base") options.base = next;
    else if (arg === "--lcov-dir") options.lcovDir = next;
    else if (arg === "--out") options.out = next;
    else if (arg === "--json") options.json = next;
    else if (arg === "--error") options.error = next;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

async function compute(options: ReturnType<typeof parseArgs>) {
  if (options.error) return { report: { error: options.error }, lcovFiles: 0, plainBoots: 0 };
  const lcovPaths = await Array.fromAsync(
    new Bun.Glob("**/*.info").scan({ cwd: options.lcovDir, onlyFiles: true }),
  ).catch(() => [] as string[]);
  if (lcovPaths.length === 0) {
    return {
      report: { error: `no lcov file in ${options.lcovDir}: the shards wrote or uploaded none` },
      lcovFiles: 0,
      plainBoots: 0,
    };
  }
  const plainBoots = (
    await Array.fromAsync(
      new Bun.Glob("**/*.plain").scan({ cwd: options.lcovDir, onlyFiles: true }),
    )
  ).length;
  const lcov: LineHits = new Map();
  for (const path of lcovPaths)
    parseLcov(await Bun.file(`${options.lcovDir}/${path}`).text(), lcov);
  const git =
    await Bun.$`git diff -U0 -M --no-color --no-ext-diff ${`${options.base}...HEAD`} -- src/`
      .quiet()
      .nothrow();
  if (git.exitCode !== 0)
    throw new Error(`git diff ${options.base}...HEAD: ${git.stderr.toString().trim()}`);
  const diff = git.stdout.toString();
  const exemptionsFile = Bun.file(`${import.meta.dir}/coverage-exemptions.txt`);
  const exemptions = (await exemptionsFile.exists())
    ? parseExemptions(await exemptionsFile.text())
    : [];
  const root = (await Bun.$`git rev-parse --show-toplevel`.quiet().text()).trim();
  const readSource = (path: string) => readFileSync(resolve(root, path), "utf8");
  return {
    report: diffCoverage(parseDiff(diff), lcov, exemptions, readSource),
    lcovFiles: lcovPaths.length,
    plainBoots,
  };
}

if (import.meta.main) {
  let options: ReturnType<typeof parseArgs>;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  let result: Awaited<ReturnType<typeof compute>>;
  try {
    result = await compute(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = {
      report: { error: message.split("\n")[0]!.slice(0, 300) },
      lcovFiles: 0,
      plainBoots: 0,
    };
  }
  const comment = renderComment(result.report, result.lcovFiles, result.plainBoots);
  await Bun.write(options.out, comment);
  if (options.json) await Bun.write(options.json, `${JSON.stringify(result, null, 2)}\n`);
  console.log(comment);
}
