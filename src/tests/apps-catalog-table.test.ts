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

describe("Table refreshing binding", () => {
  test("a query-bound refreshing property validates", async () => {
    const issues = await issuesFor(
      withProps("table", { refreshing: { $state: "/queries/allOrders/fetching" } }),
    );
    expect(issues).toEqual([]);
  });

  test("a literal refreshing boolean validates", async () => {
    expect(await issuesFor(withProps("table", { refreshing: true }))).toEqual([]);
  });
});

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

describe("Table column filters, muted values and states", () => {
  const idIssue = (issues: { path: string }[]) =>
    issues.filter((i) => i.path === "pages.main.elements.table.props.id");

  test("filterable with an id validates", async () => {
    expect(await issuesFor(withProps("table", { id: "orders", filterable: true }))).toEqual([]);
  });

  test("filterable without an id is rejected at props.id", async () => {
    const issues = await issuesFor(withProps("table", { filterable: true }));
    expect(idIssue(issues)).toHaveLength(1);
    expect(idIssue(issues)[0]!.message).toContain("/ui/<id>/filters");
  });

  test("a column filter needs the id too; filter:false does not", async () => {
    const columns = (filter: unknown) => [{ key: "title", filter }];
    expect(
      idIssue(await issuesFor(withProps("table", { columns: columns("values") }))),
    ).toHaveLength(1);
    expect(idIssue(await issuesFor(withProps("table", { columns: columns("text") })))).toHaveLength(
      1,
    );
    expect(await issuesFor(withProps("table", { columns: columns(false) }))).toEqual([]);
    expect(
      await issuesFor(withProps("table", { id: "orders", columns: columns("values") })),
    ).toEqual([]);
  });

  test("an unknown filter mode is rejected", async () => {
    const issues = await issuesFor(
      withProps("table", { id: "orders", columns: [{ key: "title", filter: "regex" }] }),
    );
    expect(issues.some((i) => i.path.startsWith("pages.main.elements.table.props.columns.0"))).toBe(
      true,
    );
  });

  test("muted takes a list of strings", async () => {
    expect(
      await issuesFor(withProps("table", { columns: [{ key: "title", muted: ["none", "no"] }] })),
    ).toEqual([]);
    const bad = await issuesFor(withProps("table", { columns: [{ key: "title", muted: "none" }] }));
    expect(bad.length).toBeGreaterThan(0);
  });

  test("the filters slot is a readable state path of the Table's id", async () => {
    const read = (path: string) => {
      const copy = withProps("table", { id: "orders", filterable: true });
      (copy.pages.main.elements as Elements).heading!.props.text = { $state: path };
      return issuesFor(copy);
    };
    expect(await read("/ui/orders/filters/status")).toEqual([]);
    const ghost = await read("/ui/ghost/filters/status");
    expect(ghost.some((i) => i.message.includes('unknown UI control "ghost"'))).toBe(true);
  });

  test("clearState takes /ui/<id>/... paths of controls that exist", async () => {
    expect(
      await issuesFor(
        withProps("table", {
          id: "orders",
          clearState: ["/ui/search/value", "/ui/statusFilter/value"],
        }),
      ),
    ).toEqual([]);
    const notUi = await issuesFor(withProps("table", { clearState: ["/forms/x/y"] }));
    expect(notUi.some((i) => i.path.endsWith("props.clearState.0"))).toBe(true);
    const ghost = await issuesFor(withProps("table", { clearState: ["/ui/ghost/value"] }));
    expect(ghost.some((i) => i.message.includes('unknown UI control "ghost"'))).toBe(true);
  });

  test("onRetry is an action chain and is validated like one", async () => {
    expect(await issuesFor(withProps("table", { onRetry: [{ action: "app.refresh" }] }))).toEqual(
      [],
    );
    const bad = await issuesFor(withProps("table", { onRetry: [{ action: "app.nope" }] }));
    expect(bad.some((i) => i.path.startsWith("pages.main.elements.table.props.onRetry"))).toBe(
      true,
    );
  });
});

describe("currency and percent formats", () => {
  test("Table currency / percent columns, DetailList fields and Metric format validate", async () => {
    const copy = withProps("table", {
      columns: [
        { key: "amount", kind: "currency", currency: "EUR" },
        { key: "amount", kind: "percent" },
        { key: "title", popover: { fields: [{ key: "amount", kind: "currency" }] } },
      ],
    });
    const elements = copy.pages.main.elements as Elements;
    elements.detail!.props.fields = [{ key: "amount", kind: "currency", currency: "USD" }];
    elements.mRevenue!.props = { ...elements.mRevenue!.props, format: "currency", currency: "EUR" };
    expect(await issuesFor(copy)).toEqual([]);
  });

  test('a lowercase currency ("usd") is rejected on every surface', async () => {
    const copy = withProps("table", {
      columns: [
        { key: "amount", kind: "currency", currency: "usd" },
        {
          key: "title",
          popover: { fields: [{ key: "amount", kind: "currency", currency: "eu" }] },
        },
      ],
    });
    const elements = copy.pages.main.elements as Elements;
    elements.detail!.props.fields = [{ key: "amount", kind: "currency", currency: "usd" }];
    elements.mRevenue!.props = { ...elements.mRevenue!.props, format: "currency", currency: "usd" };
    const paths = (await issuesFor(copy)).map((entry) => entry.path).sort();
    expect(paths).toEqual(
      [
        "pages.main.elements.detail.props.fields.0.currency",
        "pages.main.elements.mRevenue.props.currency",
        "pages.main.elements.table.props.columns.0.currency",
        "pages.main.elements.table.props.columns.1.popover.fields.0.currency",
      ].sort(),
    );
  });

  test("an unknown Metric format is rejected", async () => {
    const issues = await issuesFor(withProps("mRevenue", { format: "money" }));
    expect(issues.map((entry) => entry.path)).toEqual([
      "pages.main.elements.mRevenue.props.format",
    ]);
  });
});
