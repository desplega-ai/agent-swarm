import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

/**
 * Regression tests for the provider-binary reachability check in
 * docker-entrypoint.sh, focused on the `acp` harness provider.
 *
 * The chain is extracted verbatim from docker-entrypoint.sh between its
 * `# BEGIN verify_provider_binary` / `# END verify_provider_binary` markers and
 * run in a real bash subprocess, so these tests track the deployed boot script
 * instead of a hand-written mirror that could silently drift.
 *
 * Regression: every branch before the `!= "pi"` catch-all excluded exactly one
 * provider (codex, claude-managed, devin, opencode, dsh) but none excluded
 * `acp`, so an `acp` worker fell through to the catch-all and had its `claude`
 * binary checked instead of its ACP target. `claude` is installed
 * unconditionally in the worker image, so the check always passed and a worker
 * with a wrong ACP_TARGET_COMMAND booted clean, then failed at `Bun.spawn`
 * inside ACPAdapter.createSession on the first claimed task.
 *
 * The check has to agree with resolveAcpTarget / customTargetProfile.command
 * in src/providers/acp-targets.ts, so these tests pin the two rules that are
 * easy to get subtly wrong:
 *   - every fallback is unset-only, because the resolver uses `??`. A
 *     set-but-empty ACP_TARGET or ACP_TARGET_COMMAND must fail at boot, not
 *     quietly fall through to a different target.
 *   - the whitespace split that isolates the executable happens only when
 *     ACP_TARGET_ARGS is absent or blank, because parseCommand keeps the whole
 *     trimmed command as argv[0] whenever those args are set.
 *
 * The stub directory is first on PATH and includes an executable `claude` on
 * purpose: it reproduces the original false pass, so the pre-fix chain really
 * does exit 0 for a missing ACP target and these tests fail without the fix.
 */

const entrypointPath = `${import.meta.dir}/../../docker-entrypoint.sh`;

/** Provider binaries the chain may look up. Each is a resolvable stub. */
const STUB_BINARIES = [
  "claude",
  "codex",
  "opencode",
  "dsh",
  "acp-target-stub",
  "acp target stub",
] as const;

let stubDir: string | undefined;

