import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import { createWorkflow, getRunDetail, triggerWorkflow, waitForRun } from "./workflow-helpers";

export const workflowWaitEventLoop: Scenario = {
  name: "workflow-wait-event-loop",
  order: 321,
  async run(ctx) {
    const eventName = `e2e.wait.loop.${ctx.nonce}`;
    const workflowId = await createWorkflow(ctx, "wait-event-loop", {
      nodes: [
        {
          id: "start",
          type: "notify",
          config: { channel: "swarm", template: "start" },
          next: "wait",
        },
        {
          id: "wait",
          type: "wait",
          config: { mode: "event", eventName, scope: "global" },
          next: { event: "check" },
        },
        {
          id: "check",
          type: "property-match",
          config: { conditions: [{ field: "wait.payload.done", op: "eq", value: true }] },
          next: { true: "done", false: "wait" },
        },
        { id: "done", type: "notify", config: { channel: "swarm", template: "done" } },
      ],
    });
    const { runId } = await triggerWorkflow(ctx, workflowId);
    const ready = async (completed: number) =>
      pollUntil(
        async () => {
          const { run, steps } = await getRunDetail(ctx, runId);
          const waits = steps.filter((step) => step.nodeId === "wait");
          return (
            run.status === "waiting" &&
            waits.filter((step) => step.status === "completed").length === completed &&
            waits.filter((step) => step.status === "waiting").length === 1
          );
        },
        10_000,
        100,
      );
    expect(await ready(0), "first event wait never parked");

    for (const done of [false, true]) {
      const response = await ctx.api("POST", "/api/workflow-events", {
        body: { name: eventName, payload: { done } },
      });
      expectStatus(response, [200], "send event to looping wait");
      expect(asRecord(response.json).ok === true, "event accepted");
      if (!done) expect(await ready(1), "loop did not reach its second event wait");
    }

    const detail = await waitForRun(
      ctx,
      runId,
      "completed",
      10_000,
      "looped wait after second event",
    );
    const waits = detail.steps.filter((step) => step.nodeId === "wait");
    expect(waits.length === 2, "exactly two iterations of the event wait");
    expect(
      waits.every((step) => step.status === "completed" && step.nextPort === "event"),
      "both waits completed through the event port",
    );
    expect(
      waits.some((step) => asRecord(asRecord(step.output).payload).done === false),
      "first payload was delivered",
    );
    expect(
      waits.some((step) => asRecord(asRecord(step.output).payload).done === true),
      "second payload was delivered",
    );
  },
};
