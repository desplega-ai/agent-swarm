import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { closeDb, createAgent, createTask, initDb } from "../be/db";
import { handleMcpBridge } from "../http/mcp-bridge";
import {
  isMcpToolAllowedForScripts,
  mcpToolNameForSdkMethod,
  SDK_ALLOWLIST,
} from "../scripts-runtime/sdk-allowlist";
import { SwarmConfig } from "../scripts-runtime/swarm-config";
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
  const originalSteeringEnabled = process.env.STEERING_ENABLED;

  beforeAll(async () => {
    // The SDK covers the full tool universe regardless of the runtime
    // steering opt-in (mirrors scripts/bundle-script-types.ts) — steer-task
    // must register for the drift check to span every allowlisted tool.
    process.env.STEERING_ENABLED = "true";
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
    // The scripts SDK bridge always builds a full-surface server (capability
    // flags shape the external MCP tool list only) — mirror that here so the
    // drift check spans every allowlisted tool.
    const server = await createServer({ fullSurface: true });
    registeredTools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
  });

  afterAll(async () => {
    if (originalSteeringEnabled === undefined) delete process.env.STEERING_ENABLED;
    else process.env.STEERING_ENABLED = originalSteeringEnabled;
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

  test("workflow_listRuns sends bounded pagination defaults and rejects an excessive limit", async () => {
    let requestUrl: URL | undefined;
    const httpServer = Bun.serve({
      port: 0,
      fetch(req) {
        requestUrl = new URL(req.url);
        return Response.json({ runs: [], page: { limit: 20, offset: 0, total: 0 } });
      },
    });
    const config = new SwarmConfig({
      system: {
        apiKey: { value: "sdk-test-key", isSecret: true },
        agentId: { value: "sdk-test-agent", isSecret: false },
        mcpBaseUrl: { value: `http://127.0.0.1:${httpServer.port}`, isSecret: false },
      },
      user: {},
    });
    const sdk = createSwarmSdk(config);

    try {
      await sdk.workflow_listRuns({ workflowId: "workflow-1" });
      expect(requestUrl?.pathname).toBe("/api/workflows/workflow-1/runs");
      expect(requestUrl?.searchParams.get("limit")).toBe("20");
      expect(requestUrl?.searchParams.get("offset")).toBe("0");

      await expect(sdk.workflow_listRuns({ workflowId: "workflow-1", limit: 101 })).rejects.toThrow(
        "between 1 and 100",
      );
    } finally {
      httpServer.stop(true);
    }
  });

  test("schedule_list maps includeFull to the full HTTP field and keeps the default slim", async () => {
    const requestUrls: URL[] = [];
    const httpServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        requestUrls.push(url);
        const full = url.searchParams.get("fields") === "full";
        return Response.json({
          schedules: [
            full
              ? { id: "schedule-1", taskTemplate: "full template" }
              : { id: "schedule-1", taskTemplatePreview: "full..." },
          ],
          count: 1,
        });
      },
    });
    const config = new SwarmConfig({
      system: {
        apiKey: { value: "sdk-test-key", isSecret: true },
        agentId: { value: "sdk-test-agent", isSecret: false },
        mcpBaseUrl: { value: `http://127.0.0.1:${httpServer.port}`, isSecret: false },
      },
      user: {},
    });
    const sdk = createSwarmSdk(config);

    try {
      const full = await sdk.schedule_list({ includeFull: true });
      expect(
        (full as { data: { schedules: Array<{ taskTemplate?: string }> } }).data.schedules[0]
          ?.taskTemplate,
      ).toBe("full template");
      expect(requestUrls[0]?.searchParams.get("fields")).toBe("full");

      const slim = await sdk.schedule_list();
      expect(
        (slim as { data: { schedules: Array<{ taskTemplatePreview?: string }> } }).data.schedules[0]
          ?.taskTemplatePreview,
      ).toBe("full...");
      expect(requestUrls[1]?.searchParams.has("fields")).toBe(false);
    } finally {
      httpServer.stop(true);
    }
  });

  test("bundled swarm-sdk.d.ts exposes only allowlisted methods", async () => {
    const types = await Bun.file("src/scripts-runtime/types/swarm-sdk.d.ts").text();
    for (const name of SDK_ALLOWLIST) {
      expect(types).toMatch(new RegExp(`\\b${name}(?:<[^>]+>)?\\(\\s*args`));
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

  test("KV delete names share the existing delete tool mapping", () => {
    expect(mcpToolNameForSdkMethod("kv_delete")).toBe("kv-delete");
    expect(mcpToolNameForSdkMethod("kv_del")).toBe("kv-delete");
  });

  test("task_storeProgress forwards force to the finish endpoint", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const httpServer = Bun.serve({
      port: 0,
      async fetch(req) {
        requestBody = (await req.json()) as Record<string, unknown>;
        return Response.json({ success: true, alreadyFinished: true });
      },
    });
    const config = new SwarmConfig({
      system: {
        apiKey: { value: "sdk-test-key", isSecret: true },
        agentId: { value: "sdk-test-agent", isSecret: false },
        mcpBaseUrl: { value: `http://127.0.0.1:${httpServer.port}`, isSecret: false },
      },
      user: {},
    });
    const sdk = createSwarmSdk(config);

    try {
      await sdk.task_storeProgress({
        taskId: "task-1",
        status: "completed",
        output: "corrected",
        force: true,
      });
      expect(requestBody).toEqual({
        status: "completed",
        output: "corrected",
        force: true,
      });
    } finally {
      httpServer.stop(true);
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
  let oversizedTaskId: string;

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
    await createAgent({
      id: "test-agent-bridge",
      name: "test-agent-bridge",
      isLead: false,
      status: "idle",
    });
    oversizedTaskId = (
      await createTask("test-agent-bridge", `large-script-sdk-task:${"x".repeat(20_000)}`)
    ).id;
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

  test("bridge-origin tool calls return complete oversized data to scripts", async () => {
    const result = await postBridge({
      tool: "get-task-details",
      args: { taskId: oversizedTaskId },
    });
    const body = result.body as {
      task?: { task?: string };
      truncation?: unknown;
    };

    expect(result.status).toBe(200);
    expect(body.task?.task).toBe(`large-script-sdk-task:${"x".repeat(20_000)}`);
    expect(body).not.toHaveProperty("truncation");
  });
});
