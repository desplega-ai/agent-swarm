/**
 * A release (package.json version bump on main) also deploys prod: the
 * deploy-release job in .github/workflows/docker-and-deploy.yml dispatches
 * deploy.yml once this run's api and worker images and the :latest promotion
 * are done.
 *
 * The test reads the real workflow, resolves its job graph the way the Actions
 * runner does (job `if`, `needs`, implicit success()), and runs the dispatch
 * step's shell verbatim against a stub `gh`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

type Step = {
  name?: string;
  run?: string;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
};
type Job = {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
};
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };
type Result = "success" | "failure" | "skipped";

const WORKFLOWS = join(import.meta.dir, "../../.github/workflows");
const DISPATCH_JOB = "deploy-release";
const REPO = "desplega-ai/agent-swarm";

async function loadWorkflow(file: string): Promise<Workflow> {
  return Bun.YAML.parse(await Bun.file(join(WORKFLOWS, file)).text()) as Workflow;
}

function dispatchJob(wf: Workflow): Job {
  const job = wf.jobs[DISPATCH_JOB];
  if (!job)
    throw new Error(
      `docker-and-deploy.yml has no ${DISPATCH_JOB} job: a release never dispatches deploy.yml`,
    );
  return job;
}

const needsOf = (job: Job): string[] => (job.needs === undefined ? [] : [job.needs].flat());

// Evaluates the GitHub expression subset the job conditions use: literals,
// dotted context paths, ! == != && || and parens, plus the status functions.
function evaluate(
  expr: string,
  ctx: Record<string, unknown>,
  status: Record<string, boolean>,
): unknown {
  const tokens = expr.match(/'(?:[^']|'')*'|&&|\|\||==|!=|[()!]|[A-Za-z_][\w.-]*/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const primary = (): unknown => {
    const t = next();
    if (t === undefined) throw new Error(`unexpected end of expression: ${expr}`);
    if (t === "!") return !primary();
    if (t === "(") {
      const v = or();
      if (next() !== ")") throw new Error(`unbalanced parens: ${expr}`);
      return v;
    }
    if (t.startsWith("'")) return t.slice(1, -1).replaceAll("''", "'");
    if (t === "true" || t === "false") return t === "true";
    if (peek() === "(") {
      next();
      if (next() !== ")") throw new Error(`unsupported call arguments in: ${expr}`);
      if (!(t in status)) throw new Error(`unsupported function ${t}() in: ${expr}`);
      return status[t];
    }
    return t
      .split(".")
      .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], ctx);
  };
  const cmp = (): unknown => {
    let v = primary();
    while (peek() === "==" || peek() === "!=") {
      const op = next();
      const r = primary();
      v = op === "==" ? v === r : v !== r;
    }
    return v;
  };
  const and = (): unknown => {
    let v = cmp();
    while (peek() === "&&") {
      next();
      const r = cmp();
      v = v && r;
    }
    return v;
  };
  const or = (): unknown => {
    let v = and();
    while (peek() === "||") {
      next();
      const r = and();
      v = v || r;
    }
    return v;
  };
  const v = or();
  if (i !== tokens.length) throw new Error(`trailing tokens in: ${expr}`);
  return v;
}

const unwrap = (s: string) => s.replace(/^\s*\$\{\{\s*([\s\S]*?)\s*\}\}\s*$/, "$1");

interface Scenario {
  ref?: string;
  eventName?: string;
  versionChanged: boolean;
  /** Jobs that fail when they run; every other job that runs succeeds. */
  failing?: string[];
}

