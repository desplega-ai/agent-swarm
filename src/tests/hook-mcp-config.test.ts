import { describe, expect, test } from "bun:test";
import { loadHookMcpConfig } from "../hooks/hook";

describe("loadHookMcpConfig", () => {
  test("falls back to the workspace config when the project has no .mcp.json", async () => {
    const tempDir = `/tmp/hook-mcp-fallback-${crypto.randomUUID()}`;
    const projectDir = `${tempDir}/repo`;
    const workspaceDir = `${tempDir}/workspace`;
    const expected = {
      url: "http://localhost:3013/mcp",
      headers: {
        Authorization: "Bearer example-test-key",
        "X-Agent-ID": "agent-test-id",
      },
    };

    await Bun.$`mkdir -p ${projectDir} ${workspaceDir}`.quiet();
    try {
      await Bun.write(
        `${workspaceDir}/.mcp.json`,
        JSON.stringify({ mcpServers: { "agent-swarm": expected } }),
      );

      expect(await loadHookMcpConfig(projectDir, workspaceDir)).toEqual(expected);
    } finally {
      await Bun.$`rm -rf ${tempDir}`.quiet();
    }
  });
});
