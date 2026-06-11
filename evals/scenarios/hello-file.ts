import { fileContains } from "../src/judge/deterministic.ts";
import type { Scenario } from "../src/types.ts";

/**
 * Smoke scenario: can the swarm execute a trivial concrete instruction
 * end-to-end (claim task -> run harness -> touch the workspace -> report
 * completion via store-progress)?
 */
export const helloFile: Scenario = {
  id: "hello-file",
  name: "Hello file",
  description:
    "Worker must create a file with exact content in the shared workspace and complete the task cleanly.",
  tasks: [
    {
      title: "Create eval marker file",
      description: [
        "Create a file at the absolute path /workspace/eval-hello.txt containing exactly one line:",
        "",
        "swarm-evals-ok",
        "",
        "Do not add any other content. When the file exists, call store-progress with status completed and a short output describing what you did.",
      ].join("\n"),
    },
  ],
  outcome: {
    checks: [fileContains("/workspace/eval-hello.txt", /swarm-evals-ok/)],
    llmJudge: {
      rubric: [
        "The agent created /workspace/eval-hello.txt containing the line 'swarm-evals-ok' and reported completion.",
        "Deduct only for concrete problems: wrong file path/content, unrelated destructive changes, or errors the agent never recovered from.",
      ].join("\n"),
    },
    passThreshold: 0.7,
  },
  timeoutMs: 8 * 60 * 1000,
};
