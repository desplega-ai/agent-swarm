import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { WebhookOptions } from "chat";
import { keepDiscordInfoLine } from "../integrations/chat-sdk/adapters";
import { drainBackground } from "../integrations/chat-sdk/background";
import {
  type DiscordGatewayListener,
  getDiscordGatewayHealth,
  startDiscordGateway,
  stopDiscordGateway,
} from "../integrations/chat-sdk/discord-gateway";
import { createScrubbingLogger, withInfoFilter } from "../integrations/chat-sdk/logger";

/**
 * A stand-in for the Discord adapter. Like the real one, it answers at once
 * and hands the listener window to `waitUntil`. A window resolves after its
 * duration or on abort, and never rejects. `innerMs` maps the call index to
 * the window duration.
 */
function stubAdapter(innerMs: number | ((call: number) => number) = 20) {
  const calls: { durationMs?: number; signal?: AbortSignal }[] = [];
  const adapter: DiscordGatewayListener = {
    async startGatewayListener(options: WebhookOptions, durationMs?: number, signal?: AbortSignal) {
      const ms = typeof innerMs === "function" ? innerMs(calls.length) : innerMs;
      calls.push({ durationMs, signal });
      const inner = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      options.waitUntil?.(inner);
      return new Response(JSON.stringify({ status: "listening" }), { status: 200 });
    },
  };
  return { adapter, calls };
}

/** Resolves on `signal` abort, so an injected sleep never outlives its loop. */
function onAbort(signal: AbortSignal, resolve: () => void): void {
  signal.addEventListener("abort", () => resolve(), { once: true });
}

/** Resolves when `predicate` holds, polling on the event loop (no fixed sleep). */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

afterEach(async () => {
  stopDiscordGateway();
  await drainBackground(1_000);
});

