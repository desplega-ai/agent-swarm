import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SocketModeClient } from "@slack/socket-mode";
import { ErrorCode } from "@slack/web-api";
import { pollUntil } from "../../scripts/e2e/http";
import { startSlackMock, stopSlackMock } from "../../scripts/e2e/slack";
import { closeDb, initDb } from "../be/db";
import {
  _getSlackSocketClientForTests,
  _setSlackSocketWatchdogOptionsForTests,
  createSlackSocketWatchdog,
  getSlackApp,
  isSlackSocketWatchdogRunning,
  SLACK_SOCKET_WATCHDOG_DEFAULTS,
  type SlackSocketWatchdogDeps,
  slackWatchdogBackoffMs,
  startSlackApp,
  stopSlackApp,
} from "../slack/app";
import {
  getSlackConnectionState,
  getSlackLastConnectedAt,
  type SlackConnectionState,
  setSlackConnectionState,
} from "../slack/connection-state";
import { isSlackLifecycleBusy, runSlackLifecycleExclusive } from "../slack/lifecycle-lock";

const SEC = 1000;
const MIN = 60 * SEC;

type Harness = {
  deps: SlackSocketWatchdogDeps;
  lines: string[];
  restarts: number;
  clock: { now: number };
  set: (patch: Partial<{ state: SlackConnectionState; active: boolean; busy: boolean }>) => void;
  setActivity: (at: number | null) => void;
};

function harness(onRestart?: (h: Harness) => void): Harness {
  let state: SlackConnectionState = "connected";
  let active = true;
  let busy = false;
  let activityAt: number | null = 0;
  const h: Harness = {
    lines: [],
    restarts: 0,
    clock: { now: 0 },
    set: (patch) => {
      state = patch.state ?? state;
      active = patch.active ?? active;
      busy = patch.busy ?? busy;
    },
    setActivity: (at) => {
      activityAt = at;
    },
    deps: {
      now: () => h.clock.now,
      getState: () => state,
      getLastActivityAt: () => activityAt,
      isSocketActive: () => active,
      isLifecycleBusy: () => busy,
      restart: async () => {
        h.restarts += 1;
        onRestart?.(h);
      },
      log: (line) => h.lines.push(line),
    },
  };
  return h;
}

/** Advance the fake clock in watchdog ticks up to `ms` from now. */
async function run(
  h: Harness,
  watchdog: ReturnType<typeof createSlackSocketWatchdog>,
  ms: number,
): Promise<void> {
  const end = h.clock.now + ms;
  // Tick at the start time too, so an outage set just before `run` starts there.
  await watchdog.tick();
  while (h.clock.now < end) {
    h.clock.now += SLACK_SOCKET_WATCHDOG_DEFAULTS.tickMs;
    await watchdog.tick();
  }
}

