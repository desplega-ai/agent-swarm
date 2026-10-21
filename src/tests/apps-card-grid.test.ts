import { describe, expect, test } from "bun:test";
import { parseAppDefinition } from "../apps/definition";

/**
 * Validator coverage for `CardGrid` and the Table column `format` template.
 * Pure `parseAppDefinition` calls — no DB, no HTTP — mirroring
 * `apps-catalog-additions.test.ts`.
 */

type Element = { type: string; props?: Record<string, unknown>; children?: string[] };

function appWith(elements: Record<string, Element>) {
  return {
    models: {
      doc: {
        columns: {
          title: { kind: "string", required: true },
          author: { kind: "string" },
          cover: { kind: "string" },
          status: { kind: "enum", enum: ["draft", "published"], default: "draft" },
        },
      },
    },
    queries: {
      docs: { model: "doc" },
      docById: { model: "doc", filter: { id: { $param: "doc" } } },
    },
    pages: {
      main: { title: "Main", root: "root", elements },
      detail: {
        title: "Detail",
        params: { doc: { kind: "string" }, position: { kind: "number" } },
        root: "detailRoot",
        elements: { detailRoot: { type: "Text", props: { content: "Detail" } } },
      },
    },
    defaultPage: "main",
  };
}

async function issuesFor(input: unknown) {
  const parsed = await parseAppDefinition(input);
  return parsed.success ? [] : parsed.issues;
}

const el = (id: string) => `pages.main.elements.${id}`;

function cardGrid(props: Record<string, unknown>) {
  return appWith({
    root: { type: "Stack", props: {}, children: ["cards"] },
    cards: {
      type: "CardGrid",
      props: {
        data: { $state: "/queries/docs/data" },
        loading: { $state: "/queries/docs/loading" },
        error: { $state: "/queries/docs/error" },
        titleKey: "title",
        ...props,
      },
    },
  });
}

const navigateToDetail = [
  { action: "app.navigate", params: { page: "detail", params: { doc: { $row: "id" } } } },
];

describe("CardGrid", () => {
  test("onClick running app.navigate to a declared page with $row params passes", async () => {
    const issues = await issuesFor(
      cardGrid({
        imageKey: "cover",
        fields: [
          { key: "author" },
          { key: "createdAt", kind: "date" },
          { key: "status", kind: "badge", tones: { published: "success" } },
        ],
        columns: { base: 1, md: 2, lg: 4 },
        emptyMessage: "No documents yet",
        onClick: navigateToDetail,
      }),
    );
    if (issues.length > 0) console.error(issues);
    expect(issues).toEqual([]);
  });

  test("$row and $rowIndex are accepted inside the onClick chain", async () => {
    const issues = await issuesFor(
      cardGrid({
        onClick: [
          { action: "app.refresh", params: { query: "docs" } },
          {
            action: "app.navigate",
            params: {
              page: "detail",
              params: { doc: { $row: "id" }, position: { $rowIndex: true } },
            },
          },
        ],
      }),
    );
    if (issues.length > 0) console.error(issues);
    expect(issues).toEqual([]);
  });

  test("$row outside the onClick chain is rejected", async () => {
    const issues = await issuesFor(cardGrid({ emptyMessage: { $row: "title" } }));
    expect(issues).toContainEqual({
      path: `${el("cards")}.props.emptyMessage`,
      message: "$row, $rowIndex, $form, and $chain bindings are only allowed in action params",
    });
  });

  test("onClick naming an unknown action fails", async () => {
    const issues = await issuesFor(cardGrid({ onClick: [{ action: "app.nope", params: {} }] }));
    expect(issues).toContainEqual({
      path: `${el("cards")}.props.onClick.0.action`,
      message: 'unknown action type "app.nope"',
    });
  });

  test("onClick navigating to an undeclared page fails", async () => {
    const issues = await issuesFor(
      cardGrid({ onClick: [{ action: "app.navigate", params: { page: "nope" } }] }),
    );
    expect(issues).toContainEqual({
      path: `${el("cards")}.props.onClick.0.params.page`,
      message: 'unknown page "nope"',
    });
  });

  test("titleKey is required", async () => {
    const copy = cardGrid({});
    delete copy.pages.main.elements.cards!.props!.titleKey;
    const issues = await issuesFor(copy);
    expect(issues.some((i) => i.path.startsWith(`${el("cards")}.props`))).toBe(true);
  });

  test("data bound to a $state path passes", async () => {
    const issues = await issuesFor(
      appWith({
        root: { type: "Stack", props: {}, children: ["cards"] },
        cards: {
          type: "CardGrid",
          props: { data: { $state: "/queries/docs/data" }, titleKey: "title" },
        },
      }),
    );
    if (issues.length > 0) console.error(issues);
    expect(issues).toEqual([]);
  });

  test("an unknown field kind is rejected", async () => {
    const issues = await issuesFor(cardGrid({ fields: [{ key: "author", kind: "status" }] }));
    expect(issues.some((i) => i.path.startsWith(`${el("cards")}.props.fields.0.kind`))).toBe(true);
  });
});

describe("Table column format", () => {
  test("a column with a {{field}} format template passes", async () => {
    const issues = await issuesFor(
      appWith({
        root: { type: "Stack", props: {}, children: ["table"] },
        table: {
          type: "Table",
          props: {
            data: { $state: "/queries/docs/data" },
            columns: [
              { key: "title", label: "Document", format: "{{title}} ({{status}})" },
              { key: "author" },
            ],
          },
        },
      }),
    );
    if (issues.length > 0) console.error(issues);
    expect(issues).toEqual([]);
  });

  test("format must be a string", async () => {
    const issues = await issuesFor(
      appWith({
        root: { type: "Stack", props: {}, children: ["table"] },
        table: {
          type: "Table",
          props: {
            data: { $state: "/queries/docs/data" },
            columns: [{ key: "title", format: 42 }],
          },
        },
      }),
    );
    expect(issues.some((i) => i.path.startsWith(`${el("table")}.props.columns.0.format`))).toBe(
      true,
    );
  });
});
