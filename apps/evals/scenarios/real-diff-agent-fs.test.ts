import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckResult, DeterministicCheck, JudgeContext } from "../src/types.ts";
import { type SimulatedBranch, simulatedContext } from "./grader-fixtures/real-diff-agent-fs.ts";
import { makeContext, nullTasks, toolCallRows } from "./grader-validation-support.ts";
import {
  __test__ as key,
  parseOutcomes,
  realDiffAgentFs,
  upstreamLookup,
} from "./real-diff-agent-fs.ts";

/**
 * Grader tests for real-diff-agent-fs. The sandbox shell is simulated (see
 * SimulatedSandbox): CI must not clone, install a 1.5 GB monorepo and run its tests.
 * What runs for real here is everything after the shell: the junit summary parser,
 * the grouping, the scoring, the keep-group rule and the gates.
 * scripts/validate-real-diff-agent-fs.ts runs the seed and the grading commands for real.
 */

function checkNamed(name: string): DeterministicCheck {
  const all = [
    ...(realDiffAgentFs.outcome.gates ?? []),
    ...(realDiffAgentFs.outcome.dimensions ?? []).flatMap((d) => d.checks ?? []),
  ];
  const hit = all.find((c) => c.name === name);
  if (!hit) throw new Error(`no check ${name}`);
  return hit;
}

async function groupScores(ctx: JudgeContext): Promise<Record<string, CheckResult>> {
  const out: Record<string, CheckResult> = {};
  for (const g of key.GROUPS) out[g.name] = await checkNamed(`hidden-${g.name}`).fn(ctx);
  return out;
}

const FIX_GROUPS = key.GROUPS.filter((g) => g.kind === "fix").map((g) => g.name);
const SELF_MOVE = "mv rejects normalized self moves without deleting the source";

function branch(over: Partial<SimulatedBranch> = {}): SimulatedBranch {
  return { name: "fix/paths", opsFilesChanged: 18, ...over };
}

describe("real-diff-agent-fs seed", () => {
  const cmds = key.seedCommands();

  test("downloads the parent commit and refuses a result that is not the pinned seed commit", () => {
    expect(cmds[0]).toContain(`codeload.github.com/desplega-ai/agent-fs/tar.gz/${key.PARENT_SHA}`);
    expect(cmds[0]).toContain(key.SEED_SHA);
    expect(cmds[0]).toContain("git push -q origin main");
    expect(key.SEED_SHA).toMatch(/^[0-9a-f]{40}$/);
    expect(key.PARENT_SHA).toMatch(/^[0-9a-f]{40}$/);
  });

  test("starts the install detached and polls for it, because one sandbox exec is capped at 60 s", () => {
    expect(cmds.some((c) => c.includes("nohup") && c.includes("install --frozen-lockfile"))).toBe(
      true,
    );
    const waits = cmds.filter((c) => c.includes("install still running"));
    expect(waits.length).toBeGreaterThanOrEqual(2);
    for (const w of waits) expect(w).toContain("seq 1 50");
  });

  test("the hidden tests never reach the sandbox before grading", () => {
    const seeded = cmds.join("\n");
    for (const f of key.HIDDEN_FILES) {
      expect(seeded).not.toContain(f.path);
      expect(seeded).not.toContain(Buffer.from(f.content).toString("base64").slice(0, 80));
    }
    for (const g of key.GROUPS) for (const t of g.tests) expect(seeded).not.toContain(t);
  });

  test("the task text carries the issue and the delivery rules, and none of the answer", () => {
    const text = realDiffAgentFs.tasks[0]?.description ?? "";
    expect(text).toContain("git push origin <branch>");
    expect(text).toContain(key.REPO);
    for (const hidden of [
      "Source and destination are the same path",
      "withLeadingSlash",
      "files_fts_docs",
    ]) {
      expect(text).not.toContain(hidden);
    }
  });
});

