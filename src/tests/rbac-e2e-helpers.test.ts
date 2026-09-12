import { expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SwarmServer, waitForListen } from "./rbac-e2e-helpers";

test("waitForListen includes a bounded server log when the process exits early", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rbac-e2e-helper-"));
  const logPath = join(dir, "server.log");
  const knownLogLine = "known boot failure from the child process";
  const discardedLogPrefix = "content before the bounded tail";
  await Bun.write(logPath, `${discardedLogPrefix}${"x".repeat(8 * 1024)}\n`);
  const logFd = openSync(logPath, "a");
  let logFdOpen = true;

  try {
    const proc = Bun.spawn(["bun", "-e", `console.error(${JSON.stringify(knownLogLine)})`], {
      stdout: logFd,
      stderr: logFd,
    });
    await proc.exited;
    closeSync(logFd);
    logFdOpen = false;

    const server: SwarmServer = {
      proc,
      port: 0,
      base: "http://localhost:0",
      dbPath: join(dir, "test.sqlite"),
      logPath,
      async stop() {
        return proc.exitCode;
      },
    };

    const earlyExitError = await waitForListen(server).catch((error: unknown) => error);
    expect(earlyExitError).toBeInstanceOf(Error);
    expect((earlyExitError as Error).message).toContain(knownLogLine);
    expect((earlyExitError as Error).message).not.toContain(discardedLogPrefix);

    const missingLogPath = join(dir, "missing.log");
    const missingLogError = await waitForListen({ ...server, logPath: missingLogPath }).catch(
      (error: unknown) => error,
    );
    expect(missingLogError).toBeInstanceOf(Error);
    expect((missingLogError as Error).message).toContain(missingLogPath);
    expect((missingLogError as Error).message).toContain("Could not read server log");
  } finally {
    if (logFdOpen) closeSync(logFd);
    await rm(dir, { recursive: true, force: true });
  }
});
