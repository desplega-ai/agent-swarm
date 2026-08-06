import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import ts from "typescript";
import { getScriptAppTypes, MAX_APP_TYPES_BYTES, renderAppTypes } from "../apps/script-types";
import { type AppRecord, createApp } from "../apps/store";
import { closeDb, getDb, initDb } from "../be/db";

const TEST_DB_PATH = "./test-apps-script-types.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function app(
  name: string,
  definition: Record<string, unknown>,
  overrides: Partial<AppRecord> = {},
): AppRecord {
  return {
    id: `${name}-id`,
    name,
    definition: { schemaVersion: 1, ...definition } as AppRecord["definition"],
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

function issueDefinition() {
  return {
    models: {
      issue: {
        columns: {
          title: { kind: "string", required: true },
          count: { kind: "number" },
          enabled: { kind: "boolean" },
          dueAt: { kind: "date" },
          status: { kind: "enum", enum: ["open", "urgent"] },
          hidden: { kind: "string", hidden: true },
        },
      },
    },
    queries: {
      byId: { model: "issue", filter: { id: { $param: "issueId" } } },
      byStatus: { model: "issue", filter: { status: { $param: "status" } } },
      all: { model: "issue" },
    },
    actions: {
      closeIssue: { kind: "task", prompt: "close it" },
      notifyOwner: { kind: "task", prompt: "notify" },
    },
    pages: { main: { root: "root", elements: { root: { type: "Container", props: {} } } } },
    defaultPage: "main",
  };
}

describe("renderAppTypes", () => {
  test("renders column kinds, requiredness, hidden columns, and system columns", () => {
    const rendered = renderAppTypes([app("PM Inbox", issueDefinition())]);

    expect(rendered).toContain("export namespace App_PmInbox");
    expect(rendered).toContain("title: string;");
    expect(rendered).toContain("count?: number;");
    expect(rendered).toContain("enabled?: boolean;");
    expect(rendered).toContain("/** date */\n    dueAt?: string;");
    expect(rendered).toContain('status?: "open" | "urgent";');
    expect(rendered).not.toContain("hidden?:");
    expect(rendered).toContain("id: string;");
    expect(rendered).toContain("createdAt: string;");
    expect(rendered).toContain("updatedAt: string;");
    expect(rendered).toContain("createdBy?: string;");
    expect(rendered).toContain("updatedBy?: string;");
  });

  test("renders typed required query params, including system and enum columns", () => {
    const rendered = renderAppTypes([app("PM Inbox", issueDefinition())]);

    expect(rendered).toContain("params: { issueId: string };");
    expect(rendered).toContain('params: { status: "open" | "urgent" };');
    expect(rendered).toContain("params?: Record<string, never>;");
  });

  test("types a reused $param as the intersection of its filter columns", () => {
    const rendered = renderAppTypes([
      app("Reuse", {
        models: {
          issue: {
            columns: {
              state: { kind: "enum", enum: ["open", "closed", "stale"] },
              flag: { kind: "enum", enum: ["closed", "stale", "urgent"] },
              priority: { kind: "enum", enum: ["high", "low"] },
              label: { kind: "string" },
              count: { kind: "number" },
            },
          },
        },
        queries: {
          overlappingEnums: {
            model: "issue",
            filter: { state: { $param: "choice" }, flag: { $param: "choice" } },
          },
          enumAndString: {
            model: "issue",
            filter: { state: { $param: "pick" }, label: { $param: "pick" } },
          },
          disjointEnums: {
            model: "issue",
            filter: { state: { $param: "which" }, priority: { $param: "which" } },
          },
          disjointPrimitives: {
            model: "issue",
            filter: { label: { $param: "value" }, count: { $param: "value" } },
          },
        },
      }),
    ]);

    expect(rendered).toContain('params: { choice: "closed" | "stale" };');
    expect(rendered).toContain('params: { pick: "open" | "closed" | "stale" };');
    expect(rendered).toContain("params: { which: never };");
    expect(rendered).toContain("params: { value: never };");
  });

  test("renders a documentation-grade action union", () => {
    const rendered = renderAppTypes([app("PM Inbox", issueDefinition())]);
    expect(rendered).toContain('export type ActionName = "closeIssue" | "notifyOwner";');
  });

  test("derives and dedupes namespaces and model interface names", () => {
    const definition = {
      models: {
        myModel: { columns: { title: { kind: "string" } } },
        my_model: { columns: { body: { kind: "string" } } },
      },
    };
    const rendered = renderAppTypes([
      app("PM Inbox", definition),
      app("spike4_scratch", definition),
      app("  ", definition),
      app("東京", definition),
      app("PM-Inbox", definition),
    ]);

    expect(rendered).toContain("namespace App_PmInbox");
    expect(rendered).toContain("namespace App_Spike4Scratch");
    expect(rendered).toContain("namespace App_Unnamed");
    expect(rendered).toContain("namespace App_Unnamed_2");
    expect(rendered).toContain("namespace App_PmInbox_2");
    expect(rendered).toContain("interface MyModel");
    expect(rendered).toContain("interface MyModel_2");
  });

  test("neutralises hostile comment text", () => {
    const rendered = renderAppTypes([
      app("*/ export const pwned = 1;\nnext", issueDefinition(), {
        id: "hostile-id",
        description: "bad */\ndescription",
      }),
    ]);

    expect(rendered).not.toContain("*/ export");
    expect(rendered).not.toContain("bad */");
    expect(rendered).not.toContain("\nnext");
  });

  test("skips broken definitions without aborting valid apps", () => {
    const broken = app(
      "Broken",
      {},
      {
        id: "broken-id",
        definitionError: [{ path: "definition", message: "invalid" }],
      },
    );
    const rendered = renderAppTypes([broken, app("Working", issueDefinition())]);

    expect(rendered).toContain('Skipped app "broken-id"');
    expect(rendered).toContain("namespace App_Working");
  });

  test("returns an empty string when there are no renderable apps", () => {
    expect(renderAppTypes([])).toBe("");
    expect(
      renderAppTypes([
        app(
          "Broken",
          {},
          {
            definitionError: [{ path: "definition", message: "invalid" }],
          },
        ),
      ]),
    ).toBe("");
  });

  test("keeps oldest apps first and omits whole later apps within the byte budget", () => {
    const definition = {
      models: { issue: { columns: { title: { kind: "string" } } } },
      queries: Object.fromEntries(
        Array.from({ length: 45 }, (_, index) => [`query${index}`, { model: "issue" }]),
      ),
    };
    const rendered = renderAppTypes([
      app("First", definition),
      app("Second", definition),
      app("Third", definition),
      app("Fourth", definition),
    ]);

    expect(new TextEncoder().encode(rendered).byteLength).toBeLessThanOrEqual(MAX_APP_TYPES_BYTES);
    expect(rendered).toContain("namespace App_First");
    expect(rendered).toContain("omitted (type budget)");
    expect(rendered).toContain("Fourth (Fourth-id)");
    expect(rendered).toContain("call app-get for their shape");
  });

  test("stays within the byte budget even when metadata alone is pathological", () => {
    const definition = {
      models: { issue: { columns: { title: { kind: "string" } } } },
      queries: Object.fromEntries(
        Array.from({ length: 45 }, (_, index) => [`query${index}`, { model: "issue" }]),
      ),
    };
    const manyOmitted = renderAppTypes(
      Array.from({ length: 40 }, (_, index) => app(`Bulk${index}`, definition)),
    );
    expect(new TextEncoder().encode(manyOmitted).byteLength).toBeLessThanOrEqual(
      MAX_APP_TYPES_BYTES,
    );
    expect(manyOmitted).toContain("+");
    expect(manyOmitted).toContain("more — call app-get for their shape");

    const manyBroken = renderAppTypes([
      ...Array.from({ length: 30 }, (_, index) =>
        app(
          `Broken${index}`,
          {},
          { id: `broken-${index}`, definitionError: [{ path: "definition", message: "invalid" }] },
        ),
      ),
      app("Working", issueDefinition()),
    ]);
    expect(new TextEncoder().encode(manyBroken).byteLength).toBeLessThanOrEqual(
      MAX_APP_TYPES_BYTES,
    );
    expect(manyBroken).toContain("...and 20 more app(s) with undecodable definitions skipped.");
    expect(manyBroken).toContain("namespace App_Working");
  });

  test("neutralises U+2028/U+2029 line separators in comment text", () => {
    const rendered = renderAppTypes([
      app(`evil\u2028export const pwned2 = 1;\u2029next`, issueDefinition(), { id: "ls-id" }),
    ]);
    expect(rendered).not.toContain("\u2028");
    expect(rendered).not.toContain("\u2029");
    expect(rendered).not.toMatch(/^export const pwned2/m);
  });

  test("a model named actionName does not collide with the ActionName alias", () => {
    const rendered = renderAppTypes([
      app("Collision", {
        models: { actionName: { columns: { title: { kind: "string" } } } },
        actions: { close: { kind: "task", prompt: "close" } },
      }),
    ]);
    expect(rendered).toContain("export interface ActionName_2");
    expect(rendered).toContain('export type ActionName = "close";');
  });

  test("emits syntactically valid TypeScript", () => {
    const source = renderAppTypes([app("PM Inbox", issueDefinition())]);
    const parsed = ts.createSourceFile("app-types.d.ts", source, ts.ScriptTarget.Latest, false);
    expect(parsed.parseDiagnostics).toHaveLength(0);
  });
});

describe("getScriptAppTypes", () => {
  beforeAll(async () => {
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
  });

  beforeEach(() => {
    getDb().run("DELETE FROM apps");
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
  });

  test("reads app records in created order", () => {
    createApp({ id: "first-id", name: "First App", definition: issueDefinition() as never });
    createApp({ id: "second-id", name: "Second App", definition: issueDefinition() as never });

    const rendered = getScriptAppTypes();
    expect(rendered.indexOf("namespace App_FirstApp")).toBeLessThan(
      rendered.indexOf("namespace App_SecondApp"),
    );
  });
});
