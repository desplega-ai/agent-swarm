import { describe, expect, mock, test } from "bun:test";

type EnsureCall = {
  id: string;
  data: Record<string, unknown>;
  validator?: (...args: unknown[]) => boolean;
};

const ensureCalls: EnsureCall[] = [];

mock.module("@desplega.ai/business-use", () => ({
  ensure: (options: EnsureCall) => {
    ensureCalls.push(options);
  },
  initialize: () => {},
  shutdown: async () => {},
}));

const { ensure } = await import("../utils/business-use");

// Built at runtime so no secret-shaped literal lands in the repo.
const githubToken = () => `gh${"p"}_${"Q".repeat(36)}`;

describe("business-use ensure() wrapper", () => {
  test("scrubs a secret in data.failureReason before forwarding", () => {
    ensureCalls.length = 0;
    const secret = githubToken();
    ensure({
      id: "failed",
      flow: "task",
      runId: "run-1",
      data: { taskId: "t-1", failureReason: `git push failed: token ${secret} rejected` },
    });

    expect(ensureCalls).toHaveLength(1);
    const forwarded = ensureCalls[0]!.data;
    expect(JSON.stringify(forwarded)).not.toContain(secret);
    expect(String(forwarded.failureReason)).toContain("[REDACTED:");
    expect(String(forwarded.failureReason)).toContain("git push failed");
    expect(forwarded.taskId).toBe("t-1");
  });

  test("scrubs nested values and leaves the validator untouched", () => {
    ensureCalls.length = 0;
    const secret = githubToken();
    const validator = (data: { output: { text: string } }) => data.output.text.length > 0;
    ensure({
      id: "completed",
      flow: "task",
      runId: "run-2",
      data: { output: { text: `done, used ${secret}` }, count: 3 },
      validator,
    });

    const call = ensureCalls[0]!;
    expect(JSON.stringify(call.data)).not.toContain(secret);
    expect(JSON.stringify(call.data)).toContain("[REDACTED:");
    expect(call.data.count).toBe(3);
    expect(call.validator).toBe(validator as unknown as EnsureCall["validator"]);
  });
});
