/**
 * Runs the real-diff-agent-fs seed and grader for real, on this machine, against a temp-dir copy
 * of the sandbox layout. Needs network (GitHub tarball, npm registry) and about 1.5 GB of disk.
 * The CI test (scenarios/real-diff-agent-fs.test.ts) simulates the shell instead; run this after
 * any change to the seed or to the grading commands.
 *
 *   bun scripts/validate-real-diff-agent-fs.ts reference   # the real fix pushed: every check 1
 *   bun scripts/validate-real-diff-agent-fs.ts noop        # a README-only commit: correctness 0
 *   bun scripts/validate-real-diff-agent-fs.ts null        # nothing pushed: the push gate fails
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeContext, nullTasks } from "../scenarios/grader-validation-support.ts";
import { __test__ as key, realDiffAgentFs } from "../scenarios/real-diff-agent-fs.ts";

const mode = process.argv[2] ?? "reference";
if (!["reference", "noop", "null"].includes(mode)) {
  console.error("usage: bun scripts/validate-real-diff-agent-fs.ts [reference|noop|null]");
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), "real-diff-agent-fs-"));
mkdirSync(join(root, "workspace"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

/** Maps the scenario's absolute sandbox paths onto the temp dir, and its bun onto this one. */
function mapPaths(cmd: string): string {
  return cmd
    .replaceAll(key.GRADE_DIR, join(root, "grade"))
    .replaceAll("/workspace", join(root, "workspace"))
    .replaceAll("/usr/local/bin/bun", process.execPath);
}

async function exec(cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", "-c", mapPaths(cmd)], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const t0 = Date.now();
for (const cmd of key.seedCommands()) {
  let res = await exec(cmd);
  // The install wait exits 2 while bun is still running; the sandbox seed repeats the wait too.
  for (let tries = 0; res.exitCode === 2 && tries < 6; tries++) res = await exec(cmd);
  if (res.exitCode !== 0) {
    console.error(
      `seed failed (${res.exitCode}): ${res.stderr.slice(0, 400)} ${res.stdout.slice(-300)}`,
    );
    process.exit(1);
  }
}
console.log(`seeded in ${Date.now() - t0} ms`);

const agent = (steps: string[]) => exec([`cd ${key.REPO}`, ...steps].join("\n"));
const commit = "git add -A && git -c user.name=Agent -c user.email=agent@example.test commit -q -m";
if (mode === "reference") {
  const res = await agent([
    "git checkout -q -b fix/paths",
    key.writeFileCmd("/tmp/reference.patch", key.REFERENCE_PATCH),
    "git apply /tmp/reference.patch",
    `${commit} 'Normalize paths in every op'`,
    "git push -q origin fix/paths",
  ]);
  if (res.exitCode !== 0) throw new Error(`reference work failed: ${res.stderr}`);
} else if (mode === "noop") {
  const res = await agent([
    "git checkout -q -b chore/readme",
    "echo 'A note.' >> README.md",
    `${commit} 'Add a note'`,
    "git push -q origin chore/readme",
  ]);
  if (res.exitCode !== 0) throw new Error(`no-op work failed: ${res.stderr}`);
}

const base = makeContext(realDiffAgentFs, { tasks: nullTasks(realDiffAgentFs) });
const worker0 = base.workers[0] as (typeof base.workers)[number];
const readFile = async (path: string) => {
  const res = await exec(`cat ${JSON.stringify(path)}`);
  return res.exitCode === 0 ? res.stdout : null;
};
const ctx = { ...base, workers: [{ ...worker0, exec, readFile }], exec, readFile };

const t1 = Date.now();
const checks = [
  ...(realDiffAgentFs.outcome.gates ?? []),
  ...(realDiffAgentFs.outcome.dimensions ?? []).flatMap((d) => d.checks ?? []),
];
const seen = new Set<string>();
for (const check of checks) {
  if (seen.has(check.name)) continue;
  seen.add(check.name);
  console.log(check.name, JSON.stringify(await check.fn(ctx)));
}
console.log(`graded in ${Date.now() - t1} ms`);
