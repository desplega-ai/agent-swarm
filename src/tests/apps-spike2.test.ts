import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
import { createAppRow } from "../apps/row-store";
import { getApp } from "../apps/store";
import { closeDb, createAgent, getDb, initDb, upsertKv } from "../be/db";
import { deleteScript, upsertScriptByName } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { handleApps } from "../http/apps";
import { handleKv } from "../http/kv";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { registerAppGetTool } from "../tools/app-get";
import { registerAppListTool } from "../tools/app-list";
import { registerAppPatchTool } from "../tools/app-patch";
import {
  registerKvDeleteTool,
  registerKvGetTool,
  registerKvIncrTool,
  registerKvListTool,
  registerKvSetTool,
} from "../tools/kv";

const TEST_DB_PATH = "./test-apps-spike2.sqlite";
const AGENT_ID = crypto.randomUUID();
const LEAD_ID = crypto.randomUUID();
const bookmarksDefinition = await Bun.file(
  new URL("./fixtures/bookmarks-definition.json.txt", import.meta.url),
).json();

const noOpEmbeddingProvider = {
  name: "test/noop-app-action-embedding",
  dimensions: 1,
  async embed() {
    return null;
  },
  async embedBatch(texts: string[]) {
    return texts.map(() => null);
  },
};

const baseDefinition = {
  models: {
    idea: {
      columns: {
        title: { kind: "string", required: true },
        status: { kind: "enum", enum: ["open", "done"], default: "open" },
      },
    },
  },
  queries: {
    allIdeas: { model: "idea", sort: { column: "createdAt", dir: "desc" } },
  },
  page: {
    root: "root",
    elements: {
      root: {
        type: "Container",
        props: { direction: "column", gap: "md" },
        children: ["title"],
      },
      title: { type: "Heading", props: { text: "Ideas", level: "h1" } },
    },
  },
};

function normalizedBaseDefinition() {
  const parsed = parseAppDefinition(baseDefinition);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.issues));
  return parsed.definition;
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
    if (await handleKv(req, res, pathSegments, queryParams)) return;
    if (await handleTasks(req, res, pathSegments, queryParams, myAgentId)) return;
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

async function createApp(
  definition: unknown = baseDefinition,
  description = "Initial",
): Promise<string> {
  const result = await request<{ app: { id: string } }>("/api/apps", {
    method: "POST",
    body: JSON.stringify({ name: "Ideas", description, definition }),
  });
  expect(result.status).toBe(201);
  return result.body.app.id;
}

function toolMeta(agentId = AGENT_ID) {
  return {
    sessionId: "apps-spike2",
    requestInfo: { headers: { "x-agent-id": agentId } },
  };
}

