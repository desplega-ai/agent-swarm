/**
 * Tests for the `CLAUDE_BINARY` env override in `ClaudeAdapter.createSession`
 * and the shared helpers.
 *
 * Behaviors under test:
 *   1. Binary resolution — argv[0..n] tracks `parseClaudeBinary(process.env.CLAUDE_BINARY)`,
 *      with `["claude"]` as the default. Same flags follow. Supports
 *      whitespace-separated command strings.
 *   2. `resolveClaudeBinary` precedence — swarm_config overlay (`config.env`)
 *      wins over `process.env`, which wins over the `"claude"` default.
 *
 * `Bun.spawn` is stubbed so the tests don't actually exec anything; we read
 * the argv off the call args.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter, parseClaudeBinary, resolveClaudeBinary } from "../providers/claude-adapter";
import type { ProviderSessionConfig } from "../providers/types";

const CUSTOM_BINARY = "my-claude-wrapper";
const CUSTOM_COMMAND = `bunx ${CUSTOM_BINARY}`;

/** Minimal config — empty apiUrl/apiKey/agentId skips the MCP-server fetch. */
function makeConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    prompt: "Say hello",
    systemPrompt: "",
    model: "sonnet",
    role: "worker",
    agentId: "",
    taskId: "test-task-binary",
    apiUrl: "",
    apiKey: "",
    cwd: "/tmp",
    logFile: "/tmp/test-claude-adapter-binary.jsonl",
    ...overrides,
  };
}

/** Fake Bun.Subprocess that behaves as a process that exited cleanly with no output. */
function makeFakeProc(): ReturnType<typeof Bun.spawn> {
  return {
    stdout: null,
    stderr: null,
    stdin: null,
    exited: Promise.resolve(0),
    exitCode: 0,
    kill: () => {},
    pid: 0,
    killed: false,
    ref: () => {},
    unref: () => {},
  } as unknown as ReturnType<typeof Bun.spawn>;
}

// ─── Pure-function tests ──────────────────────────────────────────────────────

describe("parseClaudeBinary", () => {
  test("undefined → ['claude']", () => {
    expect(parseClaudeBinary(undefined)).toEqual(["claude"]);
  });

  test("empty string → ['claude']", () => {
    expect(parseClaudeBinary("")).toEqual(["claude"]);
    expect(parseClaudeBinary("   ")).toEqual(["claude"]);
  });

  test("single token → one-element array", () => {
    expect(parseClaudeBinary("claude")).toEqual(["claude"]);
    expect(parseClaudeBinary(CUSTOM_BINARY)).toEqual([CUSTOM_BINARY]);
    expect(parseClaudeBinary(`/usr/local/bin/${CUSTOM_BINARY}`)).toEqual([
      `/usr/local/bin/${CUSTOM_BINARY}`,
    ]);
  });

  test("command string → whitespace-split argv", () => {
    expect(parseClaudeBinary(CUSTOM_COMMAND)).toEqual(["bunx", CUSTOM_BINARY]);
    expect(parseClaudeBinary(`npx -y ${CUSTOM_BINARY}`)).toEqual(["npx", "-y", CUSTOM_BINARY]);
  });

  test("version-pinned → preserves the version suffix", () => {
    expect(parseClaudeBinary(`${CUSTOM_COMMAND}@1.2.3`)).toEqual([
      "bunx",
      `${CUSTOM_BINARY}@1.2.3`,
    ]);
  });

  test("multiple-space tolerance → trims + collapses", () => {
    expect(parseClaudeBinary(`  bunx  ${CUSTOM_BINARY}  `)).toEqual(["bunx", CUSTOM_BINARY]);
    expect(parseClaudeBinary(`\tbunx\t${CUSTOM_BINARY}\n`)).toEqual(["bunx", CUSTOM_BINARY]);
  });
});

describe("resolveClaudeBinary precedence", () => {
  test("resolvedEnv wins over fallbackEnv (swarm_config overrides process.env)", () => {
    const resolvedEnv = { CLAUDE_BINARY: CUSTOM_BINARY };
    const fallbackEnv = { CLAUDE_BINARY: "claude" };
    expect(resolveClaudeBinary(resolvedEnv, fallbackEnv)).toBe(CUSTOM_BINARY);
  });

  test("falls back to fallbackEnv when resolvedEnv is absent", () => {
    const resolvedEnv = {};
    const fallbackEnv = { CLAUDE_BINARY: CUSTOM_COMMAND };
    expect(resolveClaudeBinary(resolvedEnv, fallbackEnv)).toBe(CUSTOM_COMMAND);
  });

  test("both absent → 'claude' default", () => {
    expect(resolveClaudeBinary({}, {})).toBe("claude");
  });

  test("empty / whitespace-only resolvedEnv value falls through to fallbackEnv", () => {
    // `.trim() || …` falls through on empty/whitespace.
    expect(resolveClaudeBinary({ CLAUDE_BINARY: "" }, { CLAUDE_BINARY: CUSTOM_BINARY })).toBe(
      CUSTOM_BINARY,
    );
    expect(resolveClaudeBinary({ CLAUDE_BINARY: "   " }, { CLAUDE_BINARY: CUSTOM_BINARY })).toBe(
      CUSTOM_BINARY,
    );
  });

  test("empty fallback after empty resolved → 'claude' default", () => {
    expect(resolveClaudeBinary({ CLAUDE_BINARY: "" }, { CLAUDE_BINARY: "" })).toBe("claude");
  });

  test("command-string passes through unchanged (caller does the argv split)", () => {
    const resolvedEnv = { CLAUDE_BINARY: `${CUSTOM_COMMAND}@1.2.3` };
    expect(resolveClaudeBinary(resolvedEnv, {})).toBe(`${CUSTOM_COMMAND}@1.2.3`);
  });

  test("fallbackEnv defaults to process.env when omitted", () => {
    // Smoke-test the default arg. Set + read process.env directly.
    const orig = process.env.CLAUDE_BINARY;
    process.env.CLAUDE_BINARY = "test-default-arg";
    try {
      expect(resolveClaudeBinary({})).toBe("test-default-arg");
    } finally {
      if (orig === undefined) {
        delete process.env.CLAUDE_BINARY;
      } else {
        process.env.CLAUDE_BINARY = orig;
      }
    }
  });
});

