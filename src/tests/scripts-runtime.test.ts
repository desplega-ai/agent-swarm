import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runScript } from "../scripts-runtime/loader";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";

const savedEnv = { ...process.env };
const resources = { memoryMb: 2048, cpuTimeSec: 20, maxStdoutBytes: 1_048_576 };

beforeEach(() => {
  process.env.AGENT_SWARM_API_KEY = "runtime-test-secret-1234567890";
  delete process.env.API_KEY;
  process.env.MCP_BASE_URL = "http://localhost:3013";
  refreshSecretScrubberCache();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  refreshSecretScrubberCache();
});

describe("runScript", () => {
  test("runs a trivial transform", async () => {
    const output = await runScript({
      agentId: "agent-1",
      args: { x: 1 },
      resources,
      source: "export default async (args) => args.x + 1;",
    });

    expect(output.error).toBeUndefined();
    expect(output.result).toBe(2);
    expect(output.exitCode).toBe(0);
  });

  test("ctx.stdlib.fetch returns parsed JSON", async () => {
    const output = await runScript({
      agentId: "agent-1",
      args: { url: 'data:application/json,{"ok":true}' },
      resources,
      source: "export default async (args, ctx) => ctx.stdlib.fetch(args.url);",
    });

    expect(output.error).toBeUndefined();
    expect(output.result).toEqual({ ok: true });
  });

  test("bare stdlib imports resolve through runtime shims", async () => {
    const output = await runScript({
      agentId: "agent-1",
      resources,
      source: `
        import { table } from "stdlib";
        export default async () => table([{ a: 1 }]);
      `,
    });

    expect(output.error).toBeUndefined();
    expect(output.result).toContain("a");
    expect(output.result).toContain("1");
  });

  test("timeout kills a running script", async () => {
    const started = Date.now();
    const output = await runScript({
      agentId: "agent-1",
      timeoutMs: 150,
      resources: { ...resources, wallClockMs: 150 },
      source: "export default async () => new Promise(() => {});",
    });

    expect(output.error).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("stdout is capped and marked truncated", async () => {
    const output = await runScript({
      agentId: "agent-1",
      resources: { ...resources, maxStdoutBytes: 128 },
      source: "export default async () => { console.log('x'.repeat(2048)); return 'ok'; };",
    });

    expect(output.result).toBe("ok");
    expect(output.truncated.stdout).toBe(true);
    expect(output.stdout.length).toBeLessThanOrEqual(128);
  });

  test("AbortSignal aborts a running script", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();

    const output = await runScript({
      agentId: "agent-1",
      signal: controller.signal,
      resources,
      source: "export default async () => new Promise(() => {});",
    });

    expect(output.error).toBe("killed");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("subprocess env is stripped to the explicit allowlist", async () => {
    process.env.API_KEY = "legacy-secret-that-must-not-leak";
    process.env.AGENT_SWARM_API_KEY = "preferred-secret-that-must-not-leak";
    refreshSecretScrubberCache();

    const output = await runScript({
      agentId: "agent-1",
      resources,
      source: `
        export default async () => ({
          keys: Object.keys(process.env).sort(),
          apiKey: process.env.API_KEY,
          agentSwarmApiKey: process.env.AGENT_SWARM_API_KEY,
        });
      `,
    });

    expect(output.error).toBeUndefined();
    expect(output.result).toEqual({
      keys: [
        "HOME",
        "LANG",
        "LC_ALL",
        "PATH",
        "SWARM_SCRIPT_ARGS_FILE",
        "SWARM_SCRIPT_RESULT_FILE",
        "SWARM_SCRIPT_SOURCE_FILE",
        "SWARM_SCRIPT_TMPDIR",
        "TMPDIR",
      ],
    });
  });

  test("workspace-rw is rejected in v1", async () => {
    const output = await runScript({
      agentId: "agent-1",
      fsMode: "workspace-rw",
      source: "export default async () => true;",
    });

    expect(output.error).toBe("executor_error");
    expect(output.stderr).toContain("workspace-rw");
  });
});
