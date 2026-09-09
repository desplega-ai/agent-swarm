import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../providers/claude-adapter";
import type { ProviderEvent, ProviderSession, ProviderSessionConfig } from "../providers/types";
import { runChild } from "./test-proc";

const runLive = process.env.RUN_CLAUDE_SDK_LIFECYCLE === "1";
const liveTest = runLive ? test : test.skip;
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "claude-sdk-live-lifecycle-"));
  await Promise.all([
    mkdir(join(path, "home")),
    mkdir(join(path, "claude-config")),
    mkdir(join(path, "tmp")),
  ]);
  temporaryDirectories.push(path);
  return path;
}

function liveConfig(directory: string, prompt: string): ProviderSessionConfig {
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!oauthToken) throw new Error("CLAUDE_CODE_OAUTH_TOKEN is required for this live test");
  const executable = process.env.CLAUDE_SDK_LIFECYCLE_BINARY?.trim() || Bun.which("claude") || "";
  if (!executable) throw new Error("Claude Code was not found on PATH");
  return {
    prompt,
    systemPrompt: "",
    model: process.env.CLAUDE_SDK_LIFECYCLE_MODEL || "claude-haiku-4-5",
    role: "worker",
    agentId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    apiUrl: "",
    apiKey: "",
    cwd: directory,
    logFile: join(directory, "session.jsonl"),
    additionalArgs: ["--max-turns", "6"],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      USER: process.env.USER ?? "worker",
      LANG: process.env.LANG ?? "C.UTF-8",
      TMPDIR: join(directory, "tmp"),
      HOME: join(directory, "home"),
      CLAUDE_CONFIG_DIR: join(directory, "claude-config"),
      CLAUDECODE: "",
      CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
      CLAUDE_TRANSPORT: "sdk",
      CLAUDE_QUEUE_STEERING: "1",
      CLAUDE_BINARY: executable,
      SWARM_USE_CLAUDE_BRIDGE: "0",
    } as Record<string, string>,
  };
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await Bun.file(path).exists())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(100);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while ((await processIsRunning(pid)) && Date.now() < deadline) await Bun.sleep(100);
  return !(await processIsRunning(pid));
}

async function commandForPid(pid: number): Promise<string> {
  const result = await runChild(["/bin/ps", "-p", String(pid), "-o", "command="], {
    timeoutMs: 1_000,
  });
  return result.stdout.trim();
}

async function processIsRunning(pid: number): Promise<boolean> {
  if (!processExists(pid)) return false;
  const status = await runChild(["/bin/ps", "-p", String(pid), "-o", "stat="], {
    timeoutMs: 1_000,
  });
  const state = status.stdout.trim();
  return state !== "" && !state.startsWith("Z");
}

