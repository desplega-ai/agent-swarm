// GitHub provider flows against `@emulators/github` (vercel-labs/emulate), a stateful GitHub.
//
// The emulator seeds an org repo, a maintainer, an outsider and a GitHub App installed on
// the org. The App's webhook URL is the SUT's `/api/github/webhook`, so every write below
// reaches the SUT the way GitHub delivers it: HMAC-signed, with the `installation` block.
// The API restarts once with App credentials and GITHUB_API_URL pointed at the emulator.
//   - inbound: a maintainer's mention in an issue comment and in a PR body become tasks;
//     an outsider's mention and a mention-free issue do not.
//   - installation token: the SUT mints it from the emulator with the App JWT, and the token
//     writes to the repo as the App's bot user (what a worker's `gh` call does).
//   - PR state: defer-task waits on `vcs.pr.merged`; a real merge in the emulator sends the
//     `closed` webhook, the SUT confirms the merge with a REST read, and the waiter wakes.
// Emulator gaps (no reactions route, no GraphQL, no repository rules, no combined commit
// status) are listed in the PR that added this file; nothing here hand-mocks them.
import { createEmulator } from "emulate";
import { type SqlQuery, sql } from "../db";
import { asRecord, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  claimTask,
  createAssignedTask,
  expectToolOk,
  registerWorker,
  withMcp,
} from "./core-helpers";

const APP_ID = 424_242;
const INSTALLATION_ID = 100;
const APP_SLUG = "e2e-swarm";
const ORG = "e2e-org";
const MENTION = "@agent-swarm-bot";

type TaskRow = { id: string; status: string; vcsEventType: string | null };

function webhookTasks(ctx: ScenarioContext, repo: string, where: SqlQuery) {
  return ctx.db.query<TaskRow>(
    sql`SELECT id, status, "vcsEventType" FROM agent_tasks WHERE source = 'github' AND "vcsRepo" = ${repo} AND ${where}`,
  );
}

