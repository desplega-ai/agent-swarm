import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import { setExtensionState } from "../be/extensions/db";
import { typecheckScript } from "../be/scripts/typecheck";
import { handleCore } from "../http/core";
import { handleExtensions } from "../http/extensions";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { registerExtensionInstallTool } from "../tools/extension-install";
import { registerExtensionListTool } from "../tools/extension-list";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";
import { loadBundleFixture } from "./fixtures/extensions/load";

const TEST_DB_PATH = "./test-extensions-mcp-tools.sqlite";
const API_KEY = "test-extensions-mcp-tools-key-1234567890";
const API_URL = "http://extensions-mcp-tools.test";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent: Record<string, unknown>;
};

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function buildToolServer() {
  const server = new McpServer({ name: "extensions-mcp-tools", version: "1" });
  registerExtensionInstallTool(server);
  registerExtensionListTool(server);
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  return { install: tools["extension-install"]!, list: tools["extension-list"]! };
}

function meta(agentId: string) {
  return { sessionId: "extensions-mcp-tools", requestInfo: { headers: { "x-agent-id": agentId } } };
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers as Record<string, string>;
}

async function dispatchExtensionsApi(url: string, init: RequestInit = {}): Promise<Response> {
  const parsedUrl = new URL(url);
  const headers = Object.fromEntries(
    Object.entries(headersRecord(init.headers)).map(([key, value]) => [
      key.toLowerCase(),
      String(value),
    ]),
  );
  const body = init.body === undefined ? undefined : String(init.body);
  const req = Readable.from(body ? [Buffer.from(body)] : []) as IncomingMessage;
  req.method = init.method ?? "GET";
  req.url = `${parsedUrl.pathname}${parsedUrl.search}`;
  req.headers = headers;

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

  const agentId = headers["x-agent-id"];
  if (!(await handleCore(req, res, agentId, API_KEY))) {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    if (!(await handleExtensions(req, res, pathSegments, queryParams, agentId))) {
      res.writeHead(404);
      res.end("Not Found");
    }
  }

  return new Response(text, { status, headers: { "Content-Type": "application/json" } });
}

let leadId: string;
let workerId: string;
let savedEnv: NodeJS.ProcessEnv;
let savedFetch: typeof globalThis.fetch;

beforeAll(async () => {
  savedEnv = { ...process.env };
  savedFetch = globalThis.fetch;
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  delete process.env.API_KEY;
  process.env.MCP_BASE_URL = API_URL;
  refreshSecretScrubberCache();
  leadId = (await createAgent({ name: "extensions-mcp-lead", isLead: true, status: "idle" })).id;
  workerId = (await createAgent({ name: "extensions-mcp-worker", isLead: false, status: "idle" }))
    .id;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(`${API_URL}/api/extensions`)) return dispatchExtensionsApi(url, init);
    return savedFetch(input, init);
  }) as typeof globalThis.fetch;
});

afterAll(async () => {
  globalThis.fetch = savedFetch;
  closeDb();
  await removeDbFiles();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  refreshSecretScrubberCache();
});

beforeEach(async () => {
  await getDbClient().run("DELETE FROM extensions");
});

describe("extension MCP HTTP proxy tools", () => {
  test("script SDK typechecks extension install and list calls", async () => {
    const result = await typecheckScript(`
      import type { ScriptContext } from "swarm-sdk";
      export default async (_args: unknown, ctx: ScriptContext) => {
        await ctx.swarm.extension_install({
          manifest: {},
          files: { "hooks.ts": "export default () => {}" },
        });
        return await ctx.swarm.extension_list({ enabledOnly: true });
      };
    `);
    expect(result.ok).toBe(true);
  });

  test("lead installation stays disabled and returns the shared tool envelope", async () => {
    const tools = buildToolServer();
    const result = (await tools.install.handler(
      await loadBundleFixture("minimal"),
      meta(leadId),
    )) as ToolResult;

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("POST /api/extensions/{id}/enable");
    expect(result.structuredContent).toMatchObject({
      success: true,
      enabled: false,
      status: "disabled",
    });
    expect(result.structuredContent.message).toBeTruthy();
  });

  test("worker installation returns the REST permission error in the shared tool envelope", async () => {
    const tools = buildToolServer();
    const result = (await tools.install.handler(
      await loadBundleFixture("minimal"),
      meta(workerId),
    )) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ success: false });
    expect(String(result.structuredContent.message)).toContain("Forbidden");
  });

  test("lead reinstall stores an inactive version of an enabled extension", async () => {
    const tools = buildToolServer();
    const first = (await tools.install.handler(
      await loadBundleFixture("minimal"),
      meta(leadId),
    )) as ToolResult;
    const id = String(first.structuredContent.id);
    await setExtensionState(id, { enabled: true, status: "enabled" });

    const changed = await loadBundleFixture("minimal");
    changed.files["hooks.ts"] += "\n// updated by MCP\n";
    const result = (await tools.install.handler(changed, meta(leadId))) as ToolResult;

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      version: 2,
      activeVersion: 1,
      enabled: true,
    });
  });

  test("typecheck diagnostics reach the error details", async () => {
    const tools = buildToolServer();
    const broken = await loadBundleFixture("minimal");
    broken.files["hooks.ts"] = "export default 42;";
    const result = (await tools.install.handler(broken, meta(leadId))) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      success: false,
      message: "Extension rejected by typecheck.",
    });
    expect(String(result.structuredContent.details)).toContain("TS");
  });

  test("extension-list renders a table and supports enabledOnly", async () => {
    const tools = buildToolServer();
    await tools.install.handler(await loadBundleFixture("minimal"), meta(leadId));

    const all = (await tools.list.handler({}, meta(leadId))) as ToolResult;
    expect(all.isError).toBe(false);
    expect(all.content[0]?.text).toContain(
      "| Name | Version | Active | Enabled | Status | Priority | Failures |",
    );
    expect(all.structuredContent).toMatchObject({ success: true });
    expect((all.structuredContent.extensions as unknown[]).length).toBe(1);

    const enabledOnly = (await tools.list.handler(
      { enabledOnly: true },
      meta(leadId),
    )) as ToolResult;
    expect(enabledOnly.structuredContent).toMatchObject({ success: true, extensions: [] });
  });
});
