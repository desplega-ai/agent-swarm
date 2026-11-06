import { describe, expect, mock, test } from "bun:test";
import {
  type ProviderBinaryDependencies,
  verifyProviderBinary,
} from "../commands/entrypoint-provider-binary";
import { ACP_TARGET_CATALOG } from "../providers/acp-target-catalog";

function probes() {
  const deps = {
    which: mock((command: string, _path: string | undefined) => `/bin/${command}` as string | null),
    isFile: mock(async (_path: string) => false),
    isExecutable: mock(async (_path: string) => false),
    version: mock(async (_command: string, _env: Record<string, string | undefined>) => "1.2.3"),
    log: mock((_message: string) => {}),
  } satisfies ProviderBinaryDependencies;
  return deps;
}

describe("provider binary boot step", () => {
  test.each([
    ["codex", "CODEX_BINARY", "Codex"],
    ["dsh", "DSH_BINARY", "dsh"],
    ["amp", "AMP_BINARY", "amp"],
    ["grok", "GROK_BINARY", "grok"],
    ["fx", "FX_BINARY", "fx"],
  ])("%s checks the default, empty fallback and override", async (provider, variable, label) => {
    for (const value of [undefined, "", "custom-cli"]) {
      const deps = probes();
      const env = { PATH: "/test/bin", [variable]: value };
      expect(await verifyProviderBinary(provider, env, deps)).toBe(true);
      expect(deps.which).toHaveBeenCalledWith(value || provider, env.PATH);
      expect(deps.log.mock.calls[0]?.[0]).toStartWith(`${label} CLI: /bin/${value || provider}`);
      deps.which.mockReturnValue(null);
      expect(await verifyProviderBinary(provider, env, deps)).toBe(false);
      expect(deps.log.mock.calls[1]?.[0]).toStartWith(`FATAL: ${label} CLI not found:`);
    }
  });

  test.each([
    ["grok", "GROK_DISABLE_AUTOUPDATER", "1"],
    ["fx", "FX_AUTO_UPGRADE", "0"],
  ])("%s disables updates only for its informational version call", async (provider, flag, value) => {
    const deps = probes();
    const env = { PATH: "/test/bin", [flag]: "original" };
    expect(await verifyProviderBinary(provider, env, deps)).toBe(true);
    expect(deps.version).toHaveBeenCalledWith(`/bin/${provider}`, { ...env, [flag]: value });
    expect(env[flag]).toBe("original");
    expect(deps.log.mock.calls[0]?.[0]).toEndWith("(1.2.3)");
    deps.version.mockRejectedValue(new Error("unavailable version"));
    expect(await verifyProviderBinary(provider, env, deps)).toBe(true);
    expect(deps.log.mock.calls[1]?.[0]).toEndWith("()");
  });

  test.each(["pi", "devin", "claude-managed", "cursor"])("%s needs no CLI", async (provider) => {
    const deps = probes();
    expect(await verifyProviderBinary(provider, {}, deps)).toBe(true);
    expect(deps.which).not.toHaveBeenCalled();
    expect(deps.version).not.toHaveBeenCalled();
  });

  test("Cursor checks an explicitly configured ripgrep executable", async () => {
    const deps = probes();
    const env = { CURSOR_RIPGREP_PATH: "/tools/rg" };
    expect(await verifyProviderBinary("cursor", env, deps)).toBe(false);
    expect(deps.isExecutable).toHaveBeenCalledWith("/tools/rg");
    deps.isExecutable.mockResolvedValue(true);
    expect(await verifyProviderBinary("cursor", env, deps)).toBe(true);
  });

  test("OpenCode searches global SDK roots in order, never a CLI", async () => {
    for (const root of ["/usr/lib/node_modules", "/usr/local/lib/node_modules"]) {
      const deps = probes();
      const entry = `${root}/@opencode/sdk/dist/index.js`;
      deps.isFile.mockImplementation(async (path) => path === entry);
      expect(await verifyProviderBinary("opencode", {}, deps)).toBe(true);
      expect(deps.isFile.mock.calls[0]?.[0]).toBe(
        "/usr/lib/node_modules/@opencode/sdk/dist/index.js",
      );
      expect(deps.log).toHaveBeenCalledWith(`OpenCode SDK: ${entry}`);
      expect(deps.which).not.toHaveBeenCalled();
    }
  });

  test("an explicit missing OpenCode SDK does not fall back to a global install", async () => {
    const deps = probes();
    deps.isFile.mockImplementation(async (path) => path !== "/missing/sdk.js");
    expect(
      await verifyProviderBinary("opencode", { OPENCODE_SDK_PATH: "/missing/sdk.js" }, deps),
    ).toBe(false);
    expect(deps.isFile.mock.calls).toEqual([["/missing/sdk.js"]]);
    expect(deps.log.mock.calls[0]?.[0]).toStartWith("FATAL: @opencode/sdk not found.");
  });

  test("ACP preset executables agree with the runtime catalog", async () => {
    for (const target of ACP_TARGET_CATALOG) {
      if (target.id === "custom") continue;
      const deps = probes();
      expect(await verifyProviderBinary("acp", { ACP_TARGET: target.id }, deps)).toBe(true);
      expect(deps.which).toHaveBeenCalledWith(target.command!, undefined);
    }
  });

  test.each([
    "claude",
    "unknown-provider",
    "constructor",
  ])("%s keeps the Claude fallback", async (provider) => {
    const deps = probes();
    const env = { CLAUDE_BINARY: "  custom-claude --debug  ", PATH: "/test/bin" };
    expect(await verifyProviderBinary(provider, env, deps)).toBe(true);
    expect(deps.which).toHaveBeenCalledWith("custom-claude", env.PATH);
    expect(deps.version).not.toHaveBeenCalled();
  });

  test("missing Claude reports known install locations outside PATH", async () => {
    const deps = probes();
    deps.which.mockReturnValue(null);
    deps.isFile.mockImplementation(async (path) => path === "/usr/local/bin/claude");
    expect(await verifyProviderBinary("claude", { PATH: "/test/bin" }, deps)).toBe(false);
    expect(deps.log.mock.calls.map(([message]) => message)).toEqual([
      "FATAL: Claude CLI not found: 'claude' (from CLAUDE_BINARY='claude')",
      "  PATH=/test/bin",
      "  Found at /usr/local/bin/claude (not in PATH) — set CLAUDE_BINARY=/usr/local/bin/claude",
    ]);
  });

  test("both worker leaf stages ship the standalone helper", async () => {
    const dockerfile = await Bun.file(`${import.meta.dir}/../../Dockerfile.worker`).text();
    const copy =
      "COPY src/commands/entrypoint-provider-binary.ts /usr/local/lib/agent-swarm/entrypoint-provider-binary.ts";
    const slim = dockerfile.slice(
      dockerfile.indexOf("FROM worker-base AS worker-slim"),
      dockerfile.indexOf("FROM worker-base AS worker-full-base"),
    );
    const full = dockerfile.slice(dockerfile.indexOf("FROM worker-full-base AS worker-full"));
    expect(slim).toContain(copy);
    expect(full).toContain(copy);
    expect(dockerfile.split(copy)).toHaveLength(3);
  });
});
