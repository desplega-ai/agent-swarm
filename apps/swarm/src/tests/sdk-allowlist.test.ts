import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { closeDb, initDb } from "../be/db";
import { handleMcpBridge } from "../http/mcp-bridge";
import {
  isMcpToolAllowedForScripts,
  mcpToolNameForSdkMethod,
  SDK_ALLOWLIST,
} from "../scripts-runtime/sdk-allowlist";
import type { SwarmConfig } from "../scripts-runtime/swarm-config";
import { createSwarmSdk } from "../scripts-runtime/swarm-sdk";
import { createServer } from "../server";

const TEST_DB_PATH = "./test-sdk-allowlist.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

describe("script SDK allowlist", () => {
  let registeredTools: Record<string, unknown>;

  beforeAll(async () => {
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
    const server = createServer();
    registeredTools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
  });

  test("every SDK allowlist entry resolves to a live MCP tool", () => {
    const missing = SDK_ALLOWLIST.map((name) => mcpToolNameForSdkMethod(name)).filter(
      (name) => !(name in registeredTools),
    );
    expect(missing).toEqual([]);
  });

  test("runtime proxy rejects non-allowlisted tools before fetch", async () => {
    const sdk = createSwarmSdk({} as SwarmConfig);
    await expect(sdk.join_swarm({})).rejects.toThrow(
      "Tool 'join_swarm' is not exposed to scripts (lifecycle/cred tool)",
    );
  });

  test("bundled swarm-sdk.d.ts exposes only allowlisted methods", async () => {
    const types = await Bun.file("src/scripts-runtime/types/swarm-sdk.d.ts").text();
    for (const name of SDK_ALLOWLIST) {
      expect(types).toContain(`${name}(args`);
    }
    expect(types).not.toContain("join_swarm(");
    expect(types).not.toContain("start_worker(");
  });

  test("isMcpToolAllowedForScripts accepts every MCP name in the allowlist", () => {
    for (const sdkName of SDK_ALLOWLIST) {
      const mcpName = mcpToolNameForSdkMethod(sdkName);
      expect(isMcpToolAllowedForScripts(mcpName)).toBe(true);
    }
  });

  test("isMcpToolAllowedForScripts rejects non-mapped MCP names", () => {
    // SDK method names (underscores) are not MCP names — must be rejected
    expect(isMcpToolAllowedForScripts("workflow_trigger")).toBe(false);
    expect(isMcpToolAllowedForScripts("slack_post")).toBe(false);
    // Completely unknown tool names
    expect(isMcpToolAllowedForScripts("tool-does-not-exist")).toBe(false);
    expect(isMcpToolAllowedForScripts("start-worker")).toBe(false);
  });

  test("bundled swarm-sdk.d.ts uses triggerData (not input) for workflow_trigger", async () => {
    const types = await Bun.file("src/scripts-runtime/types/swarm-sdk.d.ts").text();
    expect(types).toContain("workflow_trigger(args: { id: string; triggerData?");
    expect(types).not.toContain("workflow_trigger(args: { id: string; input?");
  });
});

describe("mcp-bridge allowlist gate", () => {
  const TEST_DB_PATH = "./test-sdk-allowlist-bridge.sqlite";
  const API_KEY = "test-mcp-bridge-key-1234567890";
  let prevApiKey: string | undefined;

  async function removeDbFiles(path: string): Promise<void> {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(path + suffix);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  beforeAll(async () => {
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
    prevApiKey = process.env.AGENT_SWARM_API_KEY;
    process.env.AGENT_SWARM_API_KEY = API_KEY;
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
    if (prevApiKey === undefined) {
      delete process.env.AGENT_SWARM_API_KEY;
    } else {
      process.env.AGENT_SWARM_API_KEY = prevApiKey;
    }
  });

  async function postBridge(
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const raw = JSON.stringify(body);
    const req = Readable.from([Buffer.from(raw)]) as IncomingMessage;
    req.method = "POST";
    req.url = "/api/mcp-bridge";
    req.headers = {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
      "x-agent-id": "test-agent-bridge",
    };

    let status = 200;
    let text = "";
    const res = {
      headersSent: false,
      writableEnded: false,
      setHeader() {},
      writeHead(code: number) {
        status = code;
        this.headersSent = true;
        return this;
      },
      end(chunk?: unknown) {
        if (chunk !== undefined) text += String(chunk);
        this.writableEnded = true;
        return this;
      },
    } as unknown as ServerResponse;

    await handleMcpBridge(
      req,
      res,
      ["api", "mcp-bridge"],
      new URLSearchParams(),
      "test-agent-bridge",
    );
    return { status, body: text ? JSON.parse(text) : {} };
  }

  test("trigger-workflow is NOT rejected with 403 (reaches tool handler)", async () => {
    const result = await postBridge({
      tool: "trigger-workflow",
      args: { id: "00000000-0000-0000-0000-000000000001" },
    });
    // Must not be an allowlist 403; may be 404/500 (non-existent workflow) — that's fine.
    expect(result.status).not.toBe(403);
  });

  test("genuinely non-mapped MCP names still return 403", async () => {
    // SDK method names (underscores) are not valid MCP names — must 403
    const sdkNameResult = await postBridge({ tool: "workflow_trigger", args: { id: "x" } });
    expect(sdkNameResult.status).toBe(403);

    // Completely unknown tool names
    const unknownResult = await postBridge({ tool: "start-worker", args: {} });
    expect(unknownResult.status).toBe(403);
  });
});
