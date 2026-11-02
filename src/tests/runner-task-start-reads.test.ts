import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

// Must match src/tests/fixtures/runner-task-start-reads.ts.
const PARENT_OUTPUT_SENTINEL = "PARENT_OUTPUT_SENTINEL_9c2e";

describe("runner task-start reads", () => {
  test(
    "a follow-up task's memory search and parent-task reads are in flight together",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "runner-task-start-reads-"));
      try {
        expectChildOk(
          await runChild(
            [
              process.execPath,
              join(import.meta.dir, "fixtures/runner-task-start-reads.ts"),
              directory,
            ],
            {
              cwd: directory,
              env: {
                PATH: process.env.PATH,
                HOME: directory,
                AGENT_ID: "11111111-1111-4111-8111-111111111111",
                API_KEY: "example-fixture-key",
                MCP_BASE_URL: "http://runner.invalid",
                HARNESS_PROVIDER: "pi",
                CRED_CHECK_DISABLE: "1",
                DATABASE_PATH: ":memory:",
                ANONYMIZED_TELEMETRY: "false",
                STEERING_ENABLED: "false",
              },
            },
          ),
          "Runner task-start reads fixture",
        );
        const result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8")) as {
          taskId: string;
          prompt: string;
          ranAlone: boolean;
        };

        expect(result.taskId).toBe("55555555-5555-4555-8555-555555555555");
        expect(result.ranAlone).toBe(false);
        // The parent's outcome still reaches the prompt through the preamble.
        expect(result.prompt).toContain("## Prior Conversation Context");
        expect(result.prompt).toContain(PARENT_OUTPUT_SENTINEL);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
