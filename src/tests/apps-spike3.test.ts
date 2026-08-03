import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import appSeed from "../../apps/ui/APP_SEED.json";
import { applyAppDefinitionPatch, parseAppDefinition } from "../apps/definition";
import { listAppRows } from "../apps/row-store";
import { getApp } from "../apps/store";
import { CONNECTORS, runAppSync } from "../apps/sync";
import { closeDb, createAgent, createTaskExtended, getDb, initDb } from "../be/db";
import { insertScript } from "../be/scripts/db";
import { applyQuery, handleApps } from "../http/apps";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { registerAppQueryTool } from "../tools/app-query";
import { registerAppSyncTool } from "../tools/app-sync";

const TEST_DB_PATH = "./test-apps-spike3.sqlite";
const AGENT_ID = crypto.randomUUID();
const nativeFetch = globalThis.fetch;
const nativeSwarmTasksConnector = CONNECTORS["swarm-tasks"];
const bookmarksDefinition = await Bun.file(
  new URL("./fixtures/bookmarks-definition.json.txt", import.meta.url),
).json();

const allTaskStatuses = [
  "backlog",
  "unassigned",
  "offered",
  "reviewing",
  "pending",
  "in_progress",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "superseded",
];

const page = {
  root: "root",
  elements: {
    root: { type: "Container", props: {} },
  },
};

const SOURCE_ERROR_TOKEN = "ghp_1234567890abcdefABCDEF1234567890ABCD";
const SCRIPT_SOURCE = `
export default function pull(args, ctx) {
  if (args.throwError) throw new Error("planned source failure");
  if (args.throwSecretError) throw new Error("planned ${SOURCE_ERROR_TOKEN}");
  if (args.captureContext) {
    return [{
      key: args.key,
      fields: {
        appId: args.app.id,
        model: args.model,
        source: args.source,
        custom: args.custom,
        runAsAgentId: ctx.stdlib.Redacted.value(ctx.swarm.config.agentId),
        state: "open",
      },
    }];
  }
  return args.records;
}
`;

let scriptSourceId = "00000000-0000-4000-8000-000000000000";

const githubDefinition = {
  models: {
    issue: {
      columns: {
        externalId: { kind: "string", index: true },
        title: { kind: "string", source: { of: "gh", field: "title", transform: "upper" } },
        slug: { kind: "string", source: { of: "gh", field: "title", transform: "slug" } },
        state: {
          kind: "enum",
          enum: ["open", "closed"],
          source: { of: "gh", field: "state" },
        },
        commentsCents: {
          kind: "number",
          source: { of: "gh", field: "comments", transform: "cents" },
        },
        author: {
          kind: "string",
          source: { of: "gh", field: "userLogin", transform: "lower" },
        },
        openedAt: {
          kind: "date",
          source: { of: "gh", field: "createdAt", transform: "date-parse" },
        },
        note: { kind: "string", required: true, default: "owned-default" },
      },
      sources: {
        gh: {
          connector: "script",
          joinKey: "externalId",
          scriptId: scriptSourceId,
          args: { records: [] },
        },
      },
    },
  },
  queries: {
    allIssues: { model: "issue", sort: { column: "syncedAt", dir: "desc" } },
  },
  actions: {
    refresh: { kind: "sync", model: "issue", source: "gh" },
  },
  page,
};

const unsourcedDefinition = {
  models: {
    note: {
      columns: {
        title: { kind: "string", required: true },
      },
    },
  },
  queries: { allNotes: { model: "note" } },
  page,
};

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

type StructuredResult<T> = {
  isError?: boolean;
  structuredContent: T;
};

type SyncPass = {
  model: string;
  source: string;
  connector: string;
  pulled: number;
  created: number;
  updated: number;
  unchanged: number;
  markedStale: number;
  warnings: Array<{ path?: string; message?: string } | string>;
  durationMs: number;
  error?: string;
};

type SyncResponse = { ok: boolean; passes: SyncPass[]; issues?: Array<{ path: string }> };

