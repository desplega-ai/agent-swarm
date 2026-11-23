import { sql } from "../db";
import { expect, expectStatus, pollUntil } from "../http";
import type { GithubCheckRun } from "../mocks/llm";
import type { Scenario, ScenarioContext } from "../run";
import {
  claimTask,
  createAssignedTask,
  expectToolError,
  expectToolOk,
  readTask,
  registerWorker,
  withMcp,
} from "./core-helpers";
import { cleanupStack, hmacSignature, putConfig, reloadConfig } from "./platform-helpers";

// defer-task `wakeOn {event: "vcs.pr.checks_done", source: "github", match}`. A completed
// `check_run` webhook only names a candidate: the server reads the PR head, the base branch's
// required checks (rulesets) and each check's latest run on that SHA, and wakes the waiter only
// when every required check finished (any conclusion), reporting the conclusions in the wake-up.
// A PR whose required checks already finished is rejected at defer time, as is a branch with no
// required checks. The same check_run delivered twice (App webhook plus repo webhook) wakes once.
// The ceiling and the 20-wait cap are the shared external-wait code, covered by defer-wake-pr-merged.

const REQUIRED = ["Merge Gate", "lint"];

function waitRow(ctx: ScenarioContext, scheduleId: string) {
  return ctx.db.get<{ status: string; firedBy: string | null }>(
    sql`SELECT status, "firedBy" FROM deferred_event_waits WHERE "scheduleId" = ${scheduleId}`,
  );
}

function wakeTasks(ctx: ScenarioContext, parentTaskId: string) {
  return ctx.db.query<{ id: string; task: string }>(
    sql`SELECT id, task FROM agent_tasks WHERE "parentTaskId" = ${parentTaskId} AND "taskType" = 'deferred'`,
  );
}

const run = (
  name: string,
  conclusion: string | null,
  at = "2026-11-17T10:00:00Z",
): GithubCheckRun =>
  conclusion
    ? { name, status: "completed", conclusion, completed_at: at }
    : { name, status: "in_progress", conclusion: null, completed_at: null };

