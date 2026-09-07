import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../providers/claude-adapter";
import type { ProviderSessionConfig } from "../providers/types";
import { CHILD_PROCESS_TEST_BUDGET_MS } from "./test-proc";

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
          GRANDCHILD_PID_FILE: grandchildPidPath,
        },
      };

      try {
        const session = await new ClaudeAdapter(async () => {}).createSession(config);
        const result = await session.waitForCompletion();
        grandchildPid = Number(await Bun.file(grandchildPidPath).text());

        expect(result.exitCode).toBe(0);
        expect(Number.isInteger(grandchildPid)).toBe(true);
        expect(processExists(grandchildPid)).toBe(false);
      } finally {
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
});
