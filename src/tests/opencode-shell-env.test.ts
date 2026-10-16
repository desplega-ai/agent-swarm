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
import { OpenCode } from "@opencode/sdk";
import { fetchResolvedEnv } from "../commands/runner";
import { createOpencodeSwarmPlugin } from "../providers/opencode-swarm-plugin";

/**
 * OpenCode runs in-process, so its shell tool would spawn with the worker's
 * process.env. The swarm plugin swaps in the env the runner resolved for the
 * task: a row admitted after boot (exportToEnv flipped on) must reach the
 * shell, and a row revoked after boot (flipped off) must leave it, even though
 * process.env still holds the boot value.
 */

type ConfigRow = { key: string; value: string; isSecret: boolean; exportToEnv: boolean };

const SHELL_TIMEOUT_MS = 15_000;

let server: ReturnType<typeof Bun.serve>;
let apiUrl = "";
let rows: ConfigRow[] = [];
let directory = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ configs: rows }),
  });
  apiUrl = `http://localhost:${server.port}`;
  directory = mkdtempSync(join(tmpdir(), "opencode-shell-env-"));
});

afterAll(() => {
  server.stop(true);
  rmSync(directory, { recursive: true, force: true });
});

type Host = Awaited<ReturnType<typeof OpenCode.create>>;

async function hostWithEnv(env: Record<string, string | undefined>): Promise<Host> {
  const plugin = createOpencodeSwarmPlugin({
    apiUrl: "http://127.0.0.1:9",
    apiKey: "",
    agentId: "agent-1",
    taskId: "",
    isLead: false,
    env,
  });
  return OpenCode.create({ plugins: [plugin], log: { level: "error", emit: () => {} } });
}

/**
 * Runs one command as a session shell call, the path the agent's shell tool
 * takes (`host.shell.create` skips plugin hooks), and returns its output.
 */
async function shell(host: Host, command: string): Promise<string> {
  const session = await host.sessions.create({ location: { directory } });
  const outFile = join(directory, `out-${crypto.randomUUID()}.txt`);
  await host.sessions.shell({
    sessionID: session.id,
    command: `{ ${command}; } > ${outFile}.tmp 2>&1; mv ${outFile}.tmp ${outFile}`,
  });
  const deadline = Date.now() + SHELL_TIMEOUT_MS;
  while (!(await Bun.file(outFile).exists())) {
    if (Date.now() > deadline) throw new Error("shell did not exit");
    await Bun.sleep(25);
  }
  return (await Bun.file(outFile).text()).trim();
}

describe("OpenCode shell env (real OpenCode host)", () => {
  const envKeys = ["SHELL_REVOKED_CANARY", "SHELL_ADMITTED_CANARY"] as const;
  const saved: Record<string, string | undefined> = {};
  let log: ReturnType<typeof spyOn>;

  beforeEach(() => {
    for (const key of envKeys) saved[key] = process.env[key];
    log = spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test(
    "admission and revocation after boot reach the shell",
    async () => {
      process.env.SHELL_REVOKED_CANARY = "boot-revoked";
      delete process.env.SHELL_ADMITTED_CANARY;
      rows = [
        { key: "SHELL_REVOKED_CANARY", value: "row-revoked", isSecret: true, exportToEnv: false },
        { key: "SHELL_ADMITTED_CANARY", value: "row-admitted", isSecret: true, exportToEnv: true },
      ];
      const { env } = await fetchResolvedEnv(apiUrl, "key", "agent-1", process.env);
      const host = await hostWithEnv(env);
      try {
        const out = await shell(
          host,
          'echo "admitted=$SHELL_ADMITTED_CANARY revoked=$SHELL_REVOKED_CANARY term=$OPENCODE_TERMINAL."; tr "\\0" "\\n" < /proc/$$/environ | grep -c "^SHELL_REVOKED_CANARY=" || true',
        );
        expect(out).toContain("admitted=row-admitted revoked= term=1.");
        expect(out.split("\n").at(-1)).toBe("0");
      } finally {
        await host.close();
      }
    },
    SHELL_TIMEOUT_MS * 2,
  );

  test(
    "concurrent hosts keep their own env",
    async () => {
      const [first, second] = await Promise.all([
        hostWithEnv({ ...process.env, SHELL_ADMITTED_CANARY: "first" }),
        hostWithEnv({ ...process.env, SHELL_ADMITTED_CANARY: undefined }),
      ]);
      try {
        const [a, b] = await Promise.all([
          shell(first, 'echo "v=$SHELL_ADMITTED_CANARY"'),
          shell(second, 'echo "v=$SHELL_ADMITTED_CANARY"'),
        ]);
        expect(a).toBe("v=first");
        expect(b).toBe("v=");
        expect(process.env.SHELL_ADMITTED_CANARY).toBeUndefined();
      } finally {
        await Promise.all([first.close(), second.close()]);
      }
    },
    SHELL_TIMEOUT_MS * 2,
  );
});
