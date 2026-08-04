import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { applyAppDefinitionPatch, parseAppDefinition } from "../apps/definition";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { handleApps } from "../http/apps";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { registerAppQueryTool } from "../tools/app-query";

const TEST_DB_PATH = "./test-apps-spike4.sqlite";
const AGENT_ID = crypto.randomUUID();
const nativeFetch = globalThis.fetch;

const rootElement = { type: "Container", props: {} };
const issueDefinition = {
  models: {
    issue: {
      columns: {
        issueId: { kind: "number" },
        title: { kind: "string" },
      },
    },
  },
  queries: { allIssues: { model: "issue" } },
  pages: { main: { root: "root", elements: { root: rootElement } } },
  defaultPage: "main",
};

function page(
  elements: Record<string, unknown> = { root: rootElement },
  params?: Record<string, unknown>,
) {
  return {
    root: "root",
    elements,
    ...(params ? { params } : {}),
  };
}

function pagesDefinition() {
  return {
    models: structuredClone(issueDefinition.models),
    queries: structuredClone(issueDefinition.queries),
    pages: {
      main: page(),
      detail: page({ root: rootElement }, { issueId: { kind: "number", required: true } }),
    },
    defaultPage: "main",
  };
}

function parseIssues(definition: unknown): Array<{ path: string; message: string }> {
  const result = parseAppDefinition(definition);
  expect(result.success).toBe(false);
  return result.success ? [] : result.issues;
}

function expectIssue(definition: unknown, path: string, message?: string): void {
  expect(parseIssues(definition)).toContainEqual({
    path,
    message: message === undefined ? expect.any(String) : message,
  });
}

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

type StructuredResult<T> = {
  isError?: boolean;
  structuredContent: T;
};

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

async function createApp(definition: unknown, name = "Spike 4"): Promise<string> {
  const result = await request<{ app: { id: string } }>("/api/apps", {
    method: "POST",
    body: JSON.stringify({ name, definition }),
  });
  expect(result.status).toBe(201);
  return result.body.app.id;
}