describe("real-diff-agent-fs hidden groups", () => {
  test("every named test is declared in a hidden file", () => {
    const sources = new Map(key.HIDDEN_FILES.map((f) => [f.path, f.content]));
    for (const g of key.GROUPS) {
      for (const name of g.tests) {
        const sourceText = [...sources.values()].join("\n");
        const literal = sourceText.includes(name);
        // Loop-generated names: `${op} rest` with the op listed as a quoted string.
        const [op, ...rest] = name.split(" ");
        const generated =
          sourceText.includes(`\`\${op} ${rest.join(" ")}\``) && sourceText.includes(`"${op}"`);
        expect({ name, declared: literal || generated }).toEqual({ name, declared: true });
      }
    }
  });

  test("18 tests fail on the parent, in six fix groups, and the keep group has 16", () => {
    expect(key.FIX_TEST_COUNT).toBe(18);
    expect(FIX_GROUPS).toHaveLength(6);
    expect(key.GROUPS.find((g) => g.kind === "keep")?.tests).toHaveLength(16);
    const all = key.GROUPS.flatMap((g) => g.tests);
    expect(new Set(all).size).toBe(all.length);
  });

  test("the reference patch touches only op source, never a test", () => {
    const files = [...key.REFERENCE_PATCH.matchAll(/^diff --git a\/(\S+) b\//gm)].map(
      (m) => m[1] as string,
    );
    expect(files).toHaveLength(18);
    for (const f of files) {
      expect(f.startsWith("packages/core/src/ops/")).toBe(true);
      expect(f).not.toContain("__tests__");
    }
  });
});

describe("real-diff-agent-fs grader", () => {
  test("the real fix scores every group and keeps the suite green", async () => {
    const ctx = simulatedContext(branch());
    for (const r of Object.values(await groupScores(ctx))) expect(r.score).toBe(1);
    expect((await checkNamed("pushed-branch").fn(ctx)).pass).toBe(true);
    expect(await checkNamed("existing-tests-still-green").fn(ctx)).toMatchObject({
      pass: true,
      score: 1,
    });
  });

  test("a family half done scores 0 for that family only", async () => {
    const scores = await groupScores(simulatedContext(branch({ red: [SELF_MOVE] })));
    expect(scores["move-copy"]).toMatchObject({ pass: false, score: 0 });
    expect(scores["move-copy"]?.detail).toContain("2/3 green");
    for (const name of FIX_GROUPS.filter((n) => n !== "move-copy")) {
      expect(scores[name]?.score).toBe(1);
    }
    expect(scores["prior-behavior-kept"]?.score).toBe(1);
  });

  test("breaking a behavior the issue never mentions costs the keep group", async () => {
    const scores = await groupScores(
      simulatedContext(
        branch({ red: ["fts keeps a trailing slash and excludes sibling prefixes"] }),
      ),
    );
    expect(scores["prior-behavior-kept"]).toMatchObject({ pass: false, score: 0 });
    for (const name of FIX_GROUPS) expect(scores[name]?.score).toBe(1);
  });

  test("a commit that changes no op source earns nothing, not even the keep group", async () => {
    const red = key.GROUPS.filter((g) => g.kind === "fix").flatMap((g) => g.tests);
    const scores = await groupScores(simulatedContext(branch({ opsFilesChanged: 0, red })));
    for (const g of key.GROUPS) expect(scores[g.name]?.score).toBe(0);
    expect(scores["prior-behavior-kept"]?.detail).toContain("no op source changed");
  });

  test("a red test elsewhere in the core suite lowers delivery in proportion", async () => {
    const res = await checkNamed("existing-tests-still-green").fn(
      simulatedContext(branch({ redCoreTests: 10 })),
    );
    expect(res.pass).toBe(false);
    expect(res.score).toBeCloseTo(30 / 40, 5);
  });

  test("the hidden files in the core run are not counted twice", async () => {
    const res = await checkNamed("existing-tests-still-green").fn(simulatedContext(branch()));
    expect(res.detail).toBe("40/40: 40 green");
  });

  test("nothing pushed scores 0 everywhere and fails the push gate", async () => {
    const ctx = simulatedContext(null);
    for (const r of Object.values(await groupScores(ctx)))
      expect(r).toMatchObject({ pass: false, score: 0 });
    expect((await checkNamed("pushed-branch").fn(ctx)).pass).toBe(false);
    expect((await checkNamed("existing-tests-still-green").fn(ctx)).score).toBe(0);
  });

  test("a clone that cannot install scores 0 and says why", async () => {
    const ctx = simulatedContext(branch({ installExit: 1 }));
    const scores = await groupScores(ctx);
    for (const r of Object.values(scores)) expect(r.score).toBe(0);
    expect(scores["write-ops"]?.detail).toContain("bun install on the clone failed");
  });

  test("a hidden run with no report scores 0 and says why", async () => {
    const scores = await groupScores(simulatedContext(branch({ noHiddenReport: true })));
    expect(scores["write-ops"]?.score).toBe(0);
    expect(scores["write-ops"]?.detail).toContain("no report");
  });

  test("a core run with no report costs delivery but not correctness", async () => {
    const ctx = simulatedContext(branch({ noCoreReport: true }));
    for (const r of Object.values(await groupScores(ctx))) expect(r.score).toBe(1);
    const res = await checkNamed("existing-tests-still-green").fn(ctx);
    expect(res).toMatchObject({ pass: false, score: 0 });
  });
});

describe("real-diff-agent-fs junit summary", () => {
  test("parseOutcomes reads status, file and name, and skips noise", () => {
    const out = parseOutcomes(
      "P\ta.test.ts\tone\nF\tb.test.ts\ttwo words\nS\tc.test.ts\tskipped\nnoise\n\n",
    );
    expect(out).toEqual([
      { status: "P", file: "a.test.ts", name: "one" },
      { status: "F", file: "b.test.ts", name: "two words" },
      { status: "S", file: "c.test.ts", name: "skipped" },
    ]);
  });

  test("the sandbox-side compactor reads a real bun junit report", () => {
    const dir = mkdtempSync(join(tmpdir(), "afs-junit-"));
    try {
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<testsuites name="bun test">',
        '<testsuite name="x.test.ts" file="x.test.ts">',
        '<testcase name="passes" classname="s" file="x.test.ts" line="1" />',
        '<testcase name="fails &quot;quoted&quot;" classname="s" file="x.test.ts" line="2">',
        '<failure type="AssertionError" message="boom&#10;line two">trace</failure>',
        "</testcase>",
        '<testcase name="is skipped" classname="s" file="x.test.ts" line="3">',
        "<skipped />",
        "</testcase>",
        "</testsuite>",
        "</testsuites>",
      ].join("\n");
      writeFileSync(join(dir, "r.xml"), xml);
      writeFileSync(join(dir, "c.js"), key.JUNIT_COMPACT_JS);
      const res = Bun.spawnSync([process.execPath, join(dir, "c.js"), join(dir, "r.xml")]);
      expect(parseOutcomes(res.stdout.toString())).toEqual([
        { status: "P", file: "x.test.ts", name: "passes" },
        { status: "F", file: "x.test.ts", name: 'fails "quoted"' },
        { status: "S", file: "x.test.ts", name: "is skipped" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("real-diff-agent-fs upstream lookup", () => {
  const bash = (command: string) => ({ toolName: "Bash", input: { command } });

  test("flags a fetch of the fix from GitHub or the published package", () => {
    for (const command of [
      "curl -sL https://github.com/desplega-ai/agent-fs/pull/73.diff",
      "curl https://codeload.github.com/desplega-ai/agent-fs/tar.gz/main | tar xz",
      "gh pr view 73 --repo desplega-ai/agent-fs",
      "npm view @desplega.ai/agent-fs versions",
      "npx @desplega.ai/agent-fs@latest --help",
      "git clone https://github.com/desplega-ai/agent-fs /tmp/x",
    ]) {
      expect(upstreamLookup([bash(command)])).not.toBeNull();
    }
    expect(
      upstreamLookup([
        { toolName: "WebFetch", input: { url: "https://github.com/desplega-ai/agent-fs" } },
      ]),
    ).not.toBeNull();
  });

  test("leaves ordinary work in the repo alone", () => {
    for (const command of [
      "bun test packages/core/src",
      "grep -rn '@desplega.ai/agent-fs-core' packages",
      "cat node_modules/@desplega.ai/agent-fs-core/package.json",
      "git remote -v && git push origin fix/paths",
      "rg normalizePath packages/core/src/ops",
    ]) {
      expect(upstreamLookup([bash(command)])).toBeNull();
    }
  });

  test("the gate reads the worker task's session log", async () => {
    const [task] = nullTasks(realDiffAgentFs);
    const taskId = task?.id as string;
    const dirty = makeContext(realDiffAgentFs, {
      tasks: [{ ...(task as NonNullable<typeof task>), agentId: "worker-0" }],
      logs: {
        [taskId]: toolCallRows(
          taskId,
          "Bash",
          { command: "curl -s https://api.github.com/repos/desplega-ai/agent-fs/pulls/73" },
          "",
          "c1",
        ),
      },
    });
    expect((await checkNamed("no-upstream-lookup").fn(dirty)).pass).toBe(false);
    expect((await checkNamed("no-upstream-lookup").fn(simulatedContext(branch()))).pass).toBe(true);
  });
});