function registeredTools(
  registrations: Array<(server: McpServer) => void>,
): Record<string, RegisteredTool> {
  const toolServer = new McpServer({ name: "apps-spike2-test", version: "1.0.0" });
  for (const register of registrations) register(toolServer);
  return (toolServer as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
}

function expectIssue(definition: unknown, expectedPath: string): void {
  const parsed = parseAppDefinition(definition);
  expect(parsed.success).toBe(false);
  if (parsed.success) return;
  expect(parsed.issues.some((issue) => issue.path.includes(expectedPath))).toBe(true);
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  setScriptEmbeddingProviderForTests(noOpEmbeddingProvider);
  createAgent({ id: AGENT_ID, name: "apps-spike2-worker", isLead: false, status: "idle" });
  createAgent({ id: LEAD_ID, name: "apps-spike2-lead", isLead: true, status: "idle" });
  server = createTestServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a port");
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  getDb().run("DELETE FROM kv_entries WHERE namespace LIKE 'apps%'");
  getDb().run("DELETE FROM agent_tasks");
  getDb().run("DELETE FROM apps");
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setScriptEmbeddingProviderForTests(null);
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

describe("app definition patches", () => {
  test("does not alias stored or patch values and rejects unsafe keys", () => {
    const stored = structuredClone(normalizedBaseDefinition());
    const patch = {
      pages: {
        main: {
          elements: {
            title: { type: "Heading", props: { text: "Patched" } },
          },
        },
      },
    };
    const result = applyAppDefinitionPatch(stored, patch);
    expect(result.success).toBe(true);
    if (result.success) {
      const storedTitle = stored.pages.main.elements.title as { props: { text: string } };
      storedTitle.props.text = "Stored changed";
      patch.pages.main.elements.title.props.text = "Patch changed";
      const resultTitle = result.definition.pages.main.elements.title as {
        props: { text: string };
      };
      expect(resultTitle.props.text).toBe("Patched");
      expect(result.definition.defaultPage).toBe("main");
      expect(result.definition).not.toHaveProperty("page");
    }

    const unsafe = applyAppDefinitionPatch(
      normalizedBaseDefinition(),
      JSON.parse(
        '{"pages":{"main":{"elements":{"__proto__":{"type":"Heading","props":{"text":"Nope"}}}}}}',
      ),
    );
    expect(unsafe.success).toBe(false);
    if (!unsafe.success) {
      expect(unsafe.issues).toContainEqual({
        path: "pages.main.elements.__proto__",
        message: 'unsafe merge patch key "__proto__" is not allowed',
      });
    }
  });

  test("applies scalar, recursive, delete, and atomic-subtree semantics", async () => {
    const appId = await createApp({
      ...baseDefinition,
      actions: {
        notify: { kind: "task", prompt: "Old prompt", agentId: AGENT_ID },
      },
    });

    const scalar = await request<{ app: { name: string; description?: string } }>(
      `/api/apps/${appId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ name: "Renamed", description: null }),
      },
    );
    expect(scalar.status).toBe(200);
    expect(scalar.body.app.name).toBe("Renamed");
    expect(scalar.body.app).not.toHaveProperty("description");

    const merge = await request<{ app: { definition: typeof baseDefinition } }>(
      `/api/apps/${appId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          definition: {
            models: { idea: { columns: { rating: { kind: "number" } } } },
            queries: { allIdeas: null },
          },
        }),
      },
    );
    expect(merge.status).toBe(200);
    expect(merge.body.app.definition.models.idea.columns).toMatchObject({
      title: { kind: "string" },
      rating: { kind: "number" },
    });
    expect(merge.body.app.definition.queries).not.toHaveProperty("allIdeas");
    expect(merge.body.app.definition).toMatchObject({
      pages: { main: baseDefinition.page },
      defaultPage: "main",
    });
    expect(merge.body.app.definition).not.toHaveProperty("page");

    const replace = await request<{
      app: {
        definition: {
          pages: { main: { elements: Record<string, unknown> } };
          defaultPage: string;
          actions: Record<string, unknown>;
        };
      };
    }>(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: {
          pages: {
            main: {
              elements: {
                title: { type: "Heading", props: { text: "Changed" } },
              },
            },
          },
          actions: { notify: { kind: "task", prompt: "New prompt" } },
        },
      }),
    });
    expect(replace.status).toBe(200);
    expect(replace.body.app.definition.pages.main.elements.title).toEqual({
      type: "Heading",
      props: { text: "Changed" },
    });
    expect(replace.body.app.definition.defaultPage).toBe("main");
    expect(replace.body.app.definition).not.toHaveProperty("page");
    expect(replace.body.app.definition.actions.notify).toEqual({
      kind: "task",
      prompt: "New prompt",
    });

    const removeElement = await request<{
      app: { definition: { pages: { main: { elements: Record<string, unknown> } } } };
    }>(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: {
          pages: {
            main: {
              elements: {
                root: { type: "Container", props: { direction: "column" } },
                title: null,
              },
            },
          },
        },
      }),
    });
    expect(removeElement.status).toBe(200);
    expect(removeElement.body.app.definition.pages.main.elements).not.toHaveProperty("title");
  });

  test("rejects an invalid patched result without writing", async () => {
    const appId = await createApp();
    const before = getApp(appId)!;
    const result = await request<{ error: string; issues: Array<{ path: string }> }>(
      `/api/apps/${appId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ definition: { pages: { main: { root: "missing" } } } }),
      },
    );
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid app definition");
    expect(result.body.issues.some((issue) => issue.path.startsWith("pages.main."))).toBe(true);
    expect(getApp(appId)).toEqual(before);
  });
});

describe("server page validation", () => {
  test("accepts the committed APP_SEED page verbatim", () => {
    expect(parseAppDefinition(appSeed).success).toBe(true);
  });

  test("accepts the real Bookmarks definition with Table aliases", () => {
    expect(parseAppDefinition(bookmarksDefinition).success).toBe(true);
  });

  test("accepts layout components and Table UI search and filters", () => {
    expect(
      parseAppDefinition({
        ...baseDefinition,
        page: {
          root: "root",
          elements: {
            root: {
              type: "Stack",
              props: { gap: "lg", padding: "md" },
              children: ["split"],
            },
            split: {
              type: "Split",
              props: { ratio: "1-2" },
              children: ["filters", "tabs"],
            },
            filters: {
              type: "Stack",
              props: { gap: "sm" },
              children: ["search", "statusFilter"],
            },
            search: { type: "SearchInput", props: { id: "ideaSearch", label: "Search" } },
            statusFilter: {
              type: "Select",
              props: { id: "status", options: ["open", "done"], label: "Status" },
            },
            tabs: {
              type: "Tabs",
              props: { id: "view", tabs: [{ key: "ideas" }, { key: "about" }] },
              children: ["table", "about"],
            },
            table: {
              type: "Table",
              props: {
                data: { $state: "/queries/allIdeas/data" },
                columns: [{ key: "title" }, { key: "status" }],
                search: { $state: "/ui/ideaSearch/value" },
                filters: { status: { $state: "/ui/status/value" } },
              },
            },
            about: { type: "Markdown", props: { content: "## About ideas" } },
          },
        },
      }).success,
    ).toBe(true);
  });

  test("validates UI control state roots", () => {
    const unknown = parseAppDefinition({
      ...baseDefinition,
      page: {
        root: "root",
        elements: {
          root: {
            type: "Table",
            props: {
              columns: [{ key: "title" }],
              search: { $state: "/ui/unknownId/value" },
            },
          },
        },
      },
    });
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.issues).toContainEqual({
        path: "pages.main.elements.root.props.search",
        message: 'state reference targets unknown UI control "unknownId"',
      });
    }

    const formIdIsNotUi = parseAppDefinition({
      ...baseDefinition,
      page: {
        root: "root",
        elements: {
          root: { type: "Stack", props: {}, children: ["form", "table"] },
          form: { type: "Form", props: { id: "formOnly", fields: [], onSubmit: [] } },
          table: {
            type: "Table",
            props: {
              columns: [{ key: "title" }],
              search: { $state: "/ui/formOnly/value" },
            },
          },
        },
      },
    });
    expect(formIdIsNotUi.success).toBe(false);
    if (!formIdIsNotUi.success) {
      expect(formIdIsNotUi.issues).toContainEqual({
        path: "pages.main.elements.table.props.search",
        message: 'state reference targets unknown UI control "formOnly"',
      });
    }

    expect(
      parseAppDefinition({
        ...baseDefinition,
        page: {
          root: "root",
          elements: {
            root: { type: "Stack", props: {}, children: ["tabs", "selectedTab"] },
            tabs: {
              type: "Tabs",
              props: { id: "view", tabs: [{ key: "all" }] },
              children: ["tabContent"],
            },
            tabContent: { type: "Text", props: { content: "All ideas" } },
            selectedTab: { type: "Text", props: { content: { $state: "/ui/view/tab" } } },
          },
        },
      }).success,
    ).toBe(true);
  });

  test("accepts omitted optional props and a single element action binding", () => {
    expect(
      parseAppDefinition({
        ...baseDefinition,
        page: {
          root: "root",
          elements: {
            root: { type: "Container", children: ["button"] },
            button: {
              type: "Button",
              props: { label: "Refresh" },
              on: { press: { action: "app.refresh", params: {} } },
            },
          },
        },
      }).success,
    ).toBe(true);
  });

  test("reports missing required props without an object-type error", () => {
    const parsed = parseAppDefinition({
      ...baseDefinition,
      page: { root: "root", elements: { root: { type: "Heading" } } },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toContainEqual({
        path: "pages.main.elements.root.props.text",
        message: "is required",
      });
      expect(parsed.issues.some((item) => item.path === "pages.main.elements.root.props")).toBe(
        false,
      );
    }
  });

  test("reports action-chain mistakes once", () => {
    const cases = [
      {
        path: "pages.main.elements.root.props.onSubmit.0.action",
        element: {
          type: "Form",
          props: {
            id: "newIdea",
            fields: [{ name: "title" }],
            onSubmit: [{ action: "missing.action", params: {} }],
          },
        },
      },
      {
        path: "pages.main.elements.root.props.rowActions.0.actions.0.action",
        element: {
          type: "Table",
          props: {
            columns: [{ key: "title" }],
            rowActions: [{ label: "Break", actions: [{ action: "missing.action", params: {} }] }],
          },
        },
      },
    ];

    for (const testCase of cases) {
      const parsed = parseAppDefinition({
        ...baseDefinition,
        page: { root: "root", elements: { root: testCase.element } },
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.issues.filter((item) => item.path === testCase.path)).toHaveLength(1);
      }
    }
  });

  test("validates action script references and task agent UUIDs at write time", () => {
    expectIssue(
      {
        ...baseDefinition,
        actions: {
          broken: { kind: "script", scriptId: crypto.randomUUID() },
        },
      },
      "actions.broken.scriptId",
    );
    expectIssue(
      {
        ...baseDefinition,
        actions: {
          assign: { kind: "task", prompt: "Do it", agentId: "not-a-uuid" },
        },
      },
      "actions.assign.agentId",
    );
  });

  test("reports every required structural, binding, and action-chain rejection class", () => {
    const cases: Array<{ path: string; definition: unknown }> = [
      {
        path: "pages.main.elements.root.extra",
        definition: {
          ...baseDefinition,
          page: {
            root: "root",
            elements: { root: { type: "Container", props: {}, extra: true } },
          },
        },
      },
      {
        path: "pages.main.elements.root.children",
        definition: {
          ...baseDefinition,
          page: {
            root: "root",
            elements: {
              root: { type: "Heading", props: { text: "No slot" }, children: ["child"] },
              child: { type: "Text", props: { content: "Child" } },
            },
          },
        },
      },
      {
        path: "pages.main.elements.right.children.0",
        definition: {
          ...baseDefinition,
          page: {
            root: "root",
            elements: {
              root: { type: "Container", props: {}, children: ["left", "right"] },
              left: { type: "Card", props: {}, children: ["shared"] },
              right: { type: "Card", props: {}, children: ["shared"] },
              shared: { type: "Text", props: { content: "Shared" } },
            },
          },
        },
      },
      {
        path: "pages.main.elements.orphan",
        definition: {
          ...baseDefinition,
          page: {
            root: "root",
            elements: {
              root: { type: "Container", props: {} },
              orphan: { type: "Text", props: { content: "orphan" } },
            },
          },
        },
      },
      {
        path: "pages.main.elements.root.children.0",
        definition: {
          ...baseDefinition,
          page: {
            root: "root",
            elements: {
              root: { type: "Container", props: {}, children: ["missing"] },
            },
          },
        },
      },
      {
        path: "pages.main.elements.card.children.0",
        definition: {
          ...baseDefinition,
          page: {
            root: "root",
            elements: {
              root: { type: "Container", props: {}, children: ["card"] },
              card: { type: "Card", props: {}, children: ["root"] },
            },
          },
        },
      },
      {
        path: "pages.main.elements.root.type",
        definition: {
          ...baseDefinition,
          page: { root: "root", elements: { root: { type: "Unknown", props: {} } } },
        },
      },
      {
        path: "pages.main.elements.root.props.direction",
        definition: {
          ...baseDefinition,
          page: {
            root: "root",
            elements: { root: { type: "Container", props: { direction: "diagonal" } } },
          },
        },
      },
      {
        path: "pages.main.elements.root.props.content",
        definition: {
          ...baseDefinition,
          page: {
            root: "root",
            elements: {
              root: { type: "Text", props: { content: { $state: "/queries/missing/data" } } },
            },
          },
        },
      },
      {
        path: "pages.main.elements.root.visible",
        definition: {
          ...baseDefinition,
          page: {
            root: "root",
            elements: {
              root: {
                type: "Container",
                props: {},
                visible: { $state: "/queries/missing/data" },
              },
            },
          },
        },
      },
      {
        path: "pages.main.elements.root.on.press.0.params.values",
        definition: {
          ...baseDefinition,
          page: {
            root: "root",
            elements: {
              root: {
                type: "Button",
                props: { label: "Create" },
                on: {
                  press: [
                    {
                      action: "app.mutate",
                      params: {
                        model: "idea",
                        op: "create",
                        values: { title: { $state: "/forms/missing/title" } },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
      {
        path: "pages.main.elements.root.on.press.0.params.model",
        definition: {
          ...baseDefinition,
          page: {
            root: "root",
            elements: {
              root: {
                type: "Button",
                props: { label: "Create" },
                on: {
                  press: [{ action: "app.mutate", params: { model: "missing", op: "create" } }],
                },
              },
            },
          },
        },
      },
      {
        path: "pages.main.elements.root.on.press.0.params.rowId",
        definition: {
          ...baseDefinition,
          page: {
            root: "root",
            elements: {
              root: {
                type: "Button",
                props: { label: "Update" },
                on: {
                  press: [{ action: "app.mutate", params: { model: "idea", op: "update" } }],
                },
              },
            },
          },
        },
      },
      {
        path: "pages.main.elements.root.on.press.0.action",
        definition: {
          ...baseDefinition,
          page: {
            root: "root",
            elements: {
              root: {
                type: "Button",
                props: { label: "Mystery" },
                on: { press: [{ action: "missing.action", params: {} }] },
              },
            },
          },
        },
      },
      {
        path: "pages.main.elements.root.on.press.0.params.name",
        definition: {
          ...baseDefinition,
          page: {
            root: "root",
            elements: {
              root: {
                type: "Button",
                props: { label: "Run" },
                on: { press: [{ action: "app.action", params: { name: "missing" } }] },
              },
            },
          },
        },
      },
    ];

    for (const item of cases) expectIssue(item.definition, item.path);
  });
});

describe("reserved apps KV namespace", () => {
  test("blocks generic HTTP and MCP writes, keeps reads open, and leaves row-store working", async () => {
    const appId = await createApp();
    const namespace = `apps:${appId}`;
    for (const [method, suffix, body] of [
      ["PUT", "key", { value: "x" }],
      ["DELETE", "key", undefined],
      ["POST", "key/incr", { by: 1 }],
    ] as const) {
      const result = await request<{ error: string }>(`/api/kv/_/${namespace}/${suffix}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(result.status).toBe(403);
      expect(result.body.error).toMatch(/reserved for swarm apps/);
    }

    const tools = registeredTools([
      registerKvGetTool,
      registerKvSetTool,
      registerKvDeleteTool,
      registerKvIncrTool,
      registerKvListTool,
    ]);
    for (const [name, input] of [
      ["kv-set", { namespace, key: "x", value: 1 }],
      ["kv-delete", { namespace, key: "x" }],
      ["kv-incr", { namespace, key: "x" }],
    ] as const) {
      const result = (await tools[name]!.handler(input, toolMeta())) as StructuredResult<{
        success: boolean;
        message: string;
      }>;
      expect(result.isError).toBe(true);
      expect(result.structuredContent.success).toBe(false);
      expect(result.structuredContent.message).toMatch(/reserved for swarm apps/);
    }

    upsertKv({ namespace, key: "debug", value: "visible", valueType: "string" });
    const getResult = (await tools["kv-get"]!.handler(
      { namespace, key: "debug" },
      toolMeta(),
    )) as StructuredResult<{ success: boolean; entry: { value: unknown } | null }>;
    expect(getResult.structuredContent.success).toBe(true);
    expect(getResult.structuredContent.entry?.value).toBe("visible");
    const listResult = (await tools["kv-list"]!.handler(
      { namespace },
      toolMeta(),
    )) as StructuredResult<{ success: boolean; entries: Array<{ key: string }> }>;
    expect(listResult.structuredContent.success).toBe(true);
    expect(listResult.structuredContent.entries.some((entry) => entry.key === "debug")).toBe(true);

    const parsed = parseAppDefinition(baseDefinition);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.issues));
    const row = await createAppRow(appId, "idea", parsed.definition.models.idea!, {
      title: "Still works",
    });
    expect(row.title).toBe("Still works");
  });
});