export const deferWakePrChecksDone: Scenario = {
  name: "defer-wake-pr-checks-done",
  order: 658,
  async run(ctx) {
    const cleanup = cleanupStack(ctx);
    const secret = `e2e-github-checks-${ctx.nonce}`;
    const repo = `e2e/checks-wait-${ctx.nonce}`;
    const workerId = await registerWorker(ctx, "checks-wait", { maxTasks: 5 });
    const claim = async (label: string) => {
      const id = await createAssignedTask(ctx, workerId, `${label} ${ctx.nonce}`);
      await claimTask(ctx, workerId, id);
      return id;
    };
    const base = (taskId: string) => ({
      taskId,
      summary: `Pushed the PR ${ctx.nonce}`,
      note: `Read the checks ${ctx.nonce}`,
      delayMs: 3_600_000,
    });
    const wake = (number: number) => ({
      event: "vcs.pr.checks_done",
      source: "github",
      match: { repo, number },
    });
    const checkRunCompleted = async (number: number, sha: string, name: string) => {
      const body = JSON.stringify({
        action: "completed",
        sender: { login: "github-actions" },
        repository: { full_name: repo, html_url: `https://github.com/${repo}` },
        check_run: {
          id: 1,
          name,
          status: "completed",
          conclusion: "success",
          html_url: `https://github.com/${repo}/runs/1`,
          started_at: "2026-11-17T09:59:00Z",
          completed_at: "2026-11-17T10:00:00Z",
          output: { title: null, summary: null },
          check_suite: { id: 1, head_sha: sha },
          pull_requests: [{ number, head: { sha } }],
        },
      });
      const response = await ctx.api("POST", "/api/github/webhook", {
        apiKey: null,
        rawBody: body,
        headers: {
          "X-GitHub-Event": "check_run",
          "X-GitHub-Delivery": crypto.randomUUID(),
          "X-Hub-Signature-256": hmacSignature(secret, body),
        },
      });
      expectStatus(response, [200], `check_run completed webhook for #${number}`);
    };
    const runReads = (sha: string) => ctx.llm.requestsTo(`/commits/${sha}/check-runs`).length;

    try {
      for (const [key, value] of [
        ["GITHUB_DISABLE", "false"],
        ["GITHUB_WEBHOOK_SECRET", secret],
      ] as const) {
        const row = await putConfig(ctx, { key, value, isSecret: key.endsWith("SECRET") });
        cleanup.add(`delete ${key}`, async () => {
          await ctx.api("DELETE", `/api/config/${String(row.id)}`);
        });
      }
      await reloadConfig(ctx);

      await withMcp(ctx, workerId, async (worker) => {
        // Rejections: no required checks on the base branch, required checks already finished.
        const rejected = await claim("Wait for checks, rejected");
        const doneSha = "d".repeat(40);
        ctx.llm.setGithubPull(repo, 1, { merged: false, headSha: doneSha });
        await expectToolError(
          worker,
          "defer-task",
          { ...base(rejected), wakeOn: wake(1) },
          "has no required status checks on main",
        );
        ctx.llm.setGithubRequiredChecks(repo, "main", REQUIRED);
        ctx.llm.setGithubCheckRuns(repo, doneSha, [
          run("Merge Gate", "success"),
          run("lint", "failure"),
        ]);
        await expectToolError(
          worker,
          "defer-task",
          { ...base(rejected), wakeOn: wake(1) },
          "already happened",
        );
        expect(
          (await readTask(ctx, rejected)).status === "in_progress",
          "A rejected deferral must leave the task running",
        );

        // Accepted: lint finished, Merge Gate still running on the head.
        const sha = "c".repeat(40);
        ctx.llm.setGithubPull(repo, 2, { merged: false, headSha: sha });
        ctx.llm.setGithubCheckRuns(repo, sha, [
          run("Merge Gate", null),
          run("lint", "success", "2026-11-17T10:01:00Z"),
        ]);
        const waiter = await claim("Wait for PR 2 checks");
        const deferred = await expectToolOk(worker, "defer-task", {
          ...base(waiter),
          wakeOn: wake(2),
        });
        const scheduleId = String(deferred.data.scheduleId);
        expect(waitRow(ctx, scheduleId)?.status === "pending", "Checks wait was not stored");

        // Negative control: a finished check_run while a required check still runs wakes nobody,
        // though the server did read the checks (the candidate was considered, not trusted).
        await pollUntil(() => runReads(sha) >= 4, 10_000); // admission + post-commit recheck
        await Bun.sleep(300);
        const before = runReads(sha);
        await checkRunCompleted(2, sha, "lint");
        expect(
          await pollUntil(() => runReads(sha) > before, 10_000),
          "The check_run webhook never made the server read the checks",
        );
        await Bun.sleep(500);
        expect(
          waitRow(ctx, scheduleId)?.status === "pending" && !wakeTasks(ctx, waiter).length,
          "A check_run woke the waiter while a required check was still running",
        );

        // A caller cannot forge a check_run through the workflow-events API.
        const forged = await ctx.api("POST", "/api/workflow-events", {
          body: { name: "github.check_run.completed", payload: { repo, pullRequests: [2] } },
        });
        expectStatus(forged, [403], "forged check_run event");

        // Positive: Merge Gate finishes (failure still counts as done) while the server is still
        // reading the checks for an earlier lint candidate, held after it read Merge Gate as
        // running. That read answers "not done"; the Merge Gate candidates arriving during it
        // must still get a read that starts after them. The same delivery arrives on both
        // webhooks at once; the waiter wakes exactly once with every conclusion.
        const held = ctx.llm.holdNextGithubCheckRunRead("lint");
        await checkRunCompleted(2, sha, "lint");
        expect(
          await Promise.race([held.reached.then(() => true), Bun.sleep(10_000).then(() => false)]),
          "The lint candidate never read the lint check",
        );
        ctx.llm.setGithubCheckRuns(repo, sha, [
          run("Merge Gate", "failure", "2026-11-17T10:05:00Z"),
          run("lint", "success", "2026-11-17T10:01:00Z"),
        ]);
        await Promise.all([
          checkRunCompleted(2, sha, "Merge Gate"),
          checkRunCompleted(2, sha, "Merge Gate"),
        ]);
        await Bun.sleep(300);
        held.release();
        expect(
          await pollUntil(() => waitRow(ctx, scheduleId)?.status === "fired", 15_000),
          "Finished required checks never fired the wait",
        );
        await Bun.sleep(500);
        const woke = wakeTasks(ctx, waiter);
        expect(woke.length === 1, `Expected one wake-up task, got ${woke.length}`);
        expect(
          woke[0]!.task.includes(
            `Wake-up cause: vcs.pr.checks_done on github (repo=${repo.toLowerCase()}, number=2): head ${sha.slice(0, 12)}, Merge Gate=failure (completed 2026-11-17T10:05:00Z), lint=success (completed 2026-11-17T10:01:00Z)`,
          ),
          `Wake-up task is wrong: ${woke[0]!.task.slice(-400)}`,
        );
        expect(
          waitRow(ctx, scheduleId)?.firedBy === "external:github:vcs.pr.checks_done",
          "Wait was not fired by the github vcs.pr.checks_done event",
        );
      });

      // Without App worker auth the reads must send GITHUB_TOKEN: unauthenticated reads share
      // GitHub's 60 requests/hour, which a PR's burst of check_run candidates spends before its
      // last required check finishes, so the wait fell to the ceiling.
      const pat = `e2e-pat-${ctx.nonce}`;
      cleanup.add("boot the base env again", () => ctx.restartSut());
      await ctx.restartSut({ env: { GITHUB_APP_INSTALLATION_ID: "", GITHUB_TOKEN: pat } });
      const patWorker = await registerWorker(ctx, "checks-wait-pat", { maxTasks: 2 });
      const patSha = "e".repeat(40);
      ctx.llm.setGithubPull(repo, 3, { merged: false, headSha: patSha });
      ctx.llm.setGithubCheckRuns(repo, patSha, [
        run("Merge Gate", null),
        run("lint", "success", "2026-11-17T10:01:00Z"),
      ]);
      await withMcp(ctx, patWorker, async (worker) => {
        const waiter = await createAssignedTask(ctx, patWorker, `Wait for PR 3 checks ${ctx.nonce}`);
        await claimTask(ctx, patWorker, waiter);
        const deferred = await expectToolOk(worker, "defer-task", {
          ...base(waiter),
          wakeOn: wake(3),
        });
        const scheduleId = String(deferred.data.scheduleId);
        ctx.llm.setGithubCheckRuns(repo, patSha, [
          run("Merge Gate", "success", "2026-11-17T10:05:00Z"),
          run("lint", "success", "2026-11-17T10:01:00Z"),
        ]);
        await checkRunCompleted(3, patSha, "Merge Gate");
        expect(
          await pollUntil(() => waitRow(ctx, scheduleId)?.status === "fired", 15_000),
          "Finished required checks never fired the wait without App auth",
        );
        const reads = ctx.llm.requestsTo(`/commits/${patSha}/check-runs`);
        expect(
          reads.length > 0 && reads.every((r) => r.headers.authorization === `Bearer ${pat}`),
          `Checks reads did not send GITHUB_TOKEN: ${reads.map((r) => r.headers.authorization ?? "none").join(", ")}`,
        );
      });
    } finally {
      await cleanup.run();
      await reloadConfig(ctx);
    }
  },
};
