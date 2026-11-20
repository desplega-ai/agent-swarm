// Linear provider flows against `@emulators/linear` (vercel-labs/emulate), a stateful Linear
// GraphQL API with OAuth and signed webhooks.
//
// The API restarts once with LINEAR_URL / LINEAR_API_URL pointed at the emulator, whose
// webhook targets the SUT's `/api/trackers/linear/webhook`. A human user drives the emulator
// with a personal token, the way a person drives Linear:
//   - OAuth: the consent page, the `actor=app` install, the code exchange, a forced
//     refresh, and disconnect with revoke.
//   - inbound: delegating a Todo issue to the app user sends `AgentSessionEvent.created`;
//     the SUT reads the issue state over GraphQL, creates a task and acknowledges the
//     session. A Backlog issue is gated: no task, and the session ends with the reason.
//   - outbound: completing the task ends the session with a `response` activity that
//     carries the task output.
//   - status sync: moving a tracked issue to Canceled sends `Issue.update`; the task is
//     cancelled.
import { createEmulator } from "emulate";
import { sql } from "../db";
import { asRecord, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { claimTask, expectToolOk, registerLead, retireAgent, withMcp } from "./core-helpers";

const LINEAR_SCOPES = [
  "read",
  "write",
  "issues:create",
  "comments:create",
  "app:assignable",
  "app:mentionable",
];
/** The outbound sync skips a write within 5 s of an inbound webhook (loop prevention). */
const LOOP_PREVENTION_WINDOW_MS = 5_000;

type Activity = { type: string; body: string };
type Session = { id: string; issue: { id: string } | null; activities: { nodes: Activity[] } };

function syncedTask(ctx: ScenarioContext, issueId: string) {
  return ctx.db.get<{ swarmId: string; lastSyncedAt: string }>(
    sql`SELECT "swarmId", "lastSyncedAt" FROM tracker_sync WHERE provider = 'linear' AND "entityType" = 'task' AND "externalId" = ${issueId}`,
  );
}

function hiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const name = match[0].match(/name="([^"]*)"/)?.[1];
    const value = match[0].match(/value="([^"]*)"/)?.[1] ?? "";
    if (name) fields[name] = value.replaceAll("&amp;", "&").replaceAll("&quot;", '"');
  }
  return fields;
}

