import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

let directory: string;
const templateId = `concurrency-test-${crypto.randomUUID()}`;
let registeredMaxTasks: number | undefined;
const api = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === `/api/templates/${templateId}`) {
      return Response.json({ config: { agentDefaults: { maxTasks: 7 } }, files: {} });
    }
    if (path === "/api/agents" && request.method === "POST") {
      registeredMaxTasks = (await request.json()).maxTasks;
    }
    // Stop boot after observing registration, before credentials or polling.
    return Response.json({ error: "test registration denied" }, { status: 401 });
  },
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "runner-max-concurrent-"));
});

afterAll(async () => {
  api.stop(true);
  await rm(directory, { recursive: true, force: true });
  await rm(`/workspace/.template-cache/${templateId}.json`, { force: true });
});

describe("runner concurrency configuration", () => {
  for (const { role, template, fallback } of [
    { role: "worker", template: true, fallback: 7 },
    { role: "worker", template: false, fallback: 1 },
    { role: "lead", template: false, fallback: 2 },
  ]) {
    for (const value of [
      undefined,
      "",
      "3workers",
      "2.5",
      "0",
      "-1",
      "1e2",
      " 3",
      "3\n",
      "3",
      "12",
    ]) {
      test(
        `${role}, template=${template}, MAX_CONCURRENT_TASKS=${JSON.stringify(value)}`,
        async () => {
          registeredMaxTasks = undefined;
          const result = await runChild(
            [process.execPath, "run", join(import.meta.dir, "../cli.tsx"), role],
            {
              cwd: directory,
              env: {
                PATH: process.env.PATH,
                AGENT_ID: crypto.randomUUID(),
                AGENT_SWARM_API_KEY: "test-concurrency-key",
                MCP_BASE_URL: api.url.toString().replace(/\/$/, ""),
                TEMPLATE_REGISTRY_URL: api.url.toString().replace(/\/$/, ""),
                TEMPLATE_ID: template ? templateId : undefined,
                MAX_CONCURRENT_TASKS: value,
                LOG_DIR: directory,
                HARNESS_PROVIDER: "claude",
                ANONYMIZED_TELEMETRY: "false",
                DESPLEGA_TELEMETRY_ENV: "test",
              },
            },
          );
          expect(result.timedOut, result.stdout + result.stderr).toBe(false);
          expect(result.stderr).toContain("Failed to register:");
          expect(result.exitCode).toBe(1);
          expect(registeredMaxTasks).toBe(value === "3" ? 3 : value === "12" ? 12 : fallback);
        },
        CHILD_PROCESS_TEST_BUDGET_MS,
      );
    }
  }
});
