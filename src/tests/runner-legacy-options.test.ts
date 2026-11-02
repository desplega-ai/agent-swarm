import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

let directory: string;
// Stop after the real CLI's startup log, before credentials or polling.
const api = Bun.serve({
  port: 0,
  fetch: () => Response.json({ error: "test registration denied" }, { status: 401 }),
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "runner-legacy-options-"));
});
afterAll(async () => {
  api.stop(true);
  await rm(directory, { recursive: true, force: true });
});

describe("retired runner options", () => {
  for (const role of ["worker", "lead"]) {
    test(
      `${role} ignores legacy flags and environment without a parse error`,
      async () => {
        const result = await runChild(
          [process.execPath, "run", join(import.meta.dir, "../cli.tsx"), role, "--yolo"],
          {
            cwd: directory,
            env: {
              PATH: process.env.PATH,
              AGENT_ID: crypto.randomUUID(),
              AGENT_ROLE: role,
              AGENT_SWARM_API_KEY: "test-legacy-options-key",
              MCP_BASE_URL: api.url.toString().replace(/\/$/, ""),
              HARNESS_PROVIDER: "claude",
              ANONYMIZED_TELEMETRY: "false",
              DESPLEGA_TELEMETRY_ENV: "test",
              YOLO: "true",
              WORKER_YOLO: "true",
              LEAD_YOLO: "true",
            },
          },
        );
        expect(result.timedOut).toBe(false);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain(`[${role}] Starting ${role}`);
        expect(result.stderr).toContain("Failed to register:");
        expect(result.stdout).not.toContain("YOLO mode:");
      },
      CHILD_PROCESS_TEST_BUDGET_MS,
    );
  }
});