/** Resolves every job's result for one push, in the order the runner would start them. */
function runGraph(wf: Workflow, s: Scenario) {
  const github = {
    ref: s.ref ?? "refs/heads/main",
    event_name: s.eventName ?? "push",
    repository: REPO,
    token: "ghs_test",
  };
  const outputs: Record<string, Record<string, string>> = {
    "detect-version-change": { version_changed: String(s.versionChanged), version: "9.9.9" },
  };
  const results: Record<string, Result> = {};
  const order: string[] = [];
  const pending = new Set(Object.keys(wf.jobs));
  while (pending.size > 0) {
    const ready = [...pending].filter((j) => needsOf(wf.jobs[j] as Job).every((n) => n in results));
    if (ready.length === 0)
      throw new Error(`job graph has a cycle or a missing need: ${[...pending]}`);
    for (const id of ready) {
      const job = wf.jobs[id] as Job;
      const deps = needsOf(job);
      const failed = deps.some((n) => results[n] === "failure");
      const allOk = deps.every((n) => results[n] === "success");
      const cond = job.if ? unwrap(job.if) : "success()";
      const usesStatus = /\b(success|failure|always|cancelled)\(/.test(cond);
      const needs = Object.fromEntries(
        deps.map((n) => [n, { result: results[n], outputs: outputs[n] ?? {} }]),
      );
      const status = { success: allOk, failure: failed, always: true, cancelled: false };
      const runs = Boolean(
        evaluate(usesStatus ? cond : `success() && (${cond})`, { github, needs }, status),
      );
      results[id] = !runs ? "skipped" : s.failing?.includes(id) ? "failure" : "success";
      if (runs) order.push(id);
      pending.delete(id);
    }
  }
  return {
    results,
    order,
    ctx: {
      github,
      needs: { "detect-version-change": { outputs: outputs["detect-version-change"] } },
    },
  };
}

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Runs each `run` step of the dispatch job verbatim, with `gh` stubbed to log its argv and exit `ghExit`. */
async function runDispatch(wf: Workflow, ghExit: number) {
  const job = dispatchJob(wf);
  const dir = await mkdtemp(join(tmpdir(), "deploy-release-"));
  dirs.push(dir);
  const log = join(dir, "gh.log");
  const gh = join(dir, "gh");
  await Bun.write(
    gh,
    `#!/usr/bin/env bash\necho "token=$GH_TOKEN args=$*" >> "${log}"\nexit ${ghExit}\n`,
  );
  await chmod(gh, 0o755);
  const { ctx } = runGraph(wf, { versionChanged: true });
  const interp = (v: string) =>
    v.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_, e: string) => String(evaluate(e, ctx, {}) ?? ""));
  const steps = [];
  for (const step of (job.steps ?? []).filter((st) => st.run)) {
    const env = Object.fromEntries(
      Object.entries(step.env ?? {}).map(([k, v]) => [k, interp(String(v))]),
    );
    const res = await runChild(["bash", "-e", "-c", interp(step.run as string)], {
      cwd: dir,
      env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, GITHUB_REPOSITORY: REPO, ...env },
    });
    steps.push({ step, res, outcome: res.exitCode === 0 ? "success" : "failure" });
  }
  const calls = (await Bun.file(log).exists())
    ? (await Bun.file(log).text()).trim().split("\n")
    : [];
  // A failed step fails the job unless it is continue-on-error.
  const jobResult: Result = steps.some(
    (s) => s.outcome === "failure" && s.step["continue-on-error"] !== true,
  )
    ? "failure"
    : "success";
  return { steps, calls, jobResult };
}

