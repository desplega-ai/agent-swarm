import { describe, expect, mock, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACP_TARGET_CATALOG } from "../providers/acp-target-catalog";
import {
  resolveCodexCommand,
  resolveOpencodeSdkSpecifier,
  validateProviderDependencies,
} from "../providers/runtime-dependencies";
import type { ProviderSessionConfig } from "../providers/types";
import { type ProviderName, ProviderNameSchema } from "../types";

function config(env: Record<string, string> = {}): ProviderSessionConfig {
  return {
    prompt: "fixture",
    systemPrompt: "",
    model: "openrouter/test/model",
    role: "worker",
    agentId: "11111111-1111-4111-8111-111111111111",
    taskId: "22222222-2222-4222-8222-222222222222",
    apiUrl: "http://fixture.invalid",
    apiKey: "fixture-key",
    cwd: process.cwd(),
    env,
  };
}

function probes() {
  return {
    which: mock((command: string, _env: Record<string, string | undefined>, _cwd: string) =>
      command.startsWith("/") ? command : (`/bin/${command}` as string | null),
    ),
    resolveModule: mock((specifier: string) => specifier),
  };
}

describe("provider runtime dependencies", () => {
  test.each(
    ProviderNameSchema.options,
  )("%s has an explicit dependency policy", async (provider) => {
    const deps = probes();
    await validateProviderDependencies(provider, config({ ACP_TARGET: "opencode" }), deps);
    const checkedClaude = deps.which.mock.calls.some(([command]) => command === "claude");
    expect(checkedClaude).toBe(provider === "claude");
  });

  test.each([
    ["codex", "CODEX_BINARY", "@openai/codex"],
    ["codex", "CODEX_PATH_OVERRIDE", "@openai/codex"],
    ["dsh", "DSH_BINARY", "@deepseek-ai/dsh"],
    ["amp", "AMP_BINARY", "@ampcode/cli"],
    ["grok", "GROK_BINARY", "@xai-official/grok"],
    ["fx", "FX_BINARY", "FX_VERSION"],
  ])("%s checks %s and gives installation guidance", async (provider, variable, hint) => {
    for (const value of [undefined, "", "/custom/provider executable"]) {
      const deps = probes();
      const session = config({
        PATH: "/fixture/bin",
        ...(value !== undefined ? { [variable]: value } : {}),
      });
      await validateProviderDependencies(provider as ProviderName, session, deps);
      expect(deps.which.mock.calls.some(([command]) => command === (value || provider))).toBe(true);
      deps.which.mockReturnValue(null);
      deps.resolveModule.mockImplementation(() => {
        throw new Error("missing module");
      });
      await expect(
        validateProviderDependencies(provider as ProviderName, session, deps),
      ).rejects.toThrow(hint);
      await expect(
        validateProviderDependencies(provider as ProviderName, session, deps),
      ).rejects.toThrow(`${provider} provider`);
    }
  });

  test("Codex prioritizes the runtime override, then legacy override, PATH and package", () => {
    const deps = probes();
    expect(
      resolveCodexCommand(
        { CODEX_PATH_OVERRIDE: "/runtime", CODEX_BINARY: "/legacy" },
        "/cwd",
        deps,
      ),
    ).toBe("/runtime");
    expect(resolveCodexCommand({ CODEX_BINARY: "/legacy" }, "/cwd", deps)).toBe("/legacy");
    expect(resolveCodexCommand({}, "/cwd", deps)).toBe("/bin/codex");
    deps.which.mockReturnValue(null);
    deps.resolveModule.mockReturnValue("/local/codex.js");
    expect(resolveCodexCommand({}, "/cwd", deps)).toBe("/local/codex.js");
  });

  test("Claude parses argv prefixes and uses the effective bridge command", async () => {
    const deps = probes();
    const session = config({ CLAUDE_BINARY: "  custom-claude --debug  " });
    await validateProviderDependencies("claude", session, deps);
    expect(deps.which.mock.calls[0]?.[0]).toBe("custom-claude");
    session.env = { SWARM_USE_CLAUDE_BRIDGE: "true", CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth" };
    await validateProviderDependencies("claude", session, deps);
    expect(deps.which.mock.calls[1]?.[0]).toBe("claude-bridge");
  });

  test.each([
    "pi",
    "devin",
    "claude-managed",
    "cursor",
  ] as const)("%s needs no CLI", async (provider) => {
    const deps = probes();
    deps.which.mockReturnValue(null);
    await validateProviderDependencies(provider, config(), deps);
    expect(deps.which).not.toHaveBeenCalled();
    expect(deps.resolveModule).not.toHaveBeenCalled();
  });

  test("Cursor validates an explicit ripgrep path", async () => {
    const deps = probes();
    deps.which.mockReturnValue(null);
    await expect(
      validateProviderDependencies("cursor", config({ CURSOR_RIPGREP_PATH: "/missing/rg" }), deps),
    ).rejects.toThrow("CURSOR_RIPGREP_PATH");
  });

  test("OpenCode resolves the SDK override and names a missing SDK without checking a CLI", async () => {
    const deps = probes();
    const session = config({ OPENCODE_SDK_PATH: "/missing/sdk.js" });
    expect(resolveOpencodeSdkSpecifier(session.env)).toBe("/missing/sdk.js");
    await validateProviderDependencies("opencode", session, deps);
    expect(deps.resolveModule).toHaveBeenCalledWith("/missing/sdk.js");
    deps.resolveModule.mockImplementation(() => {
      throw new Error("missing module");
    });
    await expect(validateProviderDependencies("opencode", session, deps)).rejects.toThrow(
      "@opencode/sdk",
    );
    await expect(validateProviderDependencies("opencode", session, deps)).rejects.toThrow(
      "OPENCODE_SDK_PATH",
    );
    expect(deps.which).not.toHaveBeenCalled();
  });

  test("ACP presets use their runtime command and supply installation guidance", async () => {
    for (const target of ACP_TARGET_CATALOG) {
      if (target.id === "custom") continue;
      const deps = probes();
      const session = config({ ACP_TARGET: target.id });
      await validateProviderDependencies("acp", session, deps);
      expect(deps.which.mock.calls[0]?.[0]).toBe(target.command!);
      deps.which.mockReturnValue(null);
      await expect(validateProviderDependencies("acp", session, deps)).rejects.toThrow(
        `ACP_TARGET='${target.id}'`,
      );
      await expect(validateProviderDependencies("acp", session, deps)).rejects.toThrow("Install");
    }
  });

  test.each([
    [{ ACP_TARGET_COMMAND: "target --stdio" }, "target"],
    [{ ACP_COMMAND: "legacy --stdio" }, "legacy"],
    [
      { ACP_TARGET_COMMAND: "/path with spaces/target", ACP_TARGET_ARGS: '["--stdio"]' },
      "/path with spaces/target",
    ],
    [{ ACP_TARGET_COMMAND: "target extra", ACP_TARGET_ARGS: "[]" }, "target extra"],
    [{ ACP_TARGET_COMMAND: "target extra", ACP_TARGET_ARGS: "  " }, "target"],
  ] as const)("ACP preserves custom argv resolution: %j", async (env, command) => {
    const deps = probes();
    await validateProviderDependencies("acp", config({ ...env }), deps);
    expect(deps.which.mock.calls[0]?.[0]).toBe(command);
  });

  test.each([
    {},
    { ACP_TARGET: "" },
    { ACP_TARGET: "unsupported" },
    { ACP_TARGET_COMMAND: "", ACP_COMMAND: "legacy" },
    { ACP_TARGET_COMMAND: "   " },
  ])("ACP rejects missing/invalid configuration: %j", async (env) => {
    await expect(validateProviderDependencies("acp", config(env), probes())).rejects.toThrow("ACP");
  });

  test("real probes reject missing/non-executable overrides, resolve relative paths and SDK modules", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dependencies-"));
    try {
      const session = config({ AMP_BINARY: "./local-cli" });
      session.cwd = directory;
      await expect(validateProviderDependencies("amp", session)).rejects.toThrow("./local-cli");
      await Bun.write(join(directory, "local-cli"), "#!/bin/sh\nexit 0\n");
      await expect(validateProviderDependencies("amp", session)).rejects.toThrow("not executable");
      await chmod(join(directory, "local-cli"), 0o755);
      await validateProviderDependencies("amp", session);
      session.env = { OPENCODE_SDK_PATH: join(directory, "sdk.js") };
      await expect(validateProviderDependencies("opencode", session)).rejects.toThrow(
        "@opencode/sdk",
      );
      await Bun.write(join(directory, "sdk.js"), "export const OpenCode = {};\n");
      await validateProviderDependencies("opencode", session);
      // Source installs resolve the local SDK without the global worker image layout.
      await validateProviderDependencies("opencode", config());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("the shell and both worker leaves no longer package a boot-time provider gate", async () => {
    for (const path of ["docker-entrypoint.sh", "Dockerfile.worker"]) {
      const source = await Bun.file(join(import.meta.dir, "../..", path)).text();
      expect(source).not.toContain("entrypoint-provider-binary");
      expect(source).not.toContain("verify_provider_binary");
    }
  });
});
