import { asRecord, asRecords, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { cleanupStack, hmacSignature, putConfig, reloadConfig } from "./platform-helpers";
import { createWorkflow, deleteWorkflowQuietly, type WorkflowDef } from "./workflow-helpers";

// Workflow `event` triggers fed by the GitHub and Jira webhooks. Every trigger name starts a run
// from a verified delivery whose payload passes the trigger's `match` fields; a delivery that
// misses a match field (other repo, label, assignee, project or status), or a GitHub comment
// that is not a creation, starts none. A redelivery (same X-GitHub-Delivery or
// X-Atlassian-Webhook-Identifier), sequential or concurrent, starts one run.

const DEFINITION: WorkflowDef = {
  nodes: [{ id: "done", type: "script", config: { runtime: "bash", script: "echo done" } }],
};

async function runsByDelivery(ctx: ScenarioContext, workflowId: string) {
  const response = await ctx.api("GET", `/api/workflows/${workflowId}/runs?limit=100`);
  expectStatus(response, [200], `list runs for ${workflowId}`);
  const byDelivery = new Map<string, Record<string, unknown>[]>();
  for (const run of asRecords(response.json, "runs")) {
    const data = asRecord(run.triggerData ?? {});
    const id = String(data.delivery_id ?? "");
    byDelivery.set(id, [...(byDelivery.get(id) ?? []), data]);
  }
  return byDelivery;
}

export const workflowGithubJiraEventTriggers: Scenario = {
  name: "workflow-github-jira-event-triggers",
  order: 334,
  async run(ctx) {
    const cleanup = cleanupStack(ctx);
    const secret = `gh-secret-${ctx.nonce}`;
    const jiraToken = `jira-token-${ctx.nonce}`;
    const repo = `e2e-org/triggers-${ctx.nonce}`;
    const project = `E2E${ctx.nonce
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 6)
      .toUpperCase()}`;

    const github = async (event: string, payload: Record<string, unknown>, delivery: string) => {
      const body = JSON.stringify({ sender: { login: "alice" }, ...payload });
      const response = await ctx.api("POST", "/api/github/webhook", {
        apiKey: null,
        rawBody: body,
        headers: {
          "X-GitHub-Event": event,
          "X-GitHub-Delivery": delivery,
          "X-Hub-Signature-256": hmacSignature(secret, body),
        },
      });
      expectStatus(response, [200], `GitHub ${event} webhook ${delivery}`);
    };
    const jira = async (payload: Record<string, unknown>, identifier: string) => {
      const response = await ctx.api("POST", `/api/trackers/jira/webhook/${jiraToken}`, {
        apiKey: null,
        body: { timestamp: Date.now(), ...payload },
        headers: { "X-Atlassian-Webhook-Identifier": identifier },
      });
      expectStatus(response, [200], `Jira ${String(payload.webhookEvent)} webhook ${identifier}`);
    };

    try {
      for (const [key, value] of [
        ["GITHUB_DISABLE", "false"],
        ["GITHUB_WEBHOOK_SECRET", secret],
        ["JIRA_WEBHOOK_TOKEN", jiraToken],
      ] as const) {
        const row = await putConfig(ctx, { key, value, isSecret: key !== "GITHUB_DISABLE" });
        cleanup.add(`delete ${key}`, async () => {
          await ctx.api("DELETE", `/api/config/${String(row.id)}`);
        });
      }
      await reloadConfig(ctx);

      // A match field must belong to the event's family.
      for (const trigger of [
        { type: "event", eventName: "jira.issue.assigned", match: { repo } },
        { type: "event", eventName: "github.pull_request.opened", match: { status: "Done" } },
        { type: "event", eventName: "slack.message", match: { label: "bug" } },
      ]) {
        const rejected = await ctx.api("POST", "/api/workflows", {
          body: { name: `bad-match-${ctx.nonce}`, definition: DEFINITION, triggers: [trigger] },
        });
        expectStatus(
          rejected,
          [400],
          `reject ${trigger.eventName} with ${JSON.stringify(trigger.match)}`,
        );
      }

      const githubEvents = [
        "github.pull_request.opened",
        "github.pull_request.ready_for_review",
        "github.pull_request.synchronize",
        "github.pull_request.closed",
        "github.issue.opened",
        "github.issue_comment.created",
        "github.check_suite.completed",
      ];
      const githubId = await createWorkflow(ctx, "github-event-triggers", DEFINITION, {
        triggers: [
          ...githubEvents.map((eventName) => ({ type: "event", eventName, match: { repo } })),
          { type: "event", eventName: "github.issue.assigned", match: { repo, assignee: "Alice" } },
          { type: "event", eventName: "github.issue.labeled", match: { repo, label: "bug" } },
        ],
      });
      cleanup.add("delete github workflow", () => deleteWorkflowQuietly(ctx, githubId));
      const jiraId = await createWorkflow(ctx, "jira-event-triggers", DEFINITION, {
        triggers: [
          { type: "event", eventName: "jira.issue.commented", match: { project } },
          {
            type: "event",
            eventName: "jira.issue.assigned",
            match: { project, assignee: "acc-alice" },
          },
          {
            type: "event",
            eventName: "jira.issue.transitioned",
            match: { project, status: "done" },
          },
        ],
      });
      cleanup.add("delete jira workflow", () => deleteWorkflowQuietly(ctx, jiraId));

      const repository = { full_name: repo, html_url: `https://github.com/${repo}` };
      const pr = (action: string, repoOverride = repository) => ({
        action,
        repository: repoOverride,
        pull_request: {
          number: 7,
          title: `PR ${ctx.nonce}`,
          body: null,
          html_url: `https://github.com/${repo}/pull/7`,
          user: { login: "alice" },
          head: { ref: "feature", sha: "a".repeat(40) },
          base: { ref: "main" },
          merged: action === "closed",
          labels: [{ name: "bug" }],
          assignees: [],
        },
      });
      const issue = (action: string, extra: Record<string, unknown> = {}) => ({
        action,
        repository,
        issue: {
          number: 8,
          title: `Issue ${ctx.nonce}`,
          body: "body",
          html_url: `https://github.com/${repo}/issues/8`,
          user: { login: "alice" },
          labels: [{ name: "triage" }],
          assignees: [],
        },
        ...extra,
      });
      const comment = (action: string) => ({
        action,
        repository,
        issue: { number: 8, title: `Issue ${ctx.nonce}`, html_url: "https://example.test/8" },
        comment: {
          id: 99,
          body: "looks good",
          html_url: "https://example.test/8#c99",
          user: { login: "bob" },
        },
      });
      const checkSuite = {
        action: "completed",
        repository,
        check_suite: {
          id: 5,
          status: "completed",
          conclusion: "failure",
          head_sha: "b".repeat(40),
          head_branch: "feature",
          pull_requests: [{ number: 7, head: { sha: "b".repeat(40) } }],
        },
      };

      const d = (label: string) => `${label}-${ctx.nonce}`;
      // Starts: one delivery per trigger name, with the payload field the run should see.
      const githubHits: Array<[string, string, Record<string, unknown>, Record<string, unknown>]> =
        [
          [
            d("pr-opened"),
            "pull_request",
            pr("opened"),
            { action: "opened", head_sha: "a".repeat(40) },
          ],
          [d("pr-ready"), "pull_request", pr("ready_for_review"), { action: "ready_for_review" }],
          [d("pr-sync"), "pull_request", pr("synchronize"), { action: "synchronize" }],
          [d("pr-closed"), "pull_request", pr("closed"), { action: "closed", merged: true }],
          [d("issue-opened"), "issues", issue("opened"), { action: "opened", number: 8 }],
          [
            d("issue-assigned"),
            "issues",
            issue("assigned", { assignee: { login: "alice", id: 1 } }),
            { assigned_to: "alice" },
          ],
          [
            d("issue-labeled"),
            "issues",
            issue("labeled", { label: { id: 1, name: "bug", color: "f00" } }),
            { label: "bug" },
          ],
          [
            d("comment"),
            "issue_comment",
            comment("created"),
            { comment: "looks good", user_login: "bob" },
          ],
          [
            d("check-suite"),
            "check_suite",
            checkSuite,
            { conclusion: "failure", pull_requests: [7] },
          ],
        ];
      // Misses: a match field does not hold, or the comment action is not `created`.
      const githubMisses: Array<[string, string, Record<string, unknown>]> = [
        [
          d("pr-other-repo"),
          "pull_request",
          pr("opened", { full_name: `${repo}-other`, html_url: "https://example.test" }),
        ],
        [
          d("issue-assigned-bob"),
          "issues",
          issue("assigned", { assignee: { login: "bob", id: 2 } }),
        ],
        [
          d("issue-labeled-other"),
          "issues",
          issue("labeled", { label: { id: 2, name: "triage", color: "0f0" } }),
        ],
        [d("comment-edited"), "issue_comment", comment("edited")],
      ];

      for (const [delivery, event, payload] of githubMisses) await github(event, payload, delivery);
      for (const [delivery, event, payload] of githubHits) await github(event, payload, delivery);
      // Redelivery: once in sequence, twice concurrently.
      await github("pull_request", pr("opened"), d("pr-opened"));
      await Promise.all([
        github("issues", issue("opened"), d("issue-opened")),
        github("issues", issue("opened"), d("issue-opened")),
      ]);

      const jiraIssue = (projectKey = project) => ({
        id: `100-${ctx.nonce}`,
        key: `${projectKey}-1`,
        fields: {
          summary: `Jira ${ctx.nonce}`,
          project: { key: projectKey },
          labels: ["backend"],
          status: { name: "Done" },
        },
      });
      const user = { accountId: "acc-bob", displayName: "Bob Roe" };
      const assigned = (to: string, toName: string, projectKey = project) => ({
        webhookEvent: "jira:issue_updated",
        user,
        issue: jiraIssue(projectKey),
        changelog: {
          items: [{ field: "assignee", from: null, fromString: null, to, toString: toName }],
        },
      });
      const transitioned = (toName: string) => ({
        webhookEvent: "jira:issue_updated",
        user,
        issue: jiraIssue(),
        changelog: {
          items: [{ field: "status", from: "1", fromString: "To Do", to: "3", toString: toName }],
        },
      });
      const commented = {
        webhookEvent: "comment_created",
        issue: jiraIssue(),
        comment: {
          id: "c1",
          body: "Ship it",
          author: { accountId: "acc-bob", displayName: "Bob Roe" },
        },
      };
      const jiraHits: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
        [d("jira-assigned"), assigned("acc-alice", "Alice Doe"), { assigned_to: "Alice Doe" }],
        [
          d("jira-transitioned"),
          transitioned("Done"),
          { status: "Done", previous_status: "To Do" },
        ],
        [d("jira-commented"), commented, { comment: "Ship it", user_login: "Bob Roe" }],
      ];
      const jiraMisses: Array<[string, Record<string, unknown>]> = [
        [d("jira-assigned-bob"), assigned("acc-bob", "Bob Roe")],
        [d("jira-assigned-other-project"), assigned("acc-alice", "Alice Doe", "OTHER")],
        [d("jira-transitioned-wip"), transitioned("In Progress")],
      ];
      for (const [identifier, payload] of jiraMisses) await jira(payload, identifier);
      for (const [identifier, payload] of jiraHits) await jira(payload, identifier);
      // Atlassian retry: same identifier, a later timestamp.
      await jira(assigned("acc-alice", "Alice Doe"), d("jira-assigned"));

      const expectRuns = async (
        workflowId: string,
        hits: Array<[string, Record<string, unknown>]>,
        misses: string[],
        label: string,
      ) => {
        let runs = new Map<string, Record<string, unknown>[]>();
        const started = await pollUntil(async () => {
          runs = await runsByDelivery(ctx, workflowId);
          return hits.every(([delivery]) => runs.has(delivery));
        }, 15_000);
        const missing = hits.filter(([delivery]) => !runs.has(delivery)).map(([id]) => id);
        expect(started, `${label}: no run for ${missing.join(", ")}`);
        // Late duplicates or misses would land in this window.
        await pollUntil(async () => false, 1_000);
        runs = await runsByDelivery(ctx, workflowId);
        for (const [delivery, fields] of hits) {
          const found = runs.get(delivery) ?? [];
          expect(found.length === 1, `${label}: ${delivery} started ${found.length} runs, want 1`);
          for (const [field, value] of Object.entries(fields)) {
            expect(
              JSON.stringify(found[0]?.[field]) === JSON.stringify(value),
              `${label}: ${delivery} triggerData.${field} = ${JSON.stringify(found[0]?.[field])}, want ${JSON.stringify(value)}`,
            );
          }
        }
        for (const delivery of misses) {
          expect(!runs.has(delivery), `${label}: ${delivery} must not start a run`);
        }
        const total = [...runs.values()].reduce((sum, list) => sum + list.length, 0);
        expect(total === hits.length, `${label}: ${total} runs, want ${hits.length}`);
      };

      await expectRuns(
        githubId,
        githubHits.map(([delivery, , , fields]) => [delivery, { repo, ...fields }]),
        githubMisses.map(([delivery]) => delivery),
        "GitHub",
      );
      await expectRuns(
        jiraId,
        jiraHits.map(([delivery, , fields]) => [
          delivery,
          { project, issue_key: `${project}-1`, ...fields },
        ]),
        jiraMisses.map(([delivery]) => delivery),
        "Jira",
      );
    } finally {
      await cleanup.run();
    }
  },
};
