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
import { applyQuery, handleApps } from "../http/apps";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { registerAppQueryTool } from "../tools/app-query";
import { registerAppSyncTool } from "../tools/app-sync";

const TEST_DB_PATH = "./test-apps-spike3.sqlite";
const AGENT_ID = crypto.randomUUID();
const nativeFetch = globalThis.fetch;
const nativeGithubConnector = CONNECTORS["github-issues"];
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
          connector: "github-issues",
          joinKey: "externalId",
          config: { repo: "owner/repo", state: "all", limit: 10, futureFlag: true },
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

interface GithubFetchPlan {
  body?: unknown;
  status?: number;
}

function githubIssue(
  number: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number,
    id: 1000 + number,
    title: `Issue ${number}`,
    state: "open",
    body: `Body ${number}`,
    user: { login: `User${number}` },
    labels: [{ name: "bug" }, { name: `p${number}` }],
    comments: number,
    html_url: `https://github.com/owner/repo/issues/${number}`,
    created_at: `2026-08-0${number}T10:00:00.000Z`,
    updated_at: `2026-08-0${number}T11:00:00.000Z`,
    ...overrides,
  };
}

function stubGithubFetch(...plans: GithubFetchPlan[]): Array<{ url: string; init?: RequestInit }> {
  let index = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    const plan = plans[index++];
    if (!plan) throw new Error(`unexpected GitHub fetch ${url}`);
    return new Response(JSON.stringify(plan.body ?? { message: "planned failure" }), {
      status: plan.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return calls;
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
  globalThis.fetch = nativeFetch;
  CONNECTORS["github-issues"] = nativeGithubConnector;
});

afterAll(async () => {
  globalThis.fetch = nativeFetch;
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
      connector: "github-issues",
      joinKey: "externalId",
      config: { repo: "owner/repo", futureFlag: true },
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
        path: "models.issue.sources.gh.config.repo",
        definition: issueDefinition((definition) => {
          delete definition.models.issue.sources.gh.config.repo;
        }),
      },
      {
        path: "models.issue.sources.gh.config.repo",
        definition: issueDefinition((definition) => {
          definition.models.issue.sources.gh.config.repo = "not-a-repository";
        }),
      },
      {
        path: "models.issue.sources.gh.config.repo",
        definition: issueDefinition((definition) => {
          definition.models.issue.sources.gh.config.repo = "./repo";
        }),
      },
      {
        path: "models.issue.sources.gh.config.repo",
        definition: issueDefinition((definition) => {
          definition.models.issue.sources.gh.config.repo = "../repo";
        }),
      },
      {
        path: "models.issue.sources.gh.config.repo",
        definition: issueDefinition((definition) => {
          definition.models.issue.sources.gh.config.repo = "owner/.";
        }),
      },
      {
        path: "models.issue.sources.gh.config.repo",
        definition: issueDefinition((definition) => {
          definition.models.issue.sources.gh.config.repo = "owner/..";
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

describe("GitHub issue sync lifecycle", () => {
  test("creates, transforms, updates projections only, avoids unchanged churn, stales, revives, warns with nulls, and fails atomically", async () => {
    const issue1 = githubIssue(1, { title: "First ISSUE", comments: 2 });
    const issue2 = githubIssue(2, { title: "Second issue", comments: 3 });
    const pullRequest = githubIssue(99, { pull_request: { url: "https://api.github.com/pr/99" } });
    const changed1 = githubIssue(1, { title: "Changed title", comments: 4 });
    const invalid1 = githubIssue(1, { title: "Changed title", state: "archived", comments: "NaN" });
    const calls = stubGithubFetch(
      { body: [issue1, issue2, pullRequest] },
      { body: [changed1, issue2] },
      { body: [changed1] },
      { body: [changed1, issue2] },
      { body: [invalid1, issue2] },
      { status: 503 },
    );
    const appId = await createApp(githubDefinition);

    const first = await syncApp(appId, { model: "issue", source: "gh" });
    expect(first.ok).toBe(true);
    expect(first.passes).toHaveLength(1);
    expect(first.passes[0]).toMatchObject({
      model: "issue",
      source: "gh",
      connector: "github-issues",
      pulled: 2,
      created: 2,
      updated: 0,
      unchanged: 0,
      markedStale: 0,
    });
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/owner/repo/issues?state=all&per_page=10",
    );
    expect(new Headers(calls[0]?.init?.headers).get("Accept")).toBe("application/vnd.github+json");
    expect(new Headers(calls[0]?.init?.headers).get("User-Agent")).toBe("agent-swarm-apps-sync");

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
    expect(firstRows.some((row) => row.externalId === "99")).toBe(false);
    const issue2SyncedAt = firstRows[1]?.syncedAt;
    const issue2UpdatedAt = firstRows[1]?.updatedAt;

    const ownedPatch = await request<{ row: Record<string, unknown> }>(
      `/api/apps/${appId}/models/issue/rows/${String(firstRows[0]?.id)}`,
      { method: "PATCH", body: JSON.stringify({ values: { note: "manual note" } }) },
    );
    expect(ownedPatch.status).toBe(200);
    await Bun.sleep(2);

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

    const reappeared = await syncApp(appId);
    expect(reappeared.passes[0]).toMatchObject({ updated: 1, unchanged: 1, markedStale: 0 });
    const revivedRows = sortedByExternalId(listAppRows(appId, "issue"));
    expect(revivedRows[1]?.stale).toBe(false);
    expect(revivedRows[1]?.syncedAt).not.toBe(issue2SyncedAt);

    const invalid = await syncApp(appId);
    expect(invalid.ok).toBe(true);
    expect(invalid.passes[0]?.warnings.length).toBeGreaterThanOrEqual(2);
    const invalidRows = sortedByExternalId(listAppRows(appId, "issue"));
    expect(invalidRows[0]).toMatchObject({ state: null, commentsCents: null, note: "manual note" });

    const beforeFailure = structuredClone(listAppRows(appId, "issue"));
    const failed = await syncApp(appId);
    expect(failed.ok).toBe(false);
    expect(failed.passes[0]?.error).toContain("503");
    expect(listAppRows(appId, "issue")).toEqual(beforeFailure);
  });

  test("serializes concurrent reconciliation after barrier-gated connector pulls", async () => {
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    CONNECTORS["github-issues"] = {
      async pull() {
        arrived += 1;
        if (arrived === 2) release();
        await barrier;
        return [
          {
            key: "1",
            fields: {
              ...githubIssue(1),
              userLogin: "User1",
              createdAt: "2026-08-01T10:00:00.000Z",
            },
          },
          {
            key: "2",
            fields: {
              ...githubIssue(2),
              userLogin: "User2",
              createdAt: "2026-08-02T10:00:00.000Z",
            },
          },
        ];
      },
    };
    const appId = await createApp(githubDefinition, "Concurrent sync");
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
    stubGithubFetch({ body: [githubIssue(1)] });
    const appId = await createApp(githubDefinition);
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
    stubGithubFetch({ body: [githubIssue(7)] });
    const appId = await createApp(githubDefinition);
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
    stubGithubFetch({ body: [githubIssue(11, { title: "MCP row" })] });
    const appId = await createApp(githubDefinition, "MCP sync");
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