describe("custom app actions", () => {
  test("runs a saved script with merged args and app context", async () => {
    const saved = await upsertScriptByName({
      name: `app_action_${crypto.randomUUID().replaceAll("-", "")}`,
      scope: "agent",
      scopeId: AGENT_ID,
      source:
        "export default function run(args: { base: number; add: number; app: { id: string } }) { return { total: args.base + args.add, appId: args.app.id }; }",
      description: "Apps spike 2 action fixture",
      intent: "Exercise a script-backed app action",
      signatureJson: JSON.stringify({ args: { type: "object" }, result: { type: "object" } }),
      agentId: AGENT_ID,
      typeChecked: true,
    });
    const appId = await createApp({
      ...baseDefinition,
      actions: {
        calculate: { kind: "script", scriptId: saved.script.id, args: { base: 2 } },
      },
    });
    const result = await request<{
      ok: boolean;
      result: { total: number; appId: string };
      stdout: string;
      durationMs: number;
    }>(`/api/apps/${appId}/actions/calculate`, {
      method: "POST",
      body: JSON.stringify({ input: { add: 3 } }),
    });
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.result).toEqual({ total: 5, appId });
    expect(result.body.stdout).toBeString();
    expect(result.body.durationMs).toBeGreaterThanOrEqual(0);

    expect(deleteScript({ name: saved.script.name, scope: "agent", scopeId: AGENT_ID })).toBe(true);
    const stale = await request<{ error: string; issues: Array<{ path: string }> }>(
      `/api/apps/${appId}/actions/calculate`,
      { method: "POST", body: JSON.stringify({ input: { add: 4 } }) },
    );
    expect(stale.status).toBe(400);
    expect(stale.body.issues.some((issue) => issue.path === "actions.calculate.scriptId")).toBe(
      true,
    );
  });

  test("returns 404 for an unknown action and creates a lead-owned task action", async () => {
    const appId = await createApp({
      ...baseDefinition,
      actions: { investigate: { kind: "task", prompt: "Investigate this input" } },
    });
    const missing = await request<{ error: string }>(`/api/apps/${appId}/actions/missing`, {
      method: "POST",
      body: JSON.stringify({ input: {} }),
    });
    expect(missing.status).toBe(404);

    const invalidInput = await request<{ error: string }>(
      `/api/apps/${appId}/actions/investigate`,
      { method: "POST", body: JSON.stringify({ input: [] }) },
    );
    expect(invalidInput.status).toBe(400);

    const started = await request<{ ok: boolean; taskId: string; status: string }>(
      `/api/apps/${appId}/actions/investigate`,
      { method: "POST", body: JSON.stringify({ input: { idea: "42" } }) },
    );
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ ok: true, status: "pending" });
    const observed = await request<{ id: string; agentId: string; task: string }>(
      `/api/tasks/${started.body.taskId}`,
    );
    expect(observed.status).toBe(200);
    expect(observed.body.id).toBe(started.body.taskId);
    expect(observed.body.agentId).toBe(LEAD_ID);
    expect(observed.body.task).toContain(`[App action] app=${appId}`);
    expect(observed.body.task).toContain('input={"idea":"42"}');
  });
});