export const linearEmulateFlows: Scenario = {
  name: "linear-emulate-flows",
  order: 692,
  async run(ctx) {
    const humanEmail = `human-${ctx.nonce}@e2e.test`;
    const humanToken = `lin_api_human_${ctx.nonce}`;
    const clientId = `e2e-linear-${ctx.nonce}`;
    const signingSecret = `e2e-linear-signing-${ctx.nonce}`;
    const appName = `Agent Swarm ${ctx.nonce}`;
    const callback = `${ctx.baseUrl}/api/trackers/linear/callback`;
    const issueIds = {
      todo: crypto.randomUUID(),
      backlog: crypto.randomUUID(),
      cancel: crypto.randomUUID(),
    };
    const emulator = await createEmulator({
      service: "linear",
      port: 0,
      seed: {
        linear: {
          users: [{ email: humanEmail, name: `Human ${ctx.nonce}` }],
          teams: [
            {
              key: "E2E",
              name: "E2E",
              states: [
                { name: "Backlog", type: "backlog" },
                { name: "Todo", type: "unstarted" },
                { name: "In Progress", type: "started" },
                { name: "Done", type: "completed" },
                { name: "Canceled", type: "canceled" },
              ],
            },
          ],
          issues: [
            { id: issueIds.todo, team: "E2E", title: `Fix login ${ctx.nonce}`, state: "Todo" },
            { id: issueIds.backlog, team: "E2E", title: `Someday ${ctx.nonce}`, state: "Backlog" },
            { id: issueIds.cancel, team: "E2E", title: `Drop me ${ctx.nonce}`, state: "Todo" },
          ],
          oauth_apps: [
            {
              client_id: clientId,
              client_secret: `secret-${ctx.nonce}`,
              name: appName,
              redirect_uris: [callback],
              scopes: LINEAR_SCOPES,
              actor: "app",
              assignable: true,
              mentionable: true,
            },
          ],
          tokens: [{ token: humanToken, type: "personal", user: humanEmail }],
          webhooks: [
            {
              url: `${ctx.baseUrl}/api/trackers/linear/webhook`,
              resource_types: ["Issue", "AgentSessionEvent"],
              secret: signingSecret,
            },
          ],
        },
      },
    });
    // The emulator binds 127.0.0.1; its advertised url says localhost.
    const origin = `http://127.0.0.1:${new URL(emulator.url).port}`;
    const graphql = async (query: string, variables: Record<string, unknown> = {}) => {
      const response = await fetch(`${origin}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: humanToken },
        body: JSON.stringify({ query, variables }),
      });
      const body = asRecord(await response.json());
      expect(
        response.ok && !body.errors,
        `emulator GraphQL answered ${response.status}: ${JSON.stringify(body.errors ?? body)}`,
      );
      return asRecord(body.data);
    };
    const sessionsFor = async (issueId: string): Promise<Session[]> => {
      const data = await graphql(
        "query { agentSessions(first: 50) { nodes { id issue { id } activities(first: 50) { nodes { type body } } } } }",
      );
      const nodes = asRecord(data.agentSessions).nodes as Session[];
      return nodes.filter((session) => session.issue?.id === issueId);
    };
    const activitiesFor = async (issueId: string) =>
      (await sessionsFor(issueId)).flatMap((session) => session.activities.nodes);
    const delegate = (issueId: string, delegateId: string | null) =>
      graphql(
        "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
        {
          id: issueId,
          input: { delegateId },
        },
      );

    let leadId: string | undefined;
    const taskIds: string[] = [];
    try {
      await ctx.restartSut({
        env: {
          LINEAR_DISABLE: "false",
          LINEAR_CLIENT_ID: clientId,
          LINEAR_CLIENT_SECRET: `secret-${ctx.nonce}`,
          LINEAR_SIGNING_SECRET: signingSecret,
          LINEAR_REDIRECT_URI: callback,
          LINEAR_URL: origin,
          LINEAR_API_URL: origin,
        },
      });

      // ── the host override is deployment env only ──
      for (const key of ["LINEAR_URL", "LINEAR_API_URL"]) {
        const write = await ctx.api("PUT", "/api/config", {
          body: { scope: "global", key, value: "https://attacker.example" },
        });
        expectStatus(write, [400], `storing ${key} in swarm_config`);
      }

      const status = async () => {
        const response = await ctx.api("GET", "/api/trackers/linear/status");
        expectStatus(response, [200], "linear status");
        return asRecord(response.json);
      };
      expect((await status()).connected === false, "Linear must start disconnected");

      // ── OAuth: consent page, actor=app install, code exchange ──
      const authorize = await ctx.api("GET", "/api/trackers/linear/authorize?format=json");
      expectStatus(authorize, [200], "linear authorize url");
      const authorizeUrl = new URL(asString(asRecord(authorize.json).authorizeUrl, "authorizeUrl"));
      expect(
        authorizeUrl.origin === origin && authorizeUrl.pathname === "/oauth/authorize",
        `the consent URL must point at the emulator (LINEAR_URL): ${authorizeUrl.origin}${authorizeUrl.pathname}`,
      );
      const consent = await fetch(authorizeUrl);
      const page = await consent.text();
      expect(
        consent.ok,
        `the emulator consent page answered ${consent.status}: ${page.slice(0, 300)}`,
      );
      const fields = hiddenFields(page);
      expect(
        fields.actor === "app",
        `the consent page must install as the app: ${JSON.stringify(fields)}`,
      );
      const approve = await fetch(`${origin}/oauth/authorize/callback`, {
        method: "POST",
        body: new URLSearchParams(fields),
        redirect: "manual",
      });
      const location = approve.headers.get("location") ?? "";
      expect(
        approve.status === 302 && location.startsWith(callback),
        `approving must redirect to the SUT callback, got ${approve.status} ${location}`,
      );
      const landed = await fetch(location, { redirect: "manual" });
      ctx.recordHttpCall("GET", "/api/trackers/linear/callback", landed.status);
      expect(
        landed.status === 200 || landed.status === 302,
        `the SUT callback answered ${landed.status}: ${(await landed.text()).slice(0, 300)}`,
      );
      const connected = await status();
      expect(
        connected.connected === true && String(connected.scope).includes("app:assignable"),
        `Linear must be connected with the granted scopes: ${JSON.stringify(connected)}`,
      );

      // Emulator gap: `User.organization` is missing, so the callback's
      // `viewer { id organization { id } }` capture fails (logged, non-fatal) and the bot's
      // app user id is not stored. The scenario reads the app user from the emulator instead.
      const users = asRecord(
        (await graphql("query { users(first: 50) { nodes { id name app } } }")).users,
      ).nodes as { id: string; name: string; app: boolean }[];
      const appUser = users.find((user) => user.app && user.name === appName);
      expect(appUser, `the emulator has no app user for ${appName}: ${JSON.stringify(users)}`);

      // A forced refresh exchanges the refresh token at the emulator.
      const refreshed = await ctx.api("POST", "/api/trackers/linear/refresh", { body: {} });
      expectStatus(refreshed, [200], "linear refresh against the emulator");

      // ── inbound: a Todo issue delegated to the app user becomes a task ──
      leadId = await registerLead(ctx, "linear-emulate");
      await delegate(issueIds.todo, appUser.id);
      const created = await pollUntil(() => syncedTask(ctx, issueIds.todo) !== null, 15_000);
      expect(created, "delegating the Todo issue created no tracked task");
      const taskId = syncedTask(ctx, issueIds.todo)!.swarmId;
      taskIds.push(taskId);
      const task = ctx.db.get<{ source: string; agentId: string | null }>(
        sql`SELECT source, "agentId" FROM agent_tasks WHERE id = ${taskId}`,
      );
      expect(
        task?.source === "linear" && task.agentId === leadId,
        `the Linear task must be routed to the lead: ${JSON.stringify(task)}`,
      );
      const acked = await pollUntil(
        async () =>
          (await activitiesFor(issueIds.todo)).some(
            (a) => a.type === "thought" && a.body.includes(taskId),
          ),
        10_000,
      );
      expect(acked, "the SUT never acknowledged the AgentSession with a thought activity");

      // ── inbound gate: a Backlog issue creates no task and ends its session ──
      await delegate(issueIds.backlog, appUser.id);
      const gated = await pollUntil(
        async () => (await activitiesFor(issueIds.backlog)).some((a) => a.type === "response"),
        10_000,
      );
      expect(gated, "the gated Backlog session never got its skip response");
      expect(syncedTask(ctx, issueIds.backlog) === null, "a Backlog issue must not create a task");

      // ── outbound: completing the task ends the session with the output ──
      const output = `Fixed the login flow ${ctx.nonce}`;
      await claimTask(ctx, leadId, taskId);
      const rawSyncedAt = syncedTask(ctx, issueIds.todo)!.lastSyncedAt;
      const syncedAt = Date.parse(
        rawSyncedAt.includes("T") ? rawSyncedAt : `${rawSyncedAt.replace(" ", "T")}Z`,
      );
      const waitMs = syncedAt + LOOP_PREVENTION_WINDOW_MS + 250 - Date.now();
      if (waitMs > 0) await Bun.sleep(waitMs);
      await withMcp(ctx, leadId, (lead) =>
        expectToolOk(lead, "store-progress", { taskId, status: "completed", output }),
      );
      const responded = await pollUntil(
        async () =>
          (await activitiesFor(issueIds.todo)).some(
            (a) => a.type === "response" && a.body.includes(output),
          ),
        10_000,
      );
      expect(responded, "completing the task never posted the output as a response activity");

      // ── status sync: Canceled in Linear cancels the swarm task ──
      await delegate(issueIds.cancel, appUser.id);
      const cancelTracked = await pollUntil(
        () => syncedTask(ctx, issueIds.cancel) !== null,
        15_000,
      );
      expect(cancelTracked, "delegating the second Todo issue created no tracked task");
      const cancelTaskId = syncedTask(ctx, issueIds.cancel)!.swarmId;
      taskIds.push(cancelTaskId);
      const states = asRecord(
        (await graphql("query { workflowStates(first: 50) { nodes { id name } } }")).workflowStates,
      ).nodes as { id: string; name: string }[];
      const canceled = states.find((state) => state.name === "Canceled");
      expect(canceled, `the emulator team has no Canceled state: ${JSON.stringify(states)}`);
      await graphql(
        "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
        {
          id: issueIds.cancel,
          input: { stateId: canceled.id },
        },
      );
      const cancelled = await pollUntil(
        () =>
          ctx.db.get<{ status: string }>(
            sql`SELECT status FROM agent_tasks WHERE id = ${cancelTaskId}`,
          )?.status === "cancelled",
        10_000,
      );
      expect(cancelled, "moving the issue to Canceled never cancelled its task");

      // ── disconnect revokes the token at the emulator ──
      const disconnect = await ctx.api("DELETE", "/api/trackers/linear/disconnect");
      expectStatus(disconnect, [200], "linear disconnect");
      expect(
        asRecord(disconnect.json).revoked === true,
        `disconnect must revoke the token at the emulator: ${disconnect.text}`,
      );
      expect(
        (await status()).connected === false,
        "Linear must read disconnected after disconnect",
      );
    } finally {
      for (const id of taskIds) {
        await ctx.api("POST", `/api/tasks/${id}/cancel`, { body: { reason: "e2e cleanup" } });
      }
      if (leadId) await retireAgent(ctx, leadId);
      // Boot the base env again, Linear off.
      await ctx.restartSut();
      await emulator.close();
    }
  },
};