let server: Server;
let base = "";

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleApps(req, res, pathSegments, queryParams, myAgentId)) return;
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const response = await nativeFetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Agent-ID": AGENT_ID,
      ...init.headers,
    },
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function createApp(definition: unknown, name = "Spike 3"): Promise<string> {
  const result = await request<{ app: { id: string } }>("/api/apps", {
    method: "POST",
    body: JSON.stringify({ name, definition }),
  });
  expect(result.status).toBe(201);
  return result.body.app.id;
}

function toolMeta(agentId = AGENT_ID) {
  return {
    sessionId: "apps-spike3",
    requestInfo: { headers: { "x-agent-id": agentId } },
  };
}

function registeredTools(
  registrations: Array<(server: McpServer) => void>,
): Record<string, RegisteredTool> {
  const toolServer = new McpServer({ name: "apps-spike3-test", version: "1.0.0" });
  for (const register of registrations) register(toolServer);
  return (toolServer as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
}

function issuesFor(definition: unknown): Array<{ path: string; message: string }> {
  const parsed = parseAppDefinition(definition);
  expect(parsed.success).toBe(false);
  return parsed.success ? [] : parsed.issues;
}

function expectIssue(definition: unknown, path: string): void {
  expect(issuesFor(definition).some((item) => item.path === path)).toBe(true);
}

function issueDefinition(mutator: (definition: any) => void): unknown {
  const definition = structuredClone(githubDefinition);
  mutator(definition);
  return definition;
}

function sourceRecord(
  number: number,
  overrides: Record<string, unknown> = {},
): { key: string; fields: Record<string, unknown> } {
  return {
    key: String(number),
    fields: {
      number,
      id: 1000 + number,
      title: `Issue ${number}`,
      state: "open",
      body: `Body ${number}`,
      userLogin: `User${number}`,
      labelsCsv: `bug,p${number}`,
      comments: number,
      htmlUrl: `https://github.com/owner/repo/issues/${number}`,
      createdAt: `2026-08-0${number}T10:00:00.000Z`,
      updatedAt: `2026-08-0${number}T11:00:00.000Z`,
      ...overrides,
    },
  };
}

async function setScriptSourceArgs(appId: string, args: Record<string, unknown>): Promise<void> {
  const patched = await request<{ app?: unknown; issues?: unknown }>(`/api/apps/${appId}`, {
    method: "PATCH",
    body: JSON.stringify({
      definition: {
        models: {
          issue: {
            sources: {
              gh: { connector: "script", joinKey: "externalId", scriptId: scriptSourceId, args },
            },
          },
        },
      },
    }),
  });
  expect(patched.status).toBe(200);
}

function sortedByExternalId(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...rows].sort((left, right) =>
    String(left.externalId).localeCompare(String(right.externalId)),
  );
}

async function syncApp(appId: string, body: Record<string, unknown> = {}): Promise<SyncResponse> {
  const result = await request<SyncResponse>(`/api/apps/${appId}/sync`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(result.status).toBe(200);
  return result.body;
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  createAgent({ id: AGENT_ID, name: "apps-spike3-worker", isLead: false, status: "idle" });
  scriptSourceId = insertScript({
    name: `apps_spike3_source_${crypto.randomUUID().replaceAll("-", "")}`,
    scope: "agent",
    scopeId: AGENT_ID,
    source: SCRIPT_SOURCE,
    description: "Apps Spike 3 dynamic source fixture",
    intent: "Exercise script-backed app source sync",
    signatureJson: JSON.stringify({ args: { type: "object" }, result: { type: "array" } }),
    agentId: AGENT_ID,
    typeChecked: true,
  }).id;
  githubDefinition.models.issue.sources.gh.scriptId = scriptSourceId;
  server = createTestServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a port");
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  getDb().run("DELETE FROM kv_entries WHERE namespace LIKE 'apps:%'");
  getDb().run("DELETE FROM agent_tasks");
  getDb().run("DELETE FROM apps");
});

