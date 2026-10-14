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
      "link",
    ];
    const issues = await issuesFor(
      withProps("table", {
        columns: kinds.map((kind) => ({ key: "title", kind, align: "end", truncate: "middle" })),
      }),
    );
    expect(issues).toEqual([]);
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
