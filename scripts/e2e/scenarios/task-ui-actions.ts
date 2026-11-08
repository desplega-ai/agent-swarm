import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  asUser,
  cancelQuietly,
  claimTask,
  createAssignedTask,
  createUser,
  expectToolOk,
  registerWorker,
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
