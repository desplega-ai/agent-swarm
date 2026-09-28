import { describe, expect, mock, test } from "bun:test";

const postMessage = mock(async (_args: Record<string, unknown>) => ({ ts: "1.0" }));
mock.module("../slack/app", () => ({
  getSlackApp: () => ({ client: { chat: { postMessage } } }),
}));

import type { ExecutorDependencies } from "../workflows/executors/base";
import { HumanInTheLoopExecutor } from "../workflows/executors/human-in-the-loop";

describe("HITL Slack card timeout caption", () => {
  test("says the request times out, never that it auto-rejects", async () => {
    const deps: ExecutorDependencies = {
      db: {
        getApprovalRequestByStepId: async () => null,
        createApprovalRequest: async () => ({ status: "pending" }),
        updateApprovalRequestNotifications: async () => {},
        getApprovalRequestById: async () => ({ status: "pending" }),
      } as unknown as typeof import("../be/db"),
      eventBus: { emit: () => {}, on: () => {}, off: () => {} },
      interpolate: (template: string) => template,
    };
    const executor = new HumanInTheLoopExecutor(deps);

    await executor.run({
      config: {
        title: "Deploy",
        questions: [{ id: "q1", type: "approval", label: "Approve?", required: true }],
        approvers: { policy: "any" },
        timeout: { seconds: 3600, action: "reject" },
        notifications: [{ channel: "slack", target: "C1" }],
      },
      context: {},
      meta: {
        runId: crypto.randomUUID(),
        stepId: crypto.randomUUID(),
        nodeId: "review",
        workflowId: crypto.randomUUID(),
        dryRun: false,
      },
    });
    // Notifications are fire-and-forget; wait for the dispatch to post.
    for (let i = 0; i < 50 && postMessage.mock.calls.length === 0; i++) {
      await Bun.sleep(10);
    }

    expect(postMessage).toHaveBeenCalledTimes(1);
    const blocks = JSON.stringify(postMessage.mock.calls[0]![0].blocks);
    expect(blocks).toContain("times out if not responded");
    expect(blocks).not.toContain("auto-rejects");
  });
});
