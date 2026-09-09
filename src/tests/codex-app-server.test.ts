import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  CodexAppServer,
  type CodexAppServerNotification,
  CodexAppServerRpcError,
} from "../providers/codex-app-server";
import { CHILD_PROCESS_TEST_BUDGET_MS } from "./test-proc";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-codex-app-server.ts");

function fixtureEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    ...extra,
  };
}

async function deleteFile(path: string): Promise<void> {
  await Bun.file(path)
    .delete()
    .catch(() => {});
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (processExists(pid)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(20);
  }
  return true;
}

describe("CodexAppServer", () => {
  test(
    "initializes before requests without config in process arguments",
    async () => {
      const argsFile = `/tmp/codex-app-server-args-${crypto.randomUUID()}.json`;
      const notifications: CodexAppServerNotification[] = [];
      const server = new CodexAppServer({
        codexPath: FIXTURE,
        env: fixtureEnv({ FAKE_ARGS_FILE: argsFile }),
      });
      server.onNotification((notification) => notifications.push(notification));

      try {
        const result = await server.request<{ params: unknown; initialized: boolean }>("echo", {
          value: 42,
        });
        expect(result).toEqual({ params: { value: 42 }, initialized: true });
        expect(server.version).toBe("0.153.4");
        expect(notifications[0]).toEqual({
          method: "configWarning",
          params: { message: "startup warning" },
        });
        expect(JSON.parse(await Bun.file(argsFile).text())).toEqual([
          "app-server",
          "--listen",
          "stdio://",
        ]);
      } finally {
        await server.close();
        await deleteFile(argsFile);
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "correlates concurrent responses and delivers notifications before responses",
    async () => {
      const server = new CodexAppServer({ codexPath: FIXTURE, env: fixtureEnv() });
      const notifications: CodexAppServerNotification[] = [];
      server.onNotification((notification) => notifications.push(notification));

      try {
        const slow = server.request<string>("slow");
        const fast = server.request<string>("fast");
        expect(await fast).toBe("fast");
        expect(await slow).toBe("slow");
        expect(await server.request<string>("notify")).toBe("notified");
        expect(notifications.at(-1)).toEqual({
          method: "turn/started",
          params: { turn: { id: "turn-1" } },
          emittedAtMs: 123,
        });
      } finally {
        await server.close();
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "returns RPC errors and rejects server requests",
    async () => {
      const server = new CodexAppServer({ codexPath: FIXTURE, env: fixtureEnv() });
      try {
        const error = await server.request("rpc-error").catch((caught) => caught);
        expect(error).toBeInstanceOf(CodexAppServerRpcError);
        expect(error).toMatchObject({ code: -32602, data: { field: "input" } });

        const result = await server.request<{ serverReply: Record<string, unknown> }>(
          "server-request",
        );
        expect(result.serverReply).toEqual({
          id: "server-request",
          error: {
            code: -32601,
            message:
              "Client does not support server request: item/commandExecution/requestApproval",
          },
        });
      } finally {
        await server.close();
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "rejects malformed JSON and timed out requests",
    async () => {
      const malformed = new CodexAppServer({ codexPath: FIXTURE, env: fixtureEnv() });
      await expect(malformed.request("malformed")).rejects.toThrow("emitted malformed JSON");
      await malformed.close();

      const timedOut = new CodexAppServer({
        codexPath: FIXTURE,
        env: fixtureEnv(),
        requestTimeoutMs: 2_000,
      });
      try {
        await expect(timedOut.request("hang")).rejects.toThrow("hang timed out after 2000ms");
      } finally {
        await timedOut.close();
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "scrubs stderr before callbacks and process-exit errors",
    async () => {
      const secret = "sk-abcdefghijklmnopqrstuvwx";
      const stderr: string[] = [];
      const server = new CodexAppServer({
        codexPath: FIXTURE,
        env: fixtureEnv({ FAKE_SECRET: secret }),
        onStderr: (line) => stderr.push(line),
      });

      const error = await server.request("exit").catch((caught) => caught as Error);
      expect(error.message).toContain("exited with code 7");
      expect(error.message).not.toContain(secret);
      expect(stderr).toEqual(["[REDACTED:sk_key]"]);
      await server.close();
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "reports process exit after the last response",
    async () => {
      const server = new CodexAppServer({ codexPath: FIXTURE, env: fixtureEnv() });
      const closed = new Promise<Error>((resolve) => server.onClose(resolve));

      expect(await server.request("exit-after-response")).toBe("accepted");
      expect((await closed).message).toContain("exited with code 8");
      await server.close();
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "forces termination after a bounded close grace period",
    async () => {
      const pidFile = `/tmp/codex-app-server-pid-${crypto.randomUUID()}.txt`;
      const server = new CodexAppServer({
        codexPath: FIXTURE,
        env: fixtureEnv({ FAKE_IGNORE_TERM: "true", FAKE_PID_FILE: pidFile }),
      });

      try {
        await server.request("echo");
        const pid = Number(await Bun.file(pidFile).text());
        const startedAt = Date.now();
        await server.close();
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(await waitForProcessGone(pid)).toBe(true);
      } finally {
        await server.close();
        await deleteFile(pidFile);
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
