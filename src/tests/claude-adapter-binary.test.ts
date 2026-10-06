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
 * the session argv off the call args and ignore the binary-version probe.
 * `Bun.which` is stubbed for the tmux gate so the tests don't depend on the
 * host having tmux installed. `$HOME` is redirected to a tmp dir so the
 * trust-preseed never touches the real `~/.claude.json`.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  utimes,
  writeFile,
} from "node:fs/promises";
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
  resolveClaudeTrustDirs,
} from "../providers/claude-adapter";
import type { ProviderSessionConfig } from "../providers/types";
import { setFlockForTests } from "../utils/file-lock";
import { holdFileLock } from "./fixtures/hold-file-lock";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

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

// Bun's child_process shim calls Bun.spawn, so the spawn mocks below must pass
// the trust-dir `git` lookup through to the real implementation.
const realSpawn = Bun.spawn;
const isGit = (cmd: unknown) =>
  (Array.isArray(cmd) ? cmd : (cmd as { cmd?: unknown[] } | null)?.cmd)?.[0] === "git";

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

async function createCompletedSession(adapter: ClaudeAdapter, config: ProviderSessionConfig) {
  const session = await adapter.createSession(config);
  await session.waitForCompletion();
  return session;
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
      { SWARM_USE_CLAUDE_BRIDGE: "true", CLAUDE_CODE_OAUTH_TOKEN: "example-sk-ant-oat01-x" },
      {},
    );
    expect(r.useClaudeBridge).toBe(true);
    expect(r.argv).toEqual(["claude-bridge"]);
    expect(r.bridgeRequestedWithoutOAuth).toBe(false);
  });

  test("bridge requested + no OAuth (only API key) → falls back to stock claude", () => {
    const r = resolveClaudeBinaryArgv(
      { SWARM_USE_CLAUDE_BRIDGE: "true", ANTHROPIC_API_KEY: "example-sk-ant-api" },
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
      { CLAUDE_CODE_OAUTH_TOKEN: "example-sk-ant-oat01-fallback" },
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
    const r = resolveClaudeBinaryArgv({ CLAUDE_CODE_OAUTH_TOKEN: "example-sk-ant-oat01-x" }, {});
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
    await preseedClaudeTrustDialog([cwd], homeDir);

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
    await preseedClaudeTrustDialog(["/abs/cwd/x"], homeDir);

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
    await preseedClaudeTrustDialog(["/abs/cwd/x"], homeDir);

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
    await preseedClaudeTrustDialog(["/abs/cwd/x"], homeDir);
    const afterStat = await Bun.file(join(homeDir, ".claude.json")).text();

    // No-op → file contents unchanged.
    expect(afterStat).toBe(beforeStat);
  });

  test("malformed file: backs it up, then writes the entry", async () => {
    await writeFile(join(homeDir, ".claude.json"), "{ this is not valid json");
    await preseedClaudeTrustDialog(["/abs/cwd/x"], homeDir);

    const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
    expect(data.projects["/abs/cwd/x"].hasTrustDialogAccepted).toBe(true);
    const backup = (await readdir(homeDir)).find((f) => f.includes(".malformed-"));
    expect(backup).toBeDefined();
    expect(await readFile(join(homeDir, backup as string), "utf-8")).toBe(
      "{ this is not valid json",
    );
  });

  test("scrubs secrets from the success and malformed-file log lines", async () => {
    const secret = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await writeFile(join(homeDir, ".claude.json"), "{ not json");
      await preseedClaudeTrustDialog([`/abs/${secret}`], homeDir);
      const out = [...logSpy.mock.calls, ...warnSpy.mock.calls].flat().join("\n");
      expect(out).toContain("Pre-seeded trust");
      expect(out).toContain("unreadable");
      expect(out).not.toContain(secret);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test(
    "worktree: seeds the worktree and the main checkout",
    async () => {
      const repo = await realpath(await mkdtemp(join(tmpdir(), "claude-trust-repo-")));
      const wt = join(repo, "..", `wt-${Date.now()}`);
      try {
        for (const args of [
          ["init", "-q"],
          ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"],
          ["worktree", "add", "-q", wt],
        ]) {
          expectChildOk(await runChild(["git", "-C", repo, ...args]), `git ${args[0]}`);
        }
        const dirs = await resolveClaudeTrustDirs(wt);
        expect(dirs).toEqual([await realpath(wt), repo]);
        await preseedClaudeTrustDialog(dirs, homeDir);
        const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
        expect(Object.keys(data.projects).sort()).toEqual([...dirs].sort());
      } finally {
        await rm(wt, { recursive: true, force: true });
        await rm(repo, { recursive: true, force: true });
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "separate-git-dir: seeds the checkout, not the metadata parent",
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "claude-trust-sep-")));
      try {
        const checkout = join(root, "checkout");
        const wt = join(root, "wt");
        await mkdir(checkout);
        await mkdir(join(root, "metadata"));
        for (const args of [
          ["init", "-q", `--separate-git-dir=${join(root, "metadata", "repo.git")}`, checkout],
        ]) {
          expectChildOk(await runChild(["git", ...args]), "git init");
        }
        for (const args of [
          ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"],
          ["worktree", "add", "-q", wt],
        ]) {
          expectChildOk(await runChild(["git", "-C", checkout, ...args]), `git ${args[0]}`);
        }
        expect(await resolveClaudeTrustDirs(checkout)).toEqual([checkout]);
        // The checkout is not discoverable from a linked worktree here; never fall back to metadata.
        expect(await resolveClaudeTrustDirs(wt)).toEqual([wt]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "bare repository: no checkout is trusted beyond cwd",
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "claude-trust-bare-")));
      try {
        const bare = join(root, "bare.git");
        expectChildOk(await runChild(["git", "init", "-q", "--bare", bare]), "git init");
        expect(await resolveClaudeTrustDirs(bare)).toEqual([bare]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test("concurrent seeding keeps every entry and unrelated keys", async () => {
    await writeFile(
      join(homeDir, ".claude.json"),
      JSON.stringify({ theme: "dark", projects: { "/kept": { custom: 1 } } }),
    );
    const dirs = Array.from({ length: 8 }, (_, i) => `/concurrent/${i}`);
    await Promise.all(dirs.map((d) => preseedClaudeTrustDialog([d], homeDir)));
    const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
    expect(data.theme).toBe("dark");
    expect(data.projects["/kept"]).toEqual({ custom: 1 });
    for (const d of dirs) expect(data.projects[d].hasTrustDialogAccepted).toBe(true);
    const leftovers = (await readdir(homeDir)).filter(
      (f) => f.endsWith(".tmp") || f.endsWith(".lock"),
    );
    expect(leftovers).toEqual([]);
  });

  test("waits for a fresh held lock until it is released", async () => {
    const lock = join(homeDir, ".claude.json.lock");
    await mkdir(lock);
    let done = false;
    const seeding = preseedClaudeTrustDialog(["/after/held"], homeDir).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(done).toBe(false);
    await rmdir(lock);
    await seeding;
    const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
    expect(data.projects["/after/held"].hasTrustDialogAccepted).toBe(true);
  });

  test("clears a stale lock", async () => {
    const lock = join(homeDir, ".claude.json.lock");
    await mkdir(lock);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await preseedClaudeTrustDialog(["/after/stale"], homeDir);
    const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
    expect(data.projects["/after/stale"].hasTrustDialogAccepted).toBe(true);
  });

  test("a suspended owner whose mkdir lock aged out keeps exclusion", async () => {
    // Owner A holds the flock and its mkdir lock has expired (as if A was
    // suspended past the lease). B must not enter until A finishes: otherwise
    // A's late commit of an older snapshot would erase B's entry.
    const releaseA = await holdFileLock(join(homeDir, ".claude.json.swarm-lock"));
    const lock = join(homeDir, ".claude.json.lock");
    await mkdir(lock);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);

    let bDone = false;
    const b = preseedClaudeTrustDialog(["/b"], homeDir).then(() => {
      bDone = true;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(bDone).toBe(false);
    await expect(readFile(join(homeDir, ".claude.json"), "utf-8")).rejects.toThrow();

    // A resumes and commits its snapshot, then releases both locks.
    await writeFile(
      join(homeDir, ".claude.json"),
      JSON.stringify({ projects: { "/a": { hasTrustDialogAccepted: true } } }),
    );
    await rmdir(lock);
    await releaseA();
    await b;

    const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
    expect(data.projects["/a"].hasTrustDialogAccepted).toBe(true);
    expect(data.projects["/b"].hasTrustDialogAccepted).toBe(true);
    expect(await readdir(homeDir)).toEqual([".claude.json", ".claude.json.swarm-lock"]);
  });

  test("many writers on an expired mkdir lock keep every entry of every round", async () => {
    const all: string[] = [];
    for (let round = 0; round < 5; round++) {
      const lock = join(homeDir, ".claude.json.lock");
      await mkdir(lock);
      const old = new Date(Date.now() - 60_000);
      await utimes(lock, old, old);
      const dirs = Array.from({ length: 6 }, (_, i) => `/round${round}/${i}`);
      all.push(...dirs);
      await Promise.all(dirs.map((d) => preseedClaudeTrustDialog([d], homeDir)));
      const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
      for (const d of all) expect(data.projects[d].hasTrustDialogAccepted).toBe(true);
    }
    expect((await readdir(homeDir)).sort()).toEqual([".claude.json", ".claude.json.swarm-lock"]);
  });

  test("without flock it fails closed and writes nothing", async () => {
    setFlockForTests(null);
    try {
      await expect(preseedClaudeTrustDialog(["/noflock"], homeDir)).rejects.toThrow(
        /flock unavailable/,
      );
    } finally {
      setFlockForTests(undefined);
    }
    expect(await Bun.file(join(homeDir, ".claude.json")).exists()).toBe(false);
  });

  test("an unopenable lock file fails closed", async () => {
    await mkdir(join(homeDir, ".claude.json.swarm-lock"));
    await expect(preseedClaudeTrustDialog(["/nolockfile"], homeDir)).rejects.toThrow(/cannot open/);
    expect(await Bun.file(join(homeDir, ".claude.json")).exists()).toBe(false);
  });

  test("non-repo cwd: only its real path", async () => {
    expect(await resolveClaudeTrustDirs(homeDir)).toEqual([await realpath(homeDir)]);
  });
});

// ─── Integration tests through ClaudeAdapter.createSession ────────────────────

describe("CLAUDE_BINARY env override", () => {
  // Cache the originals and restore after each test so the suite stays clean.
  let originalClaudeTransport: string | undefined;
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
    originalClaudeTransport = process.env.CLAUDE_TRANSPORT;
    delete process.env.CLAUDE_TRANSPORT;
    originalClaudeBinary = process.env.CLAUDE_BINARY;
    originalUseClaudeBridge = process.env.SWARM_USE_CLAUDE_BRIDGE;
    originalOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    originalHome = process.env.HOME;
    homeDir = await mkdtemp(join(tmpdir(), "claude-adapter-test-home-"));
    process.env.HOME = homeDir;
    delete process.env.CLAUDE_BINARY;
    delete process.env.SWARM_USE_CLAUDE_BRIDGE;
    delete process.env.CLAUDE_QUEUE_STEERING;
    // Credential check runs before binary resolution; satisfy it.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "example-test-token";

    spawnedArgs = [];
    spawnedEnvs = [];
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((cmd: readonly string[], opts?: unknown) => {
      if (isGit(cmd)) return (realSpawn as (...a: unknown[]) => unknown)(cmd, opts);
      if (cmd.at(-1) !== "--version") {
        spawnedArgs.push(cmd);
        spawnedEnvs.push((opts as { env?: Record<string, string> } | undefined)?.env);
      }
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
    if (originalClaudeTransport === undefined) {
      delete process.env.CLAUDE_TRANSPORT;
    } else {
      process.env.CLAUDE_TRANSPORT = originalClaudeTransport;
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
    await createCompletedSession(adapter, makeConfig());

    expect(spawnedArgs).toHaveLength(1);
    const argv = spawnedArgs[0];
    expect(argv[0]).toBe("claude");
  });

  test("legacy bridge override: argv[0] comes from CLAUDE_BINARY", async () => {
    process.env.CLAUDE_BINARY = LEGACY_BRIDGE_COMPAT_BINARY;

    const adapter = new ClaudeAdapter();
    await createCompletedSession(adapter, makeConfig());

    const argv = spawnedArgs[0];
    expect(argv[0]).toBe(LEGACY_BRIDGE_COMPAT_BINARY);
  });

  test("custom legacy bridge path: argv[0] is the absolute path", async () => {
    process.env.CLAUDE_BINARY = `/usr/local/bin/${LEGACY_BRIDGE_COMPAT_BINARY}`;

    const adapter = new ClaudeAdapter();
    await createCompletedSession(adapter, makeConfig());

    expect(spawnedArgs[0][0]).toBe(`/usr/local/bin/${LEGACY_BRIDGE_COMPAT_BINARY}`);
  });

  test("legacy bridge command string → argv[0..1] is split", async () => {
    process.env.CLAUDE_BINARY = LEGACY_BRIDGE_COMPAT_COMMAND;

    const adapter = new ClaudeAdapter();
    await createCompletedSession(adapter, makeConfig());

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
    await createCompletedSession(adapter, makeConfig());

    const argv = spawnedArgs[0];
    expect(argv[0]).toBe("bunx");
    expect(argv[1]).toBe(`${LEGACY_BRIDGE_COMPAT_PACKAGE}@1.2.3`);
  });

  test("multiple-space tolerance for legacy bridge command", async () => {
    process.env.CLAUDE_BINARY = `  bunx  ${LEGACY_BRIDGE_COMPAT_BINARY}  `;

    const adapter = new ClaudeAdapter();
    await createCompletedSession(adapter, makeConfig());

    const argv = spawnedArgs[0];
    expect(argv[0]).toBe("bunx");
    expect(argv[1]).toBe(LEGACY_BRIDGE_COMPAT_BINARY);
    expect(argv).toContain("--model");
  });

  test("argv[1..] after prefix matches between default and legacy bridge command", async () => {
    // Pin the invocation path: the stream-json/`-p` choice is version-probed
    // per binary, so without this the assertion would depend on which Claude
    // CLI happens to be installed on the machine running the test.
    process.env.CLAUDE_QUEUE_STEERING = "0";
    process.env.CLAUDE_BINARY = LEGACY_BRIDGE_COMPAT_COMMAND;
    const adapter = new ClaudeAdapter();
    await createCompletedSession(adapter, makeConfig());
    // Drop the 2-element prefix.
    const argvLegacyBridge = spawnedArgs[0].slice(2);

    spawnedArgs = [];
    delete process.env.CLAUDE_BINARY;
    await createCompletedSession(adapter, makeConfig());
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
    await createCompletedSession(
      adapter,
      makeConfig({
        env: {
          CLAUDE_BINARY: LEGACY_BRIDGE_COMPAT_BINARY,
          CLAUDE_CODE_OAUTH_TOKEN: "example-test-token",
        } as Record<string, string>,
      }),
    );

    expect(spawnedArgs[0][0]).toBe(LEGACY_BRIDGE_COMPAT_BINARY);
  });

  test("config.env legacy bridge command override splits + spawns correctly", async () => {
    delete process.env.CLAUDE_BINARY;

    const adapter = new ClaudeAdapter();
    await createCompletedSession(
      adapter,
      makeConfig({
        env: {
          CLAUDE_BINARY: LEGACY_BRIDGE_COMPAT_COMMAND,
          CLAUDE_CODE_OAUTH_TOKEN: "example-test-token",
        } as Record<string, string>,
      }),
    );

    expect(spawnedArgs[0][0]).toBe("bunx");
    expect(spawnedArgs[0][1]).toBe(LEGACY_BRIDGE_COMPAT_PACKAGE);
  });

  test("config.env without CLAUDE_BINARY falls back to process.env", async () => {
    process.env.CLAUDE_BINARY = LEGACY_BRIDGE_COMPAT_BINARY;

    const adapter = new ClaudeAdapter();
    await createCompletedSession(
      adapter,
      makeConfig({
        // env has CLAUDE_CODE_OAUTH_TOKEN but no CLAUDE_BINARY → process.env wins.
        env: { CLAUDE_CODE_OAUTH_TOKEN: "example-test-token" } as Record<string, string>,
      }),
    );

    expect(spawnedArgs[0][0]).toBe(LEGACY_BRIDGE_COMPAT_BINARY);
  });

  test("SWARM_USE_CLAUDE_BRIDGE=true routes through installed claude-bridge", async () => {
    process.env.SWARM_USE_CLAUDE_BRIDGE = "true";

    const adapter = new ClaudeAdapter();
    await createCompletedSession(adapter, makeConfig());

    const argv = spawnedArgs[0];
    expect(argv[0]).toBe("claude-bridge");
    expect(argv).toContain("--model");
    expect(argv).toContain("-p");
  });

  test("SWARM_USE_CLAUDE_BRIDGE=true passes OAuth token to the bridge process", async () => {
    process.env.SWARM_USE_CLAUDE_BRIDGE = "true";

    const adapter = new ClaudeAdapter();
    await createCompletedSession(adapter, makeConfig());

    expect(spawnedArgs[0][0]).toBe("claude-bridge");
    expect(spawnedEnvs[0]?.CLAUDE_CODE_OAUTH_TOKEN).toBe("example-test-token");
  });

  test("SWARM_USE_CLAUDE_BRIDGE=true forwards Anthropic local auth through bridge flag", async () => {
    const adapter = new ClaudeAdapter();
    await createCompletedSession(
      adapter,
      makeConfig({
        env: {
          SWARM_USE_CLAUDE_BRIDGE: "true",
          ANTHROPIC_API_KEY: "example-sk-ant-test",
        } as Record<string, string>,
      }),
    );

    expect(spawnedArgs[0][0]).toBe("claude-bridge");
    expect(spawnedArgs[0]).toContain("--desplega-local-auth");
    expect(spawnedEnvs[0]?.ANTHROPIC_API_KEY).toBe("example-sk-ant-test");
    expect(spawnedEnvs[0]?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test("SWARM_USE_CLAUDE_BRIDGE=1 wins over legacy CLAUDE_BINARY", async () => {
    process.env.SWARM_USE_CLAUDE_BRIDGE = "1";
    process.env.CLAUDE_BINARY = LEGACY_BRIDGE_COMPAT_BINARY;

    const adapter = new ClaudeAdapter();
    await createCompletedSession(adapter, makeConfig());

    expect(spawnedArgs[0][0]).toBe("claude-bridge");
  });

  test("config.env SWARM_USE_CLAUDE_BRIDGE=true is reloadable and wins over process.env false", async () => {
    process.env.SWARM_USE_CLAUDE_BRIDGE = "false";

    const adapter = new ClaudeAdapter();
    await createCompletedSession(
      adapter,
      makeConfig({
        env: {
          SWARM_USE_CLAUDE_BRIDGE: "true",
          CLAUDE_CODE_OAUTH_TOKEN: "example-test-token",
        } as Record<string, string>,
      }),
    );

    expect(spawnedArgs[0][0]).toBe("claude-bridge");
  });

  test("config.env SWARM_USE_CLAUDE_BRIDGE=false disables process.env true", async () => {
    process.env.SWARM_USE_CLAUDE_BRIDGE = "true";

    const adapter = new ClaudeAdapter();
    await createCompletedSession(
      adapter,
      makeConfig({
        env: {
          SWARM_USE_CLAUDE_BRIDGE: "false",
          CLAUDE_CODE_OAUTH_TOKEN: "example-test-token",
        } as Record<string, string>,
      }),
    );

    expect(spawnedArgs[0][0]).toBe("claude");
  });

  test("SWARM_USE_CLAUDE_BRIDGE=true without OAuth token falls back to stock claude", async () => {
    const origApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "example-sk-ant-test";
    process.env.SWARM_USE_CLAUDE_BRIDGE = "true";
    try {
      const adapter = new ClaudeAdapter();
      await createCompletedSession(adapter, makeConfig());
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
  let originalClaudeTransport: string | undefined;
  let originalClaudeBinary: string | undefined;
  let originalUseClaudeBridge: string | undefined;
  let originalOauthToken: string | undefined;
  let originalHome: string | undefined;
  let homeDir: string;
  let spawnSpy: ReturnType<typeof spyOn>;
  let whichSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    originalClaudeTransport = process.env.CLAUDE_TRANSPORT;
    delete process.env.CLAUDE_TRANSPORT;
    originalClaudeBinary = process.env.CLAUDE_BINARY;
    originalUseClaudeBridge = process.env.SWARM_USE_CLAUDE_BRIDGE;
    originalOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    originalHome = process.env.HOME;
    homeDir = await mkdtemp(join(tmpdir(), "claude-adapter-test-home-"));
    process.env.HOME = homeDir;
    delete process.env.CLAUDE_BINARY;
    delete process.env.SWARM_USE_CLAUDE_BRIDGE;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "example-test-token";
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((cmd: unknown, opts?: unknown) =>
      isGit(cmd)
        ? (realSpawn as (...a: unknown[]) => unknown)(cmd, opts)
        : makeFakeProc()) as typeof Bun.spawn);
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
    if (originalClaudeTransport === undefined) {
      delete process.env.CLAUDE_TRANSPORT;
    } else {
      process.env.CLAUDE_TRANSPORT = originalClaudeTransport;
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
    await expect(createCompletedSession(adapter, makeConfig())).resolves.toBeDefined();
  });

  test("default binary skips the tmux check (no Bun.which call for tmux)", async () => {
    process.env.CLAUDE_BINARY = "claude";
    whichSpy.mockImplementation((name: string) => {
      if (name === "tmux") return null;
      return null;
    });

    const adapter = new ClaudeAdapter();
    // Should NOT throw even though tmux is "missing".
    await expect(createCompletedSession(adapter, makeConfig())).resolves.toBeDefined();
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
  let originalClaudeTransport: string | undefined;
  let originalClaudeBinary: string | undefined;
  let originalUseClaudeBridge: string | undefined;
  let originalOauthToken: string | undefined;
  let originalHome: string | undefined;
  let homeDir: string;
  let spawnSpy: ReturnType<typeof spyOn>;
  let whichSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    originalClaudeTransport = process.env.CLAUDE_TRANSPORT;
    delete process.env.CLAUDE_TRANSPORT;
    originalClaudeBinary = process.env.CLAUDE_BINARY;
    originalUseClaudeBridge = process.env.SWARM_USE_CLAUDE_BRIDGE;
    originalOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    originalHome = process.env.HOME;
    homeDir = await mkdtemp(join(tmpdir(), "claude-adapter-trust-test-"));
    process.env.HOME = homeDir;
    delete process.env.CLAUDE_BINARY;
    delete process.env.SWARM_USE_CLAUDE_BRIDGE;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "example-test-token";
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((cmd: unknown, opts?: unknown) =>
      isGit(cmd)
        ? (realSpawn as (...a: unknown[]) => unknown)(cmd, opts)
        : makeFakeProc()) as typeof Bun.spawn);
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
    if (originalClaudeTransport === undefined) {
      delete process.env.CLAUDE_TRANSPORT;
    } else {
      process.env.CLAUDE_TRANSPORT = originalClaudeTransport;
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
    await createCompletedSession(adapter, makeConfig({ cwd }));

    const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
    expect(data.projects[cwd].hasTrustDialogAccepted).toBe(true);
    expect(data.projects[cwd].hasCompletedProjectOnboarding).toBe(true);
  });

  test("headless (no bridge) session also seeds trust", async () => {
    const cwd = "/some/headless/cwd";
    await createCompletedSession(new ClaudeAdapter(), makeConfig({ cwd }));

    const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
    expect(data.projects[cwd].hasTrustDialogAccepted).toBe(true);
  });

  test("CLAUDE_TRUST_PRESEED=false writes nothing", async () => {
    const cwd = "/some/off/cwd";
    await createCompletedSession(
      new ClaudeAdapter(),
      makeConfig({
        cwd,
        env: { CLAUDE_CODE_OAUTH_TOKEN: "example-test-token", CLAUDE_TRUST_PRESEED: "false" },
      }),
    );

    expect(await Bun.file(join(homeDir, ".claude.json")).exists()).toBe(false);
  });

  test("legacy CLAUDE_BINARY command string also triggers the pre-seed", async () => {
    process.env.CLAUDE_BINARY = LEGACY_BRIDGE_COMPAT_COMMAND;
    const cwd = "/some/other/cwd";
    const adapter = new ClaudeAdapter();
    await createCompletedSession(adapter, makeConfig({ cwd }));

    const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
    expect(data.projects[cwd].hasTrustDialogAccepted).toBe(true);
  });

  test("idempotent: re-creating legacy bridge session does not rewrite the file", async () => {
    process.env.CLAUDE_BINARY = LEGACY_BRIDGE_COMPAT_BINARY;
    const cwd = "/some/abs/cwd";
    const adapter = new ClaudeAdapter();
    await createCompletedSession(adapter, makeConfig({ cwd }));
    const first = await readFile(join(homeDir, ".claude.json"), "utf-8");
    await createCompletedSession(adapter, makeConfig({ cwd }));
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
    await createCompletedSession(adapter, makeConfig({ cwd: "/new/cwd" }));

    const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
    expect(data.projects["/other/cwd"]).toEqual({ hasTrustDialogAccepted: true, custom: 1 });
    expect(data.projects["/new/cwd"].hasTrustDialogAccepted).toBe(true);
  });

  test("SWARM_USE_CLAUDE_BRIDGE=true writes hasTrustDialogAccepted for config.cwd", async () => {
    process.env.SWARM_USE_CLAUDE_BRIDGE = "true";
    const cwd = "/some/bridge/cwd";
    const adapter = new ClaudeAdapter();
    await createCompletedSession(adapter, makeConfig({ cwd }));

    const data = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"));
    expect(data.projects[cwd].hasTrustDialogAccepted).toBe(true);
    expect(data.projects[cwd].hasCompletedProjectOnboarding).toBe(true);
  });
});