describe("release deploys prod (docker-and-deploy.yml deploy-release)", () => {
  test(
    "a release push to main dispatches deploy.yml on main with the job token",
    async () => {
      const wf = await loadWorkflow("docker-and-deploy.yml");
      dispatchJob(wf);
      expect(runGraph(wf, { versionChanged: true }).results[DISPATCH_JOB]).toBe("success");
      const { calls, jobResult, steps } = await runDispatch(wf, 0);
      expect(calls).toEqual([`token=ghs_test args=workflow run deploy.yml -R ${REPO} --ref main`]);
      expect(jobResult).toBe("success");
      expect(steps.map((s) => s.res.stdout).join("")).toContain(
        "::notice::Dispatched deploy.yml for release v9.9.9",
      );
      expect(dispatchJob(wf).permissions?.actions).toBe("write");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test("the dispatched deploy.yml accepts a no-input workflow_dispatch", async () => {
    const deploy = await loadWorkflow("deploy.yml");
    const dispatch = deploy.on.workflow_dispatch as {
      inputs?: Record<string, { required?: boolean }>;
    } | null;
    expect(deploy.on).toHaveProperty("workflow_dispatch");
    for (const input of Object.values(dispatch?.inputs ?? {}))
      expect(input.required).not.toBe(true);
  });

  test("a non-release push to main does not deploy", async () => {
    const wf = await loadWorkflow("docker-and-deploy.yml");
    dispatchJob(wf);
    const { results } = runGraph(wf, { versionChanged: false });
    expect(results[DISPATCH_JOB]).toBe("skipped");
    expect(results["promote-main-tags"]).toBe("success");
  });

  test("a version change off main does not deploy", async () => {
    const wf = await loadWorkflow("docker-and-deploy.yml");
    dispatchJob(wf);
    const { results } = runGraph(wf, {
      versionChanged: true,
      ref: "refs/heads/release-branch",
      eventName: "workflow_dispatch",
    });
    expect(results[DISPATCH_JOB]).toBe("skipped");
  });

  test("dispatch starts only after merge-server, merge-worker and promote-main-tags succeed", async () => {
    const wf = await loadWorkflow("docker-and-deploy.yml");
    dispatchJob(wf);
    const { order } = runGraph(wf, { versionChanged: true });
    for (const before of ["merge-server", "merge-worker", "promote-main-tags"]) {
      expect(order.indexOf(before)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(before)).toBeLessThan(order.indexOf(DISPATCH_JOB));
    }
    for (const failing of [
      "merge-server",
      "merge-worker",
      "merge-worker-slim",
      "promote-main-tags",
      "build-and-push-server-arm64",
    ]) {
      expect({
        failing,
        result: runGraph(wf, { versionChanged: true, failing: [failing] }).results[DISPATCH_JOB],
      }).toEqual({
        failing,
        result: "skipped",
      });
    }
  });

  test(
    "a failed dispatch warns and leaves the release run green",
    async () => {
      const wf = await loadWorkflow("docker-and-deploy.yml");
      const { calls, jobResult, steps } = await runDispatch(wf, 1);
      expect(calls).toHaveLength(1);
      expect(steps.some((s) => s.outcome === "failure")).toBe(true);
      expect(steps.map((s) => s.res.stdout).join("")).toContain(
        "::warning::Could not dispatch deploy.yml for v9.9.9",
      );
      expect(jobResult).toBe("success");
      // Nothing downstream waits on the dispatch, so it cannot skip the release jobs.
      const dependents = Object.entries(wf.jobs).filter(([, j]) =>
        needsOf(j).includes(DISPATCH_JOB),
      );
      expect(dependents).toEqual([]);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "control: each guard, removed, makes its check fail",
    async () => {
      const fresh = async () => {
        const wf = await loadWorkflow("docker-and-deploy.yml");
        return { wf, job: dispatchJob(wf) };
      };
      const noGate = await fresh();
      noGate.job.if = "github.ref == 'refs/heads/main'";
      expect(runGraph(noGate.wf, { versionChanged: false }).results[DISPATCH_JOB]).toBe("success");

      const noPromote = await fresh();
      noPromote.job.needs = needsOf(noPromote.job).filter((n) => n !== "promote-main-tags");
      expect(
        runGraph(noPromote.wf, { versionChanged: true, failing: ["promote-main-tags"] }).results[
          DISPATCH_JOB
        ],
      ).toBe("success");

      const fatal = await fresh();
      for (const st of fatal.job.steps ?? []) delete st["continue-on-error"];
      expect((await runDispatch(fatal.wf, 1)).jobResult).toBe("failure");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