describe("socket watchdog state machine", () => {
  test("backoff doubles from 30s and caps at 5 min", () => {
    const o = SLACK_SOCKET_WATCHDOG_DEFAULTS;
    expect([1, 2, 3, 4, 5, 6, 10].map((k) => slackWatchdogBackoffMs(k, o))).toEqual([
      30 * SEC,
      60 * SEC,
      120 * SEC,
      240 * SEC,
      5 * MIN,
      5 * MIN,
      5 * MIN,
    ]);
  });

  test("restarts only after 60s down, backs off, and resets on recovery", async () => {
    const h = harness();
    const watchdog = createSlackSocketWatchdog(h.deps);
    h.set({ state: "connecting" });

    await run(h, watchdog, 55 * SEC);
    expect(h.restarts).toBe(0);

    await run(h, watchdog, 5 * SEC);
    expect(h.lines).toEqual(["[Slack] watchdog: socket down for 60s, restarting (attempt 1)"]);

    // Next attempts at +30s and then +60s after that.
    await run(h, watchdog, 25 * SEC);
    expect(h.restarts).toBe(1);
    await run(h, watchdog, 5 * SEC);
    expect(h.restarts).toBe(2);
    await run(h, watchdog, 55 * SEC);
    expect(h.restarts).toBe(2);
    await run(h, watchdog, 5 * SEC);
    expect(h.restarts).toBe(3);
    expect(h.lines.at(-1)).toBe("[Slack] watchdog: socket down for 150s, restarting (attempt 3)");

    // Recovery: exactly one line, and the attempt counter resets.
    h.set({ state: "connected" });
    h.setActivity(h.clock.now);
    await run(h, watchdog, 20 * SEC);
    expect(h.lines.filter((l) => l.includes("recovered"))).toEqual([
      "[Slack] watchdog: recovered after 150s",
    ]);
    expect(watchdog.attempts()).toBe(0);

    // A fresh outage starts from attempt 1 with a 30s backoff again.
    h.set({ state: "disconnected" });
    await run(h, watchdog, 60 * SEC);
    expect(h.lines.at(-1)).toBe("[Slack] watchdog: socket down for 60s, restarting (attempt 1)");
    await run(h, watchdog, 30 * SEC);
    expect(h.lines.at(-1)).toBe("[Slack] watchdog: socket down for 90s, restarting (attempt 2)");
  });

  test("a short blip logs nothing", async () => {
    const h = harness();
    const watchdog = createSlackSocketWatchdog(h.deps);
    h.set({ state: "connecting" });
    await run(h, watchdog, 30 * SEC);
    h.set({ state: "connected" });
    await run(h, watchdog, 30 * SEC);
    expect(h.lines).toEqual([]);
    expect(h.restarts).toBe(0);
  });

  test("no restart while a config reload holds the lifecycle lock", async () => {
    const h = harness();
    const watchdog = createSlackSocketWatchdog(h.deps);
    h.set({ state: "disconnected", busy: true });
    await run(h, watchdog, 10 * MIN);
    expect(h.restarts).toBe(0);
    expect(h.lines).toEqual([]);

    h.set({ busy: false });
    await run(h, watchdog, SEC * 5);
    // Down time counts from the first tick the watchdog could act on.
    await run(h, watchdog, 60 * SEC);
    expect(h.restarts).toBe(1);
  });

  test("no restart for a connected, quiet socket that the client reports active", async () => {
    const h = harness();
    const watchdog = createSlackSocketWatchdog(h.deps);
    h.setActivity(0);
    h.set({ state: "connected", active: true });
    await run(h, watchdog, 8 * 60 * MIN);
    expect(h.restarts).toBe(0);
    expect(h.lines).toEqual([]);
  });

  test("restarts a connected, quiet socket that the client reports closed", async () => {
    const h = harness();
    const watchdog = createSlackSocketWatchdog(h.deps);
    h.setActivity(0);
    h.set({ state: "connected", active: false });
    // Not stale yet: a closed-but-recent socket gets the normal close path.
    await run(h, watchdog, 9 * MIN);
    expect(h.restarts).toBe(0);
    // Stale at 10 min, then 60s of grace.
    await run(h, watchdog, 2 * MIN);
    expect(h.restarts).toBe(1);
    expect(h.lines[0]).toMatch(
      /^\[Slack\] watchdog: socket down for \d+s, restarting \(attempt 1\)$/,
    );
  });

  test("a failing restart is retried after the backoff", async () => {
    const h = harness();
    h.deps.restart = async () => {
      h.restarts += 1;
      throw new Error("apps.connections.open failed");
    };
    const watchdog = createSlackSocketWatchdog(h.deps);
    h.set({ state: "connecting" });
    await run(h, watchdog, 90 * SEC);
    expect(h.restarts).toBe(2);
  });
});

test("a failed restart logs a scrubbed message, never the raw token", async () => {
  // Built at runtime so secret scanners do not flag a literal in the repo.
  const token = ["xoxb", "1234567890", "1234567890123", "AbCdEfGhIjKlMnOpQrStUvWx"].join("-");
  const h = harness();
  h.deps.restart = async () => {
    throw new Error(`An API error occurred: invalid_auth (token ${token})`);
  };
  const watchdog = createSlackSocketWatchdog(h.deps);
  const logged: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  try {
    h.set({ state: "connecting" });
    await run(h, watchdog, 60 * SEC);
  } finally {
    spy.mockRestore();
  }
  const failure = logged.find((line) => line.startsWith("[Slack] watchdog: restart failed:"));
  expect(failure).toBeDefined();
  expect(failure).toContain("invalid_auth");
  expect(failure).not.toContain(token);
  expect(failure).toContain("[REDACTED:");
  // The transition line is unchanged.
  expect(h.lines).toEqual(["[Slack] watchdog: socket down for 60s, restarting (attempt 1)"]);
});

