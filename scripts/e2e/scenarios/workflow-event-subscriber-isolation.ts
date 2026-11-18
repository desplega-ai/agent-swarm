import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import {
  createWorkflow,
  deleteWorkflowQuietly,
  type WorkflowDef,
  waitForRun,
} from "./workflow-helpers";

export const workflowEventSubscriberIsolation: Scenario = {
  name: "workflow-event-subscriber-isolation",
  order: 333,
  async run(ctx) {
    const definition: WorkflowDef = {
      nodes: [{ id: "done", type: "script", config: { runtime: "bash", script: "echo done" } }],
    };
    const triggers = [{ type: "event", eventName: "slack.message" }];
    const acceptingId = await createWorkflow(ctx, "event-subscriber-accepting", definition, {
      triggers,
      triggerSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    });
    const rejectingId = await createWorkflow(ctx, "event-subscriber-rejecting", definition, {
      triggers,
      triggerSchema: {
        type: "object",
        properties: { extraField: { type: "string" } },
        required: ["extraField"],
      },
    });

    try {
      // Dispatch visits enabled workflows by last update. Put the rejecting subscriber first.
      const updated = await ctx.api("PUT", `/api/workflows/${rejectingId}`, {
        body: { description: "Rejects messages without extraField" },
      });
      expectStatus(updated, [200], "update rejecting event subscriber");
      const list = await ctx.api("GET", "/api/workflows?enabled=true");
      expectStatus(list, [200], "list enabled event subscribers");
      expect(Array.isArray(list.json), "workflow list is an array");
      const subscribers = list.json
        .map(asRecord)
        .filter(({ id }) => id === acceptingId || id === rejectingId);
      expect(
        subscribers.length === 2 && subscribers[0]?.id === rejectingId,
        "rejecting subscriber is first",
      );

      const text = `Event subscriber isolation ${ctx.nonce}`;
      await ctx.slack.postMessage({ channel: "general", user: "alice", text });

      const listRuns = async (id: string) => {
        const response = await ctx.api("GET", `/api/workflows/${id}/runs`);
        expectStatus(response, [200], `list runs for event subscriber ${id}`);
        return asRecords(response.json, "runs");
      };
      let acceptingRuns: Record<string, unknown>[] = [];
      const started = await pollUntil(async () => {
        acceptingRuns = await listRuns(acceptingId);
        return acceptingRuns.length > 0;
      }, 8_000);
      expect(
        started,
        "accepting subscriber did not receive the event after the first subscriber rejected it",
      );
      expect(acceptingRuns.length === 1, "the accepting subscriber runs once");
      const runId = asString(acceptingRuns[0]?.id, "event-triggered run id");
      const { run } = await waitForRun(
        ctx,
        runId,
        "completed",
        10_000,
        "accepting event subscriber",
      );
      expect(
        asRecord(run.triggerData).text === text,
        "the accepting subscriber received the original message",
      );
      expect((await listRuns(rejectingId)).length === 0, "the rejected payload creates no run");
    } finally {
      await deleteWorkflowQuietly(ctx, rejectingId);
      await deleteWorkflowQuietly(ctx, acceptingId);
    }
  },
};
