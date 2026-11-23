import { asRecord, createApiClient, expect, expectStatus, pollUntil } from "../http";
import { createMcpConnector } from "../mcp";
import type { Scenario } from "../run";
import { startSut, stopSut } from "../sut";
import { hmacSignature } from "./platform-helpers";

// A pool claim notifies the task-started subscribers (the GitHub 👀 reaction) once, after
// the claim commits. The API runs with STORAGE_TX_REPLAY=1, so every transaction callback
// runs twice and the first run rolls back: a claim that notifies inside the transaction
// reacts twice. A stub GitHub API counts the reactions.
export const taskStartedAfterCommit: Scenario = {
  name: "task-started-after-commit",
  order: 9_030,
  async run(ctx) {
    const reactions: string[] = [];
    const github = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === "POST" && path.endsWith("/reactions")) reactions.push(path);
        return Response.json({ id: 1, content: "eyes" }, { status: 201 });
      },
    });
    const secret = `e2e-started-${ctx.nonce}`;
    const sut = await startSut(
      false,
      { SLACK_DISABLE: "true" },
      {
        STORAGE_TX_REPLAY: "1",
        GITHUB_DISABLE: "false",
        GITHUB_WEBHOOK_SECRET: secret,
        GITHUB_API_URL: `http://127.0.0.1:${github.port}`,
        GITHUB_TOKEN: `ghp_e2e_${ctx.nonce}`,
      },
      undefined,
      ctx.db.engine,
    );
    try {
      const api = createApiClient(sut.baseUrl, sut.apiKey);
      const commentId = 8_100_000 + Math.floor(Math.random() * 100_000);
      const body = JSON.stringify({
        action: "created",
        comment: {
          id: commentId,
          body: `@agent-swarm-bot take a look ${ctx.nonce}`,
          html_url: `https://github.com/e2e/repo/issues/1#issuecomment-${commentId}`,
          user: { login: `gh-member-${ctx.nonce}` },
          author_association: "MEMBER",
        },
        issue: { number: 1, title: "e2e", html_url: "https://github.com/e2e/repo/issues/1" },
        repository: { full_name: `e2e/repo-${ctx.nonce}`, html_url: "https://github.com/e2e/repo" },
        sender: { login: `gh-member-${ctx.nonce}` },
      });
      const created = await api("POST", "/api/github/webhook", {
        apiKey: null,
        rawBody: body,
        headers: {
          "X-GitHub-Event": "issue_comment",
          "X-Hub-Signature-256": hmacSignature(secret, body),
        },
      });
      expectStatus(created, [200], "issue_comment webhook");
      const taskId = asRecord(created.json).taskId;
      expect(typeof taskId === "string", `the mention opened no task: ${created.text}`);
      const target = `/repos/e2e/repo-${ctx.nonce}/issues/comments/${commentId}/reactions`;
      const count = () => reactions.filter((path) => path === target).length;
      // The webhook reacts once when it creates the task (no lead: the task is in the pool).
      expect(await pollUntil(() => count() === 1, 15_000), `creation reactions: ${count()}`);

      const agentId = crypto.randomUUID();
      const registered = await api("POST", "/api/agents", {
        agentId,
        body: { name: `started-worker-${ctx.nonce}`, role: "worker", status: "online" },
      });
      expectStatus(registered, [200, 201], "register a worker");
      // The API subscribes the GitHub reaction to task start when it builds its first MCP
      // server, as a worker's session does.
      const mcp = await createMcpConnector(sut.baseUrl, sut.apiKey)(agentId);
      await mcp.close();
      const claimed = await pollUntil(async () => {
        const polled = await api("GET", "/api/poll", { agentId });
        expectStatus(polled, [200], "poll");
        const trigger = asRecord(polled.json).trigger as Record<string, unknown> | null;
        return trigger?.taskId === taskId;
      }, 20_000);
      expect(claimed, `the worker never claimed ${String(taskId)}`);

      // One reaction for the claim. Give a second one time to land before counting.
      expect(await pollUntil(() => count() >= 2, 15_000), "the claim added no reaction");
      await Bun.sleep(2_000);
      expect(
        count() === 2,
        `expected 2 reactions (task created, task started), got ${count()}: the claim notified inside its transaction`,
      );
    } finally {
      await stopSut(sut, false);
      github.stop(true);
    }
  },
};
