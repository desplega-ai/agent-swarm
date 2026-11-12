import { asRecord, expect, expectStatus, pollUntil } from "../http";
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

// defer-task `wakeOn {event: "vcs.pr.merged", source: "github", match}`, the first external-event
// wait (provider adapters live in src/event-waits/). GitHub is off in the test SUT, so the tool refuses
// first. Then the integration is switched on through swarm_config with the GitHub REST stub in the
// mock host as its API. A `pull_request.closed` webhook only names a candidate: it wakes the waiter
// when the stub says the PR merged, and leaves the wait pending when it does not. A wait that
// reaches its ceiling is marked fired, so it stops counting toward the per-agent cap. A task-scoped
// token is refused, and an agent holds at most 20 pending event waits (timer-only defers still work).

type EventWaitRow = {
  status: string;
  firedBy: string | null;
  source: string;
  event: string;
};

function waitRow(ctx: ScenarioContext, scheduleId: string): EventWaitRow | null {
  return ctx.db.get<EventWaitRow>(
    "SELECT status, firedBy, source, event FROM deferred_event_waits WHERE scheduleId = ?",
    [scheduleId],
  );
}

function wakeTask(ctx: ScenarioContext, parentTaskId: string) {
  return ctx.db.get<{ id: string; task: string }>(
    "SELECT id, task FROM agent_tasks WHERE parentTaskId = ? AND taskType = 'deferred'",
    [parentTaskId],
  );
}