/** Executable no-op stubs, so `command -v` resolves for the provider branches. */
function getStubDir(): string {
  if (stubDir) return stubDir;
  stubDir = mkdtempSync(join(tmpdir(), "acp-entrypoint-"));
  for (const name of STUB_BINARIES) {
    const file = join(stubDir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  return stubDir;
}

function extractProviderBinaryChain(): string {
  const script = readFileSync(entrypointPath, "utf8");

  const beginMarker = "# BEGIN verify_provider_binary";
  const beginIndex = script.indexOf(beginMarker);
  if (beginIndex === -1) {
    throw new Error(
      "Could not locate `# BEGIN verify_provider_binary` in docker-entrypoint.sh — did the provider binary check move?",
    );
  }

  const endMarker = "# END verify_provider_binary";
  const endIndex = script.indexOf(endMarker, beginIndex);
  if (endIndex === -1) {
    throw new Error("Could not locate `# END verify_provider_binary` in docker-entrypoint.sh.");
  }

  return script.slice(beginIndex, endIndex);
}

interface ChainResult {
  exitCode: number | null;
  stdout: string;
}

async function runChain(env: Record<string, string>): Promise<ChainResult> {
  const chain = extractProviderBinaryChain();
  const result = await runChild(["bash", "-c", `set -u\n${chain}\n`], {
    // runChild passes env verbatim, so PATH is built here rather than merged.
    // Stubs go first so they win over any real provider CLI on the runner,
    // and the ambient PATH stays for bash and awk.
    env: { PATH: [getStubDir(), process.env.PATH ?? ""].join(delimiter), ...env },
  });
  return { exitCode: result.exitCode, stdout: result.stdout };
}

describe("docker-entrypoint.sh: acp target binary verification", () => {
  test(
    "fails boot when the custom ACP target binary is missing",
    async () => {
      const result = await runChain({
        HARNESS_PROVIDER: "acp",
        ACP_TARGET_COMMAND: "acp-target-binary-that-does-not-exist",
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain(
        "FATAL: ACP target binary not found: 'acp-target-binary-that-does-not-exist'",
      );
      // The regression proper: a reachable `claude` used to satisfy this check.
      expect(result.stdout).not.toContain("Claude CLI");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "resolves the opencode catalog target to the opencode binary",
    async () => {
      const result = await runChain({ HARNESS_PROVIDER: "acp", ACP_TARGET: "opencode" });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ACP target: ");
      expect(result.stdout).toContain("ACP_TARGET='opencode'");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "resolves a custom target supplied as a command string with argv",
    async () => {
      const result = await runChain({
        HARNESS_PROVIDER: "acp",
        ACP_TARGET_COMMAND: "acp-target-stub --stdio",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ACP target: ");
      expect(result.stdout).toContain("ACP_TARGET='custom'");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "accepts the legacy ACP_COMMAND alias",
    async () => {
      const result = await runChain({
        HARNESS_PROVIDER: "acp",
        ACP_COMMAND: "acp-target-stub",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ACP target: ");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "fails boot when no ACP target is configured at all",
    async () => {
      const result = await runChain({ HARNESS_PROVIDER: "acp" });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain(
        "FATAL: no ACP target configured. Set ACP_TARGET_COMMAND to an ACP-compatible executable",
      );
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "fails boot on an unsupported ACP target",
    async () => {
      const result = await runChain({ HARNESS_PROVIDER: "acp", ACP_TARGET: "gemini-cli" });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain(
        "FATAL: unsupported ACP target 'gemini-cli'. Supported targets: opencode, custom.",
      );
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});

describe("docker-entrypoint.sh: acp target resolution matches the adapter", () => {
  test(
    "keeps a command containing spaces whole when ACP_TARGET_ARGS is set",
    async () => {
      // parseCommand returns [trimmed, ...args] here, so argv[0] is the whole
      // path. Splitting it would check a binary the adapter never spawns.
      const spaced = join(getStubDir(), "acp target stub");
      const result = await runChain({
        HARNESS_PROVIDER: "acp",
        ACP_TARGET_COMMAND: spaced,
        ACP_TARGET_ARGS: '["--stdio"]',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("acp target stub");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "does not split the command when ACP_TARGET_ARGS is an empty JSON array",
    async () => {
      // `[]` parses to no arguments, so argv[0] is still the whole command and
      // the nonexistent binary must fail boot rather than resolve to the stub.
      const result = await runChain({
        HARNESS_PROVIDER: "acp",
        ACP_TARGET_COMMAND: "acp-target-stub definitely-not-a-binary",
        ACP_TARGET_ARGS: "[]",
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain(
        "FATAL: ACP target binary not found: 'acp-target-stub definitely-not-a-binary'",
      );
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "splits the command when ACP_TARGET_ARGS is whitespace only",
    async () => {
      // The guard in parseCommand is args?.trim(), so a blank value takes the
      // whitespace-split path and argv[0] is the first token.
      const result = await runChain({
        HARNESS_PROVIDER: "acp",
        ACP_TARGET_COMMAND: "acp-target-stub definitely-not-a-binary",
        ACP_TARGET_ARGS: "   ",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ACP target: ");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "fails boot on a set-but-empty ACP_TARGET instead of defaulting to custom",
    async () => {
      // resolveAcpTarget uses `??`, so an empty ACP_TARGET is unsupported
      // rather than the "custom" default.
      const result = await runChain({
        HARNESS_PROVIDER: "acp",
        ACP_TARGET: "",
        ACP_TARGET_COMMAND: "acp-target-stub",
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("FATAL: unsupported ACP target ''");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "fails boot on a set-but-empty ACP_TARGET_COMMAND even when ACP_COMMAND is set",
    async () => {
      // `??` only falls through on null/undefined, so an empty primary command
      // does not hand over to the legacy alias.
      const result = await runChain({
        HARNESS_PROVIDER: "acp",
        ACP_TARGET_COMMAND: "",
        ACP_COMMAND: "acp-target-stub",
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain(
        "FATAL: ACP target command is empty. Set ACP_TARGET_COMMAND to an ACP-compatible executable.",
      );
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "fails boot on a whitespace-only ACP_TARGET_COMMAND",
    async () => {
      // The command is trimmed before the empty check, so padding alone is
      // still an empty command.
      const result = await runChain({ HARNESS_PROVIDER: "acp", ACP_TARGET_COMMAND: "   " });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain(
        "FATAL: ACP target command is empty. Set ACP_TARGET_COMMAND to an ACP-compatible executable.",
      );
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});

describe("docker-entrypoint.sh: provider binary chain contract", () => {
  test("gives acp its own branch ahead of the claude catch-all", () => {
    const chain = extractProviderBinaryChain();

    const acpIndex = chain.indexOf('elif [ "$HARNESS_PROVIDER" = "acp" ]; then');
    const catchAllIndex = chain.indexOf('elif [ "$HARNESS_PROVIDER" != "pi" ]; then');

    expect(acpIndex).toBeGreaterThan(-1);
    expect(catchAllIndex).toBeGreaterThan(acpIndex);
  });

  test("acp appears in the entrypoint source at all", () => {
    // Asserted against the whole file, not the extracted block, so a missing
    // branch fails with a readable diff instead of an extraction throw.
    const script = readFileSync(entrypointPath, "utf8");
    expect(script).toContain('elif [ "$HARNESS_PROVIDER" = "acp" ]; then');
  });

  test.each([
    ["claude", "Claude CLI:"],
    ["codex", "Codex CLI:"],
    ["opencode", "opencode CLI:"],
    ["dsh", "dsh CLI:"],
    ["claude-managed", "no local CLI required"],
    ["devin", "cloud API"],
  ])(
    "keeps the %s branch resolving its own binary",
    async (provider, expected) => {
      const result = await runChain({ HARNESS_PROVIDER: provider });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(expected);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "leaves the pi provider unchecked",
    async () => {
      const result = await runChain({ HARNESS_PROVIDER: "pi" });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("FATAL");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
