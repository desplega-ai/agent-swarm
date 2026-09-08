import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

interface FixtureResult {
  captures: string[];
  profileReads: number;
  claims: number;
  firstCompleted: boolean;
  editDuringRefresh: boolean;
  tools: string;
  baselineAtFirstSpawn: string;
  baselineAtSecondSpawn: string;
}

async function runFixture(scenario: string): Promise<FixtureResult> {
  const directory = mkdtempSync(join(tmpdir(), "runner-identity-"));
  try {
    expectChildOk(
      await runChild(
        [
          process.execPath,
          join(import.meta.dir, "fixtures/runner-identity-refresh.ts"),
          scenario,
          directory,
        ],
        {
          cwd: directory,
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            AGENT_ID: "11111111-1111-4111-8111-111111111111",
            API_KEY: "fixture-key",
            MCP_BASE_URL: "http://runner.invalid",
            HARNESS_PROVIDER: "pi",
            CRED_CHECK_DISABLE: "1",
            DATABASE_PATH: ":memory:",
            ANONYMIZED_TELEMETRY: "false",
            STEERING_ENABLED: "false",
          },
        },
      ),
      `Runner identity fixture (${scenario})`,
    );
    return JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("runner per-task identity refresh", () => {
  test(
    "two sequential claimed tasks spawn with the latest post-boot identity",
    async () => {
      const result = await runFixture("sequential");
      expect(result.firstCompleted).toBe(true);
      expect(result.claims).toBe(2);
      expect(result.profileReads).toBe(3);
      expect(result.captures[0]).toContain("Soul before boot refresh");
      expect(result.captures[1]).toContain("Soul changed after task A");
      expect(result.captures[1]).toContain("Identity changed after task A");
      expect(result.captures[0]).toContain("Notes before boot refresh");
      expect(result.captures[1]).not.toContain("Notes before boot refresh");
      expect(result.captures[1]).toContain("Additional fixture instructions");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "concurrent task refresh preserves task A local edit and identity baselines",
    async () => {
      const result = await runFixture("concurrent");
      expect(result.firstCompleted).toBe(false);
      expect(result.editDuringRefresh).toBe(true);
      expect(result.claims).toBe(2);
      expect(result.captures[0]).toContain("Soul before boot refresh");
      expect(result.captures[1]).toContain("Soul changed after task A");
      expect(result.tools).toBe("Task A local edit");
      expect(result.baselineAtSecondSpawn).toBe(result.baselineAtFirstSpawn);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "null post-claim profile still spawns the next task with cached identity",
    async () => {
      const result = await runFixture("null");
      expect(result.claims).toBe(2);
      expect(result.captures[1]).toContain("Soul before boot refresh");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "hanging post-claim profile still spawns the next task with cached identity",
    async () => {
      const result = await runFixture("timeout");
      expect(result.claims).toBe(2);
      expect(result.captures[1]).toContain("Soul before boot refresh");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
