import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  ask,
  claim,
  enableSlackRenderV2Only,
  findSlackTask,
  finish,
  registerLead,
  waitForOutcome,
  waitForReaction,
} from "./slack-helpers";

const key = "SLACK_RENDER_V2_TASK_TREE_ENABLED";
async function setTree(ctx: ScenarioContext, enabled: boolean): Promise<string> {
  const response = await ctx.api("PUT", "/api/config", {
    body: { scope: "global", key, value: String(enabled), isSecret: false },
  });
  expectStatus(response, [200], "save task tree preference");
  expect(
    await pollUntil(
      () =>
        ctx.db.get<{ enabled: number }>(
          "SELECT task_tree_enabled AS enabled FROM slack_render_v2_state WHERE id = 1",
        )?.enabled === Number(enabled),
      15_000,
    ),
    "visibility preference did not apply live",
  );
  return String(asRecord(response.json).id);
}

export const slackTaskTreeToggle: Scenario = {
  name: "slack-task-tree-toggle",
  order: 136.5,
  groups: ["visuals-v2"],
  async run(ctx) {
    await enableSlackRenderV2Only(ctx);
    let configId: string | undefined;
    try {
      configId = await setTree(ctx, false);
      const lead = await registerLead(ctx, `e2e-tree-toggle-${ctx.nonce}`);
      const message = await ask(ctx, `swarm#${lead} answer without a task tree ${ctx.nonce}`);
      const task = await findSlackTask(ctx, message.ts);
      const owner = String(task.agentId ?? lead);
      await claim(ctx, owner, String(task.id));
      const answer = `tree-independent answer ${ctx.nonce}`;
      await finish(ctx, owner, String(task.id), { status: "completed", output: answer });
      await waitForOutcome(ctx, message.ts, answer);
      await waitForReaction(ctx, message.ts, "white_check_mark");
      const treeCount = () =>
        ctx.db.get<{ n: number }>(
          "SELECT count(*) AS n FROM slack_messages WHERE kind = 'tree' AND thread_ts = ?",
          [message.ts],
        )?.n;
      expect(treeCount() === 0, "disabled renderer created a tree");
      await setTree(ctx, true);
      const cutoff = ctx.db.get<{ cutoff: string }>(
        "SELECT task_tree_enabled_at AS cutoff FROM slack_render_v2_state WHERE id = 1",
      )?.cutoff;
      expect(!!cutoff, "re-enable did not persist a cutoff");
      await ctx.restartSut();
      expect(
        ctx.db.get<{ cutoff: string }>(
          "SELECT task_tree_enabled_at AS cutoff FROM slack_render_v2_state WHERE id = 1",
        )?.cutoff === cutoff,
        "restart changed the cutoff",
      );
      // A fresh ask proves the restarted watcher is processing again.
      const next = await ask(ctx, `swarm#${lead} resume tree rendering ${ctx.nonce}`);
      const nextTask = await findSlackTask(ctx, next.ts);
      expect(
        await pollUntil(
          () =>
            !!ctx.db.get(
              "SELECT id FROM slack_messages WHERE kind = 'tree' AND thread_ts = ? AND ts NOT LIKE 'pending:%'",
              [next.ts],
            ),
          30_000,
        ),
        "active thread did not get a tree after re-enable",
      );
      expect(treeCount() === 0, "re-enable backfilled a completed thread");
      const nextOwner = String(nextTask.agentId ?? lead);
      await claim(ctx, nextOwner, String(nextTask.id));
      await finish(ctx, nextOwner, String(nextTask.id), {
        status: "completed",
        output: "Tree resumed.",
      });
    } finally {
      if (configId) await ctx.api("DELETE", `/api/config/${configId}`);
    }
  },
};
