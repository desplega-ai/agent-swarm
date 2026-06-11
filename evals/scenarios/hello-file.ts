import { fileContains } from "../src/judge/deterministic.ts";
import type { Scenario } from "../src/types.ts";

/**
 * Smoke scenario: can the swarm execute a trivial concrete instruction
 * end-to-end (claim task -> run harness -> touch the workspace -> report
 * completion via store-progress)?
 *
 * Graded by the agentic judge: it gets live sandbox access and verifies the
 * file itself (cat the file, check the workspace) before submitting a verdict.
 */
export const helloFile: Scenario = {
  id: "hello-file",
  name: "Hello file",
  description: [
    "Boots a fresh swarm stack, assigns the worker one task: create /workspace/eval-hello.txt",
    "containing exactly 'swarm-evals-ok', then report completion via store-progress.",
    "Measures the harness's ability to follow a precise, verifiable instruction with a",
    "filesystem side effect. Graded by a deterministic file check plus an agentic judge",
    "that inspects the sandbox itself.",
  ].join(" "),
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
    agenticJudge: {
      rubric: [
        "The agent created /workspace/eval-hello.txt containing the line 'swarm-evals-ok' and reported completion.",
        "Verify the file's existence and exact content yourself with the sandbox tools — do not trust the transcript alone.",
        "Deduct only for concrete problems: wrong file path/content, unrelated destructive changes, or errors the agent never recovered from.",
      ].join("\n"),
      maxSteps: 8,
    },
    passThreshold: 0.7,
  },
  timeoutMs: 8 * 60 * 1000,
};
