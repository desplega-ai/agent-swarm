import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  asUser,
  cancelQuietly,
  claimTask,
  createAssignedTask,
  createUser,
  expectToolOk,
  registerLead,
  registerWorker,
  retireAgent,
  withMcp,
} from "./core-helpers";

const FLAGS = ["UI_SPEC_ENABLED", "UI_SPEC_ACTIONS_ENABLED"] as const;
const PROMPT = "Run the weekly deploys report again.";

const leaf = (type: string, props: Record<string, unknown>) => ({ type, props, children: [] });

/** A card with one Button that names the declared `rerun` follow-up action. */
const rerunSpec = {
  spec: {
    root: "c",
    elements: {
      c: { type: "Card", props: { title: "Weekly deploys" }, children: ["a"] },
      a: { type: "Actions", props: {}, children: ["b"] },
      b: leaf("Button", { id: "rerun", label: "Run again" }),
    },
  },
  actions: { rerun: { kind: "follow_up", prompt: PROMPT } },
};

async function waitForFlags(ctx: ScenarioContext, present: boolean): Promise<void> {
  const live = await pollUntil(async () => {
    const response = await ctx.api("GET", `/api/config/env-presence?keys=${FLAGS.join(",")}`);
    expectStatus(response, [200], "check the card flags presence");
    const presence = asRecord(response.json).presence as Record<string, boolean> | undefined;
    return FLAGS.every((key) => presence?.[key] === present);
  }, 10_000);
  expect(live, `The card flags presence never became ${present} within 10 seconds`);
}

/**
 * A worker completes a task with a card whose Button declares a `follow_up`
 * action. The first POST to the ui-action route starts one follow-up task for
 * the requester; the second returns `already_done` and starts none.
 */
export const taskUiActions: Scenario = {
  name: "task-ui-actions",
  order: 141,
  async run(ctx) {
    const configIds: string[] = [];
    let taskId: string | undefined;
    try {
      for (const key of FLAGS) {
        const upsert = await ctx.api("PUT", "/api/config", {
          body: { scope: "global", scopeId: null, key, value: "true", isSecret: false },
        });
        expectStatus(upsert, [200], `enable ${key}`);
        configIds.push(String(asRecord(upsert.json).id));
      }
      await waitForFlags(ctx, true);

      const worker = await registerWorker(ctx, "ui-actions");
      const requester = await createUser(ctx, "ui-actions-requester");
      taskId = await createAssignedTask(ctx, worker, `weekly deploys card ${ctx.nonce}`, {
        requestedByUserId: requester,
      });
      await claimTask(ctx, worker, taskId);
      await withMcp(ctx, worker, (conn) =>
        expectToolOk(conn, "store-progress", {
          taskId,
          status: "completed",
          output: "Weekly deploys are ready.",
          uiSpec: rerunSpec,
        }),
      );
      const stored = asRecord((await ctx.api("GET", `/api/tasks/${taskId}`)).json);
      expect(
        asRecord(asRecord(stored.uiSpec).actions).rerun !== undefined,
        `The task did not store the card action: ${JSON.stringify(stored.uiSpec)}`,
      );

      const path = `/api/tasks/${taskId}/ui-actions/rerun`;
      const asRequester = { headers: asUser(requester) };
      // Only a user principal runs a card action; the operator key gets 403.
      const operator = await ctx.api("POST", path);
      expectStatus(operator, [403], "operator ui-action click");

      const first = await ctx.api("POST", path, asRequester);
      expectStatus(first, [200], "first ui-action click");
      const started = asRecord(first.json);
      expect(
        started.status === "started" && typeof started.taskId === "string",
        `The first click did not start the action: ${JSON.stringify(started)}`,
      );
      const followUp = asRecord((await ctx.api("GET", `/api/tasks/${started.taskId}`)).json);
      expect(
        followUp.parentTaskId === taskId &&
          followUp.requestedByUserId === requester &&
          followUp.source === "ui" &&
          String(followUp.task).includes(PROMPT),
        `The follow-up task is wrong: ${JSON.stringify(followUp)}`,
      );

      const second = await ctx.api("POST", path, asRequester);
      expectStatus(second, [200], "second ui-action click");
      expect(
        asRecord(second.json).status === "already_done",
        `The second click did not return already_done: ${JSON.stringify(second.json)}`,
      );
      // The completion also wakes the lead with its own child task; count the action's only.
      const children = ctx.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM agent_tasks WHERE parentTaskId = ? AND task LIKE ?",
        [taskId, `%${PROMPT}%`],
      );
      expect(children?.count === 1, `The clicks created ${children?.count} follow-up tasks`);

      const unknown = await ctx.api("POST", `/api/tasks/${taskId}/ui-actions/missing`, asRequester);
      expectStatus(unknown, [404], "click on an undeclared action");
    } finally {
      // Cancel the follow-up and the completion's lead task: later scenarios need an idle lead.
      if (taskId) {
        const children = ctx.db.query<{ id: string }>(
          "SELECT id FROM agent_tasks WHERE parentTaskId = ?",
          [taskId],
        );
        for (const child of children) await cancelQuietly(ctx, child.id);
      }
      for (const id of configIds) {
        expectStatus(await ctx.api("DELETE", `/api/config/${id}`), [200], "delete a card flag");
      }
      await waitForFlags(ctx, false);
    }
  },
};