afterEach(() => {
  CONNECTORS["swarm-tasks"] = nativeSwarmTasksConnector;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

describe("spike 3 app definition schema", () => {
  test("accepts the complete sources, bindings, transforms, query, and sync-action definition", () => {
    const parsed = parseAppDefinition(githubDefinition);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.issues));
    expect(parsed.definition.models.issue?.sources?.gh).toMatchObject({
      connector: "script",
      joinKey: "externalId",
      scriptId: scriptSourceId,
      args: { records: [] },
    });
    expect(parsed.definition.actions?.refresh).toEqual({
      kind: "sync",
      model: "issue",
      source: "gh",
    });
  });

  test("reports every source semantic rejection at the exact contract path", () => {
    const cases: Array<{ path: string; definition: unknown }> = [
      {
        path: "models.issue.sources.gh.joinKey",
        definition: issueDefinition((definition) => {
          definition.models.issue.sources.gh.joinKey = "missing";
        }),
      },
      {
        path: "models.issue.sources.gh.joinKey",
        definition: issueDefinition((definition) => {
          definition.models.issue.columns.numericId = { kind: "number" };
          definition.models.issue.sources.gh.joinKey = "numericId";
        }),
      },
      {
        path: "models.issue.sources.gh.scriptId",
        definition: issueDefinition((definition) => {
          definition.models.issue.sources.gh.scriptId = crypto.randomUUID();
        }),
      },
      {
        path: "models.issue.columns.title.source.of",
        definition: issueDefinition((definition) => {
          definition.models.issue.columns.title.source.of = "missing";
        }),
      },
      {
        path: "models.issue.columns.title.source.field",
        definition: issueDefinition((definition) => {
          definition.models.issue.columns.title.source.field = "";
        }),
      },
      {
        path: "models.issue.columns.title.source.transform",
        definition: issueDefinition((definition) => {
          definition.models.issue.columns.title.source.transform = "cents";
        }),
      },
      {
        path: "models.issue.columns.externalId.source",
        definition: issueDefinition((definition) => {
          definition.models.issue.columns.externalId.source = { of: "gh", field: "number" };
        }),
      },
      {
        path: "models.issue.columns.externalId.required",
        definition: issueDefinition((definition) => {
          definition.models.issue.columns.externalId.required = true;
        }),
      },
      {
        path: "models.issue.columns.externalId.default",
        definition: issueDefinition((definition) => {
          definition.models.issue.columns.externalId.default = "0";
        }),
      },
      {
        path: "models.issue.columns.title.required",
        definition: issueDefinition((definition) => {
          definition.models.issue.columns.title.required = true;
        }),
      },
      {
        path: "models.issue.columns.title.default",
        definition: issueDefinition((definition) => {
          definition.models.issue.columns.title.default = "lying default";
        }),
      },
      {
        path: "models.issue.columns.note.default",
        definition: issueDefinition((definition) => {
          delete definition.models.issue.columns.note.default;
        }),
      },
      {
        path: "actions.refresh.model",
        definition: issueDefinition((definition) => {
          definition.actions.refresh.model = "missing";
        }),
      },
      {
        path: "actions.refresh.model",
        definition: issueDefinition((definition) => {
          definition.models.owned = { columns: { title: { kind: "string" } } };
          definition.actions.refresh.model = "owned";
          delete definition.actions.refresh.source;
        }),
      },
      {
        path: "actions.refresh.source",
        definition: issueDefinition((definition) => {
          definition.actions.refresh.source = "missing";
        }),
      },
      {
        path: "actions.refresh",
        definition: {
          ...structuredClone(unsourcedDefinition),
          actions: { refresh: { kind: "sync" } },
        },
      },
    ];

    for (const item of cases) expectIssue(item.definition, item.path);
  });

  test("rejects the removed github-issues connector", () => {
    const definition = issueDefinition((candidate) => {
      candidate.models.issue.sources.gh = {
        connector: "github-issues",
        joinKey: "externalId",
        config: { repo: "owner/repo" },
      };
    });
    expectIssue(definition, "models.issue.sources.gh.connector");
  });

  test("rejects every reserved sync envelope name as a column", () => {
    for (const name of ["source", "syncedAt", "stale"]) {
      expectIssue(
        {
          ...structuredClone(unsourcedDefinition),
          models: { note: { columns: { [name]: { kind: "string" } } } },
        },
        `models.note.columns.${name}`,
      );
    }
  });

  test("treats individual column and source entries as atomic merge-patch subtrees", () => {
    const result = applyAppDefinitionPatch(githubDefinition as any, {
      models: {
        issue: {
          columns: { title: { kind: "string" } },
          sources: { gh: { connector: "swarm-tasks", joinKey: "externalId" } },
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const definition = result.definition as any;
    expect(definition.models.issue.columns.title).toEqual({ kind: "string" });
    expect(definition.models.issue.sources.gh).toEqual({
      connector: "swarm-tasks",
      joinKey: "externalId",
    });

    const deleted = applyAppDefinitionPatch(githubDefinition as any, {
      models: { issue: { columns: { author: null }, sources: { gh: null } } },
    });
    expect(deleted.success).toBe(true);
    if (!deleted.success) return;
    expect((deleted.definition as any).models.issue.columns).not.toHaveProperty("author");
    expect((deleted.definition as any).models.issue.sources).not.toHaveProperty("gh");
  });

  test("keeps the APP_SEED and Bookmarks definitions valid", () => {
    expect(parseAppDefinition(appSeed).success).toBe(true);
    expect(parseAppDefinition(bookmarksDefinition).success).toBe(true);
  });

  test("sorts named queries by the syncedAt system field", () => {
    const parsed = parseAppDefinition(githubDefinition);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.issues));
    const model = parsed.definition.models.issue!;
    const query = parsed.definition.queries!.allIssues!;
    const rows = [
      {
        id: crypto.randomUUID(),
        externalId: "old",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        syncedAt: "2026-08-01T01:00:00.000Z",
      },
      {
        id: crypto.randomUUID(),
        externalId: "new",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        syncedAt: "2026-08-02T01:00:00.000Z",
      },
    ];
    expect(applyQuery(rows, query, model).map((row) => row.externalId)).toEqual(["new", "old"]);
  });
});

describe("source-managed row write enforcement", () => {
  test("rejects source-bound and join-key writes on create and patch but permits owned columns", async () => {
    const appId = await createApp(githubDefinition);

    const projectedCreate = await request<{ issues: Array<{ path: string; message: string }> }>(
      `/api/apps/${appId}/models/issue/rows`,
      { method: "POST", body: JSON.stringify({ values: { title: "Direct" } }) },
    );
    expect(projectedCreate.status).toBe(400);
    expect(projectedCreate.body.issues).toContainEqual({
      path: "title",
      message:
        'column is a read-only projection from source "gh"; mutate it via the source or a sync-refresh',
    });

    const joinCreate = await request<{ issues: Array<{ path: string; message: string }> }>(
      `/api/apps/${appId}/models/issue/rows`,
      { method: "POST", body: JSON.stringify({ values: { externalId: "1" } }) },
    );
    expect(joinCreate.status).toBe(400);
    expect(joinCreate.body.issues).toContainEqual({
      path: "externalId",
      message: "column is the sync join key and is managed by the sync engine",
    });

    const owned = await request<{ row: Record<string, unknown> }>(
      `/api/apps/${appId}/models/issue/rows`,
      { method: "POST", body: JSON.stringify({ values: { note: "owned" } }) },
    );
    expect(owned.status).toBe(201);
    expect(owned.body.row).toMatchObject({ note: "owned" });
    expect(owned.body.row).not.toHaveProperty("source");

    const projectedPatch = await request<{ issues: Array<{ path: string }> }>(
      `/api/apps/${appId}/models/issue/rows/${String(owned.body.row.id)}`,
      { method: "PATCH", body: JSON.stringify({ values: { title: "Direct patch" } }) },
    );
    expect(projectedPatch.status).toBe(400);
    expect(projectedPatch.body.issues).toContainEqual(expect.objectContaining({ path: "title" }));

    const joinPatch = await request<{ issues: Array<{ path: string }> }>(
      `/api/apps/${appId}/models/issue/rows/${String(owned.body.row.id)}`,
      { method: "PATCH", body: JSON.stringify({ values: { externalId: "2" } }) },
    );
    expect(joinPatch.status).toBe(400);
    expect(joinPatch.body.issues).toContainEqual(expect.objectContaining({ path: "externalId" }));

    const ownedPatch = await request<{ row: Record<string, unknown> }>(
      `/api/apps/${appId}/models/issue/rows/${String(owned.body.row.id)}`,
      { method: "PATCH", body: JSON.stringify({ values: { note: "still owned" } }) },
    );
    expect(ownedPatch.status).toBe(200);
    expect(ownedPatch.body.row.note).toBe("still owned");

    const reserved = await request<{ issues: Array<{ path: string }> }>(
      `/api/apps/${appId}/models/issue/rows`,
      { method: "POST", body: JSON.stringify({ values: { source: "gh" } }) },
    );
    expect(reserved.status).toBe(400);
    expect(reserved.body.issues).toContainEqual(expect.objectContaining({ path: "values.source" }));
  });

  test("enforces read-only columns atomically on the bulk endpoint", async () => {
    const appId = await createApp(githubDefinition);
    const bulk = await request<{ issues: Array<{ path: string }> }>(
      `/api/apps/${appId}/models/issue/rows/bulk`,
      {
        method: "POST",
        body: JSON.stringify({
          rows: [{ values: { note: "allowed" } }, { values: { externalId: "blocked" } }],
        }),
      },
    );
    expect(bulk.status).toBe(400);
    expect(bulk.body.issues).toContainEqual(expect.objectContaining({ path: "externalId" }));
    expect(listAppRows(appId, "issue")).toHaveLength(0);
  });
});

describe("script source sync lifecycle", () => {
  test("creates, transforms, updates projections only, avoids unchanged churn, stales, revives, warns with nulls, and fails atomically", async () => {
    const issue1 = sourceRecord(1, { title: "First ISSUE", comments: 2 });
    const issue2 = sourceRecord(2, { title: "Second issue", comments: 3 });
    const changed1 = sourceRecord(1, { title: "Changed title", comments: 4 });
    const invalid1 = sourceRecord(1, {
      title: "Changed title",
      state: "archived",
      comments: "NaN",
    });
    const appId = await createApp(githubDefinition);
    await setScriptSourceArgs(appId, { records: [issue1, issue2] });

    const first = await syncApp(appId, { model: "issue", source: "gh" });
    expect(first.ok).toBe(true);
    expect(first.passes).toHaveLength(1);
    expect(first.passes[0]).toMatchObject({
      model: "issue",
      source: "gh",
      connector: "script",
      pulled: 2,
      created: 2,
      updated: 0,
      unchanged: 0,
      markedStale: 0,
    });
    const firstRows = sortedByExternalId(listAppRows(appId, "issue"));
    expect(firstRows).toHaveLength(2);
    expect(firstRows[0]).toMatchObject({
      externalId: "1",
      title: "FIRST ISSUE",
      slug: "first-issue",
      state: "open",
      commentsCents: 200,
      author: "user1",
      openedAt: "2026-08-01T10:00:00.000Z",
      note: "owned-default",
      source: "gh",
      stale: false,
    });
    expect(firstRows[0]?.syncedAt).toBeString();
    const issue2SyncedAt = firstRows[1]?.syncedAt;
    const issue2UpdatedAt = firstRows[1]?.updatedAt;

    const ownedPatch = await request<{ row: Record<string, unknown> }>(
      `/api/apps/${appId}/models/issue/rows/${String(firstRows[0]?.id)}`,
      { method: "PATCH", body: JSON.stringify({ values: { note: "manual note" } }) },
    );
    expect(ownedPatch.status).toBe(200);
    await Bun.sleep(2);

    await setScriptSourceArgs(appId, { records: [changed1, issue2] });
    const second = await syncApp(appId);
    expect(second.passes[0]).toMatchObject({
      created: 0,
      updated: 1,
      unchanged: 1,
      markedStale: 0,
    });
    const secondRows = sortedByExternalId(listAppRows(appId, "issue"));
    expect(secondRows[0]).toMatchObject({
      externalId: "1",
      title: "CHANGED TITLE",
      commentsCents: 400,
      note: "manual note",
      stale: false,
    });
    expect(secondRows[1]?.syncedAt).not.toBe(issue2SyncedAt);
    expect(secondRows[1]?.updatedAt).toBe(issue2UpdatedAt);
    const issue2SecondSyncedAt = secondRows[1]?.syncedAt;
    const issue2SecondUpdatedAt = secondRows[1]?.updatedAt;

    await setScriptSourceArgs(appId, { records: [changed1] });
    const disappeared = await syncApp(appId);
    expect(disappeared.passes[0]).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 1,
      markedStale: 1,
    });
    const staleRows = sortedByExternalId(listAppRows(appId, "issue"));
    expect(staleRows[1]?.stale).toBe(true);
    expect(staleRows[1]?.syncedAt).toBe(issue2SecondSyncedAt);
    expect(staleRows[1]?.updatedAt).not.toBe(issue2SecondUpdatedAt);

    await setScriptSourceArgs(appId, { records: [changed1, issue2] });
    const reappeared = await syncApp(appId);
    expect(reappeared.passes[0]).toMatchObject({ updated: 1, unchanged: 1, markedStale: 0 });
    const revivedRows = sortedByExternalId(listAppRows(appId, "issue"));
    expect(revivedRows[1]?.stale).toBe(false);
    expect(revivedRows[1]?.syncedAt).not.toBe(issue2SyncedAt);

    await setScriptSourceArgs(appId, { records: [invalid1, issue2] });
    const invalid = await syncApp(appId);
    expect(invalid.ok).toBe(true);
    expect(invalid.passes[0]?.warnings.length).toBeGreaterThanOrEqual(2);
    const invalidRows = sortedByExternalId(listAppRows(appId, "issue"));
    expect(invalidRows[0]).toMatchObject({ state: null, commentsCents: null, note: "manual note" });

    const beforeFailure = structuredClone(listAppRows(appId, "issue"));
    await setScriptSourceArgs(appId, { throwError: true });
    const failed = await syncApp(appId);
    expect(failed.ok).toBe(false);
    expect(failed.passes[0]?.error).toContain("planned source failure");
    expect(listAppRows(appId, "issue")).toEqual(beforeFailure);

    await setScriptSourceArgs(appId, { throwSecretError: true });
    const secretFailure = await syncApp(appId);
    expect(secretFailure.ok).toBe(false);
    expect(secretFailure.passes[0]?.error).toContain("[REDACTED:github_token]");
    expect(secretFailure.passes[0]?.error).not.toContain(SOURCE_ERROR_TOKEN);
    expect(listAppRows(appId, "issue")).toEqual(beforeFailure);
  });

  test("rejects invalid script result shapes and the record cap with zero row churn", async () => {
    const appId = await createApp(githubDefinition, "Invalid script result");
    await setScriptSourceArgs(appId, { records: [sourceRecord(9)] });
    expect((await syncApp(appId)).ok).toBe(true);
    const beforeInvalid = structuredClone(listAppRows(appId, "issue"));

    await setScriptSourceArgs(appId, { records: { key: "not-an-array", fields: {} } });
    const invalidShape = await syncApp(appId);
    expect(invalidShape.ok).toBe(false);
    expect(invalidShape.passes[0]?.error).toContain("script source returned invalid records");
    expect(listAppRows(appId, "issue")).toEqual(beforeInvalid);

    await setScriptSourceArgs(appId, { records: [{ fields: {} }] });
    const missingKey = await syncApp(appId);
    expect(missingKey.ok).toBe(false);
    expect(missingKey.passes[0]?.error).toContain("script source returned invalid records");
    expect(listAppRows(appId, "issue")).toEqual(beforeInvalid);

    await setScriptSourceArgs(appId, {
      records: Array.from({ length: 501 }, (_, index) => ({ key: index, fields: {} })),
    });
    const overCap = await syncApp(appId);
    expect(overCap.ok).toBe(false);
    expect(overCap.passes[0]?.error).toContain("script source returned invalid records");
    expect(listAppRows(appId, "issue")).toEqual(beforeInvalid);
  });

  test("runs as the owning agent and injects source args plus app, model, and source context", async () => {
    const definition = structuredClone(githubDefinition);
    Object.assign(definition.models.issue.columns, {
      appContext: { kind: "string", source: { of: "gh", field: "appId" } },
      modelContext: { kind: "string", source: { of: "gh", field: "model" } },
      sourceContext: { kind: "string", source: { of: "gh", field: "source" } },
      customContext: { kind: "string", source: { of: "gh", field: "custom" } },
      runAsContext: { kind: "string", source: { of: "gh", field: "runAsAgentId" } },
    });
    definition.models.issue.sources.gh.args = {
      captureContext: true,
      key: 42,
      custom: "from-source-args",
      app: { id: "must-be-overridden" },
      model: "must-be-overridden",
      source: "must-be-overridden",
    };
    const appId = await createApp(definition, "Script context injection");

    const result = await syncApp(appId);
    expect(result).toMatchObject({ ok: true, passes: [{ connector: "script", created: 1 }] });
    expect(listAppRows(appId, "issue")).toEqual([
      expect.objectContaining({
        externalId: "42",
        appContext: appId,
        modelContext: "issue",
        sourceContext: "gh",
        customContext: "from-source-args",
        runAsContext: AGENT_ID,
      }),
    ]);
  });

  test("runs an ownerless global catalog-style script under the isolated app-sync identity", async () => {
    const globalScript = insertScript({
      name: `apps_spike3_global_source_${crypto.randomUUID().replaceAll("-", "")}`,
      scope: "global",
      scopeId: null,
      source: SCRIPT_SOURCE,
      description: "Ownerless global Apps source fixture",
      intent: "Prove global catalog sources can run without inheriting agent credentials",
      signatureJson: JSON.stringify({ args: { type: "object" }, result: { type: "array" } }),
      agentId: null,
      typeChecked: true,
    });
    const definition = structuredClone(githubDefinition);
    definition.models.issue.columns.runAsContext = {
      kind: "string",
      source: { of: "gh", field: "runAsAgentId" },
    };
    definition.models.issue.sources.gh.scriptId = globalScript.id;
    definition.models.issue.sources.gh.args = { captureContext: true, key: "global" };
    const appId = await createApp(definition, "Global script source");

    const result = await syncApp(appId);
    expect(result).toMatchObject({ ok: true, passes: [{ connector: "script", created: 1 }] });
    expect(listAppRows(appId, "issue")).toEqual([
      expect.objectContaining({ externalId: "global", runAsContext: "app-sync" }),
    ]);
  });

  test("serializes concurrent reconciliation after barrier-gated connector pulls", async () => {
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    CONNECTORS["swarm-tasks"] = {
      async pull() {
        arrived += 1;
        if (arrived === 2) release();
        await barrier;
        return [
          {
            key: "1",
            fields: sourceRecord(1).fields,
          },
          {
            key: "2",
            fields: sourceRecord(2).fields,
          },
        ];
      },
    };
    const concurrentDefinition = structuredClone(githubDefinition);
    concurrentDefinition.models.issue.sources.gh = {
      connector: "swarm-tasks",
      joinKey: "externalId",
    } as any;
    const appId = await createApp(concurrentDefinition, "Concurrent sync");
    const app = getApp(appId);
    if (!app) throw new Error("test app disappeared");

    const results = await Promise.all([
      runAppSync(app, { model: "issue", source: "gh" }),
      runAppSync(app, { model: "issue", source: "gh" }),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      results.flatMap((result) => result.passes).reduce((sum, pass) => sum + pass.created, 0),
    ).toBe(2);
    const rows = listAppRows(appId, "issue");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.externalId))).toEqual(new Set(["1", "2"]));
  });
});

