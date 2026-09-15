import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../providers/claude-adapter";
import type { ProviderSession, ProviderSessionConfig } from "../providers/types";
import { CHILD_PROCESS_TEST_BUDGET_MS } from "./test-proc";

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * `terminateProcessGroup` returns as soon as SIGKILL is *sent*. The kernel then
 * tears the grandchild down asynchronously, and `kill(pid, 0)` keeps succeeding
 * while it is a zombie waiting for init to reap it. Under CI load that window
 * spans the immediate assertion (merge-gate flaked 3 of 6 runs), so poll with a
 * bounded deadline instead of asserting once.
 */
async function waitForProcessGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(20);
  }
  return true;
}

async function waitForPidFile(path: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) {
      const pid = Number(await Bun.file(path).text());
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for PID file: ${path}`);
}

const PROCESS_GONE_TIMEOUT_MS = 5_000;

describe("provider process groups", () => {
  const posixTest = process.platform === "win32" ? test.skip : test;

  posixTest(
    "Claude adapter teardown kills a SIGTERM-resistant grandchild",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "provider-process-group-"));
      const fixturePath = join(dir, "fake-claude.ts");
      const grandchildPidPath = join(dir, "grandchild.pid");
      const logFile = join(dir, "claude.jsonl");
      let grandchildPid: number | undefined;
      let session: ProviderSession | undefined;

      await writeFile(
        fixturePath,
        `if (Bun.argv.includes("--version")) {
  console.log("2.1.0");
} else {
  const child = Bun.spawn(["sh", "-c", "trap '' TERM; while :; do sleep 1; done"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
  await Bun.write(process.env.GRANDCHILD_PID_FILE!, String(child.pid));
  console.log(JSON.stringify({ type: "result", total_cost_usd: 0, is_error: false }));
}
`,
      );

      const config: ProviderSessionConfig = {
        prompt: "finish immediately",
        systemPrompt: "",
        model: "sonnet",
        role: "worker",
        agentId: "test-agent-id",
        taskId: crypto.randomUUID(),
        apiUrl: "",
        apiKey: "",
        cwd: dir,
        logFile,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token",
          CLAUDE_BINARY: `bun ${fixturePath}`,
          CLAUDE_TRANSPORT: "cli",
          GRANDCHILD_PID_FILE: grandchildPidPath,
        },
      };

      try {
        session = await new ClaudeAdapter(async () => {}).createSession(config);
        grandchildPid = await waitForPidFile(grandchildPidPath, PROCESS_GONE_TIMEOUT_MS);
        const result = await session.waitForCompletion();

        expect(result.exitCode).toBe(0);
        expect(Number.isInteger(grandchildPid)).toBe(true);
        expect(await waitForProcessGone(grandchildPid, PROCESS_GONE_TIMEOUT_MS)).toBe(true);
      } finally {
        await session?.abort();
        if (grandchildPid && processExists(grandchildPid)) {
          try {
            process.kill(grandchildPid, "SIGKILL");
          } catch {
            // Already reaped.
          }
        }
        await rm(dir, { recursive: true, force: true });
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  posixTest(
    "Claude adapter bounds a hanging version probe",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "claude-version-probe-"));
      const fixturePath = join(dir, "fake-claude.ts");
      const versionChildPidPath = join(dir, "version-child.pid");
      const logFile = join(dir, "claude.jsonl");
      let session: ProviderSession | undefined;
      let versionChildPid: number | undefined;

      await writeFile(
        fixturePath,
        `if (Bun.argv.includes("--version")) {
  const child = Bun.spawn(["sh", "-c", "trap '' TERM; while :; do sleep 1; done"], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  child.unref();
  await Bun.write(process.env.VERSION_CHILD_PID_FILE!, String(child.pid));
  await Bun.sleep(60_000);
} else {
  console.log(JSON.stringify({ type: "result", total_cost_usd: 0, is_error: false }));
}
`,
      );

      const config: ProviderSessionConfig = {
        prompt: "finish immediately",
        systemPrompt: "",
        model: "sonnet",
        role: "worker",
        agentId: "test-agent-id",
        taskId: crypto.randomUUID(),
        apiUrl: "",
        apiKey: "",
        cwd: dir,
        logFile,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token",
          CLAUDE_BINARY: `bun ${fixturePath}`,
          CLAUDE_TRANSPORT: "cli",
          VERSION_CHILD_PID_FILE: versionChildPidPath,
        },
      };

      const startedAt = performance.now();
      try {
        session = await new ClaudeAdapter(async () => {}).createSession(config);
        const sessionCreationMs = performance.now() - startedAt;
        versionChildPid = await waitForPidFile(versionChildPidPath, PROCESS_GONE_TIMEOUT_MS);

        expect(sessionCreationMs).toBeLessThan(PROCESS_GONE_TIMEOUT_MS);
        expect(await waitForProcessGone(versionChildPid, PROCESS_GONE_TIMEOUT_MS)).toBe(true);
        expect(session.deliverSteering).toBeUndefined();
        const result = await session.waitForCompletion();
        expect(result.exitCode).toBe(0);
      } finally {
        await session?.abort();
        if (!versionChildPid && (await Bun.file(versionChildPidPath).exists())) {
          versionChildPid = Number(await Bun.file(versionChildPidPath).text());
        }
        if (versionChildPid && processExists(versionChildPid)) {
          try {
            process.kill(versionChildPid, "SIGKILL");
          } catch {
            // Already reaped.
          }
        }
        await rm(dir, { recursive: true, force: true });
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
