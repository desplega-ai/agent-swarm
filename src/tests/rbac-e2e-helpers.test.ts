import { expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeScratchDir,
  removeScratchDir,
  type SwarmServer,
  spawnSwarmServer,
  waitForListen,
} from "./rbac-e2e-helpers";
import {
  getFreePort,
  listenOnFreePort,
  PortInUseError,
  SERVER_BOOT_HOOK_TIMEOUT_MS,
  startOnFreePort,
} from "./test-net";

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

test("startOnFreePort retries only PortInUseError, up to its attempt bound", async () => {
  const ports = [41001, 41002, 41003, 41004];
  const getPort = async () => ports.shift() ?? 0;
  const tried: number[] = [];

  const port = await startOnFreePort(
    async (p) => {
      tried.push(p);
      if (p === 41001) throw new PortInUseError("taken");
      return p;
    },
    { getPort },
  );
  expect(port).toBe(41002);
  expect(tried).toEqual([41001, 41002]);

  const other = await startOnFreePort(
    async () => {
      throw new Error("boot crashed");
    },
    { getPort },
  ).catch((error: unknown) => error);
  expect((other as Error).message).toBe("boot crashed");
  expect(ports).toEqual([41004]);

  let calls = 0;
  const exhausted = await startOnFreePort(
    async () => {
      calls++;
      throw new PortInUseError(`taken ${calls}`);
    },
    { getPort: async () => 0 },
  ).catch((error: unknown) => error);
  expect(exhausted).toBeInstanceOf(PortInUseError);
  expect((exhausted as Error).message).toBe("taken 3");
  expect(calls).toBe(3);
});

test(
  "spawnSwarmServer starts again on a new port when its first port is taken",
  async () => {
    const dir = await makeScratchDir();
    const holder = createServer();
    const heldPort = await listenOnFreePort(holder);
    let server: SwarmServer | undefined;
    try {
      const offered: number[] = [];
      server = await spawnSwarmServer({
        dbPath: join(dir, "test.sqlite"),
        logPath: join(dir, "server.log"),
        getPort: async () => {
          const port = offered.length === 0 ? heldPort : await getFreePort();
          offered.push(port);
          return port;
        },
      });

      expect(offered).toHaveLength(2);
      expect(offered[0]).toBe(heldPort);
      expect(server.port).toBe(offered[1]);
      expect(server.port).not.toBe(heldPort);
      expect((await fetch(`${server.base}/docs`)).ok).toBe(true);
      const log = await Bun.file(server.logPath).text();
      expect(log).toContain(`Is port ${heldPort} in use?`);
    } finally {
      await server?.stop();
      holder.close();
      await removeScratchDir(dir);
    }
  },
  SERVER_BOOT_HOOK_TIMEOUT_MS * 2,
);
