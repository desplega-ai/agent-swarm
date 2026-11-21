import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../providers/codex-adapter";
import type { ProviderEvent, ProviderSession } from "../providers/types";
import {
  resetRuntimeModelCatalogForTests,
  setRuntimeModelCatalog,
} from "../utils/runtime-model-catalog";
import { CHILD_PROCESS_TEST_BUDGET_MS } from "./test-proc";

const originalArgv = process.env.AGENT_SWARM_CODEX_RUNNER_ARGV;
const sessions: ProviderSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.abort("test cleanup")));
  if (originalArgv === undefined) delete process.env.AGENT_SWARM_CODEX_RUNNER_ARGV;
  else process.env.AGENT_SWARM_CODEX_RUNNER_ARGV = originalArgv;
});

async function createSession(prompt = "accept", fixture = "codex-session-runner.ts") {
  process.env.AGENT_SWARM_CODEX_RUNNER_ARGV = JSON.stringify([
    process.execPath,
    new URL(`./fixtures/${fixture}`, import.meta.url).pathname,
  ]);
  const session = await new CodexAdapter().createSession({
    agentId: crypto.randomUUID(),
    prompt,
    systemPrompt: "Test session",
    cwd: "/private/tmp",
    logFile: "/dev/null",
  });
  sessions.push(session);
  return session;
}

describe("Codex subprocess control channel", () => {
  test(
    "pending queue acknowledgement does not block steering or cancellation",
    async () => {
      const session = await createSession("accept", "codex-deferred-queue-runner.ts");
      const queueReceived = Promise.withResolvers<void>();
      session.onEvent((event) => {
        if (event.type === "message" && event.content === "queue pending") queueReceived.resolve();
      });
      let acknowledged = false;
      const delivery = session.deliverSteering!({ mode: "queue", text: "next turn" });
      void delivery.then(() => {
        acknowledged = true;
      });
      await queueReceived.promise;
      expect(acknowledged).toBe(false);
      expect(await session.deliverSteering!({ mode: "steer", text: "current turn" })).toEqual({
        delivered: true,
        mode: "steer",
      });
      await session.abort("operator cancelled");
      expect(await delivery).toMatchObject({ delivered: false });
      expect(await session.waitForCompletion()).toMatchObject({
        exitCode: 130,
        failureReason: "operator cancelled",
      });
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "delivers native steer and queue requests and cancels gracefully",
    async () => {
      const session = await createSession();
      expect(session.steeringDeliveredExternally).not.toBe(true);
      expect(await session.deliverSteering?.({ mode: "steer", text: "Change approach" })).toEqual({
        delivered: true,
        mode: "steer",
      });
      expect(
        await session.deliverSteering?.({ mode: "queue", text: "Then check results" }),
      ).toEqual({ delivered: true, mode: "queue" });
      expect(session.sessionId).toBe("test-codex-thread");
      await session.abort("User cancelled");
      expect(await session.waitForCompletion()).toMatchObject({
        isError: false,
        output: "User cancelled",
      });
      expect(await session.deliverSteering?.({ mode: "steer", text: "Too late" })).toMatchObject({
        delivered: false,
      });
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "returns the child rejection without claiming delivery",
    async () => {
      const session = await createSession("reject");
      expect(await session.deliverSteering?.({ mode: "steer", text: "Change approach" })).toEqual({
        delivered: false,
        reason: "Turn is no longer active",
      });
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "resolves pending delivery when the child exits unexpectedly",
    async () => {
      const session = await createSession("exit");
      expect(
        await session.deliverSteering?.({ mode: "steer", text: "Change approach" }),
      ).toMatchObject({ delivered: false });
      expect(await session.waitForCompletion()).toMatchObject({ exitCode: 7, isError: true });
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});

test(
  "isolated Codex session forwards live-only effort and records the thread settings",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-live-effort-"));
    const model = "gpt-live-catalog-fixture";
    const requests = join(home, "requests.jsonl");
    const events: ProviderEvent[] = [];
    try {
      setRuntimeModelCatalog({
        openai: {
          models: {
            [model]: {
              reasoning: true,
              reasoning_options: [{ type: "effort", values: ["low", "max"] }],
            },
          },
        },
      });
      process.env.AGENT_SWARM_CODEX_RUNNER_ARGV = JSON.stringify([
        process.execPath,
        "-e",
        'import { runCodexSessionRunner } from "./src/commands/codex-session-runner"; await runCodexSessionRunner();',
      ]);
      const session = await new CodexAdapter().createSession({
        agentId: crypto.randomUUID(),
        taskId: crypto.randomUUID(),
        apiUrl: "http://localhost:0",
        apiKey: "fixture",
        role: "worker",
        model,
        reasoningEffort: "max",
        prompt: "hello",
        systemPrompt: "",
        cwd: home,
        logFile: join(home, "session.log"),
        env: {
          CODEX_HOME: home,
          HOME: home,
          CODEX_PATH_OVERRIDE: join(import.meta.dir, "fixtures/fake-codex-app-server.ts"),
          CODEX_GATEWAY_BASE_URL: "http://127.0.0.1:9/v1",
          CODEX_GATEWAY_API_KEY: "fixture",
          FAKE_CODEX_REQUESTS: requests,
        },
      });
      sessions.push(session);
      session.onEvent((event) => events.push(event));
      const result = await session.waitForCompletion();
      expect(result.exitCode).toBe(0);
      const [thread, turn] = (await Bun.file(requests).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(thread.config.model_reasoning_effort).toBe("max");
      expect(turn.effort).toBe("max");
      expect(result.appliedReasoningEffort).toBe("max");
      expect(events.filter((e) => e.type === "session_init")).toMatchObject([
        {
          sessionId: "thread-1",
          harnessVariantMeta: {
            observedModel: "thread-model-fixture",
            observedReasoningEffort: "low",
          },
        },
      ]);
      expect(
        events.some(
          (e) => e.type === "raw_stderr" && e.content.includes("low") && e.content.includes("max"),
        ),
      ).toBe(true);
    } finally {
      resetRuntimeModelCatalogForTests();
      await rm(home, { recursive: true, force: true });
    }
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);
