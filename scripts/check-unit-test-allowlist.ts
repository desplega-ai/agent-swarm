#!/usr/bin/env bun
/**
 * Rule 1 of the e2e-first plan: no new unit tests for code outside the allowlist.
 *
 * Judges only the diff against a base commit, so code already on the base never fails it.
 * A test is new when its file is added, or when an old file gains `test(` / `it(` calls.
 * A new test fails when it imports repo code that `scripts/unit-test-allowlist.txt` does
 * not list. Tests sit flat in `src/tests/`, so the check reads imports, not test paths. It
 * follows imports through test helpers (non-test files under `src/tests/`), so a helper
 * cannot carry API code past it. Type-only imports are erased and never count.
 *
 * Usage: bun scripts/check-unit-test-allowlist.ts [--base <ref>]
 * The base defaults to `git merge-base origin/main HEAD`. The head is the working tree,
 * including untracked test files, so the check runs before a commit too.
 */
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

export type AllowEntry = { path: string; reason: string };

/** One changed test file. `base` is its content on the base commit, absent when new. */
export type TestChange = { path: string; head: string; base?: string };

export type Violation = { path: string; reason: string };

const CODE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const TEST_FILE = /\.test\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_SUPPORT_DIR = "src/tests/";

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path) && !path.split("/").includes("node_modules");
}

export function parseAllowlist(text: string): AllowEntry[] {
  const entries: AllowEntry[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const hash = line.indexOf("#");
    const path = (hash === -1 ? line : line.slice(0, hash)).trim();
    const reason = hash === -1 ? "" : line.slice(hash + 1).trim();
    if (reason.length < 10) {
      throw new Error(
        `unit-test-allowlist.txt line ${index + 1}: "${path}" needs a reason of at least 10 characters after #`,
      );
    }
    entries.push({ path, reason });
  }
  return entries;
}

const stripExt = (path: string) => path.replace(CODE_EXT, "");

export function isAllowed(target: string, allowlist: readonly AllowEntry[]): boolean {
  return allowlist.some((entry) =>
    entry.path.endsWith("/")
      ? target.startsWith(entry.path)
      : stripExt(target) === stripExt(entry.path),
  );
}

/**
 * `test(`, `it(` and their modifiers (`test.skip(`, `test.each(`, `test.if(x)(`), each
 * counted once. Comments that spell `test(` count too: the rule errs toward judging.
 */
export function countTestCalls(source: string): number {
  return source.match(/(?<![\w.$])(?:test|it)(?:\.[A-Za-z]+)*\s*\(/g)?.length ?? 0;
}

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};

/** Runtime import specifiers. `mock.module` targets are not imports: mocking is not testing. */
export function importsOf(path: string, source: string): string[] {
  const transpiler = path.endsWith("x") ? transpilers.tsx : transpilers.ts;
  try {
    return transpiler.scanImports(source).map((entry) => entry.path);
  } catch {
    // A file Bun cannot parse: fall back to a regex over static and dynamic imports.
    return [...source.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g)].map(
      (match) => match[1]!,
    );
  }
}

/** Repo-relative target of a specifier, or undefined for packages and builtins. */
export function resolveSpecifier(fromPath: string, specifier: string): string | undefined {
  if (specifier.startsWith("@/")) return normalize(`src/${specifier.slice(2)}`);
  if (!specifier.startsWith(".")) return undefined;
  const target = normalize(join(dirname(fromPath), specifier));
  return target.startsWith("..") ? undefined : target;
}

/** Plain code only: JSON, Markdown, SQL and other text imports are data. */
function isCode(target: string): boolean {
  const last = target.split("/").pop() ?? "";
  return CODE_EXT.test(target) || !last.includes(".");
}

/** Find a helper's file on disk: the specifier may omit the extension or name a directory. */
type Reader = (path: string) => string | undefined;

function readModule(target: string, read: Reader): { path: string; source: string } | undefined {
  const candidates = CODE_EXT.test(target)
    ? [target]
    : [".ts", ".tsx", ".js", "/index.ts", "/index.tsx"].map((suffix) => `${target}${suffix}`);
  for (const candidate of candidates) {
    const source = read(candidate);
    if (source !== undefined) return { path: candidate, source };
  }
  return undefined;
}

/**
 * Repo code a test reaches outside the allowlist: its own imports, and through test
 * helpers the helpers' imports. Each entry is `target` or `target (via helper)`.
 */
