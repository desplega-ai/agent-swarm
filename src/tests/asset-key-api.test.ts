import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createApp } from "../apps/store";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getDbClient,
  initDb,
} from "../be/db";
import { insertScript } from "../be/scripts/db";
import { handleAssets } from "../http/assets";
import { handlePages } from "../http/pages";
import { handleSchedules } from "../http/schedules";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { handleWorkflows } from "../http/workflows";
import { setRequestAuth } from "../utils/request-auth-context";

const TEST_DB_PATH = "./test-asset-key-api.sqlite";

let server: Server;
let baseUrl: string;
let agentId: string;
let secondAgentId: string;
let userId: string;
let secondUserId: string;
let sourceTaskId: string;

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    setRequestAuth(
      req,
      req.headers["x-test-operator"] === "true"
        ? { kind: "operator", fingerprint: "asset-key-test" }
        : null,
    );
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url ?? "");
    const query = parseQueryParams(req.url ?? "");
    const callerAgentId = req.headers["x-agent-id"] as string | undefined;
    const handlers = [handleAssets, handleTasks, handleWorkflows, handleSchedules, handlePages];
    for (const handler of handlers) {
      if (await handler(req, res, pathSegments, query, callerAgentId)) return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  });
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  opts: { agentId?: string; sourceTaskId?: string; operator?: boolean } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.agentId) headers["X-Agent-ID"] = opts.agentId;
  if (opts.sourceTaskId) headers["X-Source-Task-ID"] = opts.sourceTaskId;
  if (opts.operator) headers["X-Test-Operator"] = "true";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : undefined,
  };
}

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  agentId = (await createAgent({ name: "asset-api-worker", isLead: false, status: "idle" })).id;
  secondAgentId = (await createAgent({ name: "asset-api-worker-2", isLead: false, status: "idle" }))
    .id;
  userId = (await createUser({ name: "Asset API User", email: "asset-api@example.com" })).id;
  secondUserId = (await createUser({ name: "Other Asset User", email: "asset-api-2@example.com" }))
    .id;
  sourceTaskId = (
    await createTaskExtended("trusted source", {
      agentId,
      requestedByUserId: userId,
    })
  ).id;

  server = createTestServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not listen");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

