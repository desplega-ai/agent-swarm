import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { parseAppDefinition } from "../apps/definition";
import { type AppRow, createAppRow, patchAppRow } from "../apps/row-store";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { upsertScriptConnection } from "../be/script-connections";
import { upsertScriptByName } from "../be/scripts/db";
import { handleApps } from "../http/apps";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = `/private/tmp/test-apps-sync-${process.pid}.sqlite`;
const AGENT_ID = crypto.randomUUID();
const OTHER_AGENT_ID = crypto.randomUUID();
let server: Server;
let base = "";

/** Global, owner-less: the seeded-catalog shape the sync run-as fallback exists for. */
let globalScriptId = "";
/** Agent-scoped to AGENT_ID — the writer may wire it. */
let ownedScriptId = "";
/** Agent-scoped to another agent — the ownership gate must reject it. */
let foreignScriptId = "";

const page = {
  main: { root: "root", elements: { root: { type: "Container", props: {} } } },
};

type Definition = Record<string, unknown>;

/**
 * A model projected from two sources at once (script + native), with one bound
 * column per transform, an owned column, and a required owned column carrying a
 * default. Overrides are merged over `models.issue` so each check can bend one
 * knob at a time.
 */
function syncDefinition(
  overrides: {
    columns?: Record<string, unknown>;
    sources?: Record<string, unknown>;
    queries?: Record<string, unknown>;
    actions?: Record<string, unknown>;
  } = {},
): Definition {
  return {
    models: {
      issue: {
        columns: {
          issueKey: { kind: "string" },
          taskKey: { kind: "string" },
          title: { kind: "string", source: { of: "gh", field: "title" } },
          handle: { kind: "string", source: { of: "gh", field: "user.login", transform: "slug" } },
          amountCents: { kind: "number", source: { of: "gh", field: "price", transform: "cents" } },
          openedAt: {
            kind: "date",
            source: { of: "gh", field: "created_at", transform: "date-parse" },
          },
          status: { kind: "string", source: { of: "pool", field: "status" } },
          note: { kind: "string" },
          priority: { kind: "string", required: true, default: "normal" },
          ...overrides.columns,
        },
        sources: overrides.sources ?? {
          gh: {
            connector: "script",
            scriptId: globalScriptId,
            joinKey: "issueKey",
            args: { repo: "owner/name" },
          },
          pool: {
            connector: "swarm-tasks",
            joinKey: "taskKey",
            config: { limit: 50, includeHeartbeat: false },
          },
        },
      },
    },
    queries: overrides.queries ?? {
      staleIssues: {
        model: "issue",
        filter: { stale: true },
        sort: { column: "syncedAt", dir: "desc" },
      },
    },
    ...(overrides.actions ? { actions: overrides.actions } : {}),
    pages: page,
    defaultPage: "main",
  };
}

/** The same model reduced to a single script source (the `pool` binding drops with it). */
function scriptSourceDefinition(scriptId: string, connection?: string): Definition {
  return syncDefinition({
    columns: { status: { kind: "string" } },
    sources: {
      gh: {
        connector: "script",
        scriptId,
        joinKey: "issueKey",
        ...(connection ? { connection } : {}),
      },
    },
  });
}

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
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Agent-ID": AGENT_ID,
      ...init.headers,
    },
  });
  return { status: response.status, body: (await response.json()) as T };
}

type IssuesBody = { issues?: Array<{ path: string; message: string }> };

async function createApp(definition: Definition, name = "Sync app"): Promise<string> {
  const result = await request<{ app: { id: string } } & IssuesBody>("/api/apps", {
    method: "POST",
    body: JSON.stringify({ name, definition }),
  });
  if (result.status !== 201) throw new Error(JSON.stringify(result.body));
  return result.body.app.id;
}

