import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

const root = join(import.meta.dir, "../..");
let logDir: string;
// Reject registration after the startup banner, so no harness or credentials
// are needed and the real CLI exits without entering its polling loop.
const api = Bun.serve({
  port: 0,
  fetch: () => Response.json({ error: "test registration denied" }, { status: 401 }),
});

beforeAll(async () => {
  logDir = await mkdtemp(join(tmpdir(), "runner-yolo-"));
});
afterAll(async () => {
  api.stop(true);
  await rm(logDir, { recursive: true, force: true });
});

type YoloCase = {
  name: string;
  role: "worker" | "lead";
  env: Record<string, string>;
  enabled: boolean;
  args?: string[];
};

const cases: YoloCase[] = [
  { name: "unset", role: "worker", env: {}, enabled: false },
  { name: "true", role: "worker", env: { YOLO: "true" }, enabled: true },
  { name: "1", role: "worker", env: { YOLO: "1" }, enabled: true },
  { name: "TRUE", role: "worker", env: { YOLO: "TRUE" }, enabled: true },
  { name: "trimmed True", role: "worker", env: { YOLO: " True " }, enabled: true },
  { name: "0", role: "worker", env: { YOLO: "0" }, enabled: false },
  { name: "unrecognized", role: "worker", env: { YOLO: "yes" }, enabled: false },
  { name: "worker default", role: "worker", env: { WORKER_YOLO: "true" }, enabled: true },
  { name: "lead default", role: "lead", env: { LEAD_YOLO: "true" }, enabled: true },
  { name: "other role", role: "worker", env: { LEAD_YOLO: "true" }, enabled: false },
  {
    name: "explicit false overrides the worker default",
    role: "worker",
    env: { YOLO: "false", WORKER_YOLO: "true" },
    enabled: false,
  },
  {
    name: "explicit 0 overrides the lead default",
    role: "lead",
    env: { YOLO: "0", LEAD_YOLO: "true" },
    enabled: false,
  },
  {
    name: "explicit empty overrides the worker default",
    role: "worker",
    env: { YOLO: "", WORKER_YOLO: "true" },
    enabled: false,
  },
  {
    name: "CLI flag overrides explicit false",
    role: "worker",
    env: { YOLO: "false" },
    args: ["--yolo"],
    enabled: true,
  },
];

describe("runner YOLO startup configuration", () => {
  for (const { name, role, env, enabled, args = [] } of cases) {
    test(
      name,
      async () => {
        const result = await runChild(
          [process.execPath, "run", join(root, "src/cli.tsx"), role, ...args],
          {
            cwd: logDir,
            env: {
              PATH: process.env.PATH,
              AGENT_ID: crypto.randomUUID(),
              AGENT_ROLE: role,
              AGENT_SWARM_API_KEY: "test-yolo-key",
              MCP_BASE_URL: api.url.toString().replace(/\/$/, ""),
              HARNESS_PROVIDER: "claude",
              ANONYMIZED_TELEMETRY: "false",
              DESPLEGA_TELEMETRY_ENV: "test",
              ...env,
            },
          },
        );
        expect(result.timedOut).toBe(false);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Failed to register:");
        expect(result.stdout).toContain(`[${role}] YOLO mode: ${enabled ? "enabled" : "disabled"}`);
      },
      CHILD_PROCESS_TEST_BUDGET_MS,
    );
  }
});

const dockerCases = [
  { name: "worker default", role: "worker", env: { WORKER_YOLO: "true" }, expected: "true" },
  { name: "lead default", role: "lead", env: { LEAD_YOLO: "true" }, expected: "true" },
  { name: "unset", role: "worker", env: {}, expected: "false" },
  { name: "global true", role: "worker", env: { YOLO: "1" }, expected: "1" },
  {
    name: "global false overrides the worker default",
    role: "worker",
    env: { YOLO: "false", WORKER_YOLO: "true" },
    expected: "false",
  },
  {
    name: "global 0 overrides the lead default",
    role: "lead",
    env: { YOLO: "0", LEAD_YOLO: "true" },
    expected: "0",
  },
  {
    name: "global empty overrides the worker default",
    role: "worker",
    env: { YOLO: "", WORKER_YOLO: "true" },
    expected: "",
  },
];

describe("Docker YOLO banner and inherited environment", () => {
  for (const { name, role, env, expected } of dockerCases) {
    test(
      name,
      async () => {
        const source = await Bun.file(join(root, "docker-entrypoint.sh")).text();
        const start = source.indexOf("# Determine YOLO mode");
        const end = source.indexOf('echo "=== Agent Swarm', start);
        if (start < 0 || end < start) throw new Error("Cannot find entrypoint YOLO setup");
        const result = expectChildOk(
          await runChild(
            [
              "bash",
              "-c",
              `${source.slice(start, end)}\nprintf 'banner=%s\\n' "$YOLO_MODE"\nexec env`,
            ],
            { env: { PATH: process.env.PATH, ROLE: role, ...env } },
          ),
          "entrypoint YOLO setup",
        );
        expect(result.stdout.split("\n")).toContain(`banner=${expected}`);
        expect(result.stdout.split("\n")).toContain(`YOLO=${expected}`);
      },
      CHILD_PROCESS_TEST_BUDGET_MS,
    );
  }
});
