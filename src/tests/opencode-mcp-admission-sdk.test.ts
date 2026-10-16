/**
 * Swarm MCP admission against the real `@opencode/sdk` host.
 *
 * OpenCode 2 reports a refused or unauthorized MCP server as a status and
 * keeps running, so these tests pin the shapes `checkSwarmMcpAdmission` reads:
 * the `mcp.list` statuses and the `swarm_<tool>` ids the plugin's tool lister
 * returns once the server's tools are registered.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { OpenCode } from "@opencode/sdk";
import { checkSwarmMcpAdmission } from "../providers/opencode-adapter";
import {
  createOpencodeSwarmPlugin,
  type OpencodeToolLister,
} from "../providers/opencode-swarm-plugin";
import { getFreePort } from "./test-net";

const ADMISSION_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 30_000;

let directory: string;
let mcpServer: ReturnType<typeof Bun.serve>;
let unauthorizedServer: ReturnType<typeof Bun.serve>;

/** A stateless MCP server exposing `store-progress`. */
async function handleMcp(req: Request): Promise<Response> {
  const server = new McpServer({ name: "swarm-test", version: "1.0.0" });
  server.registerTool("store-progress", { description: "Store task progress" }, async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "opencode-admission-"));
  mcpServer = Bun.serve({ port: 0, fetch: handleMcp });
  unauthorizedServer = Bun.serve({
    port: 0,
    fetch: () => new Response("unauthorized", { status: 401 }),
  });
});

afterAll(() => {
  mcpServer.stop(true);
  unauthorizedServer.stop(true);
  rmSync(directory, { recursive: true, force: true });
});

async function admit(url: string): Promise<string | null> {
  let listTools: OpencodeToolLister | undefined;
  const plugin = createOpencodeSwarmPlugin(
    { apiUrl: "http://127.0.0.1:9", apiKey: "", agentId: "agent-1", taskId: "", isLead: false },
    { onToolRegistry: (lister) => (listTools = lister) },
  );
  const host = await OpenCode.create({
    config: { content: JSON.stringify({ mcp: { swarm: { type: "remote", url } } }) },
    plugins: [plugin],
    log: { level: "error", emit: () => {} },
  });
  try {
    await host.sessions.create({ location: { directory } });
    return await checkSwarmMcpAdmission(host, directory, () => listTools, ADMISSION_TIMEOUT_MS);
  } finally {
    await host.close();
  }
}

describe("swarm MCP admission (real OpenCode host)", () => {
  test(
    "admits a server that registers store-progress",
    async () => {
      expect(await admit(`http://127.0.0.1:${mcpServer.port}/mcp`)).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "refuses an unauthorized server",
    async () => {
      const reason = await admit(`http://127.0.0.1:${unauthorizedServer.port}/mcp`);
      expect(reason).toMatch(/^swarm MCP server (needs_auth|failed): /);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "refuses a server that refuses connections",
    async () => {
      const port = await getFreePort();
      const reason = await admit(`http://127.0.0.1:${port}/mcp`);
      expect(reason).toMatch(/^swarm MCP server failed: /);
    },
    TEST_TIMEOUT_MS,
  );
});
