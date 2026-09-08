import { afterEach, describe, expect, test } from "bun:test";
import { CodexAdapter } from "../providers/codex-adapter";
import type { ProviderSession } from "../providers/types";
import { CHILD_PROCESS_TEST_BUDGET_MS } from "./test-proc";

const originalArgv = process.env.AGENT_SWARM_CODEX_RUNNER_ARGV;
const sessions: ProviderSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.abort("test cleanup")));
  if (originalArgv === undefined) delete process.env.AGENT_SWARM_CODEX_RUNNER_ARGV;
  else process.env.AGENT_SWARM_CODEX_RUNNER_ARGV = originalArgv;
});

async function createSession(prompt = "accept") {
  process.env.AGENT_SWARM_CODEX_RUNNER_ARGV = JSON.stringify([
    process.execPath,
    new URL("./fixtures/codex-session-runner.ts", import.meta.url).pathname,
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