describe("Discord gateway loop", () => {
  test("re-arms the listener after each window and counts restarts", async () => {
    const { adapter, calls } = stubAdapter();
    // Each window looks 30 s long, so no backoff runs.
    let clock = 0;
    const now = () => {
      clock += 30_000;
      return clock;
    };
    const sleeps: number[] = [];
    startDiscordGateway(adapter, {
      windowMs: 60_000,
      now,
      sleep: (ms, signal) =>
        new Promise<void>((resolve) => {
          sleeps.push(ms);
          onAbort(signal, resolve);
          resolve();
        }),
    });

    await waitFor(() => calls.length >= 3);
    expect(calls[0]!.durationMs).toBe(60_000);
    // Each window gets its own signal, not the loop's.
    expect(calls[0]!.signal).not.toBe(calls[1]!.signal);
    expect(sleeps).toEqual([]);
    const health = getDiscordGatewayHealth();
    expect(health?.state).toBe("running");
    expect(health?.restarts).toBeGreaterThanOrEqual(2);
  });

  test("backs off for 30 s when a window ends in under 10 s", async () => {
    // The first window ends after 20 ms. Later windows only end on abort.
    const { adapter, calls } = stubAdapter((call) => (call === 0 ? 20 : 60_000));
    const sleeps: number[] = [];
    let releaseSleep: (() => void) | undefined;
    startDiscordGateway(adapter, {
      sleep: (ms, signal) => {
        sleeps.push(ms);
        // Hold the loop in backoff until the test releases it or the loop stops.
        return new Promise<void>((resolve) => {
          releaseSleep = resolve;
          onAbort(signal, resolve);
        });
      },
    });

    await waitFor(() => sleeps.length === 1);
    expect(sleeps).toEqual([30_000]);
    expect(calls).toHaveLength(1);
    expect(getDiscordGatewayHealth()?.state).toBe("backoff");

    releaseSleep?.();
    await waitFor(() => calls.length === 2);
    expect(getDiscordGatewayHealth()?.restarts).toBe(1);
    expect(getDiscordGatewayHealth()?.state).toBe("running");
  });

  test("stops on abort within one iteration and reports stopped", async () => {
    // A window far longer than the test: only the abort can end it.
    const { adapter, calls } = stubAdapter(60_000);
    startDiscordGateway(adapter, {
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) => {
          onAbort(signal, resolve);
          resolve();
        }),
    });
    await waitFor(() => calls.length === 1);
    expect(calls[0]!.signal?.aborted).toBe(false);

    stopDiscordGateway();
    expect(calls[0]!.signal?.aborted).toBe(true);
    // The inner window was tracked for the shutdown drain and is closed now.
    expect(await drainBackground(1_000)).toBe(true);
    await waitFor(() => getDiscordGatewayHealth()?.state === "stopped", 1_000);
    expect(calls).toHaveLength(1);
  });

  test("a listener that refuses to start backs off instead of spinning", async () => {
    let starts = 0;
    const adapter: DiscordGatewayListener = {
      async startGatewayListener() {
        starts += 1;
        return new Response("Chat instance not initialized", { status: 500 });
      },
    };
    const sleeps: number[] = [];
    startDiscordGateway(adapter, {
      // Yields to the timer queue, as the real 30 s sleep does.
      sleep: (ms, signal) => {
        sleeps.push(ms);
        return new Promise((resolve) => {
          setTimeout(resolve, 1);
          onAbort(signal, resolve);
        });
      },
    });
    await waitFor(() => starts >= 2);
    expect(sleeps.every((ms) => ms === 30_000)).toBe(true);
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
  });

  test("an abort during the real 30 s backoff sleep ends the loop at once", async () => {
    // Production sleep: windows end after 20 ms, so the loop backs off for 30 s.
    const { adapter, calls } = stubAdapter(20);
    startDiscordGateway(adapter);
    await waitFor(() => getDiscordGatewayHealth()?.state === "backoff");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const started = Date.now();
    stopDiscordGateway();
    await waitFor(() => getDiscordGatewayHealth()?.state === "stopped", 500);
    expect(Date.now() - started).toBeLessThan(500);
    expect(calls).toHaveLength(1);
  });

  test("stop returns at once and the drain bounds a window that never closes", async () => {
    let release: (() => void) | undefined;
    let starts = 0;
    const adapter: DiscordGatewayListener = {
      async startGatewayListener(options: WebhookOptions) {
        starts += 1;
        // Ignores the abort signal: only `release` ends this window.
        options.waitUntil?.(
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        );
        return new Response("{}", { status: 200 });
      },
    };
    startDiscordGateway(adapter);
    await waitFor(() => starts === 1);

    const stopStarted = Date.now();
    stopDiscordGateway();
    expect(Date.now() - stopStarted).toBeLessThan(500);

    const drainStarted = Date.now();
    expect(await drainBackground(200)).toBe(false);
    const drainMs = Date.now() - drainStarted;
    expect(drainMs).toBeGreaterThanOrEqual(150);
    expect(drainMs).toBeLessThan(1_000);
    expect(getDiscordGatewayHealth()?.state).toBe("running");

    // Let the loop exit so later tests see an empty background set.
    release?.();
    await waitFor(() => getDiscordGatewayHealth()?.state === "stopped");
    expect(starts).toBe(1);
  });
});

describe("Chat SDK logger", () => {
  test("the Discord info filter drops noisy lines and keeps the others", () => {
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      const logger = withInfoFilter(createScrubbingLogger("discord"), keepDiscordInfoLine);
      logger.info("Discord Gateway message received", { content: "private guild text" });
      logger.child("gateway").info("Discord signature verification attempt", { publicKey: "k" });
      logger.info("Discord Gateway connected", { username: "bot" });
      expect(info).toHaveBeenCalledTimes(1);
      expect(info.mock.calls[0]?.[1]).toBe("Discord Gateway connected");
    } finally {
      info.mockRestore();
    }
  });

  test("warn and error lines pass the filter and carry their cause to the sink", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const issues: string[] = [];
      const logger = withInfoFilter(
        createScrubbingLogger("discord", (level, message) => issues.push(`${level}: ${message}`)),
        () => false,
      );
      logger.error("Discord Gateway listener error", { error: "Error [TokenInvalid]: bad" });
      logger.warn("Discord webhook verifier rejected the request", new Error("nope"));
      logger.warn("x".repeat(400));
      expect(issues[0]).toBe("error: Discord Gateway listener error: Error [TokenInvalid]: bad");
      expect(issues[1]).toBe("warn: Discord webhook verifier rejected the request: Error: nope");
      expect(issues[2]).toHaveLength("warn: ".length + 300);
      expect(error).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});
