import type { Scenario } from "../src/types.ts";

/**
 * Pure LLM-judge scenario: no workspace side effects, grades whether the
 * harness can answer a verifiable question and report it via store-progress.
 */
export const quickReasoning: Scenario = {
  id: "quick-reasoning",
  name: "Quick reasoning",
  description: "Worker must compute a small arithmetic answer and report it as the task output.",
  tasks: [
    {
      title: "Compute and report",
      description:
        "Compute 17 * 23 and explain the result in one sentence. Then call store-progress with status completed and put the numeric answer in the output.",
    },
  ],
  outcome: {
    llmJudge: {
      rubric: [
        "The task completed and its output (the authoritative task record's result) contains the correct answer 391.",
        "A correct answer in the task output is sufficient for full credit.",
      ].join("\n"),
    },
    passThreshold: 0.7,
  },
  timeoutMs: 6 * 60 * 1000,
};