describe("socket watchdog against a live Slack mock", () => {
  afterEach(async () => {
    await stopSlackApp();
    _setSlackSocketWatchdogOptionsForTests();
  });

  test("brings the socket back after a reconnect dies on a RequestError", async () => {
    const slack = await startSlackMock(false);
    initDb(":memory:");
    const saved = { ...process.env };
    try {
      Object.assign(process.env, slack.mock.env);
      process.env.SLACK_DISABLE = "false";
      process.env.SLACK_MODE = "socket";
      _setSlackSocketWatchdogOptionsForTests({
        tickMs: 50,
        downAfterMs: 300,
        backoffBaseMs: 200,
        backoffMaxMs: 1000,
      });

      expect(await startSlackApp()).toBe(true);
      await slack.mock.waitForConnection(10_000);
      expect(getSlackConnectionState()).toBe("connected");
      expect(isSlackSocketWatchdogRunning()).toBe(true);
      const firstConnectedAt = getSlackLastConnectedAt();

      // Reproduce the outage: apps.connections.open now fails with a network
      // RequestError, which @slack/socket-mode treats as unrecoverable during
      // a reconnect.
      const client = _getSlackSocketClientForTests();
      expect(client).not.toBeNull();
      const webClient = (client as unknown as { webClient: { apps: { connections: unknown } } })
        .webClient;
      webClient.apps.connections = {
        open: async () => {
          throw Object.assign(new Error("A request error occurred: ECONNRESET"), {
            code: ErrorCode.RequestError,
          });
        },
      };
      // The library runs the reconnect as `cb.apply(this).then(res)` with no
      // catch, so in production the RequestError becomes an unhandled
      // rejection. Bun's test runner fails a test on any unhandled rejection,
      // so record it here instead. The client's behavior is unchanged: it
      // does not retry again either way.
      const reconnectErrors: unknown[] = [];
      const socketClient = client as unknown as { start: () => Promise<unknown> };
      const realStart = socketClient.start;
      socketClient.start = function (this: unknown) {
        return realStart.apply(this).catch((error: unknown) => {
          reconnectErrors.push(error);
        });
      };
      const opened = slack.mock.apiCalls("apps.connections.open").length;
      slack.mock.disconnectSockets();

      // The client gives up and the state sticks in `connecting`.
      expect(await pollUntil(() => getSlackConnectionState() === "connecting", 10_000, 10)).toBe(
        true,
      );

      // The watchdog rebuilds the app with a fresh client and reconnects.
      expect(
        await pollUntil(
          () => getSlackConnectionState() === "connected" && slack.mock.connectionCount === 1,
          15_000,
          20,
        ),
      ).toBe(true);
      expect(slack.mock.apiCalls("apps.connections.open").length).toBe(opened + 1);
      expect(_getSlackSocketClientForTests()).not.toBe(client);
      expect(getSlackLastConnectedAt()?.getTime()).toBeGreaterThan(firstConnectedAt!.getTime());
      // The reconnect died on the RequestError, as in the outage.
      expect(reconnectErrors.map((e) => (e as { code?: string }).code)).toContain(
        ErrorCode.RequestError,
      );

      // stopSlackApp disarms the watchdog.
      await stopSlackApp();
      expect(isSlackSocketWatchdogRunning()).toBe(false);
    } finally {
      await stopSlackApp();
      process.env = saved;
      await stopSlackMock(slack, false);
      closeDb();
    }
  }, 40_000);

  test("waits for an in-flight lifecycle holder before it restarts", async () => {
    const slack = await startSlackMock(false);
    initDb(":memory:");
    const saved = { ...process.env };
    try {
      Object.assign(process.env, slack.mock.env);
      process.env.SLACK_DISABLE = "false";
      process.env.SLACK_MODE = "socket";
      _setSlackSocketWatchdogOptionsForTests({ tickMs: 20, downAfterMs: 50 });
      expect(await startSlackApp()).toBe(true);
      await slack.mock.waitForConnection(10_000);
      const opened = slack.mock.apiCalls("apps.connections.open").length;

      // Hold the lock like a config reload would, with the state reading down.
      let release!: () => void;
      const held = runSlackLifecycleExclusive(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      setSlackConnectionState("disconnected");
      await Bun.sleep(400);
      expect(slack.mock.apiCalls("apps.connections.open").length).toBe(opened);

      // The "reload" finishes with the socket healthy: no restart follows.
      setSlackConnectionState("connected");
      release();
      await held;
      await Bun.sleep(200);
      expect(slack.mock.apiCalls("apps.connections.open").length).toBe(opened);
    } finally {
      await stopSlackApp();
      process.env = saved;
      await stopSlackMock(slack, false);
      closeDb();
    }
  }, 20_000);

  test("stopSlackApp waits for a watchdog restart in flight, and the app stays stopped", async () => {
    await withLiveSlack({ tickMs: 20, downAfterMs: 50 }, async (slack) => {
      const first = _getSlackSocketClientForTests();
      // Every socket-mode client built from now on waits at the gate before
      // it asks apps.connections.open for a socket URL.
      const gate = gateSocketUrls();
      try {
        setSlackConnectionState("disconnected");
        // The watchdog tears down the app and blocks in the restart's start.
        expect(
          await pollUntil(
            () =>
              isSlackLifecycleBusy() &&
              _getSlackSocketClientForTests() !== null &&
              _getSlackSocketClientForTests() !== first,
            5_000,
            10,
          ),
        ).toBe(true);

        let stopped = false;
        const stopping = stopSlackApp().then(() => {
          stopped = true;
        });
        await Bun.sleep(200);
        // Shutdown waits for the restart; it does not race it.
        expect(stopped).toBe(false);

        gate.release();
        await stopping;
        expect(getSlackApp()).toBeNull();
        expect(isSlackSocketWatchdogRunning()).toBe(false);
        // Nothing brings the app back after stopSlackApp() returned.
        await Bun.sleep(200);
        expect(getSlackApp()).toBeNull();
        expect(await pollUntil(() => slack.mock.connectionCount === 0, 5_000, 20)).toBe(true);
      } finally {
        gate.restore();
      }
    });
  }, 20_000);
});

type LiveSlack = Awaited<ReturnType<typeof startSlackMock>>;

/** Start the Slack app against a mock Slack with a connected socket, run `fn`, and clean up. */
async function withLiveSlack(
  options: Partial<typeof SLACK_SOCKET_WATCHDOG_DEFAULTS>,
  fn: (slack: LiveSlack) => Promise<void>,
): Promise<void> {
  const slack = await startSlackMock(false);
  initDb(":memory:");
  const saved = { ...process.env };
  try {
    Object.assign(process.env, slack.mock.env);
    process.env.SLACK_DISABLE = "false";
    process.env.SLACK_MODE = "socket";
    _setSlackSocketWatchdogOptionsForTests(options);
    expect(await startSlackApp()).toBe(true);
    await slack.mock.waitForConnection(10_000);
    expect(getSlackConnectionState()).toBe("connected");
    await fn(slack);
  } finally {
    await stopSlackApp();
    process.env = saved;
    await stopSlackMock(slack, false);
    closeDb();
  }
}

/**
 * Hold every socket-mode client's socket URL request at a gate. The client
 * opens no socket until the gate is released.
 */
function gateSocketUrls(): { release: () => void; restore: () => void } {
  const proto = SocketModeClient.prototype as unknown as {
    retrieveWSSURL: (this: SocketModeClient) => Promise<string>;
  };
  const real = proto.retrieveWSSURL;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  proto.retrieveWSSURL = async function (this: SocketModeClient) {
    await gate;
    return real.call(this);
  };
  return {
    release,
    restore: () => {
      proto.retrieveWSSURL = real;
    },
  };
}
