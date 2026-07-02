/**
 * Tests for the `CLAUDE_BINARY` env override + trust pre-seed in
 * `ClaudeAdapter.createSession` and the shared helpers.
 *
 * Behaviors under test:
 *   1. Binary resolution — argv[0..n] tracks `parseClaudeBinary(process.env.CLAUDE_BINARY)`,
 *      with `["claude"]` as the default. Same flags follow. Supports
 *      whitespace-separated command strings.
 *   2. Claude Bridge routing — SWARM_USE_CLAUDE_BRIDGE=true/1 forces the
 *      installed `claude-bridge` argv prefix and wins over
 *      `CLAUDE_BINARY`.
 *   3. Tmux fail-fast — when the resolved binary string uses the legacy
 *      bridge compatibility path or claude-bridge is enabled, createSession
 *      throws if `tmux` is not on PATH.
 *   4. Trust pre-seed — when the resolved path drives interactive claude in
 *      tmux, the adapter writes
 *      `projects[cwd].hasTrustDialogAccepted: true` to `$HOME/.claude.json`
 *      before spawning. Idempotent. No-op for "claude".
 *
 * `Bun.spawn` is stubbed so the tests don't actually exec anything; we read
 * the argv off the call args. `Bun.which` is stubbed for the tmux gate so
 * the tests don't depend on the host having tmux installed. `$HOME` is
 * redirected to a tmp dir so the trust-preseed never touches the real
 * `~/.claude.json`.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeAdapter,
  parseClaudeBinary,
  parseClaudeBridgeEnabled,
  preseedClaudeTrustDialog,
  resolveClaudeBinary,
  resolveClaudeBinaryArgv,
  resolveClaudeBridgeEnabled,
} from "../providers/claude-adapter";
import type { ProviderSessionConfig } from "../providers/types";

const LEGACY_BRIDGE_COMPAT_BINARY = "shan" + "non";
const LEGACY_BRIDGE_COMPAT_PACKAGE = `@dexh/${LEGACY_BRIDGE_COMPAT_BINARY}`;
const LEGACY_BRIDGE_COMPAT_COMMAND = `bunx ${LEGACY_BRIDGE_COMPAT_PACKAGE}`;

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
    expect(parseClaudeBinary(LEGACY_BRIDGE_COMPAT_BINARY)).toEqual([LEGACY_BRIDGE_COMPAT_BINARY]);
    expect(parseClaudeBinary(`/usr/local/bin/${LEGACY_BRIDGE_COMPAT_BINARY}`)).toEqual([
      `/usr/local/bin/${LEGACY_BRIDGE_COMPAT_BINARY}`,
    ]);
  });

  test("command string → whitespace-split argv", () => {
    expect(parseClaudeBinary(LEGACY_BRIDGE_COMPAT_COMMAND)).toEqual([
      "bunx",
      LEGACY_BRIDGE_COMPAT_PACKAGE,
    ]);
    expect(parseClaudeBinary(`npx -y ${LEGACY_BRIDGE_COMPAT_PACKAGE}`)).toEqual([
      "npx",
      "-y",
      LEGACY_BRIDGE_COMPAT_PACKAGE,
    ]);
  });

  test("version-pinned → preserves the version suffix", () => {
    expect(parseClaudeBinary(`${LEGACY_BRIDGE_COMPAT_COMMAND}@1.2.3`)).toEqual([
      "bunx",
      `${LEGACY_BRIDGE_COMPAT_PACKAGE}@1.2.3`,
    ]);
  });

  test("multiple-space tolerance → trims + collapses", () => {
    expect(parseClaudeBinary(`  bunx  ${LEGACY_BRIDGE_COMPAT_BINARY}  `)).toEqual([
      "bunx",
      LEGACY_BRIDGE_COMPAT_BINARY,
    ]);
    expect(parseClaudeBinary(`\tbunx\t${LEGACY_BRIDGE_COMPAT_PACKAGE}\n`)).toEqual([
      "bunx",
      LEGACY_BRIDGE_COMPAT_PACKAGE,
    ]);
  });
});

describe("resolveClaudeBinary precedence", () => {
  test("resolvedEnv wins over fallbackEnv (swarm_config overrides process.env)", () => {
    const resolvedEnv = { CLAUDE_BINARY: LEGACY_BRIDGE_COMPAT_BINARY };
    const fallbackEnv = { CLAUDE_BINARY: "claude" };
    expect(resolveClaudeBinary(resolvedEnv, fallbackEnv)).toBe(LEGACY_BRIDGE_COMPAT_BINARY);
  });

  test("falls back to fallbackEnv when resolvedEnv is absent", () => {
    const resolvedEnv = {};
    const fallbackEnv = { CLAUDE_BINARY: LEGACY_BRIDGE_COMPAT_COMMAND };
    expect(resolveClaudeBinary(resolvedEnv, fallbackEnv)).toBe(LEGACY_BRIDGE_COMPAT_COMMAND);
  });

  test("both absent → 'claude' default", () => {
    expect(resolveClaudeBinary({}, {})).toBe("claude");
  });

  test("empty / whitespace-only resolvedEnv value falls through to fallbackEnv", () => {
    // `.trim() || …` falls through on empty/whitespace.
    expect(
      resolveClaudeBinary({ CLAUDE_BINARY: "" }, { CLAUDE_BINARY: LEGACY_BRIDGE_COMPAT_BINARY }),
    ).toBe(LEGACY_BRIDGE_COMPAT_BINARY);
    expect(
      resolveClaudeBinary({ CLAUDE_BINARY: "   " }, { CLAUDE_BINARY: LEGACY_BRIDGE_COMPAT_BINARY }),
    ).toBe(LEGACY_BRIDGE_COMPAT_BINARY);
  });

  test("empty fallback after empty resolved → 'claude' default", () => {
    expect(resolveClaudeBinary({ CLAUDE_BINARY: "" }, { CLAUDE_BINARY: "" })).toBe("claude");
  });

  test("command-string passes through unchanged (caller does the argv split)", () => {
    const resolvedEnv = { CLAUDE_BINARY: `${LEGACY_BRIDGE_COMPAT_COMMAND}@1.2.3` };
    expect(resolveClaudeBinary(resolvedEnv, {})).toBe(`${LEGACY_BRIDGE_COMPAT_COMMAND}@1.2.3`);
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

describe("SWARM_USE_CLAUDE_BRIDGE boolean parsing", () => {
  test("true/1 enable claude-bridge", () => {
    expect(parseClaudeBridgeEnabled("true")).toBe(true);
    expect(parseClaudeBridgeEnabled("TRUE")).toBe(true);
    expect(parseClaudeBridgeEnabled(" 1 ")).toBe(true);
  });

  test("false/0/unset and invalid values are disabled", () => {
    expect(parseClaudeBridgeEnabled("false")).toBe(false);
    expect(parseClaudeBridgeEnabled("0")).toBe(false);
    expect(parseClaudeBridgeEnabled(undefined)).toBe(false);
    expect(parseClaudeBridgeEnabled("yes")).toBe(false);
  });

  test("resolvedEnv wins over fallbackEnv", () => {
    expect(
      resolveClaudeBridgeEnabled(
        { SWARM_USE_CLAUDE_BRIDGE: "false" },
        { SWARM_USE_CLAUDE_BRIDGE: "true" },
      ),
    ).toBe(false);
    expect(
      resolveClaudeBridgeEnabled(
        { SWARM_USE_CLAUDE_BRIDGE: "1" },
        { SWARM_USE_CLAUDE_BRIDGE: "0" },
      ),
    ).toBe(true);
  });

  test("empty resolvedEnv value falls through to fallbackEnv", () => {
    expect(
      resolveClaudeBridgeEnabled(
        { SWARM_USE_CLAUDE_BRIDGE: " " },
        { SWARM_USE_CLAUDE_BRIDGE: "true" },
      ),
    ).toBe(true);
  });
});

describe("resolveClaudeBinaryArgv — claude-bridge requires an OAuth token", () => {
  test("bridge requested + OAuth token present → routes to claude-bridge", () => {
    const r = resolveClaudeBinaryArgv(
      { SWARM_USE_CLAUDE_BRIDGE: "true", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" },
      {},
    );
    expect(r.useClaudeBridge).toBe(true);
    expect(r.argv).toEqual(["claude-bridge"]);
    expect(r.bridgeRequestedWithoutOAuth).toBe(false);
  });

  test("bridge requested + no OAuth (only API key) → falls back to stock claude", () => {
    const r = resolveClaudeBinaryArgv(
      { SWARM_USE_CLAUDE_BRIDGE: "true", ANTHROPIC_API_KEY: "sk-ant-api" },
      {},
    );
    expect(r.useClaudeBridge).toBe(false);
    expect(r.argv).toEqual(["claude"]);
    expect(r.bridgeRequestedWithoutOAuth).toBe(true);
  });

  test("bridge requested + no creds at all → stock claude, flag set", () => {
    const r = resolveClaudeBinaryArgv({ SWARM_USE_CLAUDE_BRIDGE: "1" }, {});
    expect(r.useClaudeBridge).toBe(false);
    expect(r.bridgeRequestedWithoutOAuth).toBe(true);
  });

  test("OAuth token from fallbackEnv (container env) also enables the bridge", () => {
    const r = resolveClaudeBinaryArgv(
      { SWARM_USE_CLAUDE_BRIDGE: "true" },
      { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-fallback" },
    );
    expect(r.useClaudeBridge).toBe(true);
    expect(r.bridgeRequestedWithoutOAuth).toBe(false);
  });

  test("whitespace-only OAuth token does not count as present", () => {
    const r = resolveClaudeBinaryArgv(
      { SWARM_USE_CLAUDE_BRIDGE: "true", CLAUDE_CODE_OAUTH_TOKEN: "   " },
      {},
    );
    expect(r.useClaudeBridge).toBe(false);
    expect(r.bridgeRequestedWithoutOAuth).toBe(true);
  });

  test("bridge not requested → never flagged, stock claude", () => {
    const r = resolveClaudeBinaryArgv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" }, {});
    expect(r.useClaudeBridge).toBe(false);
    expect(r.bridgeRequestedWithoutOAuth).toBe(false);
    expect(r.argv).toEqual(["claude"]);
  });
});

describe("preseedClaudeTrustDialog", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "claude-trust-test-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  test("creates ~/.claude.json with the cwd trusted when file is missing", async () => {
    const cwd = "/abs/cwd/x";
    await preseedClaudeTrustDialog(cwd, homeDir);

    const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
    expect(data.projects[cwd].hasTrustDialogAccepted).toBe(true);
    expect(data.projects[cwd].hasCompletedProjectOnboarding).toBe(true);
  });

  test("preserves existing top-level keys (read-merge-write, no clobber)", async () => {
    await writeFile(
      join(homeDir, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        bypassPermissionsModeAccepted: true,
        unrelated: "value",
      }),
    );
    await preseedClaudeTrustDialog("/abs/cwd/x", homeDir);

    const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
    expect(data.hasCompletedOnboarding).toBe(true);
    expect(data.bypassPermissionsModeAccepted).toBe(true);
    expect(data.unrelated).toBe("value");
    expect(data.projects["/abs/cwd/x"].hasTrustDialogAccepted).toBe(true);
  });

  test("preserves other projects' entries", async () => {
    await writeFile(
      join(homeDir, ".claude.json"),
      JSON.stringify({
        projects: {
          "/other/project": {
            hasTrustDialogAccepted: true,
            customKey: 42,
          },
        },
      }),
    );
    await preseedClaudeTrustDialog("/abs/cwd/x", homeDir);

    const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
    expect(data.projects["/other/project"]).toEqual({
      hasTrustDialogAccepted: true,
      customKey: 42,
    });
    expect(data.projects["/abs/cwd/x"].hasTrustDialogAccepted).toBe(true);
  });

  test("idempotent: already-trusted cwd is a no-op (file not rewritten)", async () => {
    await writeFile(
      join(homeDir, ".claude.json"),
      JSON.stringify({
        projects: {
          "/abs/cwd/x": { hasTrustDialogAccepted: true, customKey: "preserved" },
        },
      }),
    );
    const beforeStat = await Bun.file(join(homeDir, ".claude.json")).text();
    await preseedClaudeTrustDialog("/abs/cwd/x", homeDir);
    const afterStat = await Bun.file(join(homeDir, ".claude.json")).text();

    // No-op → file contents unchanged.
    expect(afterStat).toBe(beforeStat);
  });

  test("malformed file: starts from {} and writes the entry", async () => {
    await writeFile(join(homeDir, ".claude.json"), "{ this is not valid json");
    await preseedClaudeTrustDialog("/abs/cwd/x", homeDir);

    const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
    expect(data.projects["/abs/cwd/x"].hasTrustDialogAccepted).toBe(true);
  });
});

// ─── Integration tests through ClaudeAdapter.createSession ────────────────────

describe("CLAUDE_BINARY env override", () => {
  // Cache the originals and restore after each test so the suite stays clean.
  let originalClaudeBinary: string | undefined;
  let originalUseClaudeBridge: string | undefined;
  let originalOauthToken: string | undefined;
  let originalHome: string | undefined;
  let homeDir: string;
  let spawnSpy: ReturnType<typeof spyOn>;
  let whichSpy: ReturnType<typeof spyOn>;
  let spawnedArgs: Array<readonly string[]>;
  let spawnedEnvs: Array<Record<string, string> | undefined>;

  beforeEach(async () => {
    originalClaudeBinary = process.env.CLAUDE_BINARY;
    originalUseClaudeBridge = process.env.SWARM_USE_CLAUDE_BRIDGE;
    originalOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    originalHome = process.env.HOME;
    homeDir = await mkdtemp(join(tmpdir(), "claude-adapter-test-home-"));
    process.env.HOME = homeDir;
    delete process.env.CLAUDE_BINARY;
    delete process.env.SWARM_USE_CLAUDE_BRIDGE;
    // Credential check runs before binary resolution; satisfy it.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";

    spawnedArgs = [];
    spawnedEnvs = [];
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((cmd: readonly string[], opts?: unknown) => {
      spawnedArgs.push(cmd);
      spawnedEnvs.push((opts as { env?: Record<string, string> } | undefined)?.env);
      return makeFakeProc();
    }) as typeof Bun.spawn);

    // Default: pretend tmux IS on PATH so non-tmux-gate tests don't trip.
    whichSpy = spyOn(Bun, "which").mockImplementation((name: string) => {
      if (name === "tmux") return "/usr/bin/tmux";
      return null;
    });
  });

  afterEach(async () => {
    spawnSpy.mockRestore();
    whichSpy.mockRestore();
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
    if (originalUseClaudeBridge === undefined) {
      delete process.env.SWARM_USE_CLAUDE_BRIDGE;
    } else {
      process.env.SWARM_USE_CLAUDE_BRIDGE = originalUseClaudeBridge;
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

  test("legacy bridge override: argv[0] comes from CLAUDE_BINARY", async () => {
    process.env.CLAUDE_BINARY = LEGACY_BRIDGE_COMPAT_BINARY;

    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig());

    const argv = spawnedArgs[0];
    expect(argv[0]).toBe(LEGACY_BRIDGE_COMPAT_BINARY);
  });

  test("custom legacy bridge path: argv[0] is the absolute path", async () => {
    process.env.CLAUDE_BINARY = `/usr/local/bin/${LEGACY_BRIDGE_COMPAT_BINARY}`;

    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig());

    expect(spawnedArgs[0][0]).toBe(`/usr/local/bin/${LEGACY_BRIDGE_COMPAT_BINARY}`);
  });

  test("legacy bridge command string → argv[0..1] is split", async () => {
    process.env.CLAUDE_BINARY = LEGACY_BRIDGE_COMPAT_COMMAND;

    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig());

    const argv = spawnedArgs[0];
    expect(argv[0]).toBe("bunx");
    expect(argv[1]).toBe(LEGACY_BRIDGE_COMPAT_PACKAGE);
    // Claude args follow.
    expect(argv).toContain("--model");
    expect(argv).toContain("-p");
  });

  test("version-pinned legacy bridge command string keeps package suffix", async () => {
    process.env.CLAUDE_BINARY = `${LEGACY_BRIDGE_COMPAT_COMMAND}@1.2.3`;

    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig());

    const argv = spawnedArgs[0];
    expect(argv[0]).toBe("bunx");
    expect(argv[1]).toBe(`${LEGACY_BRIDGE_COMPAT_PACKAGE}@1.2.3`);
  });

  test("multiple-space tolerance for legacy bridge command", async () => {
    process.env.CLAUDE_BINARY = `  bunx  ${LEGACY_BRIDGE_COMPAT_BINARY}  `;

    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig());

    const argv = spawnedArgs[0];
    expect(argv[0]).toBe("bunx");
    expect(argv[1]).toBe(LEGACY_BRIDGE_COMPAT_BINARY);
    expect(argv).toContain("--model");
  });

  test("argv[1..] after prefix matches between default and legacy bridge command", async () => {
    process.env.CLAUDE_BINARY = LEGACY_BRIDGE_COMPAT_COMMAND;
    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig());
    // Drop the 2-element prefix.
    const argvLegacyBridge = spawnedArgs[0].slice(2);

    spawnedArgs = [];
    delete process.env.CLAUDE_BINARY;
    await adapter.createSession(makeConfig());
    // Drop the 1-element prefix.
    const argvClaude = spawnedArgs[0].slice(1);

    expect(argvLegacyBridge).toEqual(argvClaude);
  });

  test("swarm_config overlay (config.env) wins over process.env CLAUDE_BINARY", async () => {
    // process.env says "claude" — but the runner's resolvedEnv overlay (passed
    // through config.env) says a legacy bridge binary. The overlay must win, mirroring the
    // HARNESS_PROVIDER reload path.
    process.env.CLAUDE_BINARY = "claude";

    const adapter = new ClaudeAdapter();
    await adapter.createSession(
      makeConfig({
        env: {
          CLAUDE_BINARY: LEGACY_BRIDGE_COMPAT_BINARY,
          CLAUDE_CODE_OAUTH_TOKEN: "test-token",
        } as Record<string, string>,
      }),
    );

    expect(spawnedArgs[0][0]).toBe(LEGACY_BRIDGE_COMPAT_BINARY);
  });

  test("config.env legacy bridge command override splits + spawns correctly", async () => {
    delete process.env.CLAUDE_BINARY;

    const adapter = new ClaudeAdapter();
    await adapter.createSession(
      makeConfig({
        env: {
          CLAUDE_BINARY: LEGACY_BRIDGE_COMPAT_COMMAND,
          CLAUDE_CODE_OAUTH_TOKEN: "test-token",
        } as Record<string, string>,
      }),
    );

    expect(spawnedArgs[0][0]).toBe("bunx");
    expect(spawnedArgs[0][1]).toBe(LEGACY_BRIDGE_COMPAT_PACKAGE);
  });

  test("config.env without CLAUDE_BINARY falls back to process.env", async () => {
    process.env.CLAUDE_BINARY = LEGACY_BRIDGE_COMPAT_BINARY;

    const adapter = new ClaudeAdapter();
    await adapter.createSession(
      makeConfig({
        // env has CLAUDE_CODE_OAUTH_TOKEN but no CLAUDE_BINARY → process.env wins.
        env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" } as Record<string, string>,
      }),
    );

    expect(spawnedArgs[0][0]).toBe(LEGACY_BRIDGE_COMPAT_BINARY);
  });

  test("SWARM_USE_CLAUDE_BRIDGE=true routes through installed claude-bridge", async () => {
    process.env.SWARM_USE_CLAUDE_BRIDGE = "true";

    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig());

    const argv = spawnedArgs[0];
    expect(argv[0]).toBe("claude-bridge");
    expect(argv).toContain("--model");
    expect(argv).toContain("-p");
  });

  test("SWARM_USE_CLAUDE_BRIDGE=true passes OAuth token to the bridge process", async () => {
    process.env.SWARM_USE_CLAUDE_BRIDGE = "true";

    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig());

    expect(spawnedArgs[0][0]).toBe("claude-bridge");
    expect(spawnedEnvs[0]?.CLAUDE_CODE_OAUTH_TOKEN).toBe("test-token");
  });

  test("SWARM_USE_CLAUDE_BRIDGE=true forwards Anthropic local auth through bridge flag", async () => {
    const adapter = new ClaudeAdapter();
    await adapter.createSession(
      makeConfig({
        env: {
          SWARM_USE_CLAUDE_BRIDGE: "true",
          ANTHROPIC_API_KEY: "sk-ant-test",
        } as Record<string, string>,
      }),
    );

    expect(spawnedArgs[0][0]).toBe("claude-bridge");
    expect(spawnedArgs[0]).toContain("--desplega-local-auth");
    expect(spawnedEnvs[0]?.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(spawnedEnvs[0]?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test("SWARM_USE_CLAUDE_BRIDGE=1 wins over legacy CLAUDE_BINARY", async () => {
    process.env.SWARM_USE_CLAUDE_BRIDGE = "1";
    process.env.CLAUDE_BINARY = LEGACY_BRIDGE_COMPAT_BINARY;

    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig());

    expect(spawnedArgs[0][0]).toBe("claude-bridge");
  });

  test("config.env SWARM_USE_CLAUDE_BRIDGE=true is reloadable and wins over process.env false", async () => {
    process.env.SWARM_USE_CLAUDE_BRIDGE = "false";

    const adapter = new ClaudeAdapter();
    await adapter.createSession(
      makeConfig({
        env: {
          SWARM_USE_CLAUDE_BRIDGE: "true",
          CLAUDE_CODE_OAUTH_TOKEN: "test-token",
        } as Record<string, string>,
      }),
    );

    expect(spawnedArgs[0][0]).toBe("claude-bridge");
  });

  test("config.env SWARM_USE_CLAUDE_BRIDGE=false disables process.env true", async () => {
    process.env.SWARM_USE_CLAUDE_BRIDGE = "true";

    const adapter = new ClaudeAdapter();
    await adapter.createSession(
      makeConfig({
        env: {
          SWARM_USE_CLAUDE_BRIDGE: "false",
          CLAUDE_CODE_OAUTH_TOKEN: "test-token",
        } as Record<string, string>,
      }),
    );

    expect(spawnedArgs[0][0]).toBe("claude");
  });

  test("SWARM_USE_CLAUDE_BRIDGE=true without OAuth token falls back to stock claude", async () => {
    const origApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.SWARM_USE_CLAUDE_BRIDGE = "true";
    try {
      const adapter = new ClaudeAdapter();
      await adapter.createSession(makeConfig());
      // No OAuth token → bridge is skipped, stock claude is used (Claude Code
      // authenticates fine from ANTHROPIC_API_KEY; the bridge can't).
      expect(spawnedArgs[0][0]).toBe("claude");
    } finally {
      if (origApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = origApiKey;
      }
    }
  });
});

describe("Claude Bridge tmux fail-fast gate", () => {
  let originalClaudeBinary: string | undefined;
  let originalUseClaudeBridge: string | undefined;
  let originalOauthToken: string | undefined;
  let originalHome: string | undefined;
  let homeDir: string;
  let spawnSpy: ReturnType<typeof spyOn>;
  let whichSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    originalClaudeBinary = process.env.CLAUDE_BINARY;
    originalUseClaudeBridge = process.env.SWARM_USE_CLAUDE_BRIDGE;
    originalOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    originalHome = process.env.HOME;
    homeDir = await mkdtemp(join(tmpdir(), "claude-adapter-test-home-"));
    process.env.HOME = homeDir;
    delete process.env.CLAUDE_BINARY;
    delete process.env.SWARM_USE_CLAUDE_BRIDGE;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => makeFakeProc()) as typeof Bun.spawn);
    whichSpy = spyOn(Bun, "which");
  });

  afterEach(async () => {
    spawnSpy.mockRestore();
    whichSpy.mockRestore();
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
    if (originalUseClaudeBridge === undefined) {
      delete process.env.SWARM_USE_CLAUDE_BRIDGE;
    } else {
      process.env.SWARM_USE_CLAUDE_BRIDGE = originalUseClaudeBridge;
    }
    if (originalOauthToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauthToken;
    }
  });

  test("sad path: rejects with tmux-mentioning error when legacy CLAUDE_BINARY is set and tmux is missing", async () => {
    process.env.CLAUDE_BINARY = LEGACY_BRIDGE_COMPAT_BINARY;
    whichSpy.mockImplementation((name: string) => {
      if (name === "tmux") return null;
      return `/usr/bin/${name}`;
    });

    const adapter = new ClaudeAdapter();
    await expect(adapter.createSession(makeConfig())).rejects.toThrow(/tmux/i);
  });

  test("happy path: does not throw when legacy CLAUDE_BINARY is set and tmux IS on PATH", async () => {
    process.env.CLAUDE_BINARY = LEGACY_BRIDGE_COMPAT_BINARY;
    whichSpy.mockImplementation((name: string) => {
      if (name === "tmux") return "/usr/bin/tmux";
      return null;
    });

    const adapter = new ClaudeAdapter();
    await expect(adapter.createSession(makeConfig())).resolves.toBeDefined();
  });

  test("default binary skips the tmux check (no Bun.which call for tmux)", async () => {
    process.env.CLAUDE_BINARY = "claude";
    whichSpy.mockImplementation((name: string) => {
      if (name === "tmux") return null;
      return null;
    });

    const adapter = new ClaudeAdapter();
    // Should NOT throw even though tmux is "missing".
    await expect(adapter.createSession(makeConfig())).resolves.toBeDefined();
  });

  test("custom legacy bridge path still triggers the tmux check", async () => {
    process.env.CLAUDE_BINARY = `/usr/local/bin/${LEGACY_BRIDGE_COMPAT_BINARY}`;
    whichSpy.mockImplementation((name: string) => {
      if (name === "tmux") return null;
      return null;
    });

    const adapter = new ClaudeAdapter();
    await expect(adapter.createSession(makeConfig())).rejects.toThrow(/tmux/i);
  });

  test("legacy bridge command string still triggers the tmux check", async () => {
    process.env.CLAUDE_BINARY = LEGACY_BRIDGE_COMPAT_COMMAND;
    whichSpy.mockImplementation((name: string) => {
      if (name === "tmux") return null;
      return null;
    });

    const adapter = new ClaudeAdapter();
    await expect(adapter.createSession(makeConfig())).rejects.toThrow(/tmux/i);
  });

  test("SWARM_USE_CLAUDE_BRIDGE=true triggers the tmux check", async () => {
    process.env.SWARM_USE_CLAUDE_BRIDGE = "true";
    whichSpy.mockImplementation((name: string) => {
      if (name === "tmux") return null;
      return null;
    });

    const adapter = new ClaudeAdapter();
    await expect(adapter.createSession(makeConfig())).rejects.toThrow(/SWARM_USE_CLAUDE_BRIDGE/);
  });
});

describe("Trust pre-seed via ClaudeAdapter.createSession", () => {
  let originalClaudeBinary: string | undefined;
  let originalUseClaudeBridge: string | undefined;
  let originalOauthToken: string | undefined;
  let originalHome: string | undefined;
  let homeDir: string;
  let spawnSpy: ReturnType<typeof spyOn>;
  let whichSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    originalClaudeBinary = process.env.CLAUDE_BINARY;
    originalUseClaudeBridge = process.env.SWARM_USE_CLAUDE_BRIDGE;
    originalOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    originalHome = process.env.HOME;
    homeDir = await mkdtemp(join(tmpdir(), "claude-adapter-trust-test-"));
    process.env.HOME = homeDir;
    delete process.env.CLAUDE_BINARY;
    delete process.env.SWARM_USE_CLAUDE_BRIDGE;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => makeFakeProc()) as typeof Bun.spawn);
    whichSpy = spyOn(Bun, "which").mockImplementation((name: string) => {
      if (name === "tmux") return "/usr/bin/tmux";
      return null;
    });
  });

  afterEach(async () => {
    spawnSpy.mockRestore();
    whichSpy.mockRestore();
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
    if (originalUseClaudeBridge === undefined) {
      delete process.env.SWARM_USE_CLAUDE_BRIDGE;
    } else {
      process.env.SWARM_USE_CLAUDE_BRIDGE = originalUseClaudeBridge;
    }
    if (originalOauthToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauthToken;
    }
  });

  test("legacy CLAUDE_BINARY writes hasTrustDialogAccepted for config.cwd", async () => {
    process.env.CLAUDE_BINARY = LEGACY_BRIDGE_COMPAT_BINARY;
    const cwd = "/some/abs/cwd";
    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig({ cwd }));

    const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
    expect(data.projects[cwd].hasTrustDialogAccepted).toBe(true);
    expect(data.projects[cwd].hasCompletedProjectOnboarding).toBe(true);
  });

  test("legacy CLAUDE_BINARY command string also triggers the pre-seed", async () => {
    process.env.CLAUDE_BINARY = LEGACY_BRIDGE_COMPAT_COMMAND;
    const cwd = "/some/other/cwd";
    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig({ cwd }));

    const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
    expect(data.projects[cwd].hasTrustDialogAccepted).toBe(true);
  });

  test("idempotent: re-creating legacy bridge session does not rewrite the file", async () => {
    process.env.CLAUDE_BINARY = LEGACY_BRIDGE_COMPAT_BINARY;
    const cwd = "/some/abs/cwd";
    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig({ cwd }));
    const first = await readFile(join(homeDir, ".claude.json"), "utf-8");
    await adapter.createSession(makeConfig({ cwd }));
    const second = await readFile(join(homeDir, ".claude.json"), "utf-8");
    expect(second).toBe(first);
  });

  test("preserves other projects' entries when seeding a new cwd", async () => {
    await writeFile(
      join(homeDir, ".claude.json"),
      JSON.stringify({
        projects: {
          "/other/cwd": { hasTrustDialogAccepted: true, custom: 1 },
        },
      }),
    );
    process.env.CLAUDE_BINARY = LEGACY_BRIDGE_COMPAT_BINARY;
    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig({ cwd: "/new/cwd" }));

    const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
    expect(data.projects["/other/cwd"]).toEqual({ hasTrustDialogAccepted: true, custom: 1 });
    expect(data.projects["/new/cwd"].hasTrustDialogAccepted).toBe(true);
  });

  test("default CLAUDE_BINARY=claude does NOT touch ~/.claude.json", async () => {
    delete process.env.CLAUDE_BINARY;
    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig({ cwd: "/some/abs/cwd" }));

    // No .claude.json should have been written.
    const exists = await Bun.file(join(homeDir, ".claude.json")).exists();
    expect(exists).toBe(false);
  });

  test("SWARM_USE_CLAUDE_BRIDGE=true writes hasTrustDialogAccepted for config.cwd", async () => {
    process.env.SWARM_USE_CLAUDE_BRIDGE = "true";
    const cwd = "/some/bridge/cwd";
    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig({ cwd }));

    const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
    expect(data.projects[cwd].hasTrustDialogAccepted).toBe(true);
    expect(data.projects[cwd].hasCompletedProjectOnboarding).toBe(true);
  });
});
