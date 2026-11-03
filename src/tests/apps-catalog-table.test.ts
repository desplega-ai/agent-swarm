import { describe, expect, test } from "bun:test";
import { parseAppDefinition } from "../apps/definition";

const definition = await Bun.file(
  new URL("./fixtures/catalog-table-definition.json.txt", import.meta.url),
).json();

type Elements = Record<string, { type: string; props: Record<string, unknown> }>;

function withProps(elementId: string, props: Record<string, unknown>) {
  const copy = structuredClone(definition);
  const elements = copy.pages.main.elements as Elements;
  elements[elementId]!.props = { ...elements[elementId]!.props, ...props };
  return copy;
}

async function issuesFor(input: unknown) {
  const parsed = await parseAppDefinition(input);
  return parsed.success ? [] : parsed.issues;
}

describe("Table list layer and icons", () => {
  test("the example app with row click, new column kinds and icons passes validation", async () => {
    const parsed = await parseAppDefinition(definition);
    if (!parsed.success) console.error(parsed.issues);
    expect(parsed.success).toBe(true);
  });

  test("every new column kind is accepted", async () => {
    const kinds = [
      "status",
      "user",
      "agent",
      "relative",
      "duration",
      "progress",
      "copy",
      "switch",
      "checkbox",
      "link",
    ];
    const issues = await issuesFor(
      withProps("table", {
        columns: kinds.map((kind) => ({ key: "title", kind, align: "end", truncate: "middle" })),
      }),
    );
    expect(issues).toEqual([]);
  });

  test("a checkbox column's onChange chain is validated like a switch's", async () => {
    const issues = await issuesFor(
      withProps("table", {
        columns: [
          {
            key: "title",
            kind: "checkbox",
            onChange: [{ action: "app.mutate", params: { model: "nope", op: "update" } }],
          },
        ],
      }),
    );
    expect(
      issues.some((i) => i.path.startsWith("pages.main.elements.table.props.columns.0.onChange")),
    ).toBe(true);
  });

  test("onRowClick is an action chain with $row checked against the model", async () => {
    const issues = await issuesFor(
      withProps("table", {
        onRowClick: [
          {
            action: "app.navigate",
            params: { page: "main", params: { panel: { $row: "ownr" } } },
          },
        ],
      }),
    );
    expect(
      issues.some((i) => i.path.startsWith("pages.main.elements.table.props.onRowClick")),
    ).toBe(true);
  });

  test("a switch column's onChange chain is validated like a row action", async () => {
    const issues = await issuesFor(
      withProps("table", {
        columns: [
          {
            key: "title",
            kind: "switch",
            onChange: [{ action: "app.mutate", params: { model: "nope", op: "update" } }],
          },
        ],
      }),
    );
    expect(
      issues.some((i) => i.path.startsWith("pages.main.elements.table.props.columns.0.onChange")),
    ).toBe(true);
  });

  test("icon names outside the curated set are rejected", async () => {
    expect((await issuesFor(withProps("badge", { icon: "skull" }))).length).toBeGreaterThan(0);
    expect(await issuesFor(withProps("triageBtn", { icon: "plus" }))).toEqual([]);
    const iconBlock = structuredClone(definition);
    const elements = iconBlock.pages.main.elements as Elements;
    elements.root!.children = [...(elements.root as { children: string[] }).children, "spark"];
    (elements as Record<string, unknown>).spark = {
      type: "Icon",
      props: { name: "sparkles", tone: "muted", label: "Live" },
    };
    expect(await issuesFor(iconBlock)).toEqual([]);
  });

  test("tables without any of the new props still validate (backward compatible)", async () => {
    const legacy = structuredClone(definition);
    const table = (legacy.pages.main.elements as Elements).table!.props;
    for (const key of ["onRowClick", "selectedId", "emptyState", "mobileFields"]) delete table[key];
    table.columns = [
      { key: "title", label: "Order" },
      { key: "status", kind: "badge", tones: { completed: "success" } },
    ];
    table.rowActions = [
      {
        label: "Open",
        actions: [
          { action: "app.navigate", params: { page: "main", params: { panel: { $row: "id" } } } },
        ],
      },
    ];
    expect(await issuesFor(legacy)).toEqual([]);
  });
});

describe("Table row selection", () => {
  const bulkAction = (extra: Record<string, unknown> = {}) => ({
    label: "Mark done",
    icon: "check",
    actions: [
      {
        action: "app.action",
        params: { name: "triage", input: { ids: { $state: "/ui/orders/selected" } } },
      },
    ],
    ...extra,
  });

  const idIssue = (issues: { path: string }[]) =>
    issues.filter((i) => i.path === "pages.main.elements.table.props.id");

  test("selectable with an id validates", async () => {
    expect(await issuesFor(withProps("table", { id: "orders", selectable: true }))).toEqual([]);
  });

  test("selectable without an id is rejected at props.id", async () => {
    const issues = await issuesFor(withProps("table", { selectable: true }));
    expect(idIssue(issues)).toHaveLength(1);
    expect(idIssue(issues)[0]!.message).toContain("/ui/<id>/selected");
  });

  test("bulkActions without an id is rejected, with one validates", async () => {
    expect(
      idIssue(await issuesFor(withProps("table", { bulkActions: [bulkAction()] }))),
    ).toHaveLength(1);
    expect(
      await issuesFor(withProps("table", { id: "orders", bulkActions: [bulkAction()] })),
    ).toEqual([]);
  });

  test("selectable: false and an empty bulkActions need no id", async () => {
    expect(await issuesFor(withProps("table", { selectable: false, bulkActions: [] }))).toEqual([]);
  });

  test("bulkActions take the rowActions fields but not placement", async () => {
    const withPlacement = await issuesFor(
      withProps("table", { id: "orders", bulkActions: [bulkAction({ placement: "menu" })] }),
    );
    expect(withPlacement.length).toBeGreaterThan(0);
    const full = await issuesFor(
      withProps("table", {
        id: "orders",
        bulkActions: [
          bulkAction({
            variant: "destructive",
            confirm: {
              title: "Sure?",
              description: "Applies to the selection.",
              confirmLabel: "Go",
            },
          }),
        ],
      }),
    );
    expect(full).toEqual([]);
  });

  test("a bulk chain is validated like a row action chain", async () => {
    const issues = await issuesFor(
      withProps("table", {
        id: "orders",
        bulkActions: [bulkAction({ actions: [{ action: "app.nope", params: {} }] })],
      }),
    );
    expect(
      issues.some((i) =>
        i.path.startsWith("pages.main.elements.table.props.bulkActions.0.actions"),
      ),
    ).toBe(true);
  });

  test("the selection path resolves only for a Table id that exists", async () => {
    const wrongId = bulkAction({
      actions: [
        {
          action: "app.action",
          params: { name: "triage", input: { ids: { $state: "/ui/ghost/selected" } } },
        },
      ],
    });
    const issues = await issuesFor(withProps("table", { id: "orders", bulkActions: [wrongId] }));
    expect(issues.some((i) => i.message.includes('unknown UI control "ghost"'))).toBe(true);
  });
});