describe("asset namespace REST contract", () => {
  test("creates and filters all primary entity types and returns lightweight aggregate rows", async () => {
    const task = await api(
      "POST",
      "/api/tasks",
      { task: "namespaced task", agentId, key: "Shared/Team" },
      { agentId },
    );
    expect(task.status).toBe(201);
    expect(task.body.key).toBe("shared/team/");

    const workflow = await api(
      "POST",
      "/api/workflows",
      {
        name: "Namespaced workflow",
        key: "shared/team/",
        definition: {
          nodes: [{ id: "task", type: "agent-task", config: { template: "workflow work" } }],
        },
      },
      { agentId },
    );
    expect(workflow.status).toBe(201);
    expect(workflow.body.key).toBe("shared/team/");

    const schedule = await api(
      "POST",
      "/api/schedules",
      {
        name: `namespaced-schedule-${Date.now()}`,
        key: "shared/team/",
        intervalMs: 60_000,
        taskTemplate: "scheduled work",
      },
      { agentId },
    );
    expect(schedule.status).toBe(201);
    expect(schedule.body.key).toBe("shared/team/");

    const page = await api(
      "POST",
      "/api/pages",
      {
        slug: `namespaced-page-${Date.now()}`,
        title: "Namespaced page",
        key: "shared/team/",
        contentType: "text/html",
        authMode: "authed",
        body: "<p>private content omitted from aggregate</p>",
      },
      { agentId },
    );
    expect(page.status).toBe(201);
    expect(page.body.key).toBe("shared/team/");

    const app = await createApp({
      name: "Namespaced app",
      definition: { models: {}, pages: {}, defaultPage: "main" } as never,
    });
    const script = await insertScript({
      name: `namespaced-script-${Date.now()}`,
      scope: "agent",
      scopeId: agentId,
      source: "export default async function () { return { ok: true }; }",
      description: "Namespaced script",
      intent: "Exercise asset namespace moves",
      signatureJson: "{}",
      agentId,
      embeddingMode: "skip",
    });
    expect(
      await api("PATCH", `/api/assets/app/${app.id}/key`, { key: "shared/team/" }, { agentId }),
    ).toMatchObject({ status: 200, body: { entityType: "app", key: "shared/team/" } });
    expect(
      await api(
        "PATCH",
        `/api/assets/script/${script.id}/key`,
        { key: "shared/team/" },
        { agentId },
      ),
    ).toMatchObject({ status: 200, body: { entityType: "script", key: "shared/team/" } });
    expect(
      await api(
        "PATCH",
        `/api/assets/script/${script.id}/key`,
        { key: "shared/other/" },
        { agentId: secondAgentId },
      ),
    ).toMatchObject({ status: 403 });

    const aggregate = await api(
      "GET",
      "/api/assets?keyPrefix=shared/team&types=task,workflow,schedule,page,app,script",
    );
    expect(aggregate.status).toBe(200);
    expect(aggregate.body.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityType: "task", id: task.body.id, key: "shared/team/" }),
        expect.objectContaining({
          entityType: "workflow",
          id: workflow.body.id,
          key: "shared/team/",
        }),
        expect.objectContaining({
          entityType: "schedule",
          id: schedule.body.id,
          key: "shared/team/",
        }),
        expect.objectContaining({ entityType: "page", id: page.body.id, key: "shared/team/" }),
        expect.objectContaining({ entityType: "app", id: app.id, key: "shared/team/" }),
        expect.objectContaining({ entityType: "script", id: script.id, key: "shared/team/" }),
      ]),
    );
    expect(
      await getDbClient().query<{ entity_type: string }>(
        "SELECT entity_type FROM asset_key_history WHERE entity_id IN (?, ?) ORDER BY entity_type",
        [app.id, script.id],
      ),
    ).toEqual([{ entity_type: "app" }, { entity_type: "script" }]);
    expect(JSON.stringify(aggregate.body)).not.toContain("namespaced task");
    expect(JSON.stringify(aggregate.body)).not.toContain("private content omitted");

    const taskList = await api("GET", "/api/tasks?keyPrefix=shared/team&includeHeartbeat=true");
    expect(taskList.body.tasks.some((row: { id: string }) => row.id === task.body.id)).toBe(true);
    const workflowList = await api("GET", "/api/workflows?key=shared/team/");
    expect(workflowList.body.some((row: { id: string }) => row.id === workflow.body.id)).toBe(true);
    const scheduleList = await api("GET", "/api/schedules?keyPrefix=shared/team/");
    expect(
      scheduleList.body.schedules.some((row: { id: string }) => row.id === schedule.body.id),
    ).toBe(true);
    const pageList = await api("GET", "/api/pages?key=shared/team/");
    expect(pageList.body.pages.some((row: { id: string }) => row.id === page.body.id)).toBe(true);
  });

  test("personal writes require the matching trusted resolved user", async () => {
    const allowed = await api(
      "POST",
      "/api/tasks",
      {
        task: "personal task",
        agentId,
        key: `personal/${userId}/drafts/`,
      },
      { agentId, sourceTaskId },
    );
    expect(allowed.status).toBe(201);
    expect(allowed.body.key).toBe(`personal/${userId}/drafts/`);

    const mismatched = await api(
      "POST",
      "/api/tasks",
      {
        task: "wrong personal task",
        agentId,
        key: `personal/${secondUserId}/drafts/`,
      },
      { agentId, sourceTaskId },
    );
    expect(mismatched.status).toBe(403);

    const automation = await api(
      "POST",
      "/api/tasks",
      {
        task: "unattributed personal task",
        agentId: secondAgentId,
        key: `personal/${secondUserId}/drafts/`,
      },
      { agentId: secondAgentId },
    );
    expect(automation.status).toBe(403);
  });

  test("moves entity and provider metadata without changing the physical provider key", async () => {
    const task = await api(
      "POST",
      "/api/tasks",
      { task: "move target", agentId, key: "shared/inbox/" },
      { agentId },
    );
    const move = await api(
      "PATCH",
      `/api/assets/task/${task.body.id}/key`,
      { key: "shared/archive/" },
      { agentId },
    );
    expect(move.status).toBe(200);
    expect(move.body.key).toBe("shared/archive/");

    const mapping = await api(
      "POST",
      "/api/assets/mappings",
      {
        providerId: "agent-fs",
        orgId: "org-api",
        driveId: "drive-api",
        providerKey: "reports/api-result.md",
        key: "shared/inbox/",
      },
      { agentId, operator: true },
    );
    expect(mapping.status).toBe(200);
    const fileMove = await api(
      "PATCH",
      `/api/assets/file/${mapping.body.id}/key`,
      { key: "shared/archive/" },
      { agentId, operator: true },
    );
    expect(fileMove.status).toBe(200);

    const files = await api("GET", "/api/assets?types=file&keyPrefix=shared/archive/");
    const file = files.body.assets.find((row: { id: string }) => row.id === mapping.body.id);
    expect(file.providerRef).toEqual({
      providerId: "agent-fs",
      orgId: "org-api",
      driveId: "drive-api",
      providerKey: "reports/api-result.md",
    });

    const deniedAudit = await api("GET", "/api/assets/key-audit", undefined, { agentId });
    expect(deniedAudit.status).toBe(403);
    const audit = await api("GET", "/api/assets/key-audit", undefined, { operator: true });
    expect(audit.status).toBe(200);
    expect(audit.body.structuralValid).toBe(true);
    expect(audit.body.warningCount).toBe(0);
  });
});
