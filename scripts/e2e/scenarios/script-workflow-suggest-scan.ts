import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { createAssignedTask, createUser } from "./core-helpers";
import { expectRunOk, getLead, registerAgent, runScript } from "./script-helpers";

/**
 * Flow `workflow-suggestion`: the seeded `workflow-suggest-scan` script reads a person's
 * earlier asks, the Lead's `workflow-suggest` ledger, maturity and integrations, and
 * writes nothing. Repeat grouping across days is unit-tested: the API stamps createdAt.
 */
export const scriptWorkflowSuggestScan: Scenario = {
  name: "script-workflow-suggest-scan",
  order: 461,
  async run(ctx) {
    const leadId = await getLead(ctx);
    const workerId = await registerAgent(ctx, "wf-suggest-worker");
    const userId = await createUser(ctx, "wf-suggest");
    const loneUserId = await createUser(ctx, "wf-suggest-lone");
    const text = `compile the weekly competitor radar report ${ctx.nonce}`;
    const earlierId = await createAssignedTask(ctx, workerId, text, {
      source: "ui",
      requestedByUserId: userId,
    });
    const askId = await createAssignedTask(ctx, workerId, `please ${text} again`, {
      source: "ui",
      requestedByUserId: userId,
    });
    const loneId = await createAssignedTask(ctx, workerId, `a first ask ${ctx.nonce}`, {
      source: "ui",
      requestedByUserId: loneUserId,
    });

    const scan = async (taskId: string, label: string) => {
      const run = await runScript(
        ctx,
        leadId,
        { name: "workflow-suggest-scan", scope: "global", args: { taskId } },
        label,
      );
      expectRunOk(run, label);
      return asRecord(run.result);
    };

    const first = await scan(askId, "scan a repeated ask");
    expect(first.signalValid === true && first.historyCount === 1, "the earlier ask is the signal");
    expect(first.requesterUserId === userId, "the scan keys on the task's requester");
    expect(
      typeof first.threadRef === "string" && first.threadRef !== "",
      "the scan names the thread",
    );
    expect(
      first.pattern === null,
      "two asks on one day are one day of asks, below the 3-day default",
    );
    expect(
      first.optedOut === false && first.alreadyOffered === false && first.pendingOffer === null,
      "an empty ledger has no opt-out and no offer",
    );
    expect(first.mature === false, "a fresh install is not mature");
    const integrations = asRecord(first.integrations);
    expect(
      ["slack", "github", "agentfs"].every((id) => typeof integrations[id] === "string"),
      `the scan carries integration states, got ${JSON.stringify(integrations)}`,
    );
    const thresholds = asRecord(first.thresholds);
    expect(
      thresholds.similarityMin === 0.35 &&
        thresholds.repeatMinCount === 3 &&
        thresholds.lookbackDays === 166 &&
        thresholds.maturityMinWorkflows === 2 &&
        thresholds.maturityMinRunsPerWeek === 133,
      `the measured defaults apply, got ${JSON.stringify(thresholds)}`,
    );

    const lone = await scan(loneId, "scan a first ask");
    expect(lone.signalValid === false && lone.pattern === null, "no history is no signal");

    // The Lead records an offer in this thread and the person's opt-out.
    const put = async (key: string, value: Record<string, unknown>) =>
      expectStatus(
        await ctx.api("PUT", `/api/kv/_/workflow-suggest/${encodeURIComponent(key)}`, {
          agentId: leadId,
          body: { value, valueType: "json" },
        }),
        [200],
        `write ledger ${key}`,
      );
    await put(`u/${userId}/p/${earlierId}`, {
      state: "offered",
      sample: text,
      taskIds: [earlierId],
      thread: first.threadRef,
    });
    await put(`u/${userId}/optout`, { at: new Date().toISOString() });

    const second = await scan(askId, "scan after the offer");
    expect(second.alreadyOffered === true, "a record whose sample matches marks the ask offered");
    expect(
      asRecord(second.pendingOffer).state === "offered" &&
        asRecord(second.pendingOffer).thread === first.threadRef,
      "the unanswered offer in this thread is pending",
    );
    expect(second.optedOut === true, "the opt-out record is read");

    for (const key of [`u/${userId}/p/${earlierId}`, `u/${userId}/optout`]) {
      await ctx.api("DELETE", `/api/kv/_/workflow-suggest/${encodeURIComponent(key)}`, {
        agentId: leadId,
      });
    }
  },
};