export function disallowedImports(
  path: string,
  source: string,
  allowlist: readonly AllowEntry[],
  read: Reader,
): string[] {
  // Target to the helper that reached it; a direct import wins over a helper.
  const found = new Map<string, string | undefined>();
  const seen = new Set<string>([path]);
  const walk = (file: string, text: string, via?: string) => {
    for (const specifier of importsOf(file, text)) {
      const target = resolveSpecifier(file, specifier);
      if (!target || !isCode(target)) continue;
      if (target.startsWith(TEST_SUPPORT_DIR) && !isTestFile(target)) {
        const helper = readModule(target, read);
        if (helper && !seen.has(helper.path)) {
          seen.add(helper.path);
          walk(helper.path, helper.source, via ?? helper.path);
        }
        continue;
      }
      if (isAllowed(target, allowlist)) continue;
      if (!found.has(target) || !via) found.set(target, via);
    }
  };
  walk(path, source);
  return [...found.keys()].sort().map((target) => {
    const via = found.get(target);
    return via ? `${target} (via ${via})` : target;
  });
}

export function judge(
  changes: readonly TestChange[],
  allowlist: readonly AllowEntry[],
  read: Reader,
): Violation[] {
  const violations: Violation[] = [];
  for (const change of changes) {
    if (!isTestFile(change.path)) continue;
    if (isAllowed(change.path, allowlist)) continue;
    let what: string;
    if (change.base === undefined) {
      what = "new test file";
    } else {
      const added = countTestCalls(change.head) - countTestCalls(change.base);
      if (added <= 0) continue;
      what = `${added} new test( call(s)`;
    }
    const imports = disallowedImports(change.path, change.head, allowlist, read);
    if (imports.length === 0) continue;
    violations.push({
      path: change.path,
      reason: `${what} importing code outside the allowlist: ${imports.join(", ")}`,
    });
  }
  return violations;
}

async function git(args: string[]): Promise<string> {
  const result = await Bun.$`git ${args}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

/** Changed test files between `base` and the working tree, with their base content. */
async function changedTests(base: string, root: string): Promise<TestChange[]> {
  const fields = (await git(["diff", "--name-status", "-z", "-M", "--diff-filter=ACMR", base]))
    .split("\0")
    .filter(Boolean);
  const pairs: Array<{ path: string; from?: string }> = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++]!;
    if (status.startsWith("R")) {
      const from = fields[i++]!;
      pairs.push({ path: fields[i++]!, from });
    } else if (status.startsWith("C")) {
      // A copy is a new file: its tests did not exist before.
      i++;
      pairs.push({ path: fields[i++]! });
    } else if (status === "A") {
      pairs.push({ path: fields[i++]! });
    } else {
      const path = fields[i++]!;
      pairs.push({ path, from: path });
    }
  }
  const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean);
  for (const path of untracked) pairs.push({ path });

  const changes: TestChange[] = [];
  for (const { path, from } of pairs) {
    if (!isTestFile(path)) continue;
    const head = await Bun.file(join(root, path))
      .text()
      .catch(() => undefined);
    if (head === undefined) continue;
    const baseText = from
      ? await Bun.$`git show ${`${base}:${from}`}`
          .quiet()
          .nothrow()
          .then((result) => (result.exitCode === 0 ? result.stdout.toString() : undefined))
      : undefined;
    changes.push({ path, head, base: baseText });
  }
  return changes;
}

async function main(argv: string[]): Promise<number> {
  const baseFlag = argv.indexOf("--base");
  const root = (await git(["rev-parse", "--show-toplevel"])).trim();
  const base =
    baseFlag >= 0 && argv[baseFlag + 1]
      ? argv[baseFlag + 1]!
      : (await git(["merge-base", "origin/main", "HEAD"])).trim();
  const allowlistPath = join(root, "scripts/unit-test-allowlist.txt");
  const allowlist = parseAllowlist(await Bun.file(allowlistPath).text());
  const changes = await changedTests(base, root);
  const read: Reader = (path) => {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch {
      return undefined;
    }
  };
  const violations = judge(changes, allowlist, read);
  const judged = changes.length;
  if (violations.length === 0) {
    console.log(
      `Rule 1 (no new unit tests): ok, ${judged} changed test file(s) against ${base.slice(0, 12)}`,
    );
    return 0;
  }
  console.error(`Rule 1 (no new unit tests): ${violations.length} violation(s)\n`);
  for (const violation of violations) {
    console.error(`  ${violation.path}: ${violation.reason}`);
  }
  console.error(
    [
      "",
      "Cover this code with an e2e scenario in scripts/e2e/scenarios/ (scripts/e2e/README.md).",
      "If a unit test is right here, add a line with a reason to scripts/unit-test-allowlist.txt:",
      "  <test file path>  # <why a scenario cannot check this>",
    ].join("\n"),
  );
  return 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
