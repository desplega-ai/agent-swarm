import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import ts from "typescript";
import {
  getScriptAppTypes,
  MAX_APP_TYPES_BYTES,
  MAX_APP_TYPES_BYTES_PER_APP,
  renderAppTypes,
  renderAppTypesReport,
  scriptAppTypesWarnings,
} from "../apps/script-types";
import { type AppRecord, createApp } from "../apps/store";
import { closeDb, getDbClient, initDb } from "../be/db";

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

/** Default-cap max-size models (50) with 40-character column names; 400 columns overflows one app's budget. */
function maxSizeDefinition(columns: number) {
  const columnDefs = Object.fromEntries(
    Array.from({ length: columns }, (_, index) => [
      `c${String(index).padStart(39, "0")}`,
      { kind: "string" },
    ]),
  );
  return {
    models: Object.fromEntries(
      Array.from({ length: 50 }, (_, index) => [`model${index}`, { columns: columnDefs }]),
    ),
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
          payload: { kind: "json" },
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
    expect(rendered).toContain("payload?: unknown;");
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

  test("renders action names and arguments with server-stamped caller context", () => {
    const rendered = renderAppTypes([app("PM Inbox", issueDefinition())]);
    expect(rendered).toContain('export type ActionName = "closeIssue" | "notifyOwner";');
    expect(rendered).toContain("export interface ActionArgs");
    expect(rendered).toContain('app: { id: "PM Inbox-id" };');
    expect(rendered).toContain("caller: AppActionCaller;");
    expect(rendered).toContain('kind: "user" | "agent" | "operator" | "guest";');
    expect(rendered).toContain("id: string | null;");
    expect(rendered).toContain("name?: string;");
    expect(rendered).toContain("pageId?: string;");
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
    const maxSize = maxSizeDefinition(200);
    const report = renderAppTypesReport([
      app("Huge", maxSizeDefinition(400)),
      ...["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth"].map((name) =>
        app(name, maxSize),
      ),
    ]);
    const rendered = report.source;

    expect(new TextEncoder().encode(rendered).byteLength).toBeLessThanOrEqual(MAX_APP_TYPES_BYTES);
    // A max-size app at the default caps keeps its types; one past the per-app budget does not.
    expect(rendered).toContain("namespace App_First");
    expect(rendered).toContain("namespace App_Seventh");
    expect(rendered).not.toContain("namespace App_Huge");
    expect(rendered).toContain("omitted (type budget)");
    expect(rendered).toContain("Huge (Huge-id), Eighth (Eighth-id)");
    expect(rendered).toContain("call app-get for their shape");
    expect(report.omitted.map(({ id, budget }) => ({ id, budget }))).toEqual([
      { id: "Huge-id", budget: "per-app" },
      { id: "Eighth-id", budget: "total" },
    ]);
    expect(report.omitted[0]!.bytes).toBeGreaterThan(MAX_APP_TYPES_BYTES_PER_APP);

    const warnings = scriptAppTypesWarnings(
      'ctx.swarm.app_query({ appId: "Eighth-id", query: "q" }); type T = App_Huge.Model0;',
      report.omitted,
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('App "Huge" (Huge-id) has no generated script types');
    expect(warnings[0]).toContain("per-app budget");
    expect(warnings[1]).toContain("swarm-wide budget");
    expect(scriptAppTypesWarnings("App_Huge_2 First-id", report.omitted)).toEqual([]);

    // A script's typecheck renders only the apps it names, so other apps cost it nothing.
    const selected = renderAppTypesReport(
      [app("First", maxSize), app("Eighth", issueDefinition())],
      (candidate) => candidate.id === "Eighth-id",
    ).source;
    expect(selected).toContain("namespace App_Eighth");
    expect(selected).not.toContain("namespace App_First");
    expect(selected).toContain("SwarmAppQueryResult");
  });

  test("stays within the byte budget even when metadata alone is pathological", () => {
    const small = {
      models: { issue: { columns: { title: { kind: "string" } } } },
      queries: Object.fromEntries(
        Array.from({ length: 45 }, (_, index) => [`query${index}`, { model: "issue" }]),
      ),
    };
    const maxSize = maxSizeDefinition(200);
    const manyOmitted = renderAppTypes([
      ...Array.from({ length: 7 }, (_, index) => app(`Big${index}`, maxSize)),
      ...Array.from({ length: 40 }, (_, index) => app(`Bulk${index}`, small)),
    ]);
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

  test("model names do not collide with generated action types", () => {
    const rendered = renderAppTypes([
      app("Collision", {
        models: {
          actionName: { columns: { title: { kind: "string" } } },
          actionArgs: { columns: { title: { kind: "string" } } },
          appActionCaller: { columns: { title: { kind: "string" } } },
        },
        actions: { close: { kind: "task", prompt: "close" } },
      }),
    ]);
    expect(rendered).toContain("export interface ActionName_2");
    expect(rendered).toContain("export interface ActionArgs_2");
    expect(rendered).toContain("export interface AppActionCaller_2");
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

  beforeEach(async () => {
    await getDbClient().run("DELETE FROM apps");
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
  });

  test("reads app records in created order", async () => {
    await createApp({ id: "first-id", name: "First App", definition: issueDefinition() as never });
    await createApp({
      id: "second-id",
      name: "Second App",
      definition: issueDefinition() as never,
    });

    const rendered = await getScriptAppTypes();
    expect(rendered.indexOf("namespace App_FirstApp")).toBeLessThan(
      rendered.indexOf("namespace App_SecondApp"),
    );
  });
});