async function cleanFixturePid(pid: number, marker: string): Promise<void> {
  if (!processExists(pid)) return;
  if (!(await commandForPid(pid)).includes(marker)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function abortQuietly(session: ProviderSession | undefined): Promise<void> {
  if (!session) return;
  await session.abort("live lifecycle cleanup").catch(() => {});
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Claude SDK live lifecycle", () => {
  liveTest(
    "delivers simultaneous queued messages and reports explicit compaction",
    async () => {
      const directory = await temporaryDirectory();
      let session: ProviderSession | undefined;
      try {
        session = await new ClaudeAdapter(async () => {}).createSession(
          liveConfig(
            directory,
            "Reply with INITIAL_ACK. Continue until every queued message is handled.",
          ),
        );
        const events: ProviderEvent[] = [];
        let completedResults = 0;
        let warmupDelivery: ReturnType<NonNullable<ProviderSession["deliverSteering"]>>;
        let compactionRequested = false;
        let markersRequested = false;
        let compactionDelivery: ReturnType<NonNullable<ProviderSession["deliverSteering"]>>;
        let markerDeliveries: Promise<unknown[]>;
        session.onEvent((event) => {
          events.push(event);
          if (event.type === "result") completedResults++;
          if (event.type === "result" && completedResults === 1) {
            warmupDelivery = session!.deliverSteering!({
              mode: "queue",
              text: "Reply with SECOND_ACK only.",
            });
          }
          if (event.type === "result" && completedResults === 2 && !compactionRequested) {
            compactionRequested = true;
            compactionDelivery = session!.deliverSteering!({ mode: "queue", text: "/compact" });
          }
          if (event.type === "compaction" && !markersRequested) {
            markersRequested = true;
            markerDeliveries = Promise.all([
              session!.deliverSteering!({
                mode: "queue",
                text: "Reply with both exact markers QUEUE_ALPHA and QUEUE_BETA.",
              }),
              session!.deliverSteering!({
                mode: "queue",
                text: "Confirm both exact markers QUEUE_ALPHA and QUEUE_BETA.",
              }),
            ]);
          }
        });
        const result = await settleWithin(session.waitForCompletion(), 90_000);
        expect(await warmupDelivery!).toEqual({ delivered: true, mode: "queue" });
        expect(await compactionDelivery!).toEqual({ delivered: true, mode: "queue" });
        expect(await markerDeliveries!).toEqual([
          { delivered: true, mode: "queue" },
          { delivered: true, mode: "queue" },
        ]);
        expect(result).toMatchObject({ exitCode: 0, isError: false });
        expect(result.output).toContain("QUEUE_ALPHA");
        expect(result.output).toContain("QUEUE_BETA");
        expect(events.some((event) => event.type === "compaction")).toBeTrue();
        const compaction = events.find((event) => event.type === "compaction");
        if (compaction?.type === "compaction") {
          console.log(
            JSON.stringify({
              probe: "claude-sdk-compaction",
              preCompactTokens: compaction.preCompactTokens,
              trigger: compaction.compactTrigger,
            }),
          );
        }
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "session_init",
            providerMeta: { transport: "sdk" },
          }),
        );
      } finally {
        await abortQuietly(session);
      }
    },
    { timeout: 100_000 },
  );

  liveTest(
    "cancels the Claude fixture and its child process",
    async () => {
      const directory = await temporaryDirectory();
      const stateFile = join(directory, "fixture-pids.json");
      await Bun.write(
        join(directory, "hold.ts"),
        `const child = Bun.spawn(["/bin/sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });\n` +
          `await Bun.write(process.argv[2], JSON.stringify({ fixturePid: process.pid, childPid: child.pid }));\n` +
          `await child.exited;\n`,
      );
      let session: ProviderSession | undefined;
      let fixturePid: number | undefined;
      let childPid: number | undefined;
      try {
        session = await new ClaudeAdapter(async () => {}).createSession(
          liveConfig(
            directory,
            "Use Bash to run exactly: bun hold.ts fixture-pids.json. Wait for it to finish.",
          ),
        );
        await waitForFile(stateFile, 45_000);
        const pids = JSON.parse(await Bun.file(stateFile).text()) as {
          fixturePid: number;
          childPid: number;
        };
        fixturePid = pids.fixturePid;
        childPid = pids.childPid;
        expect(processExists(fixturePid)).toBeTrue();
        expect(processExists(childPid)).toBeTrue();

        const cancellationStartedAt = performance.now();
        await settleWithin(session.abort("live fixture cancellation"), 5_000);
        const cancellationElapsedMs = Math.round(performance.now() - cancellationStartedAt);
        expect(cancellationElapsedMs).toBeLessThan(5_000);
        const result = await settleWithin(session.waitForCompletion(), 10_000);
        expect(result).toMatchObject({
          exitCode: 130,
          isError: true,
          errorCategory: "cancelled",
          failureReason: "live fixture cancellation",
        });
        expect(await waitForProcessExit(fixturePid, 5_000)).toBeTrue();
        expect(await waitForProcessExit(childPid, 5_000)).toBeTrue();
        console.log(
          JSON.stringify({
            probe: "claude-sdk-cancellation",
            cancellationElapsedMs,
            fixtureExited: true,
            childExited: true,
          }),
        );
      } finally {
        await abortQuietly(session);
        if (fixturePid) await cleanFixturePid(fixturePid, "hold.ts");
        if (childPid) await cleanFixturePid(childPid, "/bin/sleep 60");
      }
    },
    { timeout: 75_000 },
  );
});
