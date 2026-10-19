import { afterAll, beforeAll, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type AppRecord, createApp } from "../apps/store";
import { closeDb, createAgent, getTaskById, initDb } from "../be/db";
import { upsertScriptByName } from "../be/scripts/db";
import { handleCore } from "../http/core";
import { handleMcpBridge } from "../http/mcp-bridge";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { LEGACY_POLICY, type LegacyRule } from "../rbac";
import { isMcpToolAllowedForScripts } from "../scripts-runtime/sdk-allowlist";
import { registerAppActionRunTool } from "../tools/app-action-run";
import { markExtensionRequestOrigin, markScriptSdkRequestOrigin } from "../tools/utils";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";
import { listenOnFreePort } from "./test-net";
import { CHILD_PROCESS_TEST_BUDGET_MS } from "./test-proc";

const dbPath = `/private/tmp/test-app-action-run-tool-${process.pid}.sqlite`;
const agentId = crypto.randomUUID();
const ownerId = crypto.randomUUID();
const apiKey = "example-app-action-run-key";
const previousKey = process.env.AGENT_SWARM_API_KEY;
const previousBase = process.env.MCP_BASE_URL;
const definition: AppRecord["definition"] = {
  schemaVersion: 1,
  models: { note: { columns: { title: { kind: "string" } } } },
  actions: { triage: { kind: "task", prompt: "Triage the notes." } },
  pages: { main: { root: "root", elements: { root: { type: "Container", props: {} } } } },
  defaultPage: "main",
};
type ToolResult = {
  isError?: boolean;
  structuredContent: {
    message: string;
    data: { ok: boolean; taskId: string; status: string; result?: unknown };
  };
};
let handler: (args: unknown, extra: unknown) => Promise<ToolResult>;
let appId: string;

async function removeDb() {
  for (const suffix of ["", "-wal", "-shm"]) await unlink(dbPath + suffix).catch(() => undefined);
}
beforeAll(async () => {
  process.env.AGENT_SWARM_API_KEY = apiKey;
  await removeDb();
  initDb(dbPath);
  await createAgent({ id: agentId, name: "Action invoker", isLead: false, status: "idle" });
  await createAgent({ id: ownerId, name: "Script owner", isLead: true, status: "idle" });
  appId = (await createApp({ name: "Action tool", definition })).id;
  const server = new McpServer({ name: "app-action-run-tool", version: "1.0.0" });
  registerAppActionRunTool(server);
  handler = (server as unknown as { _registeredTools: Record<string, { handler: typeof handler }> })
    ._registeredTools["app-action-run"]!.handler;
});
afterAll(async () => {
  closeDb();
  await removeDb();
  if (previousKey === undefined) delete process.env.AGENT_SWARM_API_KEY;
  else process.env.AGENT_SWARM_API_KEY = previousKey;
  if (previousBase === undefined) delete process.env.MCP_BASE_URL;
  else process.env.MCP_BASE_URL = previousBase;
});
function call(
  action: string,
  input: Record<string, unknown> = {},
  origin?: "script-sdk" | "extension",
  id = agentId,
  target = appId,
) {
  const extra = { sessionId: "action-tool", requestInfo: { headers: { "x-agent-id": id } } };
  if (origin === "script-sdk") markScriptSdkRequestOrigin(extra);
  if (origin === "extension") markExtensionRequestOrigin(extra);
  return handler({ appId: target, action, input }, extra);
}

test("runs task actions with the verified caller and the REST response shape", async () => {
  const output = await call("triage", { caller: { kind: "guest", id: "forged" } });
  expect(output.isError).not.toBe(true);
  expect(output.structuredContent).toMatchObject({ ok: true, status: "pending" });
  const task = await getTaskById(output.structuredContent.taskId);
  expect(task?.task).toContain(`"kind":"agent","id":"${agentId}","name":"Action invoker"`);
});

test("refuses script and extension origins and stays outside the SDK allowlist", async () => {
  for (const origin of ["script-sdk", "extension"] as const) {
    const output = await call("triage", {}, origin);
    expect(output.isError).toBe(true);
    expect(output.structuredContent.message).toContain("cannot run app actions");
  }
  expect(isMcpToolAllowedForScripts("app-action-run")).toBe(false);
});

test("rejects missing agents, apps, actions, and denied principals", async () => {
  expect((await call("triage", {}, undefined, "")).isError).toBe(true);
  expect((await call("triage", {}, undefined, agentId, "missing")).isError).toBe(true);
  expect((await call("missing")).isError).toBe(true);
  const policy = LEGACY_POLICY as unknown as Record<"app.use", LegacyRule>;
  const original = policy["app.use"];
  policy["app.use"] = { name: "deny-actions", denyReason: "denied actions", evaluate: () => false };
  try {
    expect((await call("triage")).isError).toBe(true);
  } finally {
    policy["app.use"] = original;
  }
});

test.skipIf(SKIP_SANDBOX_SPAWN_TESTS)(
  "runs script actions as the owner while preserving the invoking agent caller",
  async () => {
    const server = createHttpServer(async (req, res) => {
      const id = req.headers["x-agent-id"] as string | undefined;
      if (await handleCore(req, res, id, apiKey)) return;
      if (
        await handleMcpBridge(
          req,
          res,
          getPathSegments(req.url ?? ""),
          parseQueryParams(req.url ?? ""),
          id,
        )
      )
        return;
      res.writeHead(404).end();
    });
    try {
      const port = await listenOnFreePort(server);
      process.env.MCP_BASE_URL = `http://localhost:${port}`;
      const saved = await upsertScriptByName({
        name: "action_tool_owner",
        scope: "agent",
        scopeId: ownerId,
        agentId: ownerId,
        source: `export default async function(args, ctx) {
        const response = await ctx.swarm.app_row_create({ appId: args.app.id, model: "note", values: { title: "owner-write" } });
        return { caller: args.caller, row: (response?.data ?? response).row };
      }`,
        description: "Owner action fixture",
        intent: "Verify script owner and caller",
        signatureJson: "{}",
        typeChecked: true,
        embeddingMode: "skip",
      });
      const app = await createApp({
        name: "Script action",
        definition: {
          ...definition,
          actions: {
            write: {
              kind: "script",
              scriptId: saved.script.id,
              args: { caller: { kind: "guest", id: "default-forgery" } },
            },
          },
        },
      });
      const output = await call(
        "write",
        { caller: { kind: "operator", id: "forged" } },
        undefined,
        agentId,
        app.id,
      );
      expect(output.isError).not.toBe(true);
      expect(output.structuredContent).toMatchObject({
        ok: true,
        result: {
          caller: { kind: "agent", id: agentId, name: "Action invoker" },
          row: { title: "owner-write", createdBy: `agent:${ownerId}` },
        },
      });
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);