export const deferWakePrMerged: Scenario = {
  name: "defer-wake-pr-merged",
  order: 657,
  async run(ctx) {
    const cleanup = cleanupStack(ctx);
    const secret = `e2e-github-${ctx.nonce}`;
    const repo = `e2e/pr-wait-${ctx.nonce}`;
    const workerId = await registerWorker(ctx, "pr-wait", { maxTasks: 5 });
    const claim = async (label: string, wid = workerId) => {
      const id = await createAssignedTask(ctx, wid, `${label} ${ctx.nonce}`);
      await claimTask(ctx, wid, id);
      return id;
    };
    const base = (taskId: string) => ({
      taskId,
      summary: `Opened the PR ${ctx.nonce}`,
      note: `Check the merge ${ctx.nonce}`,
      delayMs: 3_600_000,
    });
    const closedMerged = async (number: number) => {
      const body = JSON.stringify({
        action: "closed",
        sender: { login: "e2e-merger" },
        repository: { full_name: repo, html_url: `https://github.com/${repo}` },
        pull_request: {
          number,
          title: "e2e pr",
          body: null,
          html_url: `https://github.com/${repo}/pull/${number}`,
          user: { login: "e2e-author" },
          head: { ref: "feat/e2e", sha: "a".repeat(40) },
          base: { ref: "main" },
          merged: true,
        },
      });
      const response = await ctx.api("POST", "/api/github/webhook", {
        apiKey: null,
        rawBody: body,
        headers: {
          "X-GitHub-Event": "pull_request",
          "X-Hub-Signature-256": hmacSignature(secret, body),
        },
      });
      expectStatus(response, [200], `pull_request closed webhook for #${number}`);
    };

    try {
      const rejected = await claim("Wait for a PR to merge");
      await withMcp(ctx, workerId, async (worker) => {
        const wake = { event: "vcs.pr.merged", source: "github", match: { repo, number: 1 } };
        await expectToolError(
          worker,
          "defer-task",
          { ...base(rejected), wakeOn: wake },
          "The github integration is off",
        );

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

        // Rejections: wrong shape, already merged, unreadable. None completes the task.
        await expectToolError(
          worker,
          "defer-task",
          { ...base(rejected), wakeOn: { ...wake, match: { repo } } },
          "takes repo (owner/name) and number only",
        );
        await expectToolError(
          worker,
          "defer-task",
          { ...base(rejected), wakeOn: { ...wake, source: "gitlab" } },
          'Source "gitlab" does not serve vcs.pr.merged',
        );
        await expectToolError(
          worker,
          "defer-task",
          { ...base(rejected), wakeOn: { event: "settled", taskId: rejected, source: "github" } },
          "take no source or match",
        );
        ctx.llm.setGithubPull(repo, 1, { merged: true });
        await expectToolError(
          worker,
          "defer-task",
          { ...base(rejected), wakeOn: wake },
          "already happened",
        );
        await expectToolError(
          worker,
          "defer-task",
          { ...base(rejected), wakeOn: { ...wake, match: { repo, number: 404 } } },
          "Could not read vcs.pr.merged",
        );
        expect(
          (await readTask(ctx, rejected)).status === "in_progress",
          "A rejected deferral must leave the task running",
        );

        // An open PR is accepted (the repo is matched case-insensitively).
        ctx.llm.setGithubPull(repo, 2, { merged: false });
        const waiter = await claim("Wait for PR 2");
        const deferred = await expectToolOk(worker, "defer-task", {
          ...base(waiter),
          wakeOn: {
            event: "vcs.pr.merged",
            source: "github",
            match: { repo: repo.toUpperCase(), number: 2 },
          },
        });
        const scheduleId = String(deferred.data.scheduleId);
        const pending = waitRow(ctx, scheduleId);
        expect(
          pending?.status === "pending" &&
            pending.source === "github" &&
            pending.event === "vcs.pr.merged",
          `PR wait row is wrong: ${JSON.stringify(pending)}`,
        );
        expect(
          String((await readTask(ctx, waiter)).output).includes(
            `Waiting on vcs.pr.merged on github (repo=${repo.toLowerCase()}, number=2)`,
          ),
          "The deferral card does not name the event",
        );

        // Negative control: a merged webhook for a PR GitHub still reports open wakes nobody.
        const reads = () => ctx.llm.requestsTo("/pulls/2").length;
        await pollUntil(() => reads() >= 2, 10_000); // defer's own post-commit recheck
        await Bun.sleep(300);
        const before = reads();
        await closedMerged(2);
        expect(
          await pollUntil(() => reads() > before, 10_000),
          "The webhook never made the server read GitHub",
        );
        await Bun.sleep(500);
        expect(
          waitRow(ctx, scheduleId)?.status === "pending" && !wakeTask(ctx, waiter),
          "An unconfirmed merged event woke the waiter",
        );

        // A caller cannot forge the provider event through the workflow-events API, even when
        // GitHub would confirm it: only the webhook ingest feeds provider names to the waits.
        ctx.llm.setGithubPull(repo, 2, { merged: true });
        for (const path of [
          "/api/workflow-events",
          `/api/workflow-runs/${crypto.randomUUID()}/events`,
        ]) {
          const forged = await ctx.api("POST", path, {
            body: {
              name: "github.pull_request.closed",
              payload: { repo, number: 2, merged: true },
            },
          });
          expectStatus(forged, [403], `forged provider event via ${path}`);
        }
        await Bun.sleep(500);
        expect(
          waitRow(ctx, scheduleId)?.status === "pending" && !wakeTask(ctx, waiter),
          "A forged provider event woke the waiter",
        );

        // Positive: GitHub confirms the merge, the real webhook wakes it.
        await closedMerged(2);
        expect(
          await pollUntil(() => waitRow(ctx, scheduleId)?.status === "fired", 15_000),
          "A confirmed merge never fired the wait",
        );
        const woke = wakeTask(ctx, waiter);
        expect(
          woke?.task.includes(
            `Wake-up cause: vcs.pr.merged on github (repo=${repo.toLowerCase()}, number=2)`,
          ),
          `Wake-up task is wrong: ${JSON.stringify(woke)}`,
        );
        expect(
          waitRow(ctx, scheduleId)?.firedBy === "external:github:vcs.pr.merged",
          "Wait was not fired by the github vcs.pr.merged event",
        );
        expect(
          ctx.db.get<{ enabled: number }>("SELECT enabled FROM scheduled_tasks WHERE id = ?", [
            scheduleId,
          ])?.enabled === 0,
          "The ceiling timer stayed enabled after the wake",
        );

        // The ceiling still wakes a PR wait, and marks it fired so it frees its cap slot.
        ctx.llm.setGithubPull(repo, 3, { merged: false });
        const capped = await claim("Wait for PR 3");
        const ceiling = await expectToolOk(worker, "defer-task", {
          ...base(capped),
          delayMs: 1500,
          wakeOn: { event: "vcs.pr.merged", source: "github", match: { repo, number: 3 } },
        });
        const ceilingId = String(ceiling.data.scheduleId);
        expect(
          await pollUntil(() => waitRow(ctx, ceilingId)?.status === "fired", 40_000, 500),
          "The ceiling never fired the PR wait",
        );
        expect(waitRow(ctx, ceilingId)?.firedBy === "ceiling", "Ceiling wake not recorded");
        expect(
          asRecord((await ctx.api("GET", `/api/tasks/${wakeTask(ctx, capped)?.id}`)).json).task !==
            undefined,
          "Ceiling wake-up task is missing",
        );
      });

      // A task-scoped token cannot register an event wait: the wait outlives the task that holds it.
      ctx.llm.setGithubPull(repo, 4, { merged: false });
      const tokenTask = await claim("Task token wait");
      const minted = await ctx.api("POST", "/api/sessions/tokens", {
        body: { agentId: workerId, taskId: tokenTask, ttlMs: 600_000 },
      });
      expectStatus(minted, [200, 201], "mint task-scoped token");
      const scoped = await ctx.connectMcp(workerId, {
        apiKey: String(asRecord(minted.json).plaintext),
        headers: { "X-Source-Task-Id": tokenTask },
      });
      try {
        await expectToolError(
          scoped,
          "defer-task",
          {
            ...base(tokenTask),
            wakeOn: { event: "vcs.pr.merged", source: "github", match: { repo, number: 4 } },
          },
          "task-scoped token",
        );
      } finally {
        await scoped.close();
      }
      expect(
        (await readTask(ctx, tokenTask)).status === "in_progress",
        "A refused task-token deferral must leave the task running",
      );

      // The per-agent cap: 20 pending waits, the 21st is refused, a timer-only defer still works.
      const capWorker = await registerWorker(ctx, "pr-wait-cap", { maxTasks: 25 });
      await withMcp(ctx, capWorker, async (worker) => {
        for (let n = 100; n < 120; n++) {
          ctx.llm.setGithubPull(repo, n, { merged: false });
          await expectToolOk(worker, "defer-task", {
            ...base(await claim(`Cap wait ${n}`, capWorker)),
            wakeOn: { event: "vcs.pr.merged", source: "github", match: { repo, number: n } },
          });
        }
        ctx.llm.setGithubPull(repo, 200, { merged: false });
        const over = await claim("Cap wait 21", capWorker);
        await expectToolError(
          worker,
          "defer-task",
          {
            ...base(over),
            wakeOn: { event: "vcs.pr.merged", source: "github", match: { repo, number: 200 } },
          },
          "already hold 20",
        );
        const held = ctx.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM deferred_event_waits w
             JOIN scheduled_tasks s ON s.id = w.scheduleId
            WHERE w.status = 'pending' AND s.targetAgentId = ?`,
          [capWorker],
        );
        expect(held?.n === 20, `Expected 20 pending waits for the agent, got ${held?.n}`);
        await expectToolOk(worker, "defer-task", base(over));
      });
    } finally {
      await cleanup.run();
      await reloadConfig(ctx);
    }
  },
};