// ─── Integration tests through ClaudeAdapter.createSession ────────────────────

describe("CLAUDE_BINARY env override", () => {
  // Cache the originals and restore after each test so the suite stays clean.
  let originalClaudeBinary: string | undefined;
  let originalOauthToken: string | undefined;
  let originalHome: string | undefined;
  let homeDir: string;
  let spawnSpy: ReturnType<typeof spyOn>;
  let spawnedArgs: Array<readonly string[]>;

  beforeEach(async () => {
    originalClaudeBinary = process.env.CLAUDE_BINARY;
    originalOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    originalHome = process.env.HOME;
    homeDir = await mkdtemp(join(tmpdir(), "claude-adapter-test-home-"));
    process.env.HOME = homeDir;
    delete process.env.CLAUDE_BINARY;
    // Credential check runs before binary resolution; satisfy it.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";

    spawnedArgs = [];
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((cmd: readonly string[]) => {
      spawnedArgs.push(cmd);
      return makeFakeProc();
    }) as typeof Bun.spawn);
  });

  afterEach(async () => {
    spawnSpy.mockRestore();
    await rm(homeDir, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalClaudeBinary === undefined) {
      delete process.env.CLAUDE_BINARY;
    } else {
      process.env.CLAUDE_BINARY = originalClaudeBinary;
    }
    if (originalOauthToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauthToken;
    }
  });

  test("default: argv[0] is 'claude' when CLAUDE_BINARY is unset", async () => {
    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig());

    expect(spawnedArgs).toHaveLength(1);
    const argv = spawnedArgs[0];
    expect(argv[0]).toBe("claude");
  });

  test("custom binary: argv[0] comes from CLAUDE_BINARY", async () => {
    process.env.CLAUDE_BINARY = CUSTOM_BINARY;

    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig());

    const argv = spawnedArgs[0];
    expect(argv[0]).toBe(CUSTOM_BINARY);
  });

  test("custom absolute path: argv[0] is the absolute path", async () => {
    process.env.CLAUDE_BINARY = `/usr/local/bin/${CUSTOM_BINARY}`;

    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig());

    expect(spawnedArgs[0][0]).toBe(`/usr/local/bin/${CUSTOM_BINARY}`);
  });

  test("custom command string → argv[0..1] is split", async () => {
    process.env.CLAUDE_BINARY = CUSTOM_COMMAND;

    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig());

    const argv = spawnedArgs[0];
    expect(argv[0]).toBe("bunx");
    expect(argv[1]).toBe(CUSTOM_BINARY);
    // Claude args follow.
    expect(argv).toContain("--model");
    expect(argv).toContain("-p");
  });

  test("argv[1..] after prefix matches between default and custom command", async () => {
    process.env.CLAUDE_BINARY = CUSTOM_COMMAND;
    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig());
    // Drop the 2-element prefix.
    const argvCustom = spawnedArgs[0].slice(2);

    spawnedArgs = [];
    delete process.env.CLAUDE_BINARY;
    await adapter.createSession(makeConfig());
    // Drop the 1-element prefix.
    const argvClaude = spawnedArgs[0].slice(1);

    expect(argvCustom).toEqual(argvClaude);
  });

  test("swarm_config overlay (config.env) wins over process.env CLAUDE_BINARY", async () => {
    // process.env says "claude" — but the runner's resolvedEnv overlay (passed
    // through config.env) says a custom binary. The overlay must win, mirroring
    // the HARNESS_PROVIDER reload path.
    process.env.CLAUDE_BINARY = "claude";

    const adapter = new ClaudeAdapter();
    await adapter.createSession(
      makeConfig({
        env: {
          CLAUDE_BINARY: CUSTOM_BINARY,
          CLAUDE_CODE_OAUTH_TOKEN: "test-token",
        } as Record<string, string>,
      }),
    );

    expect(spawnedArgs[0][0]).toBe(CUSTOM_BINARY);
  });

  test("config.env custom command override splits + spawns correctly", async () => {
    delete process.env.CLAUDE_BINARY;

    const adapter = new ClaudeAdapter();
    await adapter.createSession(
      makeConfig({
        env: {
          CLAUDE_BINARY: CUSTOM_COMMAND,
          CLAUDE_CODE_OAUTH_TOKEN: "test-token",
        } as Record<string, string>,
      }),
    );

    expect(spawnedArgs[0][0]).toBe("bunx");
    expect(spawnedArgs[0][1]).toBe(CUSTOM_BINARY);
  });

  test("config.env without CLAUDE_BINARY falls back to process.env", async () => {
    process.env.CLAUDE_BINARY = CUSTOM_BINARY;

    const adapter = new ClaudeAdapter();
    await adapter.createSession(
      makeConfig({
        // env has CLAUDE_CODE_OAUTH_TOKEN but no CLAUDE_BINARY → process.env wins.
        env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" } as Record<string, string>,
      }),
    );

    expect(spawnedArgs[0][0]).toBe(CUSTOM_BINARY);
  });
});
