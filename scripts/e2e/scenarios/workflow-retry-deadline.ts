import { expect } from "../http";
import { MockLlmHttpError } from "../mocks/llm";
import type { Scenario } from "../run";
import {
  createWorkflow,
  hasStep,
  stepOf,
  TERMINAL_RUN_STATUSES,
  triggerWorkflow,
  waitForRun,
} from "./workflow-helpers";

export const workflowRetryDeadline: Scenario = {
  name: "workflow-retry-deadline",
  order: 332,
  async run(ctx) {
    const prompt = `retry-deadline-${ctx.nonce}`;
    const timeoutMs = 1_500;
    let attempts = 0;
    ctx.llm.setChatResponder(async (request) => {
      if (!JSON.stringify(request.input ?? request.messages).includes(prompt)) return;
      attempts++;
      if (attempts === 1) throw new MockLlmHttpError(400, "first attempt failed");
      await Bun.sleep(2 * timeoutMs);
      return "late success";
    });

    try {
      const workflowId = await createWorkflow(ctx, "retry-deadline", {
        nodes: [
          {
            id: "slow",
            type: "raw-llm",
            config: { prompt, timeoutMs },
            retry: { strategy: "static", maxRetries: 1, baseDelayMs: 1 },
            next: "after",
          },
          {
            id: "after",
            type: "raw-llm",
            config: { prompt: "successor" },
          },
        ],
      });
      const { runId } = await triggerWorkflow(ctx, workflowId);
      const detail = await waitForRun(ctx, runId, TERMINAL_RUN_STATUSES);
      const { run } = detail;
      const step = stepOf(detail, "slow");
      expect(attempts === 2, `expected two inference requests, saw ${attempts}`);
      expect(
        run.status === "failed" && step.error === `Step timed out after ${timeoutMs}ms`,
        `retry should time out, got run ${run.status}, step ${step.status}, error ${step.error}`,
      );
      expect(!hasStep(detail, "after"), "a timed-out retry does not start its successor");
    } finally {
      ctx.llm.setChatResponder(undefined);
    }
  },
};
