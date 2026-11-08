import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

describe("runner missing provider dependencies", () => {
  test.each(["boot-binary", "boot-sdk", "live-switch"])(
    "%s fails the claimed task with guidance and removes its active session",
    async (scenario) => {
      const directory = await mkdtemp(join(tmpdir(), "runner-dependencies-"));
      try {
        expectChildOk(
          await runChild(
            [
              process.execPath,
              join(import.meta.dir, "fixtures/runner-missing-dependency.ts"),
              directory,
              scenario,
            ],
            {
              cwd: directory,
              env: {
                PATH: process.env.PATH,
                HOME: directory,
                AGENT_ID: "11111111-1111-4111-8111-111111111111",
                API_KEY: "example-fixture-key",
                MCP_BASE_URL: "http://runner.invalid",
                CRED_CHECK_DISABLE: "1",
                MAX_CONCURRENT_TASKS: "1",
                DATABASE_PATH: ":memory:",
                ANONYMIZED_TELEMETRY: "false",
                STEERING_ENABLED: "false",
              },
            },
          ),
          `Missing dependency (${scenario})`,
        );
        const result = await Bun.file(join(directory, "result.json")).json();
        const provider = scenario === "boot-sdk" ? "opencode" : "grok";
        expect(result.adapters).toEqual(scenario === "live-switch" ? ["pi", "grok"] : [provider]);
        expect(result.registrations[0]).toBe(scenario === "live-switch" ? "pi" : provider);
        expect(result.registrations).toContain(provider);
        expect(result.lifecycle).toEqual(["registered", "failed", "removed"]);
        expect(result.failure.status).toBe("failed");
        expect(result.failure.provider).toBe(provider);
        expect(result.failure.failureReason).toContain(`Spawn failed: ${provider} provider:`);
        expect(result.failure.failureReason).toContain(
          scenario === "boot-sdk" ? "missing-sdk.js" : "missing-grok",
        );
        expect(result.failure.failureReason).toContain(
          scenario === "boot-sdk" ? "OPENCODE_SDK_PATH" : "GROK_BINARY",
        );
        expect(result.failure.failureReason).toContain("install");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
