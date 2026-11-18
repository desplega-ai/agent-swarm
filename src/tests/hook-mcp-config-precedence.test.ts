import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHookMcpConfig } from "../hooks/hook";

function swarmEntry(url: string) {
  return {
    url,
    headers: { Authorization: "Bearer example-test-key", "X-Agent-ID": "agent-test-id" },
  };
}

async function writeMcpJson(dir: string, servers: Record<string, unknown>) {
  await Bun.write(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
}

describe("loadHookMcpConfig precedence", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function dirs() {
    root = await mkdtemp(join(tmpdir(), "hook-mcp-precedence-"));
    const projectDir = join(root, "repo");
    const workspaceDir = join(root, "workspace");
    await Bun.$`mkdir -p ${projectDir} ${workspaceDir}`.quiet();
    return { projectDir, workspaceDir };
  }

  test("the workspace swarm entry wins over a project .mcp.json swarm entry", async () => {
    const { projectDir, workspaceDir } = await dirs();
    const workspace = swarmEntry("http://api.swarm.internal:3013/mcp");
    await writeMcpJson(workspaceDir, { "agent-swarm": workspace });
    await writeMcpJson(projectDir, { "agent-swarm": swarmEntry("https://example.com/mcp") });

    expect(await loadHookMcpConfig(projectDir, workspaceDir)).toEqual(workspace);
  });

  test("a project .mcp.json with other servers keeps the workspace swarm entry", async () => {
    const { projectDir, workspaceDir } = await dirs();
    const workspace = swarmEntry("http://api.swarm.internal:3013/mcp");
    await writeMcpJson(workspaceDir, { "agent-swarm": workspace });
    await writeMcpJson(projectDir, { datadog: { url: "https://example.com/mcp" } });

    expect(await loadHookMcpConfig(projectDir, workspaceDir)).toEqual(workspace);
  });

  test("the project swarm entry is used when the workspace has no .mcp.json", async () => {
    const { projectDir, workspaceDir } = await dirs();
    const project = swarmEntry("http://localhost:3013/mcp");
    await writeMcpJson(projectDir, { "agent-swarm": project });

    expect(await loadHookMcpConfig(projectDir, workspaceDir)).toEqual(project);
  });
});
