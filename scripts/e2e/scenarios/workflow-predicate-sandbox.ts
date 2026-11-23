// code-match nodes and string wait filters run author JavaScript. Both evaluate it
// in a separate QuickJS realm: the realm's global object, reached through a
// function value's constructor, has no API-process globals (process, Bun).
import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import {
  createWorkflow,
  getRunDetail,
  stepOf,
  triggerWorkflow,
  waitForRun,
} from "./workflow-helpers";

// True when the evaluator's global object is the API process realm.
const HOST_REALM = `(() => { const g = (() => 0).constructor("return this")(); return !!(g && (g.process || g.Bun)); })()`;

export const workflowPredicateSandbox: Scenario = {
  name: "workflow-predicate-sandbox",
  order: 327,
  async run(ctx) {
    const eventName = `e2e.predicate.sandbox.${ctx.nonce}`;
    const workflowId = await createWorkflow(ctx, "predicate-sandbox", {
      nodes: [
        {
          id: "probe",
          type: "code-match",
          config: {
            code: `(input) => (${HOST_REALM} ? "host" : input.trigger.port)`,
            outputPorts: ["host", "guest"],
          },
          next: { guest: "wait", host: "wait" },
        },
        {
          id: "wait",
          type: "wait",
          config: {
            mode: "event",
            eventName,
            scope: "global",
            filter: `(p) => p.go === true && !${HOST_REALM}`,
          },
        },
      ],
    });
    const { runId } = await triggerWorkflow(ctx, workflowId, { port: "guest" });

    const parked = await pollUntil(
      async () => {
        const { run, steps } = await getRunDetail(ctx, runId);
        return run.status === "waiting" && steps.some((s) => s.nodeId === "wait");
      },
      10_000,
      100,
    );
    expect(parked, "the run never reached the event wait");

    // Control: a payload the filter rejects leaves the wait parked.
    const miss = await ctx.api("POST", "/api/workflow-events", {
      body: { name: eventName, payload: { go: false } },
    });
    expectStatus(miss, [200], "send non-matching event");
    expect((await getRunDetail(ctx, runId)).run.status === "waiting", "go:false matched");

    const hit = await ctx.api("POST", "/api/workflow-events", {
      body: { name: eventName, payload: { go: true } },
    });
    expectStatus(hit, [200], "send matching event");
    const done = await waitForRun(ctx, runId, "completed", 10_000, "string filter match");
    expect(
      asRecord(asRecord(stepOf(done, "wait").output).payload).go === true,
      "the wait completed on the matching payload",
    );
    expect(stepOf(done, "probe").nextPort === "guest", "code-match ran in the API realm");

    // Before QuickJS, a predicate that never returns hung the API thread.
    // Now the deadline stops it: code-match fails, a filter does not match.
    const loopId = await createWorkflow(ctx, "predicate-sandbox-loop", {
      nodes: [
        {
          id: "spin",
          type: "code-match",
          config: { code: "() => { for (;;) {} }", outputPorts: ["true"] },
        },
      ],
    });
    const loop = await triggerWorkflow(ctx, loopId);
    const failed = await waitForRun(ctx, loop.runId, "failed", 10_000, "code-match busy loop");
    const spinError = String(stepOf(failed, "spin").error ?? "");
    expect(
      spinError.startsWith("code-match execution error: "),
      `busy loop error: ${spinError}`,
    );

    const loopEvent = `e2e.predicate.loop.${ctx.nonce}`;
    const spinWaitId = await createWorkflow(ctx, "predicate-sandbox-filter-loop", {
      nodes: [
        {
          id: "wait",
          type: "wait",
          config: {
            mode: "event",
            eventName: loopEvent,
            scope: "global",
            filter: "() => { for (;;) {} }",
          },
        },
      ],
    });
    const spinWait = await triggerWorkflow(ctx, spinWaitId);
    expect(
      await pollUntil(
        async () => (await getRunDetail(ctx, spinWait.runId)).run.status === "waiting",
        10_000,
        100,
      ),
      "the busy-loop filter run never parked",
    );
    const spun = await ctx.api("POST", "/api/workflow-events", {
      body: { name: loopEvent, payload: { go: true } },
    });
    expectStatus(spun, [200], "send event to the busy-loop filter");
    expect(
      (await getRunDetail(ctx, spinWait.runId)).run.status === "waiting",
      "a busy-loop filter matched",
    );
  },
};
