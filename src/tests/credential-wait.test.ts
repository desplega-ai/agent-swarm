import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { awaitCredentials, BootMaxWaitExceededError } from "../commands/credential-wait";

/**
 * Capture-only logger so test output stays clean and we can assert on
 * specific lines emitted by the loop.
 */
function makeLogger() {
  const lines: string[] = [];
  return {
    fn: (line: string) => lines.push(line),
    lines,
  };
}

/** Track every sleep duration the loop requests so we can assert on backoff. */
function makeSleeper() {
  const calls: number[] = [];
  return {
    fn: (ms: number) => {
      calls.push(ms);
      return Promise.resolve();
    },
    calls,
  };
}

/** Save and restore env vars touched by the loop. */
function withEnv(snapshot: Record<string, string | undefined>) {
  const previous: Record<string, string | undefined> = {};
  for (const k of Object.keys(snapshot)) previous[k] = process.env[k];
  return () => {
    for (const k of Object.keys(snapshot)) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k]!;
    }
  };
}

describe("awaitCredentials", () => {
  let restore: () => void = () => {};

  beforeEach(() => {
    // Wipe any harness creds the test runner might inherit so the loop
    // starts in the "blocked" state for tests that expect it.
    restore = withEnv({
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
      CODEX_OAUTH: undefined,
      DEVIN_API_KEY: undefined,
      DEVIN_ORG_ID: undefined,
    });
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.CODEX_OAUTH;
    delete process.env.DEVIN_API_KEY;
    delete process.env.DEVIN_ORG_ID;
  });

  afterEach(() => {
    restore();
  });

  test("immediate-return when creds are already present", async () => {
    const log = makeLogger();
    const sleeper = makeSleeper();
    let refreshCalls = 0;

    const status = await awaitCredentials({
      provider: "claude",
      initialEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
      refreshEnv: async () => {
        refreshCalls += 1;
        return {};
      },
      sleep: sleeper.fn,
      log: log.fn,
    });

    expect(status.ready).toBe(true);
    expect(refreshCalls).toBe(0);
    expect(sleeper.calls.length).toBe(0);
    expect(log.lines.some((l) => l.startsWith("[boot] credentials ready"))).toBe(true);
  });

  test("loops until refreshEnv yields a valid credential", async () => {
    const log = makeLogger();
    const sleeper = makeSleeper();
    const ticks: Array<{ ready: boolean; missing: string[]; attempt: number }> = [];

    let callCount = 0;
    const status = await awaitCredentials({
      provider: "claude",
      initialEnv: {}, // empty
      refreshEnv: async () => {
        callCount += 1;
        // First two refreshes return nothing; third yields the token.
        if (callCount < 3) return {};
        return { CLAUDE_CODE_OAUTH_TOKEN: "tok" };
      },
      sleep: sleeper.fn,
      log: log.fn,
      onTick: (s, attempt) => ticks.push({ ready: s.ready, missing: [...s.missing], attempt }),
      backoff: { initialMs: 100, maxMs: 1000, maxWaitSeconds: 0 },
    });

    expect(status.ready).toBe(true);
    expect(callCount).toBe(3);
    // Backoff sequence should have doubled until cap: 100ms, 200ms, 400ms.
    expect(sleeper.calls).toEqual([100, 200, 400]);
    // onTick fires per iteration (3 waiting ticks + 1 final ready tick).
    expect(ticks.length).toBe(4);
    expect(ticks[0]!.ready).toBe(false);
    expect(ticks[ticks.length - 1]!.ready).toBe(true);
  });

  test("backoff caps at maxMs", async () => {
    const log = makeLogger();
    const sleeper = makeSleeper();

    let callCount = 0;
    await awaitCredentials({
      provider: "claude",
      initialEnv: {},
      refreshEnv: async () => {
        callCount += 1;
        // Resolve only after 6 iterations.
        if (callCount < 6) return {};
        return { CLAUDE_CODE_OAUTH_TOKEN: "tok" };
      },
      sleep: sleeper.fn,
      log: log.fn,
      backoff: { initialMs: 100, maxMs: 500, maxWaitSeconds: 0 },
    });

    // 100, 200, 400, then capped at 500 forever.
    expect(sleeper.calls).toEqual([100, 200, 400, 500, 500, 500]);
  });

  test("BOOT_MAX_WAIT_SECONDS throws BootMaxWaitExceededError when exceeded", async () => {
    const log = makeLogger();
    let fakeNow = 0;

    await expect(
      awaitCredentials({
        provider: "claude",
        initialEnv: {},
        refreshEnv: async () => ({}), // never resolves
        sleep: async (ms) => {
          fakeNow += ms;
        },
        now: () => fakeNow,
        log: log.fn,
        backoff: { initialMs: 1000, maxMs: 1000, maxWaitSeconds: 5 },
      }),
    ).rejects.toBeInstanceOf(BootMaxWaitExceededError);
  });

  test("onTick errors are non-fatal", async () => {
    const log = makeLogger();
    const sleeper = makeSleeper();

    let onTickCalls = 0;
    let refreshCalls = 0;
    const status = await awaitCredentials({
      provider: "claude",
      initialEnv: {},
      refreshEnv: async () => {
        refreshCalls += 1;
        return refreshCalls >= 1 ? { CLAUDE_CODE_OAUTH_TOKEN: "tok" } : {};
      },
      sleep: sleeper.fn,
      log: log.fn,
      onTick: () => {
        onTickCalls += 1;
        throw new Error("status report failed");
      },
      backoff: { initialMs: 1, maxMs: 1, maxWaitSeconds: 0 },
    });

    expect(status.ready).toBe(true);
    expect(onTickCalls).toBe(2); // one waiting tick + one final ready tick
    expect(log.lines.some((l) => l.includes("onTick error"))).toBe(true);
  });

  test("refreshEnv errors are non-fatal — loop continues to next tick", async () => {
    const log = makeLogger();
    const sleeper = makeSleeper();

    let refreshCalls = 0;
    const status = await awaitCredentials({
      provider: "claude",
      initialEnv: {},
      refreshEnv: async () => {
        refreshCalls += 1;
        if (refreshCalls === 1) throw new Error("network blip");
        return { CLAUDE_CODE_OAUTH_TOKEN: "tok" };
      },
      sleep: sleeper.fn,
      log: log.fn,
      backoff: { initialMs: 1, maxMs: 1, maxWaitSeconds: 0 },
    });

    expect(status.ready).toBe(true);
    expect(refreshCalls).toBe(2);
    expect(log.lines.some((l) => l.includes("env refresh failed"))).toBe(true);
  });

  test("merges refreshed env into process.env", async () => {
    const log = makeLogger();
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    const status = await awaitCredentials({
      provider: "claude",
      initialEnv: {},
      refreshEnv: async () => ({ CLAUDE_CODE_OAUTH_TOKEN: "fresh-tok" }),
      sleep: async () => {},
      log: log.fn,
      backoff: { initialMs: 1, maxMs: 1, maxWaitSeconds: 0 },
    });

    expect(status.ready).toBe(true);
    // After the loop returns ready, process.env reflects the fresh value.
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("fresh-tok");
  });

  test("backoff config falls back to env-var defaults when override absent", async () => {
    const log = makeLogger();
    const sleeper = makeSleeper();

    process.env.BOOT_INITIAL_BACKOFF_MS = "50";
    process.env.BOOT_MAX_BACKOFF_MS = "100";

    let callCount = 0;
    await awaitCredentials({
      provider: "claude",
      initialEnv: { BOOT_INITIAL_BACKOFF_MS: "50", BOOT_MAX_BACKOFF_MS: "100" },
      refreshEnv: async () => {
        callCount += 1;
        return callCount >= 4 ? { CLAUDE_CODE_OAUTH_TOKEN: "tok" } : {};
      },
      sleep: sleeper.fn,
      log: log.fn,
    });

    // 50, 100 (capped), 100, 100.
    expect(sleeper.calls).toEqual([50, 100, 100, 100]);

    delete process.env.BOOT_INITIAL_BACKOFF_MS;
    delete process.env.BOOT_MAX_BACKOFF_MS;
  });

  test("forwards CredCheckOptions for file-based providers", async () => {
    const log = makeLogger();
    const probedPaths: string[] = [];

    const status = await awaitCredentials({
      provider: "codex",
      initialEnv: { HOME: "/home/worker" },
      refreshEnv: async () => ({}),
      sleep: async () => {},
      log: log.fn,
      backoff: { initialMs: 1, maxMs: 1, maxWaitSeconds: 0 },
      credCheckOptions: {
        homeDir: "/home/worker",
        fs: {
          existsSync: (p: string) => {
            probedPaths.push(p);
            return p === "/home/worker/.codex/auth.json";
          },
        },
      },
    });

    expect(status.ready).toBe(true);
    expect(probedPaths).toContain("/home/worker/.codex/auth.json");
  });
});