/** POST a definition expected to be rejected, and return its issues. */
async function rejectedIssues(
  definition: Definition,
  headers: Record<string, string> = {},
): Promise<Array<{ path: string; message: string }>> {
  const result = await request<IssuesBody>("/api/apps", {
    method: "POST",
    body: JSON.stringify({ name: "Rejected", definition }),
    headers,
  });
  expect(result.status).toBe(400);
  return result.body.issues ?? [];
}

function issueAt(
  issues: Array<{ path: string; message: string }>,
  path: string,
): { path: string; message: string } | undefined {
  return issues.find((issue) => issue.path === path);
}

/** Model definition for direct row-store calls (the HTTP path re-reads it anyway). */
function modelOf(definition: Definition, model: string) {
  const parsed = parseAppDefinition(definition);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.issues));
  const resolved = parsed.definition.models[model];
  if (!resolved) throw new Error(`unknown model ${model}`);
  return resolved;
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  createAgent({ id: AGENT_ID, name: "apps-sync-worker", isLead: false, status: "idle" });
  createAgent({ id: OTHER_AGENT_ID, name: "apps-sync-other", isLead: false, status: "idle" });

  const fixture = {
    source: "export default function run() { return { records: [] }; }",
    intent: "Exercise app sync source validation",
    signatureJson: JSON.stringify({ args: { type: "object" }, result: { type: "object" } }),
    typeChecked: true,
  };
  globalScriptId = (
    await upsertScriptByName({
      ...fixture,
      name: `apps_sync_global_${crypto.randomUUID().replaceAll("-", "")}`,
      scope: "global",
      description: "Owner-less global source fixture",
    })
  ).script.id;
  ownedScriptId = (
    await upsertScriptByName({
      ...fixture,
      name: `apps_sync_owned_${crypto.randomUUID().replaceAll("-", "")}`,
      scope: "agent",
      scopeId: AGENT_ID,
      agentId: AGENT_ID,
      description: "Writer-owned source fixture",
    })
  ).script.id;
  foreignScriptId = (
    await upsertScriptByName({
      ...fixture,
      name: `apps_sync_foreign_${crypto.randomUUID().replaceAll("-", "")}`,
      scope: "agent",
      scopeId: OTHER_AGENT_ID,
      agentId: OTHER_AGENT_ID,
      description: "Foreign-owned source fixture",
    })
  ).script.id;

  await upsertScriptConnection({
    slug: "vendorApi",
    kind: "graphql",
    scope: "global",
    baseUrl: "https://api.vendor.test/graphql",
    allowedHosts: ["api.vendor.test"],
  });
  await upsertScriptConnection({
    slug: "dormant",
    kind: "graphql",
    scope: "global",
    baseUrl: "https://api.dormant.test/graphql",
    allowedHosts: ["api.dormant.test"],
    enabled: false,
  });
  // Agent-scoped: reachable only when the sync run-as identity IS that agent.
  await upsertScriptConnection({
    slug: "mine",
    kind: "graphql",
    scope: "agent",
    scopeId: AGENT_ID,
    baseUrl: "https://api.mine.test/graphql",
    allowedHosts: ["api.mine.test"],
  });

  server = createTestServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a port");
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  getDb().run("DELETE FROM kv_entries WHERE namespace LIKE 'apps:%'");
  getDb().run("DELETE FROM apps");
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

