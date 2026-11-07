import { describe, expect, test } from "bun:test";
import { parseAppDefinition } from "../apps/definition";

/**
 * Validator coverage for the `SchemaForm` component: its `onChange` action
 * chain and the `$state` `rowId` binding a nested-document editor persists
 * with. Pure `parseAppDefinition` calls — no DB, no HTTP — mirroring
 * `apps-tree.test.ts`.
 */

async function expectParseIssue(definition: unknown, message: string): Promise<void> {
  const parsed = await parseAppDefinition(definition);
  expect(parsed.success).toBe(false);
  if (parsed.success) return;
  expect(parsed.issues.some((entry) => entry.message.includes(message))).toBe(true);
}

/**
 * A definition with a `screen` model and a `SchemaForm` whose `onChange` chain
 * runs an `app.mutate` against the named model.
 */
function schemaFormDefinition(model = "screen", id = "props") {
  return {
    models: {
      screen: { columns: { doc: { kind: "json" } } },
    },
    queries: {},
    pages: {
      main: {
        root: "root",
        elements: {
          root: { type: "Stack", props: {}, children: ["props"] },
          props: {
            type: "SchemaForm",
            props: {
              id,
              schema: { type: "object", properties: { title: { type: "string" } } },
              onChange: [
                {
                  action: "app.mutate",
                  params: { model, op: "update", rowId: "r1", values: { doc: { $form: "" } } },
                },
              ],
            },
          },
        },
      },
    },
    defaultPage: "main",
  };
}

describe("SchemaForm validation", () => {
  test("accepts a SchemaForm onChange app.mutate chain against a declared model", async () => {
    const parsed = await parseAppDefinition(schemaFormDefinition());
    expect(parsed.success).toBe(true);
  });

  test("rejects a SchemaForm onChange app.mutate chain against an undeclared model", async () => {
    await expectParseIssue(schemaFormDefinition("ghost"), 'unknown model "ghost"');
  });
});

describe("SchemaForm id", () => {
  test.each([
    "a/b",
    "a b",
    "..",
    "",
    "__proto__",
    "constructor",
    "prototype",
    "a.b",
  ])("rejects the id %p", async (id) => {
    await expectParseIssue(schemaFormDefinition("screen", id), "SchemaForm id must match");
  });

  test("accepts letters, digits, underscore and hyphen", async () => {
    const parsed = await parseAppDefinition(schemaFormDefinition("screen", "Props_1-a"));
    expect(parsed.success).toBe(true);
  });
});

/**
 * A document-editing page: a Tree selects an element of a row's `doc`, and a
 * SchemaForm merges edits into it (`baseDoc` + `nodeKey`) and persists the
 * whole doc with an `app.mutate` keyed by the route param.
 */
function documentEditorDefinition(rowId: unknown) {
  return {
    models: { screen: { columns: { doc: { kind: "json" }, name: { kind: "string" } } } },
    queries: { screenById: { model: "screen", filter: { id: { $param: "screenId" } }, limit: 1 } },
    pages: {
      editor: {
        params: { screenId: { kind: "string", required: true } },
        root: "root",
        elements: {
          root: { type: "Stack", props: {}, children: ["tree", "props"] },
          tree: {
            type: "Tree",
            props: { id: "tree", nodes: { $state: "/queries/screenById/data/0/doc" } },
          },
          props: {
            type: "SchemaForm",
            props: {
              id: "props",
              schema: { $state: "/ui/props/schema" },
              baseDoc: { $state: "/queries/screenById/data/0/doc" },
              nodeKey: { $state: "/ui/tree/value" },
              onChange: [
                {
                  action: "app.mutate",
                  params: {
                    model: "screen",
                    op: "update",
                    rowId,
                    values: { doc: { $state: "/ui/props/value" } },
                  },
                },
              ],
            },
          },
        },
      },
    },
    defaultPage: "editor",
  };
}

describe("app.mutate rowId binding", () => {
  test("accepts a $state rowId bound to a route param (editor persists by screenId)", async () => {
    const parsed = await parseAppDefinition(
      documentEditorDefinition({ $state: "/route/params/screenId" }),
    );
    expect(parsed.success).toBe(true);
  });

  test("a $state rowId still validates its target — an unknown route param fails", async () => {
    await expectParseIssue(
      documentEditorDefinition({ $state: "/route/params/ghost" }),
      'unknown route param "ghost"',
    );
  });

  test("rejects a rowId that is neither a string, $row, nor $state binding", async () => {
    await expectParseIssue(
      documentEditorDefinition({ nope: true }),
      "must be a string, $row, or $state binding",
    );
  });
});