describe("app MCP iteration tools", () => {
  test("gets full definitions, lists summaries, and patches with issue round-tripping", async () => {
    const appId = await createApp();
    const tools = registeredTools([registerAppGetTool, registerAppListTool, registerAppPatchTool]);

    const fetched = (await tools["app-get"]!.handler({ appId }, toolMeta())) as StructuredResult<{
      success: boolean;
      app: { id: string; definition: unknown };
    }>;
    expect(fetched.structuredContent.success).toBe(true);
    expect(fetched.structuredContent.app.id).toBe(appId);
    expect(fetched.structuredContent.app.definition).toEqual(normalizedBaseDefinition());
    expect(fetched.structuredContent.app.definition).toMatchObject({
      pages: { main: baseDefinition.page },
      defaultPage: "main",
    });
    expect(fetched.structuredContent.app.definition).not.toHaveProperty("page");

    const listed = (await tools["app-list"]!.handler({}, toolMeta())) as StructuredResult<{
      success: boolean;
      apps: Array<{ id: string; definition?: unknown }>;
    }>;
    expect(listed.structuredContent.success).toBe(true);
    expect(listed.structuredContent.apps).toHaveLength(1);
    expect(listed.structuredContent.apps[0]?.id).toBe(appId);
    expect(listed.structuredContent.apps[0]).not.toHaveProperty("definition");

    const patched = (await tools["app-patch"]!.handler(
      { appId, name: "Patched by MCP" },
      toolMeta(),
    )) as StructuredResult<{ success: boolean; app: { name: string }; appId: string; url: string }>;
    expect(patched.structuredContent.success).toBe(true);
    expect(patched.structuredContent.app.name).toBe("Patched by MCP");
    expect(patched.structuredContent).toMatchObject({ appId, url: `/apps/${appId}` });

    const invalid = (await tools["app-patch"]!.handler(
      { appId, definition: { pages: { main: { root: "missing" } } } },
      toolMeta(),
    )) as StructuredResult<{
      success: boolean;
      issues: Array<{ path: string; message: string }>;
    }>;
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent.success).toBe(false);
    expect(
      invalid.structuredContent.issues.some((issue) => issue.path.startsWith("pages.main.")),
    ).toBe(true);
  });
});
