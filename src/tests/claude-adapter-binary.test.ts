/**
 * Tests for the `CLAUDE_BINARY` env override + trust pre-seed in
 * `ClaudeAdapter.createSession` and the shared helpers.
 *
 * Behaviors under test:
 *   1. Binary resolution — argv[0..n] tracks `parseClaudeBinary(process.env.CLAUDE_BINARY)`,
 *      with `["claude"]` as the default. Same flags follow. Supports
 *      whitespace-separated command strings (e.g. `"bunx @dexh/shannon"`).
 *   2. Tmux fail-fast — when the resolved binary string contains "shannon"
 *      (anywhere — including inside a command string), createSession throws
 *      if `tmux` is not on PATH.
 *   3. Trust pre-seed — when the resolved binary contains "shannon", the
 *      adapter writes `projects[cwd].hasTrustDialogAccepted: true` to
 *      `$HOME/.claude.json` before spawning. Idempotent. No-op for "claude".
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
  preseedClaudeTrustDialog,
  resolveClaudeBinary,
} from "../providers/claude-adapter";
import type { ProviderSessionConfig } from "../providers/types";

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
    expect(parseClaudeBinary("shannon")).toEqual(["shannon"]);
    expect(parseClaudeBinary("/usr/local/bin/shannon")).toEqual(["/usr/local/bin/shannon"]);
  });

  test("command string → whitespace-split argv", () => {
    expect(parseClaudeBinary("bunx @dexh/shannon")).toEqual(["bunx", "@dexh/shannon"]);
    expect(parseClaudeBinary("npx -y @dexh/shannon")).toEqual(["npx", "-y", "@dexh/shannon"]);
  });

  test("version-pinned → preserves the version suffix", () => {
    expect(parseClaudeBinary("bunx @dexh/shannon@1.2.3")).toEqual(["bunx", "@dexh/shannon@1.2.3"]);
  });

  test("multiple-space tolerance → trims + collapses", () => {
    expect(parseClaudeBinary("  bunx  shannon  ")).toEqual(["bunx", "shannon"]);
    expect(parseClaudeBinary("\tbunx\t@dexh/shannon\n")).toEqual(["bunx", "@dexh/shannon"]);
  });
});

describe("resolveClaudeBinary precedence", () => {
  test("resolvedEnv wins over fallbackEnv (swarm_config overrides process.env)", () => {
    const resolvedEnv = { CLAUDE_BINARY: "shannon" };
    const fallbackEnv = { CLAUDE_BINARY: "claude" };
    expect(resolveClaudeBinary(resolvedEnv, fallbackEnv)).toBe("shannon");
  });

  test("falls back to fallbackEnv when resolvedEnv is absent", () => {
    const resolvedEnv = {};
    const fallbackEnv = { CLAUDE_BINARY: "bunx @dexh/shannon" };
    expect(resolveClaudeBinary(resolvedEnv, fallbackEnv)).toBe("bunx @dexh/shannon");
  });

  test("both absent → 'claude' default", () => {
    expect(resolveClaudeBinary({}, {})).toBe("claude");
  });

  test("empty / whitespace-only resolvedEnv value falls through to fallbackEnv", () => {
    // `.trim() || …` falls through on empty/whitespace.
    expect(resolveClaudeBinary({ CLAUDE_BINARY: "" }, { CLAUDE_BINARY: "shannon" })).toBe(
      "shannon",
    );
    expect(resolveClaudeBinary({ CLAUDE_BINARY: "   " }, { CLAUDE_BINARY: "shannon" })).toBe(
      "shannon",
    );
  });

  test("empty fallback after empty resolved → 'claude' default", () => {
    expect(resolveClaudeBinary({ CLAUDE_BINARY: "" }, { CLAUDE_BINARY: "" })).toBe("claude");
  });

  test("command-string passes through unchanged (caller does the argv split)", () => {
    const resolvedEnv = { CLAUDE_BINARY: "bunx @dexh/shannon@1.2.3" };
    expect(resolveClaudeBinary(resolvedEnv, {})).toBe("bunx @dexh/shannon@1.2.3");
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
  let originalOauthToken: string | undefined;
  let originalHome: string | undefined;
  let homeDir: string;
  let spawnSpy: ReturnType<typeof spyOn>;
  let whichSpy: ReturnType<typeof spyOn>;
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

  test("override: argv[0] is 'shannon' when CLAUDE_BINARY=shannon", async () => {
    process.env.CLAUDE_BINARY = "shannon";

    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig());

    const argv = spawnedArgs[0];
    expect(argv[0]).toBe("shannon");
  });

  test("custom path: argv[0] is the absolute path when CLAUDE_BINARY=/usr/local/bin/shannon", async () => {
    process.env.CLAUDE_BINARY = "/usr/local/bin/shannon";

    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig());

    expect(spawnedArgs[0][0]).toBe("/usr/local/bin/shannon");
  });

  test("command string: 'bunx @dexh/shannon' → argv[0..1] is ['bunx', '@dexh/shannon']", async () => {
    process.env.CLAUDE_BINARY = "bunx @dexh/shannon";

    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig());

    const argv = spawnedArgs[0];
    expect(argv[0]).toBe("bunx");
    expect(argv[1]).toBe("@dexh/shannon");
    // Claude args follow.
    expect(argv).toContain("--model");
    expect(argv).toContain("-p");
  });

  test("version-pinned command string: argv[0..1] = ['bunx', '@dexh/shannon@1.2.3']", async () => {
    process.env.CLAUDE_BINARY = "bunx @dexh/shannon@1.2.3";

    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig());

    const argv = spawnedArgs[0];
    expect(argv[0]).toBe("bunx");
    expect(argv[1]).toBe("@dexh/shannon@1.2.3");
  });

  test("multiple-space tolerance: '  bunx  shannon  ' → argv = ['bunx', 'shannon', ...]", async () => {
    process.env.CLAUDE_BINARY = "  bunx  shannon  ";

    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig());

    const argv = spawnedArgs[0];
    expect(argv[0]).toBe("bunx");
    expect(argv[1]).toBe("shannon");
    expect(argv).toContain("--model");
  });

  test("argv[1..] (after prefix) matches between default 'claude' and command-string 'bunx @dexh/shannon'", async () => {
    process.env.CLAUDE_BINARY = "bunx @dexh/shannon";
    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig());
    // Drop the 2-element prefix.
    const argvShannon = spawnedArgs[0].slice(2);

    spawnedArgs = [];
    delete process.env.CLAUDE_BINARY;
    await adapter.createSession(makeConfig());
    // Drop the 1-element prefix.
    const argvClaude = spawnedArgs[0].slice(1);

    expect(argvShannon).toEqual(argvClaude);
  });

  test("swarm_config overlay (config.env) wins over process.env CLAUDE_BINARY", async () => {
    // process.env says "claude" — but the runner's resolvedEnv overlay (passed
    // through config.env) says "shannon". The overlay must win, mirroring the
    // HARNESS_PROVIDER reload path.
    process.env.CLAUDE_BINARY = "claude";

    const adapter = new ClaudeAdapter();
    await adapter.createSession(
      makeConfig({
        env: { CLAUDE_BINARY: "shannon", CLAUDE_CODE_OAUTH_TOKEN: "test-token" } as Record<
          string,
          string
        >,
      }),
    );

    expect(spawnedArgs[0][0]).toBe("shannon");
  });

  test("config.env CLAUDE_BINARY='bunx @dexh/shannon' (swarm_config override) splits + spawns correctly", async () => {
    delete process.env.CLAUDE_BINARY;

    const adapter = new ClaudeAdapter();
    await adapter.createSession(
      makeConfig({
        env: {
          CLAUDE_BINARY: "bunx @dexh/shannon",
          CLAUDE_CODE_OAUTH_TOKEN: "test-token",
        } as Record<string, string>,
      }),
    );

    expect(spawnedArgs[0][0]).toBe("bunx");
    expect(spawnedArgs[0][1]).toBe("@dexh/shannon");
  });

  test("config.env without CLAUDE_BINARY falls back to process.env", async () => {
    process.env.CLAUDE_BINARY = "shannon";

    const adapter = new ClaudeAdapter();
    await adapter.createSession(
      makeConfig({
        // env has CLAUDE_CODE_OAUTH_TOKEN but no CLAUDE_BINARY → process.env wins.
        env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" } as Record<string, string>,
      }),
    );

    expect(spawnedArgs[0][0]).toBe("shannon");
  });
});

describe("Shannon tmux fail-fast gate", () => {
  let originalClaudeBinary: string | undefined;
  let originalOauthToken: string | undefined;
  let originalHome: string | undefined;
  let homeDir: string;
  let spawnSpy: ReturnType<typeof spyOn>;
  let whichSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    originalClaudeBinary = process.env.CLAUDE_BINARY;
    originalOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    originalHome = process.env.HOME;
    homeDir = await mkdtemp(join(tmpdir(), "claude-adapter-test-home-"));
    process.env.HOME = homeDir;
    delete process.env.CLAUDE_BINARY;
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
    if (originalOauthToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauthToken;
    }
  });

  test("sad path: rejects with tmux-mentioning error when CLAUDE_BINARY=shannon and tmux is missing", async () => {
    process.env.CLAUDE_BINARY = "shannon";
    whichSpy.mockImplementation((name: string) => {
      if (name === "tmux") return null;
      return `/usr/bin/${name}`;
    });

    const adapter = new ClaudeAdapter();
    await expect(adapter.createSession(makeConfig())).rejects.toThrow(/tmux/i);
  });

  test("happy path: does not throw when CLAUDE_BINARY=shannon and tmux IS on PATH", async () => {
    process.env.CLAUDE_BINARY = "shannon";
    whichSpy.mockImplementation((name: string) => {
      if (name === "tmux") return "/usr/bin/tmux";
      return null;
    });

    const adapter = new ClaudeAdapter();
    await expect(adapter.createSession(makeConfig())).resolves.toBeDefined();
  });

  test("non-shannon binary skips the tmux check (no Bun.which call for tmux)", async () => {
    process.env.CLAUDE_BINARY = "claude";
    whichSpy.mockImplementation((name: string) => {
      if (name === "tmux") return null;
      return null;
    });

    const adapter = new ClaudeAdapter();
    // Should NOT throw even though tmux is "missing".
    await expect(adapter.createSession(makeConfig())).resolves.toBeDefined();
  });

  test("custom shannon path (e.g. /usr/local/bin/shannon) still triggers the tmux check", async () => {
    process.env.CLAUDE_BINARY = "/usr/local/bin/shannon";
    whichSpy.mockImplementation((name: string) => {
      if (name === "tmux") return null;
      return null;
    });

    const adapter = new ClaudeAdapter();
    await expect(adapter.createSession(makeConfig())).rejects.toThrow(/tmux/i);
  });

  test("command-string CLAUDE_BINARY='bunx @dexh/shannon' still triggers the tmux check", async () => {
    process.env.CLAUDE_BINARY = "bunx @dexh/shannon";
    whichSpy.mockImplementation((name: string) => {
      if (name === "tmux") return null;
      return null;
    });

    const adapter = new ClaudeAdapter();
    await expect(adapter.createSession(makeConfig())).rejects.toThrow(/tmux/i);
  });
});

describe("Trust pre-seed via ClaudeAdapter.createSession", () => {
  let originalClaudeBinary: string | undefined;
  let originalOauthToken: string | undefined;
  let originalHome: string | undefined;
  let homeDir: string;
  let spawnSpy: ReturnType<typeof spyOn>;
  let whichSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    originalClaudeBinary = process.env.CLAUDE_BINARY;
    originalOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    originalHome = process.env.HOME;
    homeDir = await mkdtemp(join(tmpdir(), "claude-adapter-trust-test-"));
    process.env.HOME = homeDir;
    delete process.env.CLAUDE_BINARY;
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
    if (originalOauthToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauthToken;
    }
  });

  test("CLAUDE_BINARY=shannon writes hasTrustDialogAccepted for config.cwd", async () => {
    process.env.CLAUDE_BINARY = "shannon";
    const cwd = "/some/abs/cwd";
    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig({ cwd }));

    const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
    expect(data.projects[cwd].hasTrustDialogAccepted).toBe(true);
    expect(data.projects[cwd].hasCompletedProjectOnboarding).toBe(true);
  });

  test("CLAUDE_BINARY='bunx @dexh/shannon' (command string) also triggers the pre-seed", async () => {
    process.env.CLAUDE_BINARY = "bunx @dexh/shannon";
    const cwd = "/some/other/cwd";
    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig({ cwd }));

    const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
    expect(data.projects[cwd].hasTrustDialogAccepted).toBe(true);
  });

  test("idempotent: re-creating session with shannon does not rewrite the file", async () => {
    process.env.CLAUDE_BINARY = "shannon";
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
    process.env.CLAUDE_BINARY = "shannon";
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
});
