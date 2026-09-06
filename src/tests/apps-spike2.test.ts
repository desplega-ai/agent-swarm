import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import appSeed from "../../scripts/dev/ideas-app.seed.json";
import { applyAppDefinitionPatch, parseAppDefinition } from "../apps/definition";
import { createAppRow } from "../apps/row-store";
import { getApp } from "../apps/store";
import { closeDb, createAgent, getDbClient, initDb, upsertKv } from "../be/db";
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
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";

const skip = test.skipIf(SKIP_SANDBOX_SPAWN_TESTS);

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
  pages: {
    main: {
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
  },
  defaultPage: "main",
};

async function normalizedBaseDefinition() {
  const parsed = await parseAppDefinition(baseDefinition);
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

async function expectIssue(definition: unknown, expectedPath: string): Promise<void> {
  const parsed = await parseAppDefinition(definition);
  expect(parsed.success).toBe(false);
  if (parsed.success) return;
  expect(parsed.issues.some((issue) => issue.path.includes(expectedPath))).toBe(true);
}

// Script actions resolve the swarm bearer via getApiKey(); CI runs without a
// .env, so provide a key for the duration of this file and restore after.
const PRIOR_AGENT_SWARM_API_KEY = process.env.AGENT_SWARM_API_KEY;

beforeAll(async () => {
  process.env.AGENT_SWARM_API_KEY ??= "test-apps-spike2-key-1234567890";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  setScriptEmbeddingProviderForTests(noOpEmbeddingProvider);
  await createAgent({ id: AGENT_ID, name: "apps-spike2-worker", isLead: false, status: "idle" });
  await createAgent({ id: LEAD_ID, name: "apps-spike2-lead", isLead: true, status: "idle" });
  server = createTestServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a port");
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  await getDbClient().run("DELETE FROM kv_entries WHERE namespace LIKE 'apps%'");
  await getDbClient().run("DELETE FROM agent_tasks");
  await getDbClient().run("DELETE FROM apps");
});

afterAll(async () => {
  if (PRIOR_AGENT_SWARM_API_KEY === undefined) {
    delete process.env.AGENT_SWARM_API_KEY;
  }
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
  test("does not alias stored or patch values and rejects unsafe keys", async () => {
    const stored = structuredClone(await normalizedBaseDefinition());
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
      await normalizedBaseDefinition(),
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
      pages: baseDefinition.pages,
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
    const before = (await getApp(appId))!;
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
    expect(await getApp(appId)).toEqual(before);
  });
});

describe("server page validation", () => {
  test("accepts the committed ideas-app seed page verbatim", async () => {
    expect((await parseAppDefinition(appSeed)).success).toBe(true);
  });

  test("accepts the real Bookmarks definition with Table aliases", async () => {
    expect((await parseAppDefinition(bookmarksDefinition)).success).toBe(true);
  });

  test("accepts layout components and Table UI search and filters", async () => {
    expect(
      (
        await parseAppDefinition({
          ...baseDefinition,
          pages: {
            main: {
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
          },
          defaultPage: "main",
        })
      ).success,
    ).toBe(true);
  });

  test("validates UI control state roots", async () => {
    const unknown = await parseAppDefinition({
      ...baseDefinition,
      pages: {
        main: {
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
      },
      defaultPage: "main",
    });
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.issues).toContainEqual({
        path: "pages.main.elements.root.props.search",
        message: 'state reference targets unknown UI control "unknownId"',
      });
    }

    const formIdIsNotUi = await parseAppDefinition({
      ...baseDefinition,
      pages: {
        main: {
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
      },
      defaultPage: "main",
    });
    expect(formIdIsNotUi.success).toBe(false);
    if (!formIdIsNotUi.success) {
      expect(formIdIsNotUi.issues).toContainEqual({
        path: "pages.main.elements.table.props.search",
        message: 'state reference targets unknown UI control "formOnly"',
      });
    }

    expect(
      (
        await parseAppDefinition({
          ...baseDefinition,
          pages: {
            main: {
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
          },
          defaultPage: "main",
        })
      ).success,
    ).toBe(true);
  });

  test("accepts omitted optional props and a single element action binding", async () => {
    expect(
      (
        await parseAppDefinition({
          ...baseDefinition,
          pages: {
            main: {
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
          },
          defaultPage: "main",
        })
      ).success,
    ).toBe(true);
  });

  test("reports missing required props without an object-type error", async () => {
    const parsed = await parseAppDefinition({
      ...baseDefinition,
      pages: { main: { root: "root", elements: { root: { type: "Heading" } } } },
      defaultPage: "main",
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

  test("reports action-chain mistakes once", async () => {
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
      const parsed = await parseAppDefinition({
        ...baseDefinition,
        pages: { main: { root: "root", elements: { root: testCase.element } } },
        defaultPage: "main",
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.issues.filter((item) => item.path === testCase.path)).toHaveLength(1);
      }
    }
  });

  test("validates action script references and task agent ids at write time", async () => {
    await expectIssue(
      {
        ...baseDefinition,
        actions: {
          broken: { kind: "script", scriptId: crypto.randomUUID() },
        },
      },
      "actions.broken.scriptId",
    );
    // Agent ids come verbatim from X-Agent-ID at registration and may be
    // non-UUID custom stable ids — only empty is rejected.
    const custom = await parseAppDefinition({
      ...baseDefinition,
      actions: {
        assign: { kind: "task", prompt: "Do it", agentId: "custom-stable-agent" },
      },
    });
    expect(custom.success).toBe(true);
    await expectIssue(
      {
        ...baseDefinition,
        actions: {
          assign: { kind: "task", prompt: "Do it", agentId: "" },
        },
      },
      "actions.assign.agentId",
    );
  });

  test("reports every required structural, binding, and action-chain rejection class", async () => {
    const cases: Array<{ path: string; definition: unknown }> = [
      {
        path: "pages.main.elements.root.extra",
        definition: {
          ...baseDefinition,
          pages: {
            main: {
              root: "root",
              elements: { root: { type: "Container", props: {}, extra: true } },
            },
          },
          defaultPage: "main",
        },
      },
      {
        path: "pages.main.elements.root.children",
        definition: {
          ...baseDefinition,
          pages: {
            main: {
              root: "root",
              elements: {
                root: { type: "Heading", props: { text: "No slot" }, children: ["child"] },
                child: { type: "Text", props: { content: "Child" } },
              },
            },
          },
          defaultPage: "main",
        },
      },
      {
        path: "pages.main.elements.right.children.0",
        definition: {
          ...baseDefinition,
          pages: {
            main: {
              root: "root",
              elements: {
                root: { type: "Container", props: {}, children: ["left", "right"] },
                left: { type: "Card", props: {}, children: ["shared"] },
                right: { type: "Card", props: {}, children: ["shared"] },
                shared: { type: "Text", props: { content: "Shared" } },
              },
            },
          },
          defaultPage: "main",
        },
      },
      {
        path: "pages.main.elements.orphan",
        definition: {
          ...baseDefinition,
          pages: {
            main: {
              root: "root",
              elements: {
                root: { type: "Container", props: {} },
                orphan: { type: "Text", props: { content: "orphan" } },
              },
            },
          },
          defaultPage: "main",
        },
      },
      {
        path: "pages.main.elements.root.children.0",
        definition: {
          ...baseDefinition,
          pages: {
            main: {
              root: "root",
              elements: {
                root: { type: "Container", props: {}, children: ["missing"] },
              },
            },
          },
          defaultPage: "main",
        },
      },
      {
        path: "pages.main.elements.card.children.0",
        definition: {
          ...baseDefinition,
          pages: {
            main: {
              root: "root",
              elements: {
                root: { type: "Container", props: {}, children: ["card"] },
                card: { type: "Card", props: {}, children: ["root"] },
              },
            },
          },
          defaultPage: "main",
        },
      },
      {
        path: "pages.main.elements.root.type",
        definition: {
          ...baseDefinition,
          pages: { main: { root: "root", elements: { root: { type: "Unknown", props: {} } } } },
          defaultPage: "main",
        },
      },
      {
        path: "pages.main.elements.root.props.direction",
        definition: {
          ...baseDefinition,
          pages: {
            main: {
              root: "root",
              elements: { root: { type: "Container", props: { direction: "diagonal" } } },
            },
          },
          defaultPage: "main",
        },
      },
      {
        path: "pages.main.elements.root.props.content",
        definition: {
          ...baseDefinition,
          pages: {
            main: {
              root: "root",
              elements: {
                root: { type: "Text", props: { content: { $state: "/queries/missing/data" } } },
              },
            },
          },
          defaultPage: "main",
        },
      },
      {
        path: "pages.main.elements.root.visible",
        definition: {
          ...baseDefinition,
          pages: {
            main: {
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
          defaultPage: "main",
        },
      },
      {
        path: "pages.main.elements.root.on.press.0.params.values",
        definition: {
          ...baseDefinition,
          pages: {
            main: {
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
          defaultPage: "main",
        },
      },
      {
        path: "pages.main.elements.root.on.press.0.params.model",
        definition: {
          ...baseDefinition,
          pages: {
            main: {
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
          defaultPage: "main",
        },
      },
      {
        path: "pages.main.elements.root.on.press.0.params.rowId",
        definition: {
          ...baseDefinition,
          pages: {
            main: {
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
          defaultPage: "main",
        },
      },
      {
        path: "pages.main.elements.root.on.press.0.action",
        definition: {
          ...baseDefinition,
          pages: {
            main: {
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
          defaultPage: "main",
        },
      },
      {
        path: "pages.main.elements.root.on.press.0.params.name",
        definition: {
          ...baseDefinition,
          pages: {
            main: {
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
          defaultPage: "main",
        },
      },
    ];

    for (const item of cases) await expectIssue(item.definition, item.path);
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

    await upsertKv({ namespace, key: "debug", value: "visible", valueType: "string" });
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

    const parsed = await parseAppDefinition(baseDefinition);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.issues));
    const row = await createAppRow(appId, "idea", parsed.definition.models.idea!, {
      title: "Still works",
    });
    expect(row.title).toBe("Still works");
  });
});

describe("custom app actions", () => {
  skip("runs a saved script with merged args and app context", async () => {
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

    expect(await deleteScript({ name: saved.script.name, scope: "agent", scopeId: AGENT_ID })).toBe(
      true,
    );
    const stale = await request<{ error: string; issues: Array<{ path: string }> }>(
      `/api/apps/${appId}/actions/calculate`,
      { method: "POST", body: JSON.stringify({ input: { add: 4 } }) },
    );
    expect(stale.status).toBe(400);
    expect(stale.body.issues.some((issue) => issue.path === "actions.calculate.scriptId")).toBe(
      true,
    );
  });

  test("agent writers cannot wire another agent's script; operator wiring is grandfathered", async () => {
    const OTHER_AGENT_ID = crypto.randomUUID();
    const foreign = await upsertScriptByName({
      name: `app_action_foreign_${crypto.randomUUID().replaceAll("-", "")}`,
      scope: "agent",
      scopeId: OTHER_AGENT_ID,
      source: "export default function run() { return { ok: true }; }",
      description: "Foreign-owned action fixture",
      intent: "Prove the script ownership gate",
      signatureJson: JSON.stringify({ args: { type: "object" }, result: { type: "object" } }),
      agentId: OTHER_AGENT_ID,
      typeChecked: true,
    });

    try {
      // An agent writer referencing a foreign agent-scoped script is rejected.
      const denied = await request<{ issues: Array<{ path: string; message: string }> }>(
        "/api/apps",
        {
          method: "POST",
          body: JSON.stringify({
            name: "Foreign wire",
            definition: {
              ...baseDefinition,
              actions: { steal: { kind: "script", scriptId: foreign.script.id } },
            },
          }),
        },
      );
      expect(denied.status).toBe(400);
      expect(
        denied.body.issues.some(
          (issue) =>
            issue.path === "actions.steal.scriptId" &&
            issue.message.includes("agent-scoped to another agent"),
        ),
      ).toBe(true);

      // The operator (no X-Agent-ID) may wire any existing script.
      const operatorCreate = await fetch(`${base}/api/apps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Operator wired",
          definition: {
            ...baseDefinition,
            actions: { run: { kind: "script", scriptId: foreign.script.id } },
          },
        }),
      });
      expect(operatorCreate.status).toBe(201);
      const operatorAppId = ((await operatorCreate.json()) as { app: { id: string } }).app.id;

      // Grandfathering: an agent can still edit the app that already carries the
      // foreign script action.
      const patched = await request<{ app: { description: string } }>(
        `/api/apps/${operatorAppId}`,
        { method: "PATCH", body: JSON.stringify({ description: "agent touched" }) },
      );
      expect(patched.status).toBe(200);
    } finally {
      await deleteScript({ name: foreign.script.name, scope: "agent", scopeId: OTHER_AGENT_ID });
    }
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
    const observed = await request<{ id: string; agentId: string; task: string; key: string }>(
      `/api/tasks/${started.body.taskId}`,
    );
    expect(observed.status).toBe(200);
    expect(observed.body.id).toBe(started.body.taskId);
    expect(observed.body.agentId).toBe(LEAD_ID);
    expect(observed.body.task).toContain(`[App action] app=${appId}`);
    expect(observed.body.task).toContain('input={"idea":"42"}');
    // The app-namespaced asset key lets a swarm-tasks source pull these back
    // via config.assetKey.
    expect(observed.body.key).toBe(`shared/app:${appId}/action:investigate/`);
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
    expect(fetched.structuredContent.app.definition).toEqual({
      ...(await normalizedBaseDefinition()),
      schemaVersion: 1,
    });
    expect(fetched.structuredContent.app.definition).toMatchObject({
      pages: baseDefinition.pages,
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
    const snapshot = await getDbClient().get<{ snapshot: string; changedByAgentId: string }>(
      "SELECT snapshot, changedByAgentId FROM app_versions WHERE appId = ? ORDER BY version DESC LIMIT 1",
      [appId],
    );
    expect(snapshot!.changedByAgentId).toBe(AGENT_ID);
    expect(JSON.parse(snapshot!.snapshot).definition).toEqual({
      ...(await normalizedBaseDefinition()),
      schemaVersion: 1,
    });

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

  test("fails closed when app-patch cannot snapshot", async () => {
    const appId = await createApp();
    const tools = registeredTools([registerAppPatchTool]);
    const before = await getApp(appId);
    await getDbClient().run(`
      CREATE TRIGGER fail_mcp_app_snapshot
      BEFORE INSERT ON app_versions
      BEGIN SELECT RAISE(FAIL, 'snapshot intentionally failed'); END;
    `);

    const patched = (await tools["app-patch"]!.handler(
      { appId, name: "must not persist", description: "must not persist" },
      toolMeta(),
    )) as StructuredResult<{ success: boolean; message: string }>;
    await getDbClient().run("DROP TRIGGER fail_mcp_app_snapshot");

    expect(patched.isError).toBe(true);
    expect(patched.structuredContent.success).toBe(false);
    expect(patched.structuredContent.message).toStartWith("Failed to snapshot app");
    expect(await getApp(appId)).toEqual(before);
    expect(
      await getDbClient().get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM app_versions WHERE appId = ?",
        [appId],
      ),
    ).toEqual({ count: 0 });
  });
});

describe("page-validator guards", () => {
  test("cross-checks busyWith against declared actions and reserves $-prefixed form field names", async () => {
    const withButton = (busyWith: string) =>
      parseAppDefinition({
        ...baseDefinition,
        actions: { notify: { kind: "task", prompt: "Ping the owner" } },
        pages: {
          main: {
            root: "root",
            elements: {
              root: {
                type: "Button",
                props: { label: "Notify", busyWith },
                on: { press: [{ action: "app.action", params: { name: "notify" } }] },
              },
            },
          },
        },
        defaultPage: "main",
      });

    // A typo'd busyWith watches a slot nothing writes — rejected like an
    // unknown app.action name.
    const typo = await withButton("notfy");
    expect(typo.success).toBe(false);
    if (!typo.success) {
      expect(typo.issues).toContainEqual({
        path: "pages.main.elements.root.props.busyWith",
        message: 'unknown app action "notfy"',
      });
    }
    expect((await withButton("notify")).success).toBe(true);

    // `$`-prefixed form field names collide with reserved runtime slots
    // (`/forms/<id>/$error` carries the inline mutate failure).
    const reservedField = await parseAppDefinition({
      ...baseDefinition,
      pages: {
        main: {
          root: "root",
          elements: {
            root: {
              type: "Form",
              props: {
                id: "f",
                fields: [{ name: "$error" }],
                onSubmit: [{ action: "app.mutate", params: { op: "create", model: "idea" } }],
              },
            },
          },
        },
      },
      defaultPage: "main",
    });
    expect(reservedField.success).toBe(false);
    if (!reservedField.success) {
      expect(
        reservedField.issues.some(
          (issue) => issue.path === "pages.main.elements.root.props.fields.0.name",
        ),
      ).toBe(true);
    }
  });
});
