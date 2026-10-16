import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

// Must match src/tests/fixtures/runner-legacy-resume-prompt.ts.
const REQUESTER_SENTINEL = "RESUME_REQUESTER_SENTINEL_7f3a";
const MISSING_DIR = "/nonexistent/legacy-resume-dir-7f3a";

describe("runner legacy paused-task resume prompt", () => {
  test(
    "resumed session gets the requester profile and missing-dir warning in its task prompt",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "runner-legacy-resume-"));
      try {
        expectChildOk(
          await runChild(
            [
              process.execPath,
              join(import.meta.dir, "fixtures/runner-legacy-resume-prompt.ts"),
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
          "Runner legacy resume fixture",
        );
        const result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8")) as {
          taskId: string;
          prompt: string;
          systemPrompt: string;
        };

        expect(result.taskId).toBe("44444444-4444-4444-8444-444444444444");
        expect(result.prompt).toContain(REQUESTER_SENTINEL);
        expect(result.prompt).toContain("Fixture Requester");
        // The same text the fresh task path sends (missingTaskDirWarning).
        expect(result.prompt).toContain(
          `Note: The task requested working directory "${MISSING_DIR}" but it does not exist. Falling back to default directory.`,
        );
        // Per-task context stays out of the cacheable system prompt.
        expect(result.systemPrompt).not.toContain(REQUESTER_SENTINEL);
        expect(result.systemPrompt).not.toContain(MISSING_DIR);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
