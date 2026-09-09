import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter, getTaskFilePath } from "../providers/claude-adapter";
import type { ProviderEvent, ProviderSessionConfig } from "../providers/types";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

const fixturePath = join(import.meta.dir, "claude-sdk-process.fixture.ts");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "claude-sdk-lifecycle-"));
  temporaryDirectories.push(path);
  return path;
}

function config(
  directory: string,
  mode: "queue" | "cancel" | "stderr-error",
  stateFile: string,
): ProviderSessionConfig {
  return {
    prompt: "initial-message",
    systemPrompt: "",
    model: "claude-haiku-4-5",
    role: "worker",
    agentId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    apiUrl: "",
    apiKey: "",
    cwd: directory,
    logFile: join(directory, `${mode}.jsonl`),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth-token",
      CLAUDE_TRANSPORT: "sdk",
      CLAUDE_QUEUE_STEERING: "1",
      CLAUDE_BINARY: `${process.execPath} ${fixturePath}`,
      CLAUDE_SDK_FIXTURE_MODE: mode,
      CLAUDE_SDK_FIXTURE_STATE_FILE: stateFile,
    },
  };
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await Bun.file(path).exists())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(20);
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

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while ((await processIsRunning(pid)) && Date.now() < deadline) await Bun.sleep(20);
  return !(await processIsRunning(pid));
}

