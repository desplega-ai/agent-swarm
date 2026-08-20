import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, getKv, initDb } from "../be/db";
import { runScript } from "../scripts-runtime/loader";
import { mcpOverflowNamespace } from "../tools/utils";

const TEST_DB_PATH = "./test-slack-read-boundaries.sqlite";
const API_KEY = "test-slack-read-boundaries-key-1234567890";
const AGENT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const CHANNEL_ID = "C_BUSY_BOUNDARY";
const FULL_MESSAGE_COUNT = 20;

const busyMessages = Array.from({ length: FULL_MESSAGE_COUNT }, (_, index) => ({
  bot_id: "B_TEST",
  username: "Agent",
  text: `busy-message-${index}:${"x".repeat(900)}`,
  ts: `1700000000.${String(index).padStart(6, "0")}`,
}));

mock.module("../slack/app", () => ({
  getSlackApp: () => ({
    client: {
      auth: { test: async () => ({ user_id: "U_BOT" }) },
      conversations: {
        history: async () => ({ messages: busyMessages }),
      },
      users: {
        info: async ({ user }: { user: string }) => ({
          user: { real_name: user },
        }),
      },
    },
  }),
  initSlackApp: async () => null,
  startSlackApp: async () => {},
  stopSlackApp: async () => {},
}));

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
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

describe("slack-read response boundaries", () => {
  let directTool: RegisteredTool;
  let handleMcpBridge: typeof import("../http/mcp-bridge").handleMcpBridge;
  let savedApiKey: string | undefined;

  beforeAll(async () => {
    savedApiKey = process.env.AGENT_SWARM_API_KEY;
    process.env.AGENT_SWARM_API_KEY = API_KEY;
    await removeDbFiles();
    initDb(TEST_DB_PATH);
    await createAgent({ id: AGENT_ID, name: "Boundary Lead", isLead: true, status: "idle" });

    const [{ handleMcpBridge: bridge }, { registerSlackReadTool }] = await Promise.all([
      import("../http/mcp-bridge"),
      import("../tools/slack-read"),
    ]);
    handleMcpBridge = bridge;

    const server = new McpServer({ name: "slack-read-boundaries", version: "1.0.0" });
    registerSlackReadTool(server);
    directTool = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
      ._registeredTools["slack-read"]!;
  });

  afterAll(async () => {
    if (savedApiKey === undefined) delete process.env.AGENT_SWARM_API_KEY;
    else process.env.AGENT_SWARM_API_KEY = savedApiKey;
    closeDb();
    await removeDbFiles();
  });

  test("agent-facing read stays bounded, spills, and keeps a non-empty message prefix", async () => {
    const result = (await directTool.handler(
      { channelId: CHANNEL_ID, limit: FULL_MESSAGE_COUNT, includeFiles: false },
      {
        sessionId: "direct-agent",
        requestInfo: { headers: { "x-agent-id": AGENT_ID } },
      },
    )) as {
      structuredContent: {
        message: string;
        messages: typeof busyMessages;
        truncation: { fullValueAt: string; limitBytes: number };
      };
    };

    const kept = result.structuredContent.messages;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(FULL_MESSAGE_COUNT);
    expect(result.structuredContent.message).toContain(`Retrieved ${kept.length} message(s)`);
    expect(result.structuredContent.message).toContain(`truncated from ${FULL_MESSAGE_COUNT}`);
    expect(result.structuredContent.truncation.limitBytes).toBe(10_000);

    const namespace = mcpOverflowNamespace(AGENT_ID);
    const key = result.structuredContent.truncation.fullValueAt.replace(`kv://${namespace}/`, "");
    const stored = await getKv(namespace, key);
    const canonical = JSON.parse(String(stored?.value)) as {
      outcome: { data: { messages: unknown[] } };
    };
    expect(canonical.outcome.data.messages).toHaveLength(FULL_MESSAGE_COUNT);
  });

  test("script bridge read returns the complete messages array", async () => {
    const raw = JSON.stringify({
      tool: "slack-read",
      args: { channelId: CHANNEL_ID, limit: FULL_MESSAGE_COUNT, includeFiles: false },
    });
    const req = Readable.from([Buffer.from(raw)]) as IncomingMessage;
    req.method = "POST";
    req.url = "/api/mcp-bridge";
    req.headers = { "content-type": "application/json", "x-agent-id": AGENT_ID };

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

    await handleMcpBridge(req, res, ["api", "mcp-bridge"], new URLSearchParams(), AGENT_ID);
    const body = JSON.parse(text) as {
      messages: typeof busyMessages;
      truncation?: unknown;
    };

    expect(status).toBe(200);
    expect(body.messages).toHaveLength(FULL_MESSAGE_COUNT);
    expect(body.messages.map((message) => message.text)).toEqual(
      busyMessages.map((message) => message.text),
    );
    expect(body).not.toHaveProperty("truncation");
  });

  test("ctx.swarm.slack_read receives all messages inside a real script sandbox", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(webRequest) {
        const raw = await webRequest.text();
        const req = Readable.from(raw ? [Buffer.from(raw)] : []) as IncomingMessage;
        const url = new URL(webRequest.url);
        req.method = webRequest.method;
        req.url = `${url.pathname}${url.search}`;
        req.headers = Object.fromEntries(webRequest.headers.entries());

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

        const handled = await handleMcpBridge(
          req,
          res,
          ["api", "mcp-bridge"],
          url.searchParams,
          AGENT_ID,
        );
        return new Response(handled ? text : "Not Found", { status: handled ? status : 404 });
      },
    });

    try {
      const output = await runScript({
        agentId: AGENT_ID,
        mcpBaseUrl: `http://127.0.0.1:${server.port}`,
        resources: { memoryMb: 512, cpuTimeSec: 20, maxStdoutBytes: 1_048_576 },
        source: `
          export default async (_args, ctx) =>
            ctx.swarm.slack_read({
              channelId: "${CHANNEL_ID}",
              limit: ${FULL_MESSAGE_COUNT},
              includeFiles: false,
            });
        `,
      });
      const result = output.result as {
        success: boolean;
        status: number;
        data: { messages: typeof busyMessages; truncation?: unknown };
      };

      expect(output.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
      expect(result.data.messages).toHaveLength(FULL_MESSAGE_COUNT);
      expect(result.data).not.toHaveProperty("truncation");
    } finally {
      server.stop(true);
    }
  });
});