function registeredQueryTool(): RegisteredTool {
  const toolServer = new McpServer({ name: "apps-spike4-test", version: "1.0.0" });
  registerAppQueryTool(toolServer);
  return (toolServer as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools["app-query"]!;
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  createAgent({ id: AGENT_ID, name: "apps-spike4-worker", isLead: false, status: "idle" });
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

describe("Spike 4 definition normalization", () => {
  test("rejects legacy singular page definitions", () => {
    const legacy = {
      models: structuredClone(issueDefinition.models),
      queries: structuredClone(issueDefinition.queries),
      page: structuredClone(issueDefinition.pages.main),
    };
    expectIssue(
      legacy,
      "page",
      "legacy singular page is no longer supported — define pages plus defaultPage",
    );
  });

  test("requires pages and defaultPage", () => {
    expectIssue(
      { ...pagesDefinition(), page: structuredClone(issueDefinition.pages.main) },
      "page",
    );
    const neither = pagesDefinition() as Record<string, unknown>;
    delete neither.pages;
    delete neither.defaultPage;
    expectIssue(neither, "pages");
  });

  test("rejects reserved page param names", () => {
    for (const name of ["mode", "apiUrl", "apiKey", "email", "name"]) {
      const definition = pagesDefinition();
      definition.pages.main.params = { [name]: { kind: "string" } };
      expectIssue(definition, `pages.main.params.${name}`, "reserved param name");
    }
  });

  test("requires valid page and param names and an exact single-key $param filter", () => {
    const badPage = pagesDefinition() as any;
    badPage.pages.BadPage = badPage.pages.main;
    delete badPage.pages.main;
    badPage.defaultPage = "BadPage";
    expectIssue(badPage, "pages.BadPage");

    const badParam = pagesDefinition() as any;
    badParam.pages.main.params = { BadParam: {} };
    expectIssue(badParam, "pages.main.params.BadParam");

    const badFilter = pagesDefinition() as any;
    badFilter.queries.allIssues.filter = {
      issueId: { $param: "issueId", extra: true },
    };
    expectIssue(badFilter, "queries.allIssues.filter.issueId");
  });

  test("rejects unknown page and page-param keys instead of stripping them", () => {
    const badPage = pagesDefinition() as any;
    badPage.pages.main.typo = true;
    expectIssue(badPage, "pages.main");

    const badParam = pagesDefinition() as any;
    badParam.pages.detail.params.issueId.requird = true;
    expectIssue(badParam, "pages.detail.params.issueId");
  });
});

describe("Spike 4 page validation", () => {
  test("prefixes tree issues per page and keeps route refs page-local", () => {
    const definition = pagesDefinition();
    definition.pages.detail.root = "missing";
    expectIssue(definition, "pages.detail.root");

    const valid = pagesDefinition();
    valid.pages.detail.elements = {
      root: {
        type: "Stack",
        props: {},
        children: ["pageName", "routeParam"],
      },
      pageName: { type: "Text", props: { content: { $state: "/route/page" } } },
      routeParam: {
        type: "Text",
        props: { content: { $state: "/route/params/issueId" } },
      },
    };
    expect(parseAppDefinition(valid).success).toBe(true);

    const invalid = structuredClone(valid);
    invalid.pages.main.elements.root = {
      type: "Text",
      props: { content: { $state: "/route/params/issueId" } },
    };
    expectIssue(invalid, "pages.main.elements.root.props.content");
  });

  test("keeps form and UI ids page-local", () => {
    const definition = pagesDefinition();
    definition.pages.main.elements = {
      root: { type: "Stack", props: {}, children: ["formRef", "uiRef"] },
      formRef: {
        type: "Text",
        props: { content: { $state: "/forms/detailForm/values/title" } },
      },
      uiRef: {
        type: "Text",
        props: { content: { $state: "/ui/detailSearch/value" } },
      },
    };
    definition.pages.detail.elements = {
      root: { type: "Stack", props: {}, children: ["form", "search"] },
      form: {
        type: "Form",
        props: {
          id: "detailForm",
          fields: [{ name: "title", label: "Title" }],
          onSubmit: [],
        },
      },
      search: { type: "SearchInput", props: { id: "detailSearch" } },
    };

    const issues = parseIssues(definition);
    expect(issues).toContainEqual(
      expect.objectContaining({ path: "pages.main.elements.formRef.props.content" }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ path: "pages.main.elements.uiRef.props.content" }),
    );
  });

  test("captures state refs in comparison objects and nested logical conditions", () => {
    const definition = pagesDefinition();
    definition.pages.main.elements.root = {
      type: "Container",
      props: {},
      visible: {
        $and: [
          { $state: "/queries/allIssues/data", eq: true, neq: false },
          { $or: [{ $state: "/queries/typo/data", gt: 0 }] },
        ],
      },
    };
    expectIssue(definition, "pages.main.elements.root.visible.$and.1.$or.0");
  });

  test("rejects visible shapes the renderer silently ignores", () => {
    const wrapperNot = pagesDefinition() as any;
    wrapperNot.pages.main.elements.root = {
      ...rootElement,
      visible: { not: { $state: "/queries/allIssues/data/0/id" } },
    };
    expectIssue(wrapperNot, "pages.main.elements.root.visible");

    const multiComparison = pagesDefinition() as any;
    multiComparison.pages.main.elements.root = {
      ...rootElement,
      visible: { $state: "/queries/allIssues/loading", eq: true, neq: false },
    };
    expectIssue(multiComparison, "pages.main.elements.root.visible");

    const nonBooleanNot = pagesDefinition() as any;
    nonBooleanNot.pages.main.elements.root = {
      ...rootElement,
      visible: { $state: "/queries/allIssues/loading", not: "yes" },
    };
    expectIssue(nonBooleanNot, "pages.main.elements.root.visible.not");

    const negationFlag = pagesDefinition() as any;
    negationFlag.pages.main.elements.root = {
      ...rootElement,
      visible: {
        $and: [
          { $state: "/queries/allIssues/data/0/id", not: true },
          { $state: "/queries/allIssues/loading", eq: false },
        ],
      },
    };
    expect(parseAppDefinition(negationFlag).success).toBe(true);
  });

  test("validates app.navigate targets, supplied params, and required params", () => {
    const definition = pagesDefinition();
    definition.pages.main.elements.root = {
      type: "Table",
      props: {
        columns: [{ key: "title" }],
        rowActions: [
          {
            label: "Open",
            actions: [
              {
                action: "app.navigate",
                params: { page: "detail", params: { issueId: { $row: "issueId" } } },
              },
            ],
          },
        ],
      },
    };
    expect(parseAppDefinition(definition).success).toBe(true);

    const action = (candidate: ReturnType<typeof pagesDefinition>) =>
      (candidate.pages.main.elements.root as any).props.rowActions[0].actions[0].params;

    const unknown = structuredClone(definition);
    action(unknown).page = "missing";
    expectIssue(unknown, "pages.main.elements.root.props.rowActions.0.actions.0.params.page");

    const inherited = structuredClone(definition);
    action(inherited).page = "toString";
    expectIssue(inherited, "pages.main.elements.root.props.rowActions.0.actions.0.params.page");

    const undeclared = structuredClone(definition);
    action(undeclared).params.extra = "x";
    expectIssue(
      undeclared,
      "pages.main.elements.root.props.rowActions.0.actions.0.params.params.extra",
    );

    const missing = structuredClone(definition);
    delete action(missing).params.issueId;
    expectIssue(
      missing,
      "pages.main.elements.root.props.rowActions.0.actions.0.params.params.issueId",
    );
  });

  test("requires referenced query params and Drawer params on the containing page", () => {
    const definition = pagesDefinition();
    definition.queries.issueDetail = {
      model: "issue",
      filter: { issueId: { $param: "issueId" } },
    } as any;
    definition.pages.main.elements.root = {
      type: "Drawer",
      props: { param: "panel" },
      children: ["detail"],
    };
    definition.pages.main.elements.detail = {
      type: "DetailList",
      props: {
        data: { $state: "/queries/issueDetail/data/0" },
        fields: [{ key: "title" }],
      },
    };
    const issues = parseIssues(definition);
    expect(issues).toContainEqual(
      expect.objectContaining({ path: "pages.main.elements.root.props.param" }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ path: "pages.main.elements.detail.props.data" }),
    );
  });

  test("requires Drawer param to be a literal string", () => {
    const definition = pagesDefinition();
    definition.pages.main.params = { panel: { kind: "string" } };
    definition.pages.main.elements.root = {
      type: "Drawer",
      props: { param: { $state: "/route/params/panel" } },
    };
    expectIssue(
      definition,
      "pages.main.elements.root.props.param",
      "Drawer param must be a literal route param name (not a binding)",
    );
  });
});