async function processIsRunning(pid: number): Promise<boolean> {
  if (!processExists(pid)) return false;
  const status = await runChild(["/bin/ps", "-p", String(pid), "-o", "stat="], {
    timeoutMs: 1_000,
  });
  const state = status.stdout.trim();
  return state !== "" && !state.startsWith("Z");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Claude SDK production adapter lifecycle", () => {
  test(
    "delivers simultaneous queued input and preserves compaction",
    async () => {
      const directory = await temporaryDirectory();
      const stateFile = join(directory, "queue-state.json");
      const session = await new ClaudeAdapter(async () => {}).createSession(
        config(directory, "queue", stateFile),
      );
      const events: ProviderEvent[] = [];
      session.onEvent((event) => events.push(event));

      const deliveries = await Promise.all([
        session.deliverSteering?.({ mode: "queue", text: "queued-message-a" }),
        session.deliverSteering?.({ mode: "queue", text: "queued-message-b" }),
      ]);
      expect(deliveries).toEqual([
        { delivered: true, mode: "queue" },
        { delivered: true, mode: "queue" },
      ]);

      const result = await session.waitForCompletion();
      expect(result).toMatchObject({
        exitCode: 0,
        isError: false,
        output: "accepted:queued-message-b",
      });
      expect(result.cost).toMatchObject({ totalCostUsd: 0.003, numTurns: 3 });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session_init",
          providerMeta: { transport: "sdk" },
        }),
      );
      expect(events).toContainEqual({
        type: "compaction",
        preCompactTokens: 1234,
        compactTrigger: "auto",
        contextTotalTokens: 200_000,
      });
      await waitForFile(stateFile);
      const fixtureState = JSON.parse(await Bun.file(stateFile).text()) as {
        argv: string[];
        userMessages: string[];
      };
      expect(fixtureState.userMessages).toEqual([
        "initial-message",
        "queued-message-a",
        "queued-message-b",
      ]);
      expect(
        fixtureState.argv.some(
          (argument, index) =>
            argument === "--system-prompt" && fixtureState.argv[index + 1] === "",
        ),
      ).toBeFalse();
    },
    { timeout: CHILD_PROCESS_TEST_BUDGET_MS },
  );

  test(
    "classifies cancellation and stops the fixture process group",
    async () => {
      const directory = await temporaryDirectory();
      const stateFile = join(directory, "cancel-state.json");
      const session = await new ClaudeAdapter(async () => {}).createSession(
        config(directory, "cancel", stateFile),
      );
      await waitForFile(stateFile);
      const pids = JSON.parse(await Bun.file(stateFile).text()) as {
        fixturePid: number;
        childPid: number;
      };
      expect(processExists(pids.fixturePid)).toBeTrue();
      expect(processExists(pids.childPid)).toBeTrue();

      await session.abort("fixture cancellation");
      const result = await session.waitForCompletion();
      expect(result).toMatchObject({
        exitCode: 130,
        isError: true,
        errorCategory: "cancelled",
        failureReason: "fixture cancellation",
      });
      expect(await waitForProcessExit(pids.fixturePid)).toBeTrue();
      expect(await waitForProcessExit(pids.childPid)).toBeTrue();
    },
    { timeout: CHILD_PROCESS_TEST_BUDGET_MS },
  );

  test(
    "keeps SDK queue delivery when the wrapper version is unknown",
    async () => {
      const directory = await temporaryDirectory();
      const stateFile = join(directory, "unknown-version-state.json");
      const fixtureConfig = config(directory, "queue", stateFile);
      const unknownVersionEnv = { ...fixtureConfig.env } as Record<string, string>;
      delete unknownVersionEnv.CLAUDE_QUEUE_STEERING;
      unknownVersionEnv.CLAUDE_SDK_FIXTURE_UNKNOWN_VERSION = "1";
      fixtureConfig.env = unknownVersionEnv;
      const session = await new ClaudeAdapter(async () => {}).createSession(fixtureConfig);
      expect(session.deliverSteering).toBeFunction();
      await Promise.all([
        session.deliverSteering?.({ mode: "queue", text: "queued-message-a" }),
        session.deliverSteering?.({ mode: "queue", text: "queued-message-b" }),
      ]);
      expect((await session.waitForCompletion()).exitCode).toBe(0);
    },
    { timeout: CHILD_PROCESS_TEST_BUDGET_MS },
  );

  test("rejects protocol arguments before staging session files", async () => {
    const directory = await temporaryDirectory();
    const stateFile = join(directory, "invalid-args-state.json");
    const fixtureConfig = config(directory, "queue", stateFile);
    fixtureConfig.additionalArgs = ["--resume", "native-session"];
    await expect(new ClaudeAdapter(async () => {}).createSession(fixtureConfig)).rejects.toThrow(
      /does not accept '--resume'/,
    );
    expect(
      await Bun.file(getTaskFilePath(`${process.pid}-${fixtureConfig.taskId}`)).exists(),
    ).toBeFalse();
  });

  test("rejects protocol arguments in the executable prefix before staging", async () => {
    const directory = await temporaryDirectory();
    const stateFile = join(directory, "invalid-prefix-state.json");
    const fixtureConfig = config(directory, "queue", stateFile);
    fixtureConfig.env = {
      ...fixtureConfig.env,
      CLAUDE_BINARY: `${process.execPath} ${fixturePath} --resume native-session`,
    } as Record<string, string>;
    await expect(new ClaudeAdapter(async () => {}).createSession(fixtureConfig)).rejects.toThrow(
      /does not accept '--resume'/,
    );
    expect(
      await Bun.file(getTaskFilePath(`${process.pid}-${fixtureConfig.taskId}`)).exists(),
    ).toBeFalse();
  });

  test(
    "honors the explicit SDK queue kill switch",
    async () => {
      const directory = await temporaryDirectory();
      const stateFile = join(directory, "queue-disabled-state.json");
      const fixtureConfig = config(directory, "cancel", stateFile);
      fixtureConfig.env = {
        ...fixtureConfig.env,
        CLAUDE_QUEUE_STEERING: "0",
      } as Record<string, string>;
      const session = await new ClaudeAdapter(async () => {}).createSession(fixtureConfig);
      expect(session.deliverSteering).toBeUndefined();
      await waitForFile(stateFile);
      await session.abort("queue disabled cleanup");
      await session.waitForCompletion();
    },
    { timeout: CHILD_PROCESS_TEST_BUDGET_MS },
  );

  test(
    "drains and classifies stderr before closing the session log",
    async () => {
      const directory = await temporaryDirectory();
      const stateFile = join(directory, "stderr-state.json");
      const fixtureConfig = config(directory, "stderr-error", stateFile);
      const session = await new ClaudeAdapter(async () => {}).createSession(fixtureConfig);
      const result = await session.waitForCompletion();
      expect(result).toMatchObject({
        exitCode: 1,
        isError: true,
        errorCategory: "error_during_execution",
      });
      expect(result.failureReason).toContain("Error during execution");
      expect(await Bun.file(fixtureConfig.logFile).text()).toContain(
        "rate limit exceeded in fixture stderr tail",
      );
    },
    { timeout: CHILD_PROCESS_TEST_BUDGET_MS },
  );
});
