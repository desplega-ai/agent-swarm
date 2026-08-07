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
  // The writer agent IS the lead: owner-less global sources resolve run-as to
  // the lead, and only that identity (or the operator) may wire them.
  createAgent({ id: AGENT_ID, name: "apps-sync-worker", isLead: true, status: "idle" });
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

  test("check 7b — a stored foreign reference does not grandfather new paths for the same script", async () => {
    // Operator wires the foreign script as an ACTION only.
    const withAction = await fetch(`${base}/api/apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Foreign action only",
        definition: syncDefinition({
          actions: { run: { kind: "script", scriptId: foreignScriptId } },
        }),
      }),
    });
    expect(withAction.status).toBe(201);
    const actionAppId = ((await withAction.json()) as { app: { id: string } }).app.id;

    // Action-to-source: the agent must not repoint a source at that id — the
    // source would run with the foreign owner's bindings under fresh args.
    const sourcePatch = await request<IssuesBody>(`/api/apps/${actionAppId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: {
          models: {
            issue: {
              sources: {
                gh: { connector: "script", scriptId: foreignScriptId, joinKey: "issueKey" },
              },
            },
          },
        },
      }),
    });
    expect(sourcePatch.status).toBe(400);
    expect(
      issueAt(sourcePatch.body.issues ?? [], "models.issue.sources.gh.scriptId")?.message,
    ).toContain("agent-scoped to another agent");

    // Source-to-action: the inverse hop is rejected the same way.
    const withSource = await fetch(`${base}/api/apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Foreign source only",
        definition: scriptSourceDefinition(foreignScriptId),
      }),
    });
    expect(withSource.status).toBe(201);
    const sourceAppId = ((await withSource.json()) as { app: { id: string } }).app.id;

    const actionPatch = await request<IssuesBody>(`/api/apps/${sourceAppId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: { actions: { steal: { kind: "script", scriptId: foreignScriptId } } },
      }),
    });
    expect(actionPatch.status).toBe(400);
    expect(issueAt(actionPatch.body.issues ?? [], "actions.steal.scriptId")?.message).toContain(
      "agent-scoped to another agent",
    );

    // The grandfathered path itself stays editable.
    const stillEditable = await request(`/api/apps/${sourceAppId}`, {
      method: "PATCH",
      body: JSON.stringify({ definition: { models: { issue: { columns: { extra: null } } } } }),
    });
    expect(stillEditable.status).toBe(200);
  });

  test("check 7c — grandfathering pins args and connection, not just the script id", async () => {
    const foreignSource = (args: Record<string, unknown>, connection?: string) =>
      syncDefinition({
        columns: { status: { kind: "string" } },
        sources: {
          gh: {
            connector: "script",
            scriptId: foreignScriptId,
            joinKey: "issueKey",
            args,
            ...(connection ? { connection } : {}),
          },
        },
      });
    const operatorApp = await fetch(`${base}/api/apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Foreign source with args",
        definition: foreignSource({ repo: "owner/name" }),
      }),
    });
    expect(operatorApp.status).toBe(201);
    const appId = ((await operatorApp.json()) as { app: { id: string } }).app.id;

    // Same script id, attacker-chosen args: the sync would run the owner's
    // credentials over a different request — not grandfathered.
    const argsSwap = await request<IssuesBody>(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({ definition: foreignSource({ repo: "owner/evil" }) }),
    });
    expect(argsSwap.status).toBe(400);
    expect(
      issueAt(argsSwap.body.issues ?? [], "models.issue.sources.gh.scriptId")?.message,
    ).toContain("agent-scoped to another agent");

    // Same id, same args, new connection choice: also not grandfathered.
    const connectionSwap = await request<IssuesBody>(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({ definition: foreignSource({ repo: "owner/name" }, "vendorApi") }),
    });
    expect(connectionSwap.status).toBe(400);
    expect(
      issueAt(connectionSwap.body.issues ?? [], "models.issue.sources.gh.scriptId")?.message,
    ).toContain("agent-scoped to another agent");

    // The unchanged reference stays editable around.
    const unchanged = await request(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({ definition: foreignSource({ repo: "owner/name" }) }),
    });
    expect(unchanged.status).toBe(200);
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

    // Owner-less global script: run-as falls back to the lead — the writer
    // here — so the lead-scoped `mine` connection is reachable.
    const globalId = await createApp(scriptSourceDefinition(globalScriptId, "mine"), "Lead mine");
    expect(globalId).toBeString();

    // Foreign-owned script: run-as = ITS owner, which `mine` never applies to
    // (the ownership gate fires too; both issues surface).
    const issues = await rejectedIssues(scriptSourceDefinition(foreignScriptId, "mine"));
    expect(issueAt(issues, "models.issue.sources.gh.connection")?.message).toBe(
      'connection "mine" not found or disabled for the sync run-as identity',
    );
  });

  test("check 10 — only the lead or operator may wire an owner-less global source", async () => {
    const issues = await rejectedIssues(scriptSourceDefinition(globalScriptId), {
      "X-Agent-ID": OTHER_AGENT_ID,
    });
    expect(issueAt(issues, "models.issue.sources.gh.scriptId")?.message).toContain(
      "only that agent or the operator may wire or alter this source",
    );

    // The operator may wire it...
    const operatorApp = await fetch(`${base}/api/apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Operator catalog",
        definition: scriptSourceDefinition(globalScriptId),
      }),
    });
    expect(operatorApp.status).toBe(201);
    const appId = ((await operatorApp.json()) as { app: { id: string } }).app.id;

    // ...and the stored, pinned reference stays editable around for others.
    const edited = await request(`/api/apps/${appId}`, {
      method: "PATCH",
      headers: { "X-Agent-ID": OTHER_AGENT_ID },
      body: JSON.stringify({ definition: { models: { issue: { columns: { extra: null } } } } }),
    });
    expect(edited.status).toBe(200);
  });

  test("check 11 — rollback restores get the same ownership checks as ordinary writes", async () => {
    // Operator authors an app carrying the foreign source, then replaces it
    // with a sourceless definition — version 1 snapshots the foreign source.
    const withForeign = await fetch(`${base}/api/apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Rollback gate",
        definition: scriptSourceDefinition(foreignScriptId),
      }),
    });
    expect(withForeign.status).toBe(201);
    const appId = ((await withForeign.json()) as { app: { id: string } }).app.id;

    const sourceless = syncDefinition({
      columns: {
        title: { kind: "string" },
        handle: { kind: "string" },
        amountCents: { kind: "number" },
        openedAt: { kind: "date" },
        status: { kind: "string" },
      },
      sources: {},
    });
    const replaced = await fetch(`${base}/api/apps/${appId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ definition: sourceless }),
    });
    expect(replaced.status).toBe(200);

    // A non-owner agent cannot reintroduce the foreign source via rollback.
    const denied = await request<IssuesBody>(`/api/apps/${appId}/rollback`, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    expect(denied.status).toBe(400);
    expect(
      issueAt(denied.body.issues ?? [], "models.issue.sources.gh.scriptId")?.message,
    ).toContain("agent-scoped to another agent");

    // The operator may restore it.
    const restored = await fetch(`${base}/api/apps/${appId}/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    expect(restored.status).toBe(200);
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

describe("apps sync source edits as schema changes", () => {
  /** One source, one bound column, one owned column — the lifecycle-edit shape. */
  function lifecycleDefinition(
    overrides: { columns?: Record<string, unknown>; sources?: Record<string, unknown> | null } = {},
  ): Definition {
    return {
      models: {
        issue: {
          columns: {
            issueKey: { kind: "string" },
            title: { kind: "string", source: { of: "gh", field: "title" } },
            note: { kind: "string" },
            ...overrides.columns,
          },
          ...(overrides.sources === null
            ? {}
            : { sources: overrides.sources ?? { gh: ghSource() } }),
        },
      },
      pages: page,
      defaultPage: "main",
    };
  }

  function ghSource(): Record<string, unknown> {
    return {
      connector: "script",
      scriptId: globalScriptId,
      joinKey: "issueKey",
      args: { repo: "owner/name" },
    };
  }

  /** The same model before any source exists — every column plain and owned. */
  function sourcelessDefinition(): Definition {
    return lifecycleDefinition({ columns: { title: { kind: "string" } }, sources: null });
  }

  type PatchBody = {
    app: { definition: { models: { issue: Record<string, Record<string, unknown>> } } };
    migration: { detachedRows: number; purgedValues: number };
  } & IssuesBody;

  function patchDefinition(
    appId: string,
    definition: Definition,
    migration?: Record<string, unknown>,
  ): Promise<{ status: number; body: PatchBody }> {
    return request<PatchBody>(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({ definition, ...(migration ? { migration } : {}) }),
    });
  }

  /** Seed the row shape only the sync engine may write. */
  function seedSyncedRow(
    appId: string,
    definition: Definition,
    values: Record<string, unknown>,
    source = "gh",
    syncedAt = "2026-08-06T10:00:00.000Z",
  ): Promise<AppRow> {
    return createAppRow(appId, "issue", modelOf(definition, "issue"), values, {
      allowSourceManaged: true,
      envelope: { source, syncedAt, stale: false },
      actor: `sync:${source}`,
    });
  }

  function listRows(appId: string): Promise<{ status: number; body: { rows: AppRow[] } }> {
    return request<{ rows: AppRow[] }>(`/api/apps/${appId}/models/issue/rows?sort=createdAt:asc`);
  }

  function listVersions(appId: string): Promise<{
    status: number;
    body: { versions: Array<{ version: number; snapshot: { definition: Definition } }> };
  }> {
    return request(`/api/apps/${appId}/versions`);
  }

  test("adding a sources entry is free and snapshots the previous definition", async () => {
    const appId = await createApp(sourcelessDefinition());
    const before = await listVersions(appId);

    const patched = await patchDefinition(appId, {
      models: { issue: { sources: { gh: ghSource() } } },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.app.definition.models.issue.sources).toEqual({ gh: ghSource() });
    expect(patched.body.migration.detachedRows).toBe(0);

    const after = await listVersions(appId);
    expect(after.body.versions).toHaveLength(before.body.versions.length + 1);
    // The snapshot is the pre-patch, source-less definition.
    expect(after.body.versions[0]?.snapshot.definition).toMatchObject({
      models: { issue: { columns: { title: { kind: "string" } } } },
    });
    expect(
      (
        after.body.versions[0]?.snapshot.definition.models as Record<
          string,
          Record<string, unknown>
        >
      ).issue?.sources,
    ).toBeUndefined();
  });

  test("adding a new column with a source binding is free", async () => {
    const appId = await createApp(lifecycleDefinition());
    const patched = await patchDefinition(appId, {
      models: {
        issue: { columns: { body: { kind: "string", source: { of: "gh", field: "body" } } } },
      },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.app.definition.models.issue.columns?.body).toEqual({
      kind: "string",
      source: { of: "gh", field: "body" },
    });
    expect(patched.body.migration.detachedRows).toBe(0);
  });

  test("binding an existing column that holds values is rejected with the row count", async () => {
    const appId = await createApp(lifecycleDefinition());
    for (const note of ["hand written", "also mine"]) {
      const created = await request(`/api/apps/${appId}/models/issue/rows`, {
        method: "POST",
        body: JSON.stringify({ values: { note } }),
      });
      expect(created.status).toBe(201);
    }
    // A third row leaves the column absent — only populated rows are counted.
    await request(`/api/apps/${appId}/models/issue/rows`, {
      method: "POST",
      body: JSON.stringify({ values: {} }),
    });

    const rejected = await patchDefinition(appId, {
      models: {
        issue: { columns: { note: { kind: "string", source: { of: "gh", field: "body" } } } },
      },
    });
    expect(rejected.status).toBe(400);
    expect(issueAt(rejected.body.issues ?? [], "models.issue.columns.note.source")?.message).toBe(
      "binding an existing column would let the next pass overwrite 2 row(s) of existing data; hide or purge the column and add it bound instead",
    );
  });

  test("binding an existing column with zero values is free", async () => {
    const appId = await createApp(lifecycleDefinition());
    // A row that never set the column does not populate it.
    await request(`/api/apps/${appId}/models/issue/rows`, {
      method: "POST",
      body: JSON.stringify({ values: {} }),
    });

    const patched = await patchDefinition(appId, {
      models: {
        issue: { columns: { note: { kind: "string", source: { of: "gh", field: "body" } } } },
      },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.app.definition.models.issue.columns?.note).toEqual({
      kind: "string",
      source: { of: "gh", field: "body" },
    });
  });

  test("changing a binding's field and transform is free and leaves rows alone", async () => {
    const definition = lifecycleDefinition();
    const appId = await createApp(definition);
    const seeded = await seedSyncedRow(appId, definition, { issueKey: "1", title: "Original" });

    const patched = await patchDefinition(appId, {
      models: {
        issue: {
          columns: {
            title: { kind: "string", source: { of: "gh", field: "headline", transform: "slug" } },
          },
        },
      },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.app.definition.models.issue.columns?.title).toEqual({
      kind: "string",
      source: { of: "gh", field: "headline", transform: "slug" },
    });

    const rows = await listRows(appId);
    expect(rows.body.rows[0]).toEqual({
      id: seeded.id,
      createdAt: seeded.createdAt,
      updatedAt: seeded.updatedAt,
      createdBy: "sync:gh",
      updatedBy: "sync:gh",
      issueKey: "1",
      title: "Original",
      source: "gh",
      syncedAt: "2026-08-06T10:00:00.000Z",
      stale: false,
    });
  });

  test("changing args, connection, scriptId and config is free", async () => {
    const definition = lifecycleDefinition();
    const appId = await createApp(definition);
    const seeded = await seedSyncedRow(appId, definition, { issueKey: "1", title: "Original" });

    const patched = await patchDefinition(appId, {
      models: {
        issue: {
          sources: {
            gh: {
              connector: "script",
              scriptId: ownedScriptId,
              joinKey: "issueKey",
              args: { repo: "other/name" },
              connection: "vendorApi",
            },
          },
        },
      },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.app.definition.models.issue.sources?.gh).toEqual({
      connector: "script",
      scriptId: ownedScriptId,
      joinKey: "issueKey",
      args: { repo: "other/name" },
      connection: "vendorApi",
    });
    // A free source edit leaves the synced row byte-identical.
    const rows = await listRows(appId);
    expect(rows.body.rows[0]).toMatchObject({
      title: "Original",
      source: "gh",
      syncedAt: "2026-08-06T10:00:00.000Z",
      stale: false,
      updatedAt: seeded.updatedAt,
    });

    const nativeDefinition = lifecycleDefinition({
      columns: { title: { kind: "string", source: { of: "pool", field: "status" } } },
      sources: { pool: { connector: "swarm-tasks", joinKey: "issueKey", config: { limit: 50 } } },
    });
    const nativeId = await createApp(nativeDefinition, "Native source app");
    await seedSyncedRow(nativeId, nativeDefinition, { issueKey: "1", title: "queued" }, "pool");
    const configPatched = await patchDefinition(nativeId, {
      models: {
        issue: {
          sources: {
            pool: {
              connector: "swarm-tasks",
              joinKey: "issueKey",
              config: { limit: 10, status: "queued" },
            },
          },
        },
      },
    });
    expect(configPatched.status).toBe(200);
    expect(configPatched.body.app.definition.models.issue.sources?.pool).toEqual({
      connector: "swarm-tasks",
      joinKey: "issueKey",
      config: { limit: 10, status: "queued" },
    });
  });

  test("changing joinKey is rejected as immutable even with zero rows", async () => {
    const appId = await createApp(lifecycleDefinition());
    const rejected = await patchDefinition(appId, {
      models: { issue: { sources: { gh: { ...ghSource(), joinKey: "note" } } } },
    });
    expect(rejected.status).toBe(400);
    expect(issueAt(rejected.body.issues ?? [], "models.issue.sources.gh.joinKey")?.message).toBe(
      "join key is immutable; remove the source and add it again",
    );
  });

  test("changing connector is rejected while the source owns rows, free when it owns none", async () => {
    const swarmTasksSource = {
      connector: "swarm-tasks",
      joinKey: "issueKey",
      config: { limit: 10 },
    };

    const emptyId = await createApp(lifecycleDefinition());
    const free = await patchDefinition(emptyId, {
      models: { issue: { sources: { gh: swarmTasksSource } } },
    });
    expect(free.status).toBe(200);
    expect(free.body.app.definition.models.issue.sources?.gh).toEqual(swarmTasksSource);

    const definition = lifecycleDefinition();
    const ownedId = await createApp(definition, "Owned rows app");
    await seedSyncedRow(ownedId, definition, { issueKey: "1", title: "a" });
    await seedSyncedRow(ownedId, definition, { issueKey: "2", title: "b" });
    // An operator-owned row carries no provenance and must not be counted.
    await request(`/api/apps/${ownedId}/models/issue/rows`, {
      method: "POST",
      body: JSON.stringify({ values: { note: "mine" } }),
    });

    const rejected = await patchDefinition(ownedId, {
      models: { issue: { sources: { gh: swarmTasksSource } } },
    });
    expect(rejected.status).toBe(400);
    expect(issueAt(rejected.body.issues ?? [], "models.issue.sources.gh.connector")?.message).toBe(
      "connector change would orphan 2 row(s) this source owns; remove the source and add it again",
    );
  });

  test("removing a source without dropping its binding is rejected before any detach", async () => {
    const definition = lifecycleDefinition();
    const appId = await createApp(definition);
    await seedSyncedRow(appId, definition, { issueKey: "1", title: "From GitHub" });

    // The bound `title` column stays — check 3 must fire before the migration
    // plan's detach ever becomes a write.
    const rejected = await patchDefinition(appId, {
      models: { issue: { sources: { gh: null } } },
    });
    expect(rejected.status).toBe(400);
    expect(
      issueAt(rejected.body.issues ?? [], "models.issue.columns.title.source.of")?.message,
    ).toBe('unknown source "gh"');

    const rows = await listRows(appId);
    expect(rows.body.rows[0]).toMatchObject({ source: "gh", stale: false });
  });

  test("removing a source detaches its rows, preserves values and reports the count", async () => {
    const definition = lifecycleDefinition();
    const appId = await createApp(definition);
    const first = await seedSyncedRow(appId, definition, {
      issueKey: "1",
      title: "From GitHub",
      note: "kept",
    });
    const second = await seedSyncedRow(appId, definition, { issueKey: "2", title: "Second" });
    const operatorRow = await request<{ row: AppRow }>(`/api/apps/${appId}/models/issue/rows`, {
      method: "POST",
      body: JSON.stringify({ values: { note: "mine" } }),
    });
    expect(operatorRow.status).toBe(201);

    const patched = await patchDefinition(appId, {
      models: {
        // The binding must go with the source — a dangling source.of is rejected.
        issue: { columns: { title: { kind: "string" } }, sources: { gh: null } },
      },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.migration.detachedRows).toBe(2);
    // A merge patch that deletes the last entry leaves the map behind, empty.
    expect(patched.body.app.definition.models.issue.sources).toEqual({});

    const rows = await listRows(appId);
    const [detachedFirst, detachedSecond, untouched] = rows.body.rows;
    expect(detachedFirst).toEqual({
      id: first.id,
      createdAt: first.createdAt,
      updatedAt: first.updatedAt,
      createdBy: "sync:gh",
      updatedBy: "sync:gh",
      issueKey: "1",
      title: "From GitHub",
      note: "kept",
    });
    expect(detachedSecond).toMatchObject({ id: second.id, issueKey: "2", title: "Second" });
    expect(detachedSecond?.source).toBeUndefined();
    expect(detachedSecond?.syncedAt).toBeUndefined();
    expect(detachedSecond?.stale).toBeUndefined();
    expect(untouched).toMatchObject({ id: operatorRow.body.row.id, note: "mine" });
  });

  test("removing a bound column still follows the hide-or-purge rules", async () => {
    const definition = lifecycleDefinition();
    const appId = await createApp(definition);
    await seedSyncedRow(appId, definition, { issueKey: "1", title: "From GitHub" });

    const rejected = await patchDefinition(appId, {
      models: { issue: { columns: { title: null } } },
    });
    expect(rejected.status).toBe(400);
    expect(issueAt(rejected.body.issues ?? [], "models.issue.columns.title")?.message).toBe(
      "column holds values on 1 row — hide it, or purge explicitly with migration.title.purge",
    );

    const purged = await patchDefinition(
      appId,
      { models: { issue: { columns: { title: null } } } },
      { title: { purge: true } },
    );
    expect(purged.status).toBe(200);
    expect(purged.body.migration.purgedValues).toBe(1);
    const rows = await listRows(appId);
    expect(rows.body.rows[0]?.title).toBeUndefined();
    // The source survives its last binding; detachment is a removal-only effect.
    expect(rows.body.rows[0]?.source).toBe("gh");
  });

  test("a rejected edit writes nothing — definition, rows and versions are untouched", async () => {
    const definition = lifecycleDefinition({ columns: { altKey: { kind: "string" } } });
    const appId = await createApp(definition);
    await seedSyncedRow(appId, definition, { issueKey: "1", title: "From GitHub" });
    await request(`/api/apps/${appId}/models/issue/rows`, {
      method: "POST",
      body: JSON.stringify({ values: { note: "mine" } }),
    });

    const definitionBefore = JSON.stringify((await request(`/api/apps/${appId}`)).body);
    const rowsBefore = JSON.stringify((await listRows(appId)).body);
    const versionsBefore = (await listVersions(appId)).body.versions.length;

    const rejected = await patchDefinition(appId, {
      models: {
        issue: {
          // Two rejections at once: an immutable join key and a populated binding.
          columns: { note: { kind: "string", source: { of: "gh", field: "body" } } },
          sources: { gh: { ...ghSource(), joinKey: "altKey" } },
        },
      },
    });
    expect(rejected.status).toBe(400);
    expect((rejected.body.issues ?? []).map((issue) => issue.path).sort()).toEqual([
      "models.issue.columns.note.source",
      "models.issue.sources.gh.joinKey",
    ]);

    expect(JSON.stringify((await request(`/api/apps/${appId}`)).body)).toBe(definitionBefore);
    expect(JSON.stringify((await listRows(appId)).body)).toBe(rowsBefore);
    expect((await listVersions(appId)).body.versions).toHaveLength(versionsBefore);
  });

  test("rollback across a source-adding version restores cleanly and detaches", async () => {
    const appId = await createApp(sourcelessDefinition());
    const added = await patchDefinition(appId, {
      models: {
        issue: {
          columns: { title: { kind: "string", source: { of: "gh", field: "title" } } },
          sources: { gh: ghSource() },
        },
      },
    });
    expect(added.status).toBe(200);
    const versions = await listVersions(appId);
    const sourcelessVersion = versions.body.versions.at(-1)?.version;
    expect(sourcelessVersion).toBeNumber();

    const seeded = await seedSyncedRow(appId, lifecycleDefinition(), {
      issueKey: "1",
      title: "From GitHub",
    });

    const rolledBack = await request<PatchBody>(`/api/apps/${appId}/rollback`, {
      method: "POST",
      body: JSON.stringify({ version: sourcelessVersion }),
    });
    expect(rolledBack.status).toBe(200);
    expect(rolledBack.body.migration.detachedRows).toBe(1);
    expect(rolledBack.body.app.definition.models.issue.sources).toBeUndefined();
    expect(rolledBack.body.app.definition.models.issue.columns?.title).toEqual({ kind: "string" });

    const rows = await listRows(appId);
    expect(rows.body.rows[0]).toEqual({
      id: seeded.id,
      createdAt: seeded.createdAt,
      updatedAt: seeded.updatedAt,
      createdBy: "sync:gh",
      updatedBy: "sync:gh",
      issueKey: "1",
      title: "From GitHub",
    });
  });
});
