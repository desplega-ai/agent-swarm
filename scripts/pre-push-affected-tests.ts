/**
 * Picks the unit-test files nearest to a change, for the pre-push hook.
 *
 *   bun scripts/pre-push-affected-tests.ts <changed file>...   (or one path per line on stdin)
 *
 * Prints one test path per line (./-prefixed, ready for `bun test`) on stdout and
 * the reasons on stderr. Selection, per changed file:
 *   - a test file selects itself
 *   - otherwise walk its importers outward (relative and `@/` imports), one level
 *     at a time, and take the tests found at each level while the file's total
 *     stays within PRE_PUSH_TESTS_BUDGET (default 40). The level that would pass
 *     the budget contributes its tests named after the file (`<stem>*.test.ts`,
 *     the directory name for an index file), then its other tests in path order
 *     until the budget is full, then the walk stops.
 *   - a file no test imports (templates/, JSON, SQL) selects the tests whose
 *     source names its path, or its parent directory when that has 3+ segments
 *     (templates/skills/<name>); a migration also selects
 *     every `*migration*` test
 * `bun test --changed` takes the whole transitive import graph instead: a change
 * to src/types.ts reaches ~800 test files. CI stays authoritative: pull requests
 * run that `--changed` set, and the merge queue runs the full suite.
 */
import { dirname, join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const budget = Number(process.env.PRE_PUSH_TESTS_BUDGET ?? 40);

const argv = process.argv.slice(2);
const changed = (argv.length > 0 ? argv : (await Bun.stdin.text()).split("\n"))
  .map((f) => f.trim())
  .filter(Boolean);

// Same file set as a root `bun test`, minus bunfig.toml's pathIgnorePatterns.
const TEST_RE = /(\.test|_test|\.spec|_spec)\.[cm]?[jt]sx?$/;
const IGNORED_RE = /^(apps\/evals|packages\/ui-e2e)\//;
const isTest = (f: string) => TEST_RE.test(f) && !IGNORED_RE.test(f);
const tracked = (await Bun.$`git -C ${root} ls-files -- '*.ts' '*.tsx' '*.js' '*.mjs'`.text())
  .split("\n")
  .filter((f) => f && !f.includes("node_modules/") && !IGNORED_RE.test(f));
const tests = tracked.filter(isTest);

// Reverse import graph: file -> files that import it.
const importers = new Map<string, Set<string>>();
const sources = new Map<string, string>();
const transpiler = new Bun.Transpiler({ loader: "tsx" });
await Promise.all(
  tracked.map(async (file) => {
    const file_ = Bun.file(join(root, file));
    if (!(await file_.exists())) return;
    const text = await file_.text();
    if (isTest(file)) sources.set(file, text);
    let imports: { path: string }[];
    try {
      imports = transpiler.scanImports(text);
    } catch {
      return;
    }
    for (const { path } of imports) {
      const spec = path.startsWith("@/") ? join(root, "src", path.slice(2)) : path;
      if (!spec.startsWith(".") && !spec.startsWith("/")) continue;
      let resolved: string;
      try {
        resolved = relative(root, Bun.resolveSync(spec, join(root, dirname(file))));
      } catch {
        continue;
      }
      const set = importers.get(resolved) ?? new Set<string>();
      set.add(file);
      importers.set(resolved, set);
    }
  }),
);

const stemOf = (file: string) => {
  const base =
    file
      .split("/")
      .pop()
      ?.replace(/\.[^.]+$/, "") ?? "";
  return base === "index" ? (dirname(file).split("/").pop() ?? base) : base;
};
const namedAfter = (test: string, stem: string) => {
  const base = test.split("/").pop() ?? "";
  return base.startsWith(`${stem}.`) || base.startsWith(`${stem}-`);
};

const selected = new Set<string>();
for (const file of changed) {
  if (isTest(file)) {
    if (await Bun.file(join(root, file)).exists()) selected.add(file);
    continue;
  }
  const picked = new Set<string>();
  const seen = new Set([file]);
  let frontier = [file];
  let capped = false;
  while (frontier.length > 0 && !capped) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const imp of importers.get(f) ?? []) {
        if (seen.has(imp)) continue;
        seen.add(imp);
        next.push(imp);
      }
    }
    const levelTests = next.filter(isTest).sort();
    if (picked.size + levelTests.length > budget) {
      // Named tests first, then the rest of this level in path order until the
      // budget is full, so a hub whose direct importers alone pass the budget
      // still runs a stable, nonempty sample instead of nothing.
      const stem = stemOf(file);
      for (const t of levelTests) if (namedAfter(t, stem)) picked.add(t);
      for (const t of levelTests) {
        if (picked.size >= budget) break;
        picked.add(t);
      }
      capped = true;
    } else {
      for (const t of levelTests) picked.add(t);
    }
    frontier = next.filter((f) => !isTest(f));
  }
  if (seen.size === 1) {
    // Nothing imports it: match tests that name the file, or its directory when
    // that is specific enough (3+ segments, e.g. templates/skills/<name>).
    const dir = dirname(file);
    const dirSpecific = dir.split("/").length >= 3;
    for (const [t, text] of sources) {
      if (text.includes(file) || (dirSpecific && text.includes(dir))) picked.add(t);
    }
    if (file.startsWith("src/be/migrations/")) {
      for (const t of tests) if ((t.split("/").pop() ?? "").includes("migration")) picked.add(t);
    }
  }
  console.error(
    `[affected-tests] ${file}: ${picked.size} test file(s)${capped ? ` (importers past the budget of ${budget} left to CI)` : ""}`,
  );
  for (const t of picked) selected.add(t);
}

for (const t of [...selected].sort()) console.log(`./${t}`);
