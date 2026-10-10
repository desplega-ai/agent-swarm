import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../providers/claude-adapter";
import { BACKGROUND_KEEPALIVE_INTERVAL_MS } from "../providers/claude-background-keepalive";
import type { ProviderResult, ProviderSession, ProviderSessionConfig } from "../providers/types";
import { CHILD_PROCESS_TEST_BUDGET_MS } from "./test-proc";

// These tests go through ClaudeAdapter.createSession, so they cover the wiring
// in each transport: observe() on every parsed message and stop() at teardown.
// A fake Claude binary ends its turn and goes silent; a local server records the
// session heartbeats the keepalive sends while it waits.

const fixturePath = join(import.meta.dir, "claude-background-keepalive.fixture.ts");
const TICK_MS = 20;

// The keepalive pings every 60s. Run its interval at TICK_MS instead; every
// other timer keeps its real period.
const realSetInterval = globalThis.setInterval;
beforeAll(() => {
  globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) =>
    realSetInterval(
      handler,
      timeout === BACKGROUND_KEEPALIVE_INTERVAL_MS ? TICK_MS : timeout,
      ...rest,
    )) as typeof setInterval;
});
afterAll(() => {
  globalThis.setInterval = realSetInterval;
});

const heartbeats = new Map<string, number>();
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const match = new URL(req.url).pathname.match(/^\/api\/active-sessions\/heartbeat\/(.+)$/);
    if (req.method === "PUT" && match?.[1]) {
      const taskId = decodeURIComponent(match[1]);
      heartbeats.set(taskId, (heartbeats.get(taskId) ?? 0) + 1);
    }
    return Response.json({ updated: true });
  },
});
afterAll(() => server.stop(true));

const temporaryDirectories: string[] = [];
let originalHome: string | undefined;

beforeEach(async () => {
  // Every session seeds Claude trust into `$HOME/.claude.json`; keep that off the real home.
  originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "claude-bg-keepalive-home-"));
  temporaryDirectories.push(home);
  process.env.HOME = home;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

type Transport = "cli" | "sdk";

interface Harness {
  session: ProviderSession;
  taskId: string;
  send(command: "empty" | "exit" | "fail"): Promise<void>;
  count(): number;
  completed(): boolean;
  turnEnded(): Promise<void>;
}

async function startSession(transport: Transport, withBackgroundTask: boolean): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "claude-bg-keepalive-"));
  temporaryDirectories.push(directory);
  const controlFile = join(directory, "control");
  const logFile = join(directory, "session.jsonl");
  const taskId = crypto.randomUUID();
  const config: ProviderSessionConfig = {
    prompt: "wait on the background job",
    systemPrompt: "",
    model: "claude-haiku-4-5",
    role: "worker",
    agentId: crypto.randomUUID(),
    taskId,
    apiUrl: `http://127.0.0.1:${server.port}`,
    apiKey: "test-key",
    cwd: directory,
    logFile,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "example-fixture-oauth-token",
      CLAUDE_TRANSPORT: transport,
      CLAUDE_BINARY: `${process.execPath} ${fixturePath}`,
      BG_FIXTURE_TRANSPORT: transport,
      BG_FIXTURE_CONTROL: controlFile,
      BG_FIXTURE_BACKGROUND: withBackgroundTask ? "1" : "0",
    },
  };
  const session = await new ClaudeAdapter(async () => {}).createSession(config);
  let completed = false;
  void session.waitForCompletion().finally(() => {
    completed = true;
  });
  return {
    session,
    taskId,
    completed: () => completed,
    send: (command) => appendFile(controlFile, `${command}\n`),
    count: () => heartbeats.get(taskId) ?? 0,
    // Both transports log every protocol line; the result line marks the end of the turn.
    turnEnded: () =>
      waitFor(async () => {
        const file = Bun.file(logFile);
        return (await file.exists()) && (await file.text()).includes('"type":"result"');
      }, "the fixture's result message"),
  };
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(TICK_MS / 2);
  }
}

/** Waits out in-flight requests, then asserts no further heartbeat arrives. */
async function expectHeartbeatsStopped(harness: Harness): Promise<void> {
  await Bun.sleep(TICK_MS * 3);
  const settled = harness.count();
  await Bun.sleep(TICK_MS * 8);
  expect(harness.count()).toBe(settled);
}

async function liveSessionWithHeartbeats(transport: Transport): Promise<Harness> {
  const harness = await startSession(transport, true);
  await harness.turnEnded();
  // The turn is over and the process is silent; only the keepalive is sending.
  await waitFor(() => harness.count() >= 3, "keepalive heartbeats after the turn ended");
  return harness;
}

describe.each(["cli", "sdk"] as const)("Claude %s transport background keepalive", (transport) => {
  test(
    "heartbeats while a background task stays live after the turn ends, and stops when the set empties",
    async () => {
      const harness = await liveSessionWithHeartbeats(transport);
      try {
        await harness.send("empty");
        await expectHeartbeatsStopped(harness);
        // The session is still running: the empty set stopped the pings, not teardown.
        expect(harness.completed()).toBe(false);
      } finally {
        await harness.send("exit");
        await harness.session.waitForCompletion();
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "normal end stops the keepalive",
    async () => {
      const harness = await liveSessionWithHeartbeats(transport);
      await harness.send("exit");
      const result = await harness.session.waitForCompletion();
      expect(result.isError).toBe(false);
      await expectHeartbeatsStopped(harness);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "error end stops the keepalive",
    async () => {
      const harness = await liveSessionWithHeartbeats(transport);
      await harness.send("fail");
      const result: ProviderResult = await harness.session.waitForCompletion();
      expect(result.exitCode).not.toBe(0);
      await expectHeartbeatsStopped(harness);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "abort stops the keepalive",
    async () => {
      const harness = await liveSessionWithHeartbeats(transport);
      await harness.session.abort();
      await harness.session.waitForCompletion();
      await expectHeartbeatsStopped(harness);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "a session with no background work sends no keepalive heartbeats",
    async () => {
      const harness = await startSession(transport, false);
      try {
        await harness.turnEnded();
        await Bun.sleep(TICK_MS * 10);
        expect(harness.count()).toBe(0);
      } finally {
        await harness.send("exit");
        await harness.session.waitForCompletion();
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
