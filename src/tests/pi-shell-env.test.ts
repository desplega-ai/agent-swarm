import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { fetchResolvedEnv } from "../commands/runner";
import { buildPiShellEnv, PiMonoAdapter } from "../providers/pi-mono-adapter";

/**
 * pi's Bash tool must run with the env the runner resolved for this task,
 * not the worker's process.env: a row admitted after boot (exportToEnv
 * flipped on) must reach the shell, and a row revoked after boot (flipped off)
 * must leave it, even though process.env still holds the boot value.
 */

type ConfigRow = { key: string; value: string; isSecret: boolean; exportToEnv: boolean };

let server: ReturnType<typeof Bun.serve>;
let apiUrl = "";
let rows: ConfigRow[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/config/resolved") return Response.json({ configs: rows });
      if (url.pathname !== "/mcp") return Response.json({ servers: [] });
      const body = (await req.json()) as { id?: number; method?: string };
      const result =
        body.method === "tools/list"
          ? { tools: [] }
          : { protocolVersion: "2025-03-26", capabilities: {} };
      return Response.json({ jsonrpc: "2.0", id: body.id ?? 1, result });
    },
  });
  apiUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("pi Bash tool env", () => {
  const envKeys = [
    "PI_CODING_AGENT_DIR",
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
    "SHELL_REVOKED_CANARY",
    "SHELL_ADMITTED_CANARY",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let agentDir = "";
  let log: ReturnType<typeof spyOn>;

  beforeEach(() => {
    for (const key of envKeys) saved[key] = process.env[key];
    agentDir = mkdtempSync(join(tmpdir(), "pi-shell-env-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.OPENROUTER_API_KEY = "example-test-key";
    process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9/api/v1";
    log = spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(agentDir, { recursive: true, force: true });
  });

  async function sessionWithEnv(env: Record<string, string | undefined>): Promise<AgentSession> {
    const session = await new PiMonoAdapter().createSession({
      prompt: "hello",
      systemPrompt: "test",
      model: "openrouter/google/gemini-3-flash-preview",
      role: "worker",
      agentId: "test-agent",
      taskId: "test-task",
      apiUrl,
      apiKey: "example-test-key",
      cwd: agentDir,
      logFile: join(agentDir, `session-${crypto.randomUUID()}.log`),
      env,
    });
    return (session as unknown as { agentSession: AgentSession }).agentSession;
  }

  async function shell(session: AgentSession, command: string): Promise<string> {
    const bash = session.getToolDefinition("bash");
    if (!bash) throw new Error("bash tool missing");
    const result = await bash.execute(
      "call-1",
      { command },
      undefined,
      undefined,
      undefined as never,
    );
    return result.content
      .map((part) => ("text" in part ? part.text : ""))
      .join("")
      .trim();
  }

  test("admission and revocation after boot reach the shell", async () => {
    // Boot exported SHELL_REVOKED_CANARY and withheld SHELL_ADMITTED_CANARY; the
    // operator then flipped both rows.
    process.env.SHELL_REVOKED_CANARY = "boot-revoked";
    delete process.env.SHELL_ADMITTED_CANARY;
    rows = [
      { key: "SHELL_REVOKED_CANARY", value: "row-revoked", isSecret: true, exportToEnv: false },
      { key: "SHELL_ADMITTED_CANARY", value: "row-admitted", isSecret: true, exportToEnv: true },
    ];
    const { env } = await fetchResolvedEnv(apiUrl, "key", "agent-1", process.env);
    const session = await sessionWithEnv(env);
    try {
      const out = await shell(
        session,
        // The shell's own environment: /proc on Linux, `env` on macOS (no procfs).
        'echo "admitted=$SHELL_ADMITTED_CANARY revoked=$SHELL_REVOKED_CANARY."; { if [ -r /proc/$$/environ ]; then tr "\\0" "\\n" < /proc/$$/environ; else env; fi; } | grep -c "^SHELL_REVOKED_CANARY=" || true',
      );
      expect(out).toContain("admitted=row-admitted revoked=.");
      expect(out.split("\n").at(-1)).toBe("0");
    } finally {
      session.dispose();
    }
  });

  test("concurrent sessions keep their own env", async () => {
    const first = await sessionWithEnv({ ...process.env, SHELL_ADMITTED_CANARY: "first" });
    const second = await sessionWithEnv({ ...process.env, SHELL_ADMITTED_CANARY: undefined });
    try {
      const [a, b] = await Promise.all([
        shell(first, 'echo "v=$SHELL_ADMITTED_CANARY"'),
        shell(second, 'echo "v=$SHELL_ADMITTED_CANARY"'),
      ]);
      expect(a).toBe("v=first");
      expect(b).toBe("v=");
      expect(process.env.SHELL_ADMITTED_CANARY).toBeUndefined();
    } finally {
      first.dispose();
      second.dispose();
    }
  });
});

describe("buildPiShellEnv", () => {
  test("keeps the session env and takes only PATH and pi's session keys from its spawn env", () => {
    const env = buildPiShellEnv(
      { HOME: "/home/worker", PATH: "/usr/bin", TASK_ONLY: "yes" },
      { PATH: "/pi/bin:/usr/bin", PI_SESSION_ID: "s1", PI_OTHER: "leak", PROCESS_ONLY: "leak" },
    );
    expect(env).toEqual({
      HOME: "/home/worker",
      PATH: "/pi/bin:/usr/bin",
      TASK_ONLY: "yes",
      PI_SESSION_ID: "s1",
    });
  });
});
