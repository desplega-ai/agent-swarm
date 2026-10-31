import type { ApiResponse } from "../http";
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  Cleanup,
  callTool,
  expectToolError,
  expectToolOk,
  registerWorker,
} from "./platformb-helpers";

type TrackerCall = {
  method: string;
  path: string;
  /** The routes that skip the operator key (`auth: { apiKey: false }`) answer without it. */
  public?: boolean;
  body?: unknown;
  status: number;
  /** Substring of the JSON `error`. */
  error: string;
};

async function expectDisabled(ctx: ScenarioContext, call: TrackerCall): Promise<ApiResponse> {
  const label = `${call.method} ${call.path}`;
  const response = await ctx.api(call.method, call.path, {
    body: call.body,
    // A public route is called with no key at all: that is how a provider calls it.
    apiKey: call.public ? null : undefined,
  });
  expectStatus(response, [call.status], label);
  const error = asRecord(response.json).error;
  expect(
    typeof error === "string" && error.includes(call.error),
    `${label}: error is ${JSON.stringify(error)}, expected "${call.error}"`,
  );
  return response;
}

/**
 * Linear and Jira are disabled in the SUT (LINEAR_DISABLE / JIRA_DISABLE), so every provider route
 * answers its documented unconfigured contract: 503 for the OAuth, status, refresh, disconnect and
 * webhook-admin routes, 503 for a webhook with no signing secret, 400 for a callback whose state
 * the API never issued, and 401 for the key-protected routes without a key. The tracker tools do
 * not need a provider: they keep sync mappings and agent mappings in the database.
 */