describe("swarm task connector", () => {
  test("projects real task rows from the database", async () => {
    const task = createTaskExtended("Investigate the real task connector", {
      agentId: AGENT_ID,
      source: "api",
      tags: ["apps-spike3"],
      priority: 72,
      vcsProvider: "github",
      vcsNumber: 1066,
      vcsUrl: "https://github.com/desplega-ai/agent-swarm/pull/1066",
      vcsAuthor: "taras",
    });
    const definition = {
      models: {
        task: {
          columns: {
            taskId: { kind: "string" },
            prompt: { kind: "string", source: { of: "pool", field: "prompt" } },
            status: {
              kind: "enum",
              enum: allTaskStatuses,
              source: { of: "pool", field: "status" },
            },
            priority: { kind: "number", source: { of: "pool", field: "priority" } },
            assignee: { kind: "string", source: { of: "pool", field: "agentId" } },
            changedAt: {
              kind: "date",
              source: { of: "pool", field: "updatedAt", transform: "date-parse" },
            },
            bucket: { kind: "string", required: true, default: "inbox" },
          },
          sources: {
            pool: {
              connector: "swarm-tasks",
              joinKey: "taskId",
              config: { status: task.status, limit: 10, includeHeartbeat: false },
            },
          },
        },
      },
      queries: { allTasks: { model: "task" } },
      page,
    };
    const appId = await createApp(definition, "Task sync");
    const result = await syncApp(appId);
    expect(result).toMatchObject({ ok: true, passes: [{ pulled: 1, created: 1 }] });
    expect(listAppRows(appId, "task")).toEqual([
      expect.objectContaining({
        taskId: task.id,
        prompt: "Investigate the real task connector",
        status: task.status,
        priority: 72,
        assignee: AGENT_ID,
        bucket: "inbox",
        source: "pool",
        stale: false,
      }),
    ]);
  });
});

