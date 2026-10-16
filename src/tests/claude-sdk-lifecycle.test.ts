import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter, getTaskFilePath } from "../providers/claude-adapter";
import { userClaudeMdExclude } from "../providers/claude-flag-settings";
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
      CLAUDE_CODE_OAUTH_TOKEN: "example-fixture-oauth-token",
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

// Every session seeds Claude trust into `$HOME/.claude.json`; keep that off the real home.
let originalHome: string | undefined;
let homeDir: string;

beforeEach(async () => {
  originalHome = process.env.HOME;
  homeDir = await temporaryDirectory();
  process.env.HOME = homeDir;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
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
      // The SDK forwards `settings` as `--settings`: Claude skips both agent CLAUDE.md copies.
      const settingsAt = fixtureState.argv.indexOf("--settings");
      expect(settingsAt).toBeGreaterThan(-1);
      expect(JSON.parse(fixtureState.argv[settingsAt + 1] ?? "")).toMatchObject({
        claudeMdExcludes: ["/workspace/CLAUDE.md", userClaudeMdExclude()],
      });
    },
    { timeout: CHILD_PROCESS_TEST_BUDGET_MS },
  );

  test(
    "merges caller --settings from additionalArgs and CLAUDE_BINARY into the SDK's one flag",
    async () => {
      const directory = await temporaryDirectory();
      const stateFile = join(directory, "settings-state.json");
      const settingsFile = join(directory, "caller-settings.json");
      await Bun.write(
        settingsFile,
        JSON.stringify({ model: "from-file", claudeMdExcludes: ["/repo/CLAUDE.md"] }),
      );
      const sessionConfig = config(directory, "queue", stateFile);
      sessionConfig.env = {
        ...sessionConfig.env,
        CLAUDE_BINARY: `${process.execPath} ${fixturePath} --settings ${settingsFile}`,
      };
      sessionConfig.additionalArgs = [
        `--settings=${JSON.stringify({ env: { X: "kept" }, claudeMdExcludes: ["/other/CLAUDE.md"] })}`,
      ];
      const session = await new ClaudeAdapter(async () => {}).createSession(sessionConfig);
      // Queue mode records argv once it has the initial plus two queued messages.
      await session.deliverSteering?.({ mode: "queue", text: "queued-message-a" });
      await session.deliverSteering?.({ mode: "queue", text: "queued-message-b" });
      await session.waitForCompletion();

      await waitForFile(stateFile);
      const { argv } = JSON.parse(await Bun.file(stateFile).text()) as { argv: string[] };
      const settingsFlags = argv.filter(
        (arg) => arg === "--settings" || arg.startsWith("--settings="),
      );
      expect(settingsFlags).toEqual(["--settings"]);
      expect(JSON.parse(argv[argv.indexOf("--settings") + 1] ?? "")).toEqual({
        model: "from-file",
        env: { X: "kept" },
        claudeMdExcludes: [
          "/repo/CLAUDE.md",
          "/other/CLAUDE.md",
          "/workspace/CLAUDE.md",
          userClaudeMdExclude(),
        ],
      });
      expect(argv).not.toContain(settingsFile);
      // The version probe carries the same merged settings value.
      const spawns = (await Bun.file(`${stateFile}.spawns`).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const probe = spawns.find((args) => args.at(-1) === "--version") ?? [];
      expect(probe).toEqual([
        "--settings",
        argv[argv.indexOf("--settings") + 1] ?? "",
        "--version",
      ]);
    },
    { timeout: CHILD_PROCESS_TEST_BUDGET_MS },
  );

  test(
    "invalid caller --settings refuses to start: no Claude child spawns",
    async () => {
      const directory = await temporaryDirectory();
      // Built at runtime so no single source literal looks like a credential.
      const sentinel = ["settings", "sentinel", crypto.randomUUID()].join("-");
      await Bun.write(join(directory, "broken.json"), "{nope");
      await Bun.write(join(directory, "array.json"), "[1]");
      const cases: [string[], string][] = [
        [["--settings", "missing.json"], "cannot be read (ENOENT)"],
        [["--settings", "broken.json"], "is not valid JSON"],
        [["--settings", `{"env":{"TOKEN":"${sentinel}"`], "is not valid JSON"],
        [["--settings=array.json"], "is not a JSON object"],
        [["--settings", "--max-turns", "3"], "--settings has no value"],
        [["--settings", '--settings={"model":"x"}'], "--settings has no value"],
      ];
      for (const [index, [additionalArgs, message]] of cases.entries()) {
        const stateFile = join(directory, `invalid-${index}.json`);
        const sessionConfig = { ...config(directory, "cancel", stateFile), additionalArgs };
        let summaries = 0;
        const error = await new ClaudeAdapter(async () => {
          summaries++;
        })
          .createSession(sessionConfig)
          .then(
            () => undefined,
            (err: unknown) => err,
          );

        expect((error as Error).name).toBe("ClaudeSettingsConfigError");
        expect((error as Error).message).toContain(message);
        expect((error as Error).message).not.toContain(sentinel);
        // The fixture records every start, the `--version` probe included.
        expect(await Bun.file(`${stateFile}.spawns`).exists()).toBeFalse();
        expect(summaries).toBe(0);
        expect(
          await Bun.file(getTaskFilePath(`${process.pid}-${sessionConfig.taskId}`)).exists(),
        ).toBeFalse();
      }
    },
    { timeout: CHILD_PROCESS_TEST_BUDGET_MS },
  );

  test(
    "invalid CLAUDE_BINARY prefix --settings never reaches logs, errors, or a spawn",
    async () => {
      const directory = await temporaryDirectory();
      const sentinel = ["prefix", "sentinel", crypto.randomUUID()].join("-");
      const inline = `{"env":{"TOKEN":"${sentinel}"`;
      const logged: string[] = [];
      const capture = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
      const logSpy = spyOn(console, "log").mockImplementation(capture);
      const warnSpy = spyOn(console, "warn").mockImplementation(capture);
      const errorSpy = spyOn(console, "error").mockImplementation(capture);
      try {
        for (const [index, flag] of [`--settings=${inline}`, `--settings ${inline}`].entries()) {
          const stateFile = join(directory, `prefix-${index}.json`);
          const sessionConfig = config(directory, "cancel", stateFile);
          sessionConfig.env = {
            ...sessionConfig.env,
            CLAUDE_BINARY: `${process.execPath} ${fixturePath} ${flag}`,
          };
          const error = await new ClaudeAdapter(async () => {}).createSession(sessionConfig).then(
            () => undefined,
            (err: unknown) => err,
          );

          expect((error as Error).name).toBe("ClaudeSettingsConfigError");
          expect((error as Error).message).toContain("inline JSON is not valid JSON");
          expect((error as Error).message).not.toContain(sentinel);
          expect(await Bun.file(`${stateFile}.spawns`).exists()).toBeFalse();
        }
      } finally {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
      expect(logged.filter((line) => line.includes(sentinel))).toEqual([]);
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

  test(
    "SDK session seeds workspace trust",
    async () => {
      const directory = await temporaryDirectory();
      const session = await new ClaudeAdapter(async () => {}).createSession(
        config(directory, "cancel", join(directory, "trust-state.json")),
      );
      await session.abort("done");
      await session.waitForCompletion();
      const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
      expect(data.projects[await realpath(directory)].hasTrustDialogAccepted).toBe(true);
    },
    { timeout: CHILD_PROCESS_TEST_BUDGET_MS },
  );

  test(
    "SDK session with CLAUDE_TRUST_PRESEED=false writes nothing",
    async () => {
      const directory = await temporaryDirectory();
      const fixtureConfig = config(directory, "cancel", join(directory, "off-state.json"));
      fixtureConfig.env = { ...fixtureConfig.env, CLAUDE_TRUST_PRESEED: "false" };
      const session = await new ClaudeAdapter(async () => {}).createSession(fixtureConfig);
      await session.abort("done");
      await session.waitForCompletion();
      expect(await Bun.file(join(homeDir, ".claude.json")).exists()).toBe(false);
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