export const githubEmulateFlows: Scenario = {
  name: "github-emulate-flows",
  order: 691,
  async run(ctx) {
    const repoName = `app-${ctx.nonce}`;
    const REPO = `${ORG}/${repoName}`;
    const maintainerToken = `gho_maint_${ctx.nonce}`;
    const outsiderToken = `gho_out_${ctx.nonce}`;
    const secret = `e2e-gh-emulate-${ctx.nonce}`;
    const emulator = await createEmulator({
      service: "github",
      port: 0,
      seed: {
        tokens: {
          [maintainerToken]: { login: "e2e-maint", scopes: ["repo", "admin:org"] },
          [outsiderToken]: { login: "e2e-outsider", scopes: ["public_repo"] },
        },
        github: {
          users: [{ login: "e2e-maint" }, { login: "e2e-outsider" }],
          orgs: [{ login: ORG, members: [{ login: "e2e-maint", role: "admin" }] }],
          repos: [{ owner: ORG, name: repoName, auto_init: true }],
          apps: [
            {
              app_id: APP_ID,
              slug: APP_SLUG,
              name: "E2E Swarm",
              // private_key omitted: the emulator generates one and returns it below.
              permissions: {
                contents: "write",
                issues: "write",
                pull_requests: "write",
                metadata: "read",
              },
              events: ["issues", "issue_comment", "pull_request"],
              webhook_url: `${ctx.baseUrl}/api/github/webhook`,
              webhook_secret: secret,
              installations: [
                { installation_id: INSTALLATION_ID, account: ORG, repository_selection: "all" },
              ],
            },
          ],
        },
      },
    });
    // The emulator binds 127.0.0.1; its advertised url says localhost.
    const origin = `http://127.0.0.1:${new URL(emulator.url).port}`;
    const privateKey = emulator.generatedSecrets.find((s) => s.value.includes("PRIVATE KEY"));
    expect(privateKey, "the emulator returned no generated App private key");

    const gh = async (method: string, path: string, token: string, body?: unknown) => {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      expect(response.ok, `emulator ${method} ${path} answered ${response.status}: ${text}`);
      return asRecord(text ? JSON.parse(text) : {});
    };

    const cleanupTasks: string[] = [];
    let workerId: string | undefined;
    try {
      await ctx.restartSut({
        env: {
          GITHUB_DISABLE: "false",
          GITHUB_API_URL: origin,
          GITHUB_APP_ID: String(APP_ID),
          GITHUB_APP_PRIVATE_KEY: privateKey.value,
          GITHUB_APP_INSTALLATION_ID: String(INSTALLATION_ID),
          GITHUB_WEBHOOK_SECRET: secret,
        },
      });

      // ── inbound: an issue without a mention creates nothing ──
      const issue = await gh("POST", `/repos/${REPO}/issues`, maintainerToken, {
        title: `Flaky deploy ${ctx.nonce}`,
        body: "No bot mention here.",
      });
      const issueNumber = Number(issue.number);

      // ── inbound: an outsider's mention is refused (author_association NONE) ──
      const outsider = await gh(
        "POST",
        `/repos/${REPO}/issues/${issueNumber}/comments`,
        outsiderToken,
        { body: `${MENTION} delete the repo ${ctx.nonce}` },
      );
      expect(
        outsider.author_association === "NONE",
        `the outsider's comment must carry author_association NONE: ${JSON.stringify(outsider)}`,
      );

      // ── inbound: the maintainer's mention becomes a task ──
      const comment = await gh(
        "POST",
        `/repos/${REPO}/issues/${issueNumber}/comments`,
        maintainerToken,
        { body: `${MENTION} please look at the deploy ${ctx.nonce}` },
      );
      const commentId = Number(comment.id);
      const created = await pollUntil(
        () => webhookTasks(ctx, REPO, sql`"vcsCommentId" = ${commentId}`).length === 1,
        15_000,
      );
      expect(created, `no task for the maintainer's comment ${commentId} on ${REPO}`);
      const [commentTask] = webhookTasks(ctx, REPO, sql`"vcsCommentId" = ${commentId}`);
      cleanupTasks.push(commentTask!.id);
      const row = ctx.db.get<{ vcsInstallationId: number | null; vcsNumber: number }>(
        sql`SELECT "vcsInstallationId", "vcsNumber" FROM agent_tasks WHERE id = ${commentTask!.id}`,
      );
      expect(
        commentTask!.vcsEventType === "issue_comment" &&
          row?.vcsNumber === issueNumber &&
          row.vcsInstallationId === INSTALLATION_ID,
        `the comment task must carry the event, issue and installation: ${JSON.stringify(row)}`,
      );
      // Webhooks arrive in write order, so by now the issue and outsider deliveries landed too.
      const others = webhookTasks(
        ctx,
        REPO,
        sql`"vcsNumber" = ${issueNumber} AND id != ${commentTask!.id}`,
      );
      expect(
        others.length === 0,
        `the mention-free issue and the outsider's comment must not create tasks: ${JSON.stringify(others)}`,
      );

      // ── installation token: minted from the emulator, writes as the App bot ──
      workerId = await registerWorker(ctx, "gh-emulate", { maxTasks: 5 });
      const minted = await ctx.api("POST", "/api/github/installation-token", {
        agentId: workerId,
        body: {},
      });
      expectStatus(minted, [200], "installation token from the emulator");
      const installationToken = asString(asRecord(minted.json).token, "installation token");
      const issued = await (await fetch(`${origin}/_emulate/installation-tokens`)).json();
      expect(
        JSON.stringify(issued).includes(String(INSTALLATION_ID)),
        `the emulator must record a token minted for installation ${INSTALLATION_ID}: ${JSON.stringify(issued)}`,
      );
      const botComment = await gh(
        "POST",
        `/repos/${REPO}/issues/${issueNumber}/comments`,
        installationToken,
        { body: `On it ${ctx.nonce}` },
      );
      expect(
        asRecord(botComment.user).login === `${APP_SLUG}[bot]`,
        `the installation token must write as ${APP_SLUG}[bot]: ${JSON.stringify(botComment.user)}`,
      );

      // ── PR opened with a mention: a pull_request task ──
      const repo = await gh("GET", `/repos/${REPO}`, maintainerToken);
      const base = String(repo.default_branch ?? "main");
      const baseRef = await gh("GET", `/repos/${REPO}/git/ref/heads/${base}`, maintainerToken);
      const branch = `fix/deploy-${ctx.nonce}`;
      await gh("POST", `/repos/${REPO}/git/refs`, maintainerToken, {
        ref: `refs/heads/${branch}`,
        sha: asRecord(baseRef.object).sha,
      });
      await gh("PUT", `/repos/${REPO}/contents/fix-${ctx.nonce}.txt`, maintainerToken, {
        message: "Fix the deploy",
        content: Buffer.from(`fixed ${ctx.nonce}\n`).toString("base64"),
        branch,
      });
      const pr = await gh("POST", `/repos/${REPO}/pulls`, maintainerToken, {
        title: `Fix the deploy ${ctx.nonce}`,
        body: `${MENTION} review this please`,
        head: branch,
        base,
      });
      const prNumber = Number(pr.number);
      const prTask = await pollUntil(
        () =>
          webhookTasks(
            ctx,
            REPO,
            sql`"vcsNumber" = ${prNumber} AND "vcsEventType" = 'pull_request'`,
          ).length === 1,
        15_000,
      );
      expect(prTask, `no task for PR #${prNumber} opened with a mention`);
      for (const task of webhookTasks(ctx, REPO, sql`"vcsNumber" = ${prNumber}`))
        cleanupTasks.push(task.id);

      // ── PR state: a real merge wakes a vcs.pr.merged waiter ──
      const waiter = await createAssignedTask(
        ctx,
        workerId,
        `Wait for PR ${prNumber} ${ctx.nonce}`,
      );
      cleanupTasks.push(waiter);
      await claimTask(ctx, workerId, waiter);
      const scheduleId = await withMcp(ctx, workerId, async (worker) => {
        const deferred = await expectToolOk(worker, "defer-task", {
          taskId: waiter,
          summary: `Opened PR ${prNumber} ${ctx.nonce}`,
          note: `Check the merge ${ctx.nonce}`,
          delayMs: 3_600_000,
          wakeOn: {
            event: "vcs.pr.merged",
            source: "github",
            match: { repo: REPO, number: prNumber },
          },
        });
        return String(deferred.data.scheduleId);
      });
      const waitStatus = () =>
        ctx.db.get<{ status: string; firedBy: string | null }>(
          sql`SELECT status, "firedBy" FROM deferred_event_waits WHERE "scheduleId" = ${scheduleId}`,
        );
      expect(
        waitStatus()?.status === "pending",
        `an open PR in the emulator must leave the wait pending: ${JSON.stringify(waitStatus())}`,
      );

      await gh("PUT", `/repos/${REPO}/pulls/${prNumber}/merge`, maintainerToken, {
        merge_method: "squash",
      });
      const woke = await pollUntil(() => waitStatus()?.status === "fired", 15_000);
      expect(woke, `the merge never fired the wait: ${JSON.stringify(waitStatus())}`);
      const wake = ctx.db.get<{ id: string }>(
        sql`SELECT id FROM agent_tasks WHERE "parentTaskId" = ${waiter} AND "taskType" = 'deferred'`,
      );
      expect(wake, "the fired wait created no wake-up task");
      cleanupTasks.push(wake.id);
    } finally {
      for (const id of cleanupTasks) {
        await ctx.api("POST", `/api/tasks/${id}/cancel`, { body: { reason: "e2e cleanup" } });
      }
      if (workerId) await ctx.api("POST", "/close", { agentId: workerId, body: {} });
      // Boot the base env again, without the App credentials.
      await ctx.restartSut();
      await emulator.close();
    }
  },
};