describe("sync HTTP and action endpoints", () => {
  test("returns happy, not-found, unknown-selection, and no-pair response shapes", async () => {
    const appId = await createApp(githubDefinition);
    await setScriptSourceArgs(appId, { records: [sourceRecord(1)] });
    const happy = await request<SyncResponse>(`/api/apps/${appId}/sync`, {
      method: "POST",
      body: JSON.stringify({ model: "issue", source: "gh" }),
    });
    expect(happy.status).toBe(200);
    expect(happy.body).toMatchObject({ ok: true, passes: [{ created: 1 }] });

    const missing = await request<{ error: string }>(`/api/apps/${crypto.randomUUID()}/sync`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(404);

    for (const body of [{ model: "missing" }, { model: "issue", source: "missing" }]) {
      const invalid = await request<{ issues: Array<{ path: string }> }>(
        `/api/apps/${appId}/sync`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      expect(invalid.status).toBe(400);
      expect(invalid.body.issues.length).toBeGreaterThan(0);
    }

    const noPairsId = await createApp(unsourcedDefinition, "No sources");
    const noPairs = await request<{ issues: Array<{ path: string }> }>(
      `/api/apps/${noPairsId}/sync`,
      { method: "POST", body: JSON.stringify({}) },
    );
    expect(noPairs.status).toBe(400);
    expect(noPairs.body.issues.length).toBeGreaterThan(0);
  });

  test("runs a sync action with the script-kind inline result shape", async () => {
    const appId = await createApp(githubDefinition);
    await setScriptSourceArgs(appId, { records: [sourceRecord(7)] });
    const result = await request<{
      ok: boolean;
      result: { passes: SyncPass[] };
      error?: string;
      durationMs: number;
      taskId?: string;
    }>(`/api/apps/${appId}/actions/refresh`, {
      method: "POST",
      body: JSON.stringify({ input: {} }),
    });
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.result.passes).toEqual([expect.objectContaining({ created: 1 })]);
    expect(result.body.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.body).not.toHaveProperty("taskId");
  });
});

describe("sync and query MCP tools", () => {
  test("round-trips through registered tools with a registered UUID agent", async () => {
    const appId = await createApp(githubDefinition, "MCP sync");
    await setScriptSourceArgs(appId, { records: [sourceRecord(11, { title: "MCP row" })] });
    const tools = registeredTools([registerAppSyncTool, registerAppQueryTool]);

    const synced = (await tools["app-sync"]!.handler(
      { appId, model: "issue", source: "gh" },
      toolMeta(),
    )) as StructuredResult<{ success: boolean; passes: SyncPass[] }>;
    expect(synced.isError).not.toBe(true);
    expect(synced.structuredContent.success).toBe(true);
    expect(synced.structuredContent.passes).toEqual([expect.objectContaining({ created: 1 })]);

    const queried = (await tools["app-query"]!.handler(
      { appId, query: "allIssues" },
      { sessionId: "apps-spike3", requestInfo: { headers: {} } },
    )) as StructuredResult<{
      success: boolean;
      rows: Array<Record<string, unknown>>;
      count: number;
    }>;
    expect(queried.isError).not.toBe(true);
    expect(queried.structuredContent.success).toBe(true);
    expect(queried.structuredContent.count).toBe(1);
    expect(queried.structuredContent.rows).toEqual([
      expect.objectContaining({ externalId: "11", title: "MCP ROW", source: "gh" }),
    ]);
  });
});
