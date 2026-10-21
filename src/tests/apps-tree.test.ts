import { describe, expect, test } from "bun:test";
import { parseAppDefinition } from "../apps/definition";

/**
 * Validator coverage for the `Tree` component: its `/ui/<id>/value` state slot,
 * the type-less `nodes` prop (a bare `z.unknown()` in the catalog), and the
 * generated schema's enforcement. Pure `parseAppDefinition` calls — no DB, no
 * HTTP — mirroring `apps-catalog-additions.test.ts`.
 */

type Element = { type: string; props?: Record<string, unknown>; children?: string[] };

const el = (id: string) => `pages.main.elements.${id}`;

/**
 * A `document` model with a json `doc` column, a `documentById` query over it,
 * a `Tree` bound to that query's doc, and a `Text` reading the tree's
 * selection slot. `tree` props are overridable per case.
 */
function treeDefinition(
  treeProps: Record<string, unknown> = {},
  elements: Record<string, Element> = {},
) {
  return {
    models: {
      document: { columns: { doc: { kind: "json" } } },
    },
    queries: { documentById: { model: "document" } },
    pages: {
      main: {
        title: "Main",
        root: "root",
        elements: {
          root: { type: "Stack", props: {}, children: ["tree", "selected"] },
          tree: {
            type: "Tree",
            props: {
              id: "nodes",
              nodes: { $state: "/queries/documentById/data/0/doc" },
              ...treeProps,
            },
          },
          selected: { type: "Text", props: { content: { $state: "/ui/nodes/value" } } },
          ...elements,
        },
      },
    },
    defaultPage: "main",
  };
}

async function issuesFor(input: unknown) {
  const parsed = await parseAppDefinition(input);
  return parsed.success ? [] : parsed.issues;
}

describe("Tree validation", () => {
  test("a Tree whose /ui/<id>/value slot is read by a bound Text validates", async () => {
    const issues = await issuesFor(treeDefinition());
    if (issues.length > 0) console.error(issues);
    expect(issues).toEqual([]);
  });

  test("a /ui/<id>/value read with no Tree of that id is rejected", async () => {
    const issues = await issuesFor(
      treeDefinition(
        {},
        { selected: { type: "Text", props: { content: { $state: "/ui/phantom/value" } } } },
      ),
    );
    expect(issues).toContainEqual({
      path: `${el("selected")}.props.content`,
      message: 'state reference targets unknown UI control "phantom"',
    });
  });

  test("nodes accepts an inline doc-shaped literal as well as a $state binding", async () => {
    const issues = await issuesFor(
      treeDefinition({ nodes: { root: "a", elements: { a: { type: "Stack" } } } }),
    );
    if (issues.length > 0) console.error(issues);
    expect(issues).toEqual([]);
  });

  test("label, maxHeight and fill validate together", async () => {
    const issues = await issuesFor(
      treeDefinition({ label: "Outline", maxHeight: "320px", fill: true }),
    );
    if (issues.length > 0) console.error(issues);
    expect(issues).toEqual([]);
  });

  test("an unknown prop is rejected", async () => {
    const issues = await issuesFor(treeDefinition({ foo: 1 }));
    expect(issues).toContainEqual({
      path: `${el("tree")}.props.foo`,
      message: "unknown property",
    });
  });

  test("id is required", async () => {
    // No `selected` reader here: without an id there is no slot for it to target.
    const issues = await issuesFor({
      ...treeDefinition(),
      pages: {
        main: {
          title: "Main",
          root: "root",
          elements: {
            root: { type: "Stack", props: {}, children: ["tree"] },
            tree: {
              type: "Tree",
              props: { nodes: { $state: "/queries/documentById/data/0/doc" } },
            },
          },
        },
      },
    });
    expect(issues.map((issue) => issue.path)).toContain(`${el("tree")}.props.id`);
  });

  test("maxHeight must be a string and fill a boolean", async () => {
    const paths = (await issuesFor(treeDefinition({ maxHeight: 320, fill: "yes" }))).map(
      (issue) => issue.path,
    );
    expect(paths).toContain(`${el("tree")}.props.maxHeight`);
    expect(paths).toContain(`${el("tree")}.props.fill`);
  });
});