describe("apps sync definition surface", () => {
  test("accepts a full sources + bindings definition and stores it verbatim", async () => {
    const appId = await createApp(syncDefinition());
    const stored = await request<{
      app: {
        definition: {
          models: {
            issue: {
              sources: Record<string, Record<string, unknown>>;
              columns: Record<string, Record<string, unknown>>;
            };
          };
        };
      };
    }>(`/api/apps/${appId}`);
    expect(stored.status).toBe(200);
    const model = stored.body.app.definition.models.issue;
    expect(Object.keys(model.sources).sort()).toEqual(["gh", "pool"]);
    expect(model.sources.gh).toEqual({
      connector: "script",
      scriptId: globalScriptId,
      joinKey: "issueKey",
      args: { repo: "owner/name" },
    });
    expect(model.sources.pool).toEqual({
      connector: "swarm-tasks",
      joinKey: "taskKey",
      config: { limit: 50, includeHeartbeat: false },
    });
    expect(model.columns.handle?.source).toEqual({
      of: "gh",
      field: "user.login",
      transform: "slug",
    });
  });

  test("accepts several sources of the same connector on one model", async () => {
    const appId = await createApp(
      syncDefinition({
        columns: { otherKey: { kind: "string" } },
        sources: {
          gh: { connector: "script", scriptId: globalScriptId, joinKey: "issueKey" },
          pool: { connector: "swarm-tasks", joinKey: "taskKey", config: { status: "queued" } },
          done: { connector: "swarm-tasks", joinKey: "otherKey", config: { status: "completed" } },
        },
      }),
    );
    expect(appId).toBeString();
  });

  test("caps a model at 4 sources", async () => {
    const issues = await rejectedIssues(
      syncDefinition({
        columns: { k3: { kind: "string" }, k4: { kind: "string" }, k5: { kind: "string" } },
        sources: {
          a: { connector: "swarm-tasks", joinKey: "issueKey" },
          b: { connector: "swarm-tasks", joinKey: "taskKey" },
          c: { connector: "swarm-tasks", joinKey: "k3" },
          d: { connector: "swarm-tasks", joinKey: "k4" },
          e: { connector: "swarm-tasks", joinKey: "k5" },
        },
      }),
    );
    expect(issueAt(issues, "models.issue.sources")?.message).toBe("must define at most 4 sources");
  });

  test("check 1 — joinKey must name an existing, non-hidden string column", async () => {
    const missing = await rejectedIssues(
      syncDefinition({
        sources: { gh: { connector: "swarm-tasks", joinKey: "nope" } },
        columns: { title: { kind: "string" }, status: { kind: "string" } },
      }),
    );
    expect(issueAt(missing, "models.issue.sources.gh.joinKey")?.message).toBe(
      'unknown or hidden column "nope"',
    );

    const hidden = await rejectedIssues(
      syncDefinition({
        sources: { gh: { connector: "swarm-tasks", joinKey: "issueKey" } },
        columns: {
          issueKey: { kind: "string", hidden: true },
          title: { kind: "string" },
          status: { kind: "string" },
        },
      }),
    );
    expect(issueAt(hidden, "models.issue.sources.gh.joinKey")?.message).toBe(
      'unknown or hidden column "issueKey"',
    );

    const wrongKind = await rejectedIssues(
      syncDefinition({
        sources: { gh: { connector: "swarm-tasks", joinKey: "issueKey" } },
        columns: {
          issueKey: { kind: "number" },
          title: { kind: "string" },
          status: { kind: "string" },
        },
      }),
    );
    expect(issueAt(wrongKind, "models.issue.sources.gh.joinKey")?.message).toBe(
      'join key column "issueKey" must be a string column',
    );
  });

  test("check 2 — the joinKey column may not be bound, required, or defaulted", async () => {
    const bound = await rejectedIssues(
      syncDefinition({
        sources: { gh: { connector: "swarm-tasks", joinKey: "issueKey" } },
        columns: {
          issueKey: { kind: "string", source: { of: "gh", field: "number" } },
          title: { kind: "string" },
          status: { kind: "string" },
        },
      }),
    );
    expect(issueAt(bound, "models.issue.sources.gh.joinKey")?.message).toBe(
      'join key column "issueKey" must not be bound to a source',
    );

    const required = await rejectedIssues(
      syncDefinition({
        sources: { gh: { connector: "swarm-tasks", joinKey: "issueKey" } },
        columns: {
          issueKey: { kind: "string", required: true },
          title: { kind: "string" },
          status: { kind: "string" },
        },
      }),
    );
    expect(issueAt(required, "models.issue.sources.gh.joinKey")?.message).toBe(
      'join key column "issueKey" must not be required',
    );

    const defaulted = await rejectedIssues(
      syncDefinition({
        sources: { gh: { connector: "swarm-tasks", joinKey: "issueKey" } },
        columns: {
          issueKey: { kind: "string", default: "seed" },
          title: { kind: "string" },
          status: { kind: "string" },
        },
      }),
    );
    expect(issueAt(defaulted, "models.issue.sources.gh.joinKey")?.message).toBe(
      'join key column "issueKey" must not declare a default',
    );
  });

  test("check 3 — source.of must resolve and field must be non-empty", async () => {
    const unknownSource = await rejectedIssues(
      syncDefinition({
        columns: { title: { kind: "string", source: { of: "nope", field: "t" } } },
      }),
    );
    expect(issueAt(unknownSource, "models.issue.columns.title.source.of")?.message).toBe(
      'unknown source "nope"',
    );

    const emptyField = await rejectedIssues(
      syncDefinition({ columns: { title: { kind: "string", source: { of: "gh", field: "" } } } }),
    );
    expect(issueAt(emptyField, "models.issue.columns.title.source.field")).toBeDefined();
  });

  test("check 4 — transforms must match the column kind", async () => {
    const slugOnNumber = await rejectedIssues(
      syncDefinition({
        columns: {
          amountCents: { kind: "number", source: { of: "gh", field: "price", transform: "slug" } },
        },
      }),
    );
    expect(
      issueAt(slugOnNumber, "models.issue.columns.amountCents.source.transform")?.message,
    ).toBe('transform "slug" requires a string column');

    const centsOnString = await rejectedIssues(
      syncDefinition({
        columns: {
          title: { kind: "string", source: { of: "gh", field: "t", transform: "cents" } },
        },
      }),
    );
    expect(issueAt(centsOnString, "models.issue.columns.title.source.transform")?.message).toBe(
      'transform "cents" requires a number column',
    );

    const dateOnString = await rejectedIssues(
      syncDefinition({
        columns: {
          title: { kind: "string", source: { of: "gh", field: "t", transform: "date-parse" } },
        },
      }),
    );
    expect(issueAt(dateOnString, "models.issue.columns.title.source.transform")?.message).toBe(
      'transform "date-parse" requires a date column',
    );
  });

  test("check 5 — source-bound columns may not be required or defaulted", async () => {
    const issues = await rejectedIssues(
      syncDefinition({
        columns: {
          title: {
            kind: "string",
            required: true,
            default: "x",
            source: { of: "gh", field: "title" },
          },
        },
      }),
    );
    expect(issueAt(issues, "models.issue.columns.title.required")?.message).toBe(
      "source-bound column must not be required",
    );
    expect(issueAt(issues, "models.issue.columns.title.default")?.message).toBe(
      "source-bound column must not declare a default",
    );
  });

  test("check 6 — a model with sources needs a default on every required owned column", async () => {
    const issues = await rejectedIssues(
      syncDefinition({ columns: { note: { kind: "string", required: true } } }),
    );
    expect(issueAt(issues, "models.issue.columns.note")?.message).toBe(
      "required column on a model with sources must declare a default — sync-created rows cannot supply it",
    );

    // A source-less model keeps the plain rule.
    const okId = await createApp({
      models: { plain: { columns: { note: { kind: "string", required: true } } } },
      pages: page,
      defaultPage: "main",
    });
    expect(okId).toBeString();

    // Hidden required columns are exempt: no write path ever enforces them
    // (prepareValues skips hidden columns), so a default would be dead weight.
    const hiddenId = await createApp(
      syncDefinition({ columns: { ghost: { kind: "string", required: true, hidden: true } } }),
      "Hidden required",
    );
    expect(hiddenId).toBeString();
  });

  test("check 7 — source scripts must exist and pass the writer ownership gate", async () => {
    const orphanId = crypto.randomUUID();
    const missing = await rejectedIssues(scriptSourceDefinition(orphanId));
    expect(issueAt(missing, "models.issue.sources.gh.scriptId")?.message).toBe(
      `script "${orphanId}" not found`,
    );

    const foreign = await rejectedIssues(scriptSourceDefinition(foreignScriptId));
    expect(issueAt(foreign, "models.issue.sources.gh.scriptId")?.message).toBe(
      `script "${foreignScriptId}" is agent-scoped to another agent — reference a script you own or a global script`,
    );

    // The writer's own agent-scoped script is fine.
    const ownedApp = await createApp(scriptSourceDefinition(ownedScriptId));
    expect(ownedApp).toBeString();
  });

  test("check 7 — a foreign source script already stored is grandfathered for agent edits", async () => {
    // An operator (no X-Agent-ID) may wire any script.
    const operatorApp = await fetch(`${base}/api/apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Operator wired",
        definition: scriptSourceDefinition(foreignScriptId),
      }),
    });
    expect(operatorApp.status).toBe(201);
    const appId = ((await operatorApp.json()) as { app: { id: string } }).app.id;

    // The agent can keep editing it — the stored script id is grandfathered.
    const patched = await request(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({ definition: { models: { issue: { columns: { extra: null } } } } }),
    });
    expect(patched.status).toBe(200);
  });

  test("check 8 — connection must resolve to an enabled connection for the run-as identity", async () => {
    const issues = await rejectedIssues(scriptSourceDefinition(globalScriptId, "ghost"));
    expect(issueAt(issues, "models.issue.sources.gh.connection")?.message).toBe(
      'connection "ghost" not found or disabled for the sync run-as identity',
    );

    // A connection that exists but is disabled is just as unreachable.
    const disabled = await rejectedIssues(scriptSourceDefinition(globalScriptId, "dormant"));
    expect(issueAt(disabled, "models.issue.sources.gh.connection")?.message).toBe(
      'connection "dormant" not found or disabled for the sync run-as identity',
    );

    const appId = await createApp(scriptSourceDefinition(globalScriptId, "vendorApi"));
    expect(appId).toBeString();
  });

  test("check 8 — reachability follows the run-as identity, not the writer", async () => {
    // Owned script: run-as = its owner, who the `mine` connection is scoped to.
    const ownedId = await createApp(scriptSourceDefinition(ownedScriptId, "mine"));
    expect(ownedId).toBeString();

    // Owner-less global script: run-as falls back past the (absent) lead to
    // "app-sync", which an agent-scoped connection never applies to.
    const issues = await rejectedIssues(scriptSourceDefinition(globalScriptId, "mine"));
    expect(issueAt(issues, "models.issue.sources.gh.connection")?.message).toBe(
      'connection "mine" not found or disabled for the sync run-as identity',
    );
  });

  test("check 9 — a sync action must resolve to at least one (model x source) pair", async () => {
    const unknownModel = await rejectedIssues(
      syncDefinition({ actions: { refresh: { kind: "sync", model: "nope" } } }),
    );
    expect(issueAt(unknownModel, "actions.refresh.model")?.message).toBe('unknown model "nope"');

    const unknownSource = await rejectedIssues(
      syncDefinition({ actions: { refresh: { kind: "sync", model: "issue", source: "nope" } } }),
    );
    expect(issueAt(unknownSource, "actions.refresh.source")?.message).toBe(
      'unknown source "nope" on model "issue"',
    );

    const unknownSourceAnyModel = await rejectedIssues(
      syncDefinition({ actions: { refresh: { kind: "sync", source: "nope" } } }),
    );
    expect(issueAt(unknownSourceAnyModel, "actions.refresh.source")?.message).toBe(
      'unknown source "nope" — no model declares it',
    );

    const sourcelessModel = await rejectedIssues({
      models: { plain: { columns: { note: { kind: "string" } } } },
      actions: { refresh: { kind: "sync", model: "plain" } },
      pages: page,
      defaultPage: "main",
    });
    expect(issueAt(sourcelessModel, "actions.refresh.model")?.message).toBe(
      'model "plain" declares no sources',
    );

    const nothingToSync = await rejectedIssues({
      models: { plain: { columns: { note: { kind: "string" } } } },
      actions: { refresh: { kind: "sync" } },
      pages: page,
      defaultPage: "main",
    });
    expect(issueAt(nothingToSync, "actions.refresh")?.message).toBe(
      "no model declares a source to sync",
    );

    const appId = await createApp(
      syncDefinition({
        actions: {
          refreshAll: { kind: "sync" },
          refreshGh: { kind: "sync", model: "issue", source: "gh" },
        },
      }),
    );
    expect(appId).toBeString();
  });

  test("reserves source, syncedAt and stale as model column names", async () => {
    for (const name of ["source", "syncedAt", "stale"]) {
      const issues = await rejectedIssues({
        models: { plain: { columns: { note: { kind: "string" }, [name]: { kind: "string" } } } },
        pages: page,
        defaultPage: "main",
      });
      expect(issueAt(issues, `models.plain.columns.${name}`)?.message).toBe("reserved column name");
    }
  });

  test("named queries may filter on stale and sort by syncedAt", async () => {
    // syncDefinition's default query does exactly this; a bad kind still fails.
    const appId = await createApp(syncDefinition());
    expect(appId).toBeString();

    const badKind = await rejectedIssues(
      syncDefinition({
        queries: { staleIssues: { model: "issue", filter: { stale: "yes" } } },
      }),
    );
    expect(issueAt(badKind, "queries.staleIssues.filter.stale")?.message).toBe(
      "filter must be a valid boolean value",
    );
  });
});

describe("apps sync definition patches", () => {
  test("a sources.<s> patch replaces the whole subtree — no cross-connector splice", async () => {
    const appId = await createApp(syncDefinition());
    const patched = await request<
      {
        app: { definition: { models: { issue: { sources: Record<string, unknown> } } } };
      } & IssuesBody
    >(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: {
          models: {
            issue: {
              sources: {
                gh: { connector: "swarm-tasks", joinKey: "issueKey", config: { limit: 10 } },
              },
            },
          },
        },
      }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body.app.definition.models.issue.sources.gh).toEqual({
      connector: "swarm-tasks",
      joinKey: "issueKey",
      config: { limit: 10 },
    });
  });

  test("models.<m>.sources.<s> = null deletes the source", async () => {
    const appId = await createApp(syncDefinition());
    const patched = await request<
      {
        app: { definition: { models: { issue: { sources: Record<string, unknown> } } } };
      } & IssuesBody
    >(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: {
          models: {
            issue: {
              // Bindings must go with the source — a dangling source.of is rejected.
              columns: { title: null, handle: null, amountCents: null, openedAt: null },
              sources: { gh: null },
            },
          },
        },
      }),
    });
    expect(patched.status).toBe(200);
    expect(Object.keys(patched.body.app.definition.models.issue.sources)).toEqual(["pool"]);
  });
});

describe("apps sync row envelope and read-only enforcement", () => {
  const definition = () => syncDefinition();

  async function appWithRows(): Promise<string> {
    return createApp(definition());
  }

  test("row create rejects source-bound and join-key columns with path-bearing issues", async () => {
    const appId = await appWithRows();
    const bound = await request<IssuesBody>(`/api/apps/${appId}/models/issue/rows`, {
      method: "POST",
      body: JSON.stringify({ values: { title: "hand edit" } }),
    });
    expect(bound.status).toBe(400);
    expect(issueAt(bound.body.issues ?? [], "values.title")?.message).toBe(
      'column is a read-only projection from source "gh"; mutate it via the source or a sync refresh',
    );

    const joinKey = await request<IssuesBody>(`/api/apps/${appId}/models/issue/rows`, {
      method: "POST",
      body: JSON.stringify({ values: { issueKey: "42" } }),
    });
    expect(joinKey.status).toBe(400);
    expect(issueAt(joinKey.body.issues ?? [], "values.issueKey")?.message).toBe(
      "column is the sync join key and is managed by the sync engine",
    );
  });

  test("owned columns on the same model stay writable", async () => {
    const appId = await appWithRows();
    const created = await request<{ row: AppRow }>(`/api/apps/${appId}/models/issue/rows`, {
      method: "POST",
      body: JSON.stringify({ values: { note: "mine" } }),
    });
    expect(created.status).toBe(201);
    expect(created.body.row.note).toBe("mine");
    expect(created.body.row.priority).toBe("normal");
    // An owned row never gains the sync envelope.
    expect(created.body.row.source).toBeUndefined();
    expect(created.body.row.syncedAt).toBeUndefined();
    expect(created.body.row.stale).toBeUndefined();

    const patched = await request<{ row: AppRow }>(
      `/api/apps/${appId}/models/issue/rows/${created.body.row.id}`,
      { method: "PATCH", body: JSON.stringify({ values: { note: "still mine" } }) },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.row.note).toBe("still mine");
  });

  test("row patch rejects source-bound and join-key columns", async () => {
    const appId = await appWithRows();
    const created = await request<{ row: AppRow }>(`/api/apps/${appId}/models/issue/rows`, {
      method: "POST",
      body: JSON.stringify({ values: { note: "mine" } }),
    });
    expect(created.status).toBe(201);

    for (const [column, message] of [
      [
        "status",
        'column is a read-only projection from source "pool"; mutate it via the source or a sync refresh',
      ],
      ["taskKey", "column is the sync join key and is managed by the sync engine"],
    ] as const) {
      const patched = await request<IssuesBody>(
        `/api/apps/${appId}/models/issue/rows/${created.body.row.id}`,
        { method: "PATCH", body: JSON.stringify({ values: { [column]: "x" } }) },
      );
      expect(patched.status).toBe(400);
      expect(issueAt(patched.body.issues ?? [], `values.${column}`)?.message).toBe(message);
    }
  });

  test("bulk create rejects source-bound and join-key columns", async () => {
    const appId = await appWithRows();
    const bulk = await request<IssuesBody>(`/api/apps/${appId}/models/issue/rows/bulk`, {
      method: "POST",
      body: JSON.stringify({ rows: [{ values: { note: "ok" } }, { values: { title: "nope" } }] }),
    });
    expect(bulk.status).toBe(400);
    expect(issueAt(bulk.body.issues ?? [], "values.title")?.message).toBe(
      'column is a read-only projection from source "gh"; mutate it via the source or a sync refresh',
    );

    const bulkJoinKey = await request<IssuesBody>(`/api/apps/${appId}/models/issue/rows/bulk`, {
      method: "POST",
      body: JSON.stringify({ rows: [{ values: { issueKey: "42" } }] }),
    });
    expect(bulkJoinKey.status).toBe(400);
    expect(issueAt(bulkJoinKey.body.issues ?? [], "values.issueKey")?.message).toBe(
      "column is the sync join key and is managed by the sync engine",
    );

    const ok = await request<{ rows: AppRow[] }>(`/api/apps/${appId}/models/issue/rows/bulk`, {
      method: "POST",
      body: JSON.stringify({ rows: [{ values: { note: "a" } }, { values: { note: "b" } }] }),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.rows).toHaveLength(2);
  });

  test("envelope field names are still rejected as row values", async () => {
    const appId = await appWithRows();
    for (const name of ["source", "syncedAt", "stale"]) {
      const result = await request<IssuesBody>(`/api/apps/${appId}/models/issue/rows`, {
        method: "POST",
        body: JSON.stringify({ values: { [name]: "x" } }),
      });
      expect(result.status).toBe(400);
      expect(issueAt(result.body.issues ?? [], `values.${name}`)?.message).toBe(
        `unknown or hidden column "${name}"`,
      );
    }
  });

  test("a source-managed write without an envelope is refused outright", async () => {
    const appId = await appWithRows();
    const model = modelOf(definition(), "issue");
    await expect(
      createAppRow(appId, "issue", model, { issueKey: "42" }, { allowSourceManaged: true }),
    ).rejects.toThrow("allowSourceManaged writes must carry an envelope");
  });

  test("a source-managed write stamps the envelope and round-trips it", async () => {
    const appId = await appWithRows();
    const model = modelOf(definition(), "issue");
    const row = await createAppRow(
      appId,
      "issue",
      model,
      { issueKey: "42", title: "From GitHub", status: "open" },
      {
        allowSourceManaged: true,
        envelope: { source: "gh", syncedAt: "2026-08-06T10:00:00.000Z", stale: false },
        actor: "sync:gh",
      },
    );
    expect(row.title).toBe("From GitHub");
    expect(row.issueKey).toBe("42");
    expect(row.source).toBe("gh");
    expect(row.syncedAt).toBe("2026-08-06T10:00:00.000Z");
    expect(row.stale).toBe(false);

    const listed = await request<{ rows: AppRow[] }>(`/api/apps/${appId}/models/issue/rows`);
    expect(listed.status).toBe(200);
    expect(listed.body.rows[0]).toMatchObject({
      source: "gh",
      syncedAt: "2026-08-06T10:00:00.000Z",
      stale: false,
      title: "From GitHub",
    });
  });

  test("a source-managed patch may rewrite bound columns and re-stamp the envelope", async () => {
    const appId = await appWithRows();
    const model = modelOf(definition(), "issue");
    const row = await createAppRow(
      appId,
      "issue",
      model,
      { issueKey: "42", title: "v1" },
      {
        allowSourceManaged: true,
        envelope: { source: "gh", syncedAt: "2026-08-06T10:00:00.000Z", stale: false },
      },
    );
    const patched = await patchAppRow(
      appId,
      "issue",
      model,
      row.id,
      { title: "v2" },
      {
        allowSourceManaged: true,
        skipUpdatedAt: true,
        envelope: { source: "gh", syncedAt: "2026-08-06T11:00:00.000Z", stale: true },
      },
    );
    expect(patched?.title).toBe("v2");
    expect(patched?.syncedAt).toBe("2026-08-06T11:00:00.000Z");
    expect(patched?.stale).toBe(true);
    // skipUpdatedAt keeps the human-facing timestamp frozen.
    expect(patched?.updatedAt).toBe(row.updatedAt);
  });

  test("named queries filter on stale and app rows sort by syncedAt", async () => {
    const appId = await appWithRows();
    const model = modelOf(definition(), "issue");
    await createAppRow(
      appId,
      "issue",
      model,
      { issueKey: "1", title: "old" },
      {
        allowSourceManaged: true,
        envelope: { source: "gh", syncedAt: "2026-08-01T00:00:00.000Z", stale: true },
      },
    );
    await createAppRow(
      appId,
      "issue",
      model,
      { issueKey: "2", title: "fresh" },
      {
        allowSourceManaged: true,
        envelope: { source: "gh", syncedAt: "2026-08-06T00:00:00.000Z", stale: false },
      },
    );

    const query = await request<{ rows: AppRow[] }>(`/api/apps/${appId}/queries/staleIssues`);
    expect(query.status).toBe(200);
    expect(query.body.rows).toHaveLength(1);
    expect(query.body.rows[0]?.issueKey).toBe("1");

    const sorted = await request<{ rows: AppRow[] }>(
      `/api/apps/${appId}/models/issue/rows?sort=syncedAt:desc`,
    );
    expect(sorted.status).toBe(200);
    expect(sorted.body.rows.map((row) => row.issueKey)).toEqual(["2", "1"]);

    const ascending = await request<{ rows: AppRow[] }>(
      `/api/apps/${appId}/models/issue/rows?sort=syncedAt:asc`,
    );
    expect(ascending.body.rows.map((row) => row.issueKey)).toEqual(["1", "2"]);
  });
});