describe("Spike 4 definition merge patches", () => {
  test("rejects legacy page patches with canonical guidance", () => {
    const parsed = parseAppDefinition(issueDefinition);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.issues));
    expect(applyAppDefinitionPatch(parsed.definition, { page: { root: "other" } })).toEqual({
      success: false,
      issues: [
        {
          path: "page",
          message: "definitions are normalized to the pages map — patch pages.<name> instead",
        },
      ],
    });
  });

  test("treats page elements and param declarations as atomic entries", () => {
    const definition = pagesDefinition();
    definition.pages.main.elements.root = {
      type: "Stack",
      props: { gap: "md" },
      children: ["child"],
    };
    definition.pages.main.elements.child = { type: "Text", props: { content: "old" } };
    definition.pages.main.params = { panel: { kind: "string", required: false } };

    const result = applyAppDefinitionPatch(definition as any, {
      pages: {
        main: {
          elements: { root: { type: "Heading", props: { text: "New" } } },
          params: { panel: { required: true } },
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const patched = result.definition as any;
    expect(patched.pages.main.elements.root).toEqual({
      type: "Heading",
      props: { text: "New" },
    });
    expect(patched.pages.main.elements.child).toEqual({
      type: "Text",
      props: { content: "old" },
    });
    expect(patched.pages.main.params.panel).toEqual({ required: true });
  });

  test("null-deletes a non-default page but rejects deleting the default page", () => {
    const definition = pagesDefinition();
    const deleted = applyAppDefinitionPatch(definition as any, { pages: { detail: null } });
    expect(deleted.success).toBe(true);
    if (deleted.success) expect((deleted.definition as any).pages).not.toHaveProperty("detail");

    expect(applyAppDefinitionPatch(definition as any, { pages: { main: null } })).toEqual({
      success: false,
      issues: [{ path: "pages.main", message: "cannot delete the default page" }],
    });
  });
});

describe("Spike 4 parameterized named queries", () => {
  const queryDefinition = {
    models: {
      record: {
        columns: {
          quantity: { kind: "number" },
          active: { kind: "boolean" },
          happenedAt: { kind: "date" },
          slug: { kind: "string" },
        },
      },
    },
    queries: {
      byParams: {
        model: "record",
        filter: {
          quantity: { $param: "quantity" },
          active: { $param: "active" },
          happenedAt: { $param: "happenedAt" },
          slug: { $param: "slug" },
        },
      },
    },
    pages: { main: page() },
    defaultPage: "main",
  };

  async function createParameterizedApp(): Promise<string> {
    const appId = await createApp(queryDefinition, "Parameterized query");
    const created = await request(`/api/apps/${appId}/models/record/rows`, {
      method: "POST",
      body: JSON.stringify({
        values: {
          quantity: 42,
          active: true,
          happenedAt: "2026-08-03T10:00:00.000Z",
          slug: "matched",
        },
      }),
    });
    expect(created.status).toBe(201);
    return appId;
  }

  test("passes HTTP param.<name> values and coerces them by target column kind", async () => {
    const appId = await createParameterizedApp();
    const params = new URLSearchParams({
      "param.quantity": "42",
      "param.active": "true",
      "param.happenedAt": "2026-08-03T10:00:00.000Z",
      "param.slug": "matched",
    });
    const result = await request<{ rows: Array<Record<string, unknown>> }>(
      `/api/apps/${appId}/queries/byParams?${params}`,
    );
    expect(result.status).toBe(200);
    expect(result.body.rows).toEqual([
      expect.objectContaining({ quantity: 42, active: true, slug: "matched" }),
    ]);
  });

  test("filters on system columns — a $param on id selects one row", async () => {
    const appId = await createApp(
      {
        models: { record: { columns: { slug: { kind: "string" } } } },
        queries: {
          detail: { model: "record", filter: { id: { $param: "recordId" } }, limit: 1 },
        },
        pages: { main: page() },
        defaultPage: "main",
      },
      "System column filter",
    );
    const first = await request<{ row: { id: string } }>(`/api/apps/${appId}/models/record/rows`, {
      method: "POST",
      body: JSON.stringify({ values: { slug: "one" } }),
    });
    expect(first.status).toBe(201);
    const second = await request(`/api/apps/${appId}/models/record/rows`, {
      method: "POST",
      body: JSON.stringify({ values: { slug: "two" } }),
    });
    expect(second.status).toBe(201);

    const result = await request<{ rows: Array<Record<string, unknown>> }>(
      `/api/apps/${appId}/queries/detail?param.recordId=${first.body.row.id}`,
    );
    expect(result.status).toBe(200);
    expect(result.body.rows).toEqual([
      expect.objectContaining({ id: first.body.row.id, slug: "one" }),
    ]);
  });

  test("stamps row provenance from the acting principal and filters on it", async () => {
    const appId = await createApp(
      {
        models: { record: { columns: { slug: { kind: "string" } } } },
        queries: { mine: { model: "record", filter: { createdBy: { $param: "actorId" } } } },
        pages: { main: page() },
        defaultPage: "main",
      },
      "Provenance",
    );
    const actor = `agent:${AGENT_ID}`;

    const created = await request<{ row: Record<string, unknown> }>(
      `/api/apps/${appId}/models/record/rows`,
      { method: "POST", body: JSON.stringify({ values: { slug: "one" } }) },
    );
    expect(created.status).toBe(201);
    expect(created.body.row.createdBy).toBe(actor);
    expect(created.body.row.updatedBy).toBe(actor);

    const patched = await request<{ row: Record<string, unknown> }>(
      `/api/apps/${appId}/models/record/rows/${created.body.row.id}`,
      { method: "PATCH", body: JSON.stringify({ values: { slug: "two" } }) },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.row.createdBy).toBe(actor);
    expect(patched.body.row.updatedBy).toBe(actor);

    const params = new URLSearchParams({ "param.actorId": actor });
    const rows = await request<{ rows: Array<Record<string, unknown>> }>(
      `/api/apps/${appId}/queries/mine?${params}`,
    );
    expect(rows.status).toBe(200);
    expect(rows.body.rows).toEqual([expect.objectContaining({ slug: "two", createdBy: actor })]);

    expectIssue(
      {
        models: { record: { columns: { createdBy: { kind: "string" } } } },
        pages: { main: page() },
        defaultPage: "main",
      },
      "models.record.columns.createdBy",
      "reserved column name",
    );
  });

  test("returns a structured 400 listing every missing query param", async () => {
    const appId = await createParameterizedApp();
    const result = await request<{
      error: string;
      missingParams: string[];
      issues: Array<{ path: string; message: string }>;
    }>(`/api/apps/${appId}/queries/byParams`);
    expect(result.status).toBe(400);
    expect(result.body.error).toBe(
      "missing query parameter(s): active, happenedAt, quantity, slug",
    );
    expect(result.body.missingParams).toEqual(["active", "happenedAt", "quantity", "slug"]);
    expect(result.body.issues).toContainEqual({
      path: "param.quantity",
      message: "is required by a named query filter",
    });
  });

  test("rejects non-coercible and unreferenced HTTP params", async () => {
    const appId = await createParameterizedApp();
    const validParams = {
      "param.active": "true",
      "param.happenedAt": "2026-08-03T10:00:00.000Z",
      "param.slug": "matched",
    };

    const invalidValue = await request<{
      issues: Array<{ path: string; message: string }>;
    }>(
      `/api/apps/${appId}/queries/byParams?${new URLSearchParams({
        ...validParams,
        "param.quantity": "abc",
      })}`,
    );
    expect(invalidValue.status).toBe(400);
    expect(invalidValue.body.issues).toContainEqual(
      expect.objectContaining({ path: "param.quantity" }),
    );

    const unknown = await request<{
      issues: Array<{ path: string; message: string }>;
    }>(
      `/api/apps/${appId}/queries/byParams?${new URLSearchParams({
        ...validParams,
        "param.quantity": "42",
        "param.extra": "ignored-before-f12",
      })}`,
    );
    expect(unknown.status).toBe(400);
    expect(unknown.body.issues).toContainEqual({
      path: "param.extra",
      message: 'not a declared $param of query "byParams"',
    });
  });

  test("accepts params in app-query and returns toolErr for missing names", async () => {
    const appId = await createParameterizedApp();
    const tool = registeredQueryTool();
    const called = (await tool.handler(
      {
        appId,
        query: "byParams",
        params: {
          quantity: "42",
          active: "true",
          happenedAt: "2026-08-03T10:00:00.000Z",
          slug: "matched",
        },
      },
      { sessionId: "apps-spike4", requestInfo: { headers: { "x-agent-id": AGENT_ID } } },
    )) as StructuredResult<{ count: number; rows: Array<Record<string, unknown>> }>;
    expect(called.isError).not.toBe(true);
    expect(called.structuredContent.count).toBe(1);

    const missing = (await tool.handler(
      { appId, query: "byParams", params: { quantity: 42 } },
      { sessionId: "apps-spike4", requestInfo: { headers: { "x-agent-id": AGENT_ID } } },
    )) as StructuredResult<{ missingParams: string[]; issues: Array<{ path: string }> }>;
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent.missingParams).toEqual(["active", "happenedAt", "slug"]);
    expect(missing.structuredContent.issues).toContainEqual(
      expect.objectContaining({ path: "param.active" }),
    );
  });

  test("returns app-query toolErr for non-coercible and unreferenced params", async () => {
    const appId = await createParameterizedApp();
    const tool = registeredQueryTool();
    const validParams = {
      active: "true",
      happenedAt: "2026-08-03T10:00:00.000Z",
      slug: "matched",
    };

    const invalidValue = (await tool.handler(
      { appId, query: "byParams", params: { ...validParams, quantity: "abc" } },
      {
        sessionId: "apps-spike4-invalid",
        requestInfo: { headers: { "x-agent-id": AGENT_ID } },
      },
    )) as StructuredResult<{ issues: Array<{ path: string }> }>;
    expect(invalidValue.isError).toBe(true);
    expect(invalidValue.structuredContent.issues).toContainEqual(
      expect.objectContaining({ path: "param.quantity" }),
    );

    const unknown = (await tool.handler(
      {
        appId,
        query: "byParams",
        params: { ...validParams, quantity: "42", extra: "ignored-before-f12" },
      },
      {
        sessionId: "apps-spike4-unknown",
        requestInfo: { headers: { "x-agent-id": AGENT_ID } },
      },
    )) as StructuredResult<{ issues: Array<{ path: string; message: string }> }>;
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent.issues).toContainEqual({
      path: "param.extra",
      message: 'not a declared $param of query "byParams"',
    });
  });
});