export const platformbTrackers: Scenario = {
  name: "platformb-trackers",
  order: 655,
  async run(ctx) {
    // --- HTTP: the disabled contract on every provider route, Linear then Jira.
    const linearNotConfigured = "Linear integration not configured";
    const jiraNotConfigured = "Jira integration not configured";
    const calls: TrackerCall[] = [
      {
        method: "GET",
        path: "/api/trackers/linear/status",
        status: 503,
        error: linearNotConfigured,
      },
      {
        method: "POST",
        path: "/api/trackers/linear/refresh",
        status: 503,
        error: linearNotConfigured,
      },
      {
        method: "DELETE",
        path: "/api/trackers/linear/disconnect",
        status: 503,
        error: linearNotConfigured,
      },
      {
        method: "GET",
        path: "/api/trackers/linear/authorize",
        public: true,
        status: 503,
        error: linearNotConfigured,
      },
      {
        method: "GET",
        path: `/api/trackers/linear/callback?code=e2e-${ctx.nonce}&state=never-issued-${ctx.nonce}`,
        public: true,
        status: 400,
        error: "Invalid or expired OAuth state",
      },
      {
        method: "GET",
        path: "/api/trackers/linear/callback",
        public: true,
        status: 400,
        error: "Validation error",
      },
      {
        // No LINEAR_SIGNING_SECRET: the webhook cannot verify a signature, so it never accepts.
        method: "POST",
        path: "/api/trackers/linear/webhook",
        public: true,
        body: { type: "Issue", action: "update", data: { id: `e2e-${ctx.nonce}` } },
        status: 503,
        error: "Linear webhook not configured",
      },
      { method: "GET", path: "/api/trackers/jira/status", status: 503, error: jiraNotConfigured },
      { method: "POST", path: "/api/trackers/jira/refresh", status: 503, error: jiraNotConfigured },
      {
        method: "DELETE",
        path: "/api/trackers/jira/disconnect",
        status: 503,
        error: jiraNotConfigured,
      },
      {
        method: "GET",
        path: "/api/trackers/jira/authorize",
        public: true,
        status: 503,
        error: jiraNotConfigured,
      },
      {
        method: "GET",
        path: `/api/trackers/jira/callback?code=e2e-${ctx.nonce}&state=never-issued-${ctx.nonce}`,
        public: true,
        status: 400,
        error: "Invalid or expired OAuth state",
      },
      {
        method: "GET",
        path: "/api/trackers/jira/callback?code=only-a-code",
        public: true,
        status: 400,
        error: "Validation error",
      },
      {
        method: "POST",
        path: "/api/trackers/jira/webhook-register",
        body: { jqlFilter: "project = E2E" },
        status: 503,
        error: jiraNotConfigured,
      },
      {
        method: "DELETE",
        path: "/api/trackers/jira/webhook/4242",
        status: 503,
        error: jiraNotConfigured,
      },
      {
        // No JIRA_WEBHOOK_TOKEN: the URL token cannot be checked, so the handler is not configured.
        method: "POST",
        path: `/api/trackers/jira/webhook/e2e-token-${ctx.nonce}`,
        public: true,
        body: { webhookEvent: "jira:issue_updated" },
        status: 503,
        error: "Jira webhook handler not configured",
      },
    ];
    for (const call of calls) await expectDisabled(ctx, call);

    // The routes that do need the operator key refuse a request without it.
    for (const [method, path] of [
      ["GET", "/api/trackers/linear/status"],
      ["POST", "/api/trackers/linear/refresh"],
      ["DELETE", "/api/trackers/linear/disconnect"],
      ["GET", "/api/trackers/jira/status"],
      ["POST", "/api/trackers/jira/refresh"],
      ["POST", "/api/trackers/jira/webhook-register"],
      ["DELETE", "/api/trackers/jira/webhook/4242"],
      ["DELETE", "/api/trackers/jira/disconnect"],
    ] as const) {
      expectStatus(
        await ctx.api(method, path, { apiKey: null, body: method === "POST" ? {} : undefined }),
        [401],
        `${method} ${path} without a key`,
      );
    }

    // --- MCP: sync mappings and agent mappings do not depend on a provider.
    const cleanup = new Cleanup();
    const syncIds: string[] = [];
    let connection: Awaited<ReturnType<ScenarioContext["connectMcp"]>> | undefined;
    cleanup.add("close MCP", async () => {
      await connection?.close();
    });
    cleanup.add("unlink leftover syncs", async () => {
      if (!connection) return;
      for (const syncId of syncIds) await callTool(connection, "tracker-unlink", { syncId });
    });

    await cleanup.around(async () => {
      const workerId = await registerWorker(ctx, `e2e-platformb-tracker-${ctx.nonce}`);
      connection = await ctx.connectMcp(workerId);
      // Not linear or jira: those names would put these rows on a provider the server may sync.
      const provider = `e2e-tracker-${ctx.nonce}`;

      let outcome = expectToolOk(await callTool(connection, "tracker-status"), "tracker-status");
      const trackers = asRecords(outcome.data, "trackers");
      expect(
        trackers.map((tracker) => tracker.provider).join(",") === "linear,jira",
        `tracker-status lists ${trackers.map((tracker) => tracker.provider).join(",")}`,
      );
      for (const tracker of trackers) {
        expect(
          tracker.connected === false && tracker.tokenExpiresAt === null,
          `Disabled tracker ${String(tracker.provider)} reports a connection`,
        );
      }
      expect(
        outcome.message === "Tracker status: linear: not connected, jira: not connected",
        `tracker-status message is ${outcome.message}`,
      );
      expect(outcome.text.includes("provider: jira"), "tracker-status details omit jira");

      // --- link a task
      const created = await ctx.api("POST", "/api/tasks", {
        body: { task: `tracker link target ${ctx.nonce}`, source: "api" },
      });
      expectStatus(created, [201], "create a task to link");
      const taskId = asString(asRecord(created.json).id, "task id");
      const externalId = `EXT-${ctx.nonce}`;
      outcome = expectToolOk(
        await callTool(connection, "tracker-link-task", {
          provider,
          swarmTaskId: taskId,
          externalId,
          externalIdentifier: `E2E-${ctx.nonce.slice(0, 4)}`,
          externalUrl: `https://tracker.example.invalid/${externalId}`,
        }),
        "tracker-link-task",
      );
      const sync = asRecord(outcome.data.sync);
      const syncId = asString(sync.id, "sync id");
      syncIds.push(syncId);
      expect(
        sync.provider === provider &&
          sync.entityType === "task" &&
          sync.swarmId === taskId &&
          sync.externalId === externalId &&
          sync.syncDirection === "bidirectional",
        `tracker-link-task returned ${JSON.stringify(sync)}`,
      );
      expect(
        outcome.message.includes(`Linked task ${taskId} to ${provider} issue`),
        `Link message is ${outcome.message}`,
      );
      const row = ctx.db.get<{ swarmId: string; externalUrl: string; syncDirection: string }>(
        "SELECT swarmId, externalUrl, syncDirection FROM tracker_sync WHERE id = ?",
        [syncId],
      );
      expect(
        row?.swarmId === taskId &&
          row.externalUrl === `https://tracker.example.invalid/${externalId}` &&
          row.syncDirection === "bidirectional",
        `tracker_sync row is ${JSON.stringify(row)}`,
      );
      // The same task or the same external issue cannot be linked twice for one provider.
      expectToolError(
        await callTool(connection, "tracker-link-task", {
          provider,
          swarmTaskId: taskId,
          externalId: `EXT-other-${ctx.nonce}`,
        }),
        "Failed to link task",
        "link the same task twice",
      );
      expectToolError(
        await callTool(connection, "tracker-link-task", {
          provider,
          swarmTaskId: `${taskId}-other`,
          externalId,
        }),
        "Failed to link task",
        "link the same external issue twice",
      );
      expect(
        (await callTool(connection, "tracker-link-task", { provider })).isError,
        "tracker-link-task accepted a call with no task or external id",
      );

      // --- sync status, with and without filters
      outcome = expectToolOk(
        await callTool(connection, "tracker-sync-status", { provider, entityType: "task" }),
        "tracker-sync-status by provider",
      );
      let syncs = outcome.data.syncs;
      expect(Array.isArray(syncs), "tracker-sync-status has no syncs array");
      expect(
        outcome.data.count === 1 && asRecord(syncs[0]).id === syncId,
        `tracker-sync-status by provider returned ${JSON.stringify(syncs)}`,
      );
      expect(
        outcome.message.includes(`for ${provider}`) && outcome.message.includes("(task)"),
        `Sync status message is ${outcome.message}`,
      );
      outcome = expectToolOk(await callTool(connection, "tracker-sync-status"), "unfiltered");
      syncs = outcome.data.syncs;
      expect(
        Array.isArray(syncs) && syncs.some((entry) => asRecord(entry).id === syncId),
        "Unfiltered tracker-sync-status omits the link",
      );
      outcome = expectToolOk(
        await callTool(connection, "tracker-sync-status", { provider: `${provider}-none` }),
        "tracker-sync-status for an unknown provider",
      );
      expect(outcome.data.count === 0, "An unknown provider has sync mappings");

      // --- map an agent
      outcome = expectToolOk(
        await callTool(connection, "tracker-map-agent", {
          provider,
          agentId: workerId,
          externalUserId: `user-${ctx.nonce}`,
          agentName: `Mapped ${ctx.nonce}`,
        }),
        "tracker-map-agent",
      );
      const mapping = asRecord(outcome.data.mapping);
      expect(
        mapping.provider === provider &&
          mapping.agentId === workerId &&
          mapping.externalUserId === `user-${ctx.nonce}` &&
          mapping.agentName === `Mapped ${ctx.nonce}`,
        `tracker-map-agent returned ${JSON.stringify(mapping)}`,
      );
      expect(
        ctx.db.get<{ agentName: string }>(
          "SELECT agentName FROM tracker_agent_mapping WHERE provider = ? AND agentId = ?",
          [provider, workerId],
        )?.agentName === `Mapped ${ctx.nonce}`,
        "Agent mapping is not in tracker_agent_mapping",
      );
      expectToolError(
        await callTool(connection, "tracker-map-agent", {
          provider,
          agentId: workerId,
          externalUserId: `user-other-${ctx.nonce}`,
          agentName: "Again",
        }),
        "Failed to map agent",
        "map the same agent twice",
      );
      expectToolError(
        await callTool(connection, "tracker-map-agent", {
          provider,
          agentId: `${workerId}-other`,
          externalUserId: `user-${ctx.nonce}`,
          agentName: "Same user",
        }),
        "Failed to map agent",
        "map the same external user twice",
      );

      // --- unlink
      expectToolOk(await callTool(connection, "tracker-unlink", { syncId }), "tracker-unlink");
      expect(
        ctx.db.get("SELECT id FROM tracker_sync WHERE id = ?", [syncId]) === null,
        "tracker-unlink left the tracker_sync row",
      );
      outcome = expectToolOk(
        await callTool(connection, "tracker-sync-status", { provider }),
        "sync status after unlink",
      );
      expect(outcome.data.count === 0, "Unlinked mapping still listed");
      expectToolError(
        await callTool(connection, "tracker-unlink", { syncId }),
        `No tracker mapping ${syncId}`,
        "tracker-unlink of a removed mapping",
      );
      syncIds.length = 0;
      // The task can be linked again once the old mapping is gone.
      outcome = expectToolOk(
        await callTool(connection, "tracker-link-task", {
          provider,
          swarmTaskId: taskId,
          externalId: `EXT-again-${ctx.nonce}`,
        }),
        "relink after unlink",
      );
      syncIds.push(asString(asRecord(outcome.data.sync).id, "second sync id"));

      expectStatus(
        await ctx.api("POST", `/api/tasks/${taskId}/cancel`, { body: {} }),
        [200],
        "cancel the linked task",
      );
    });
  },
};