const SCRIPT_FLAGS = [...FLAGS, "UI_SPEC_SCRIPT_ACTIONS"] as const;

/** Returns a fresh card that keeps the stored Refresh button. */
const REFRESH_SOURCE = `export default async function main(args: { label?: string }) {
  return {
    spec: {
      root: "c",
      elements: {
        c: { type: "Card", props: { title: \`Refreshed \${args.label ?? ""}\` }, children: ["a"] },
        a: { type: "Actions", props: {}, children: ["b"] },
        b: { type: "Button", props: { id: "refresh", label: "Refresh" }, children: [] },
      },
    },
  };
}
`;

/**
 * A card `script` action. The allowlist pins the script's contentHash, and
 * only a user token may write it: the operator key gets 403. The first click
 * re-runs the script and replaces the card; the second is inside the cooldown.
 */
export const taskUiScriptActions: Scenario = {
  name: "task-ui-script-actions",
  order: 142,
  async run(ctx) {
    const configIds: string[] = [];
    let taskId: string | undefined;
    let leadId: string | undefined;
    let allowlistId: string | undefined;
    let adminToken: string | undefined;
    try {
      for (const key of FLAGS) {
        const upsert = await ctx.api("PUT", "/api/config", {
          body: { scope: "global", scopeId: null, key, value: "true", isSecret: false },
        });
        expectStatus(upsert, [200], `enable ${key}`);
        configIds.push(String(asRecord(upsert.json).id));
      }

      // A lead writes the global script the card runs.
      leadId = await registerLead(ctx, "ui-script");
      const scriptName = `e2e-card-refresh-${ctx.nonce}`;
      const upserted = await ctx.api("POST", "/api/scripts/upsert", {
        agentId: leadId,
        body: {
          name: scriptName,
          scope: "global",
          description: "Card refresh fixture",
          intent: "Return a fresh card",
          source: REFRESH_SOURCE,
        },
      });
      expectStatus(upserted, [200], "upsert the card script");
      const row = ctx.db.get<{ contentHash: string }>(
        "SELECT contentHash FROM scripts WHERE name = ? AND scope = 'global'",
        [scriptName],
      );
      expect(Boolean(row?.contentHash), "The card script has no contentHash");
      const allowlist = `${scriptName}@${row?.contentHash.slice(0, 12)}`;

      // The allowlist is human-only: the shared key is refused, a user token writes it.
      const operatorWrite = await ctx.api("PUT", "/api/config", {
        body: { scope: "global", key: "UI_SPEC_SCRIPT_ACTIONS", value: allowlist },
      });
      expectStatus(operatorWrite, [403], "operator writes UI_SPEC_SCRIPT_ACTIONS");
      const admin = await createUser(ctx, "ui-script-admin");
      const minted = await ctx.api("POST", `/api/users/${admin}/mcp-tokens`, {
        body: { label: `e2e ${ctx.nonce}` },
      });
      expectStatus(minted, [200], "mint an admin user token");
      adminToken = String(asRecord(minted.json).plaintext);
      const userWrite = await ctx.api("PUT", "/api/config", {
        apiKey: adminToken,
        body: { scope: "global", key: "UI_SPEC_SCRIPT_ACTIONS", value: allowlist },
      });
      expectStatus(userWrite, [200], "admin user writes UI_SPEC_SCRIPT_ACTIONS");
      allowlistId = String(asRecord(userWrite.json).id);
      const live = await pollUntil(async () => {
        const response = await ctx.api(
          "GET",
          `/api/config/env-presence?keys=${SCRIPT_FLAGS.join(",")}`,
        );
        const presence = asRecord(response.json).presence as Record<string, boolean> | undefined;
        return SCRIPT_FLAGS.every((key) => presence?.[key] === true);
      }, 10_000);
      expect(live, "The script card flags never went live within 10 seconds");

      const worker = await registerWorker(ctx, "ui-script");
      const requester = await createUser(ctx, "ui-script-requester");
      taskId = await createAssignedTask(ctx, worker, `card refresh ${ctx.nonce}`, {
        requestedByUserId: requester,
      });
      await claimTask(ctx, worker, taskId);
      await withMcp(ctx, worker, (conn) =>
        expectToolOk(conn, "store-progress", {
          taskId,
          status: "completed",
          output: "Card ready.",
          uiSpec: {
            spec: {
              root: "c",
              elements: {
                c: { type: "Card", props: { title: "Original" }, children: ["a"] },
                a: { type: "Actions", props: {}, children: ["b"] },
                b: leaf("Button", { id: "refresh", label: "Refresh" }),
              },
            },
            actions: {
              refresh: { kind: "script", script: scriptName, args: { label: ctx.nonce } },
            },
          },
        }),
      );

      const path = `/api/tasks/${taskId}/ui-actions/refresh`;
      const asRequester = { headers: asUser(requester) };
      const first = await ctx.api("POST", path, asRequester);
      expectStatus(first, [200], "first refresh click");
      const refreshed = asRecord(first.json);
      const title = asRecord(
        asRecord(asRecord(asRecord(asRecord(refreshed.uiSpec).spec).elements).c).props,
      ).title;
      expect(
        refreshed.status === "refreshed" && title === `Refreshed ${ctx.nonce}`,
        `The click did not refresh the card: ${JSON.stringify(refreshed)}`,
      );
      const stored = asRecord((await ctx.api("GET", `/api/tasks/${taskId}`)).json);
      expect(
        String(asRecord(stored.uiSpec).fallbackText).includes(`Refreshed ${ctx.nonce}`),
        `The stored card was not replaced: ${JSON.stringify(stored.uiSpec)}`,
      );

      const second = await ctx.api("POST", path, asRequester);
      expectStatus(second, [429], "refresh click inside the cooldown");
    } finally {
      if (taskId) {
        const children = ctx.db.query<{ id: string }>(
          "SELECT id FROM agent_tasks WHERE parentTaskId = ?",
          [taskId],
        );
        for (const child of children) await cancelQuietly(ctx, child.id);
      }
      if (allowlistId && adminToken) {
        // The allowlist row is human-only, so the shared key cannot delete it.
        const del = await ctx.api("DELETE", `/api/config/${allowlistId}`, { apiKey: adminToken });
        expectStatus(del, [200], "delete UI_SPEC_SCRIPT_ACTIONS");
      }
      for (const id of configIds) {
        expectStatus(await ctx.api("DELETE", `/api/config/${id}`), [200], "delete a card flag");
      }
      if (leadId) await retireAgent(ctx, leadId);
      await waitForFlags(ctx, false);
    }
  },
};
