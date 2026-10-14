import { describe, expect, test } from "bun:test";
import { parseAppDefinition } from "../apps/definition";

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).json();

const definition = await fixture("catalog-feedback-definition.json.txt");
const legacyDefinition = await fixture("catalog-table-definition.json.txt");

type Element = { type: string; props: Record<string, unknown>; [key: string]: unknown };
type Elements = Record<string, Element>;

function edit(mutate: (elements: Elements) => void) {
  const copy = structuredClone(definition);
  mutate(copy.pages.main.elements as Elements);
  return copy;
}

function withProps(elementId: string, props: Record<string, unknown>) {
  return edit((elements) => {
    elements[elementId]!.props = { ...elements[elementId]!.props, ...props };
  });
}

async function issuesFor(input: unknown) {
  const parsed = await parseAppDefinition(input);
  return parsed.success ? [] : parsed.issues;
}

async function pathsFor(input: unknown) {
  return (await issuesFor(input)).map((issue) => issue.path);
}

const el = (id: string) => `pages.main.elements.${id}`;

describe("status, feedback, loaders and motion catalog set", () => {
  test("the example app using every new block, prop and ui.toast passes validation", async () => {
    const issues = await issuesFor(definition);
    if (issues.length > 0) console.error(issues);
    expect(issues).toEqual([]);
  });

  test("backward compatibility: the PR 1 example app is unchanged and still valid", async () => {
    expect(await issuesFor(legacyDefinition)).toEqual([]);
  });

  test("backward compatibility: the original Badge, Metric, Button and Stack props alone stay valid", async () => {
    const issues = await issuesFor(
      edit((elements) => {
        elements.badge!.props = { text: "Live", tone: "active" };
        elements.mOpen!.props = { label: "Open", value: 5 };
        elements.triageBtn!.props = { label: "Go", busyWith: "triage" };
        elements.root!.props = {};
      }),
    );
    expect(issues).toEqual([]);
  });

  test("each new block validates with only its required props", async () => {
    const blocks: [string, Record<string, unknown>][] = [
      ["Progress", { value: 1 }],
      ["EmptyState", { title: "Nothing" }],
      ["CopyButton", { value: "abc" }],
      ["Kbd", { keys: ["/"] }],
      ["Skeleton", { shape: "line" }],
      ["Spinner", {}],
      ["AvatarStack", { users: [] }],
      ["Chips", { id: "solo", options: ["a"] }],
    ];
    for (const [type, props] of blocks) {
      const issues = await issuesFor(
        edit((elements) => {
          elements.extras!.children = [...(elements.extras!.children as string[]), "probe"];
          elements.probe = { type, props };
        }),
      );
      expect({ type, issues }).toEqual({ type, issues: [] });
    }
    const section = await issuesFor(
      edit((elements) => {
        elements.formSection!.props = { title: "Only a title" };
      }),
    );
    expect(section).toEqual([]);
  });

  test("required props of the new blocks are enforced", async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["pBar", {}, "value"],
      ["emptyBlock", {}, "title"],
      ["copyId", {}, "value"],
      ["keys", {}, "keys"],
      ["skel", {}, "shape"],
      ["people", {}, "users"],
      ["formSection", {}, "title"],
      ["statusChips", {}, "options"],
    ];
    for (const [id, props, missing] of cases) {
      const issues = await issuesFor(
        edit((elements) => {
          elements[id]!.props = props;
        }),
      );
      expect(issues.map((issue) => issue.path)).toContain(`${el(id)}.props.${missing}`);
    }
  });

  test("every new enum rejects a value outside its set", async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["bCount", { variant: "pill" }, "variant"],
      ["root", { motion: "bounce" }, "motion"],
      ["tabs", { variant: "pills" }, "variant"],
      ["triageBtn", { size: "xl" }, "size"],
      ["pRing", { variant: "donut" }, "variant"],
      ["pBar", { tone: "purple" }, "tone"],
      ["skel", { shape: "circle" }, "shape"],
      ["spin", { variant: "dots" }, "variant"],
      ["spin", { size: "lg" }, "size"],
      ["mOpen", { tone: "loud" }, "tone"],
      ["mOpen", { trend: { direction: "sideways", label: "x" } }, "trend.direction"],
      ["emptyBlock", { icon: "not-an-icon" }, "icon"],
      ["statusChips", { options: [{ value: "a", icon: "nope" }] }, "options.0"],
    ];
    for (const [id, props, path] of cases) {
      const paths = await pathsFor(withProps(id, props));
      expect({
        id,
        props,
        hit: paths.some((p) => p.startsWith(`${el(id)}.props.${path}`)),
      }).toEqual({ id, props, hit: true });
    }

    const detailKind = await pathsFor(
      withProps("detail", { fields: [{ key: "title", kind: "avatar" }] }),
    );
    expect(detailKind).toContain(`${el("detail")}.props.fields.0.kind`);

    const tabCount = await pathsFor(
      withProps("tabs", {
        tabs: [{ key: "list", count: "six" }, { key: "board" }, { key: "new" }],
      }),
    );
    expect(tabCount).toContain(`${el("tabs")}.props.tabs.0.count`);
  });

  test("unknown props on the new blocks are rejected", async () => {
    const paths = await pathsFor(withProps("formSection", { open: true }));
    expect(paths).toContain(`${el("formSection")}.props.open`);
  });

  test("DetailList and Kanban cardFields accept the new field kinds", async () => {
    const kinds = ["status", "user", "relative", "copy", "json", "code", "badge"];
    const fields = kinds.map((kind) => ({ key: "title", kind }));
    expect(await issuesFor(withProps("detail", { fields }))).toEqual([]);
    expect(await issuesFor(withProps("board", { cardFields: fields }))).toEqual([]);
  });
});

describe("ui.toast", () => {
  const toastStep = (params: Record<string, unknown>) =>
    edit((elements) => {
      elements.alert!.on = { press: [{ action: "ui.toast", params }] };
    });
  const stepPath = `${el("alert")}.on.press.0.params`;

  test("message, description, tone and an undo chain validate", async () => {
    const issues = await issuesFor(
      toastStep({
        message: "Saved",
        description: "Two rows changed",
        tone: "warning",
        undo: {
          label: "Revert",
          actions: [
            { action: "app.mutate", params: { model: "order", op: "delete", rowId: "ord_1" } },
          ],
        },
      }),
    );
    expect(issues).toEqual([]);
  });

  test("message is required and tone is an enum", async () => {
    expect(await pathsFor(toastStep({ tone: "info" }))).toContain(`${stepPath}.message`);
    expect(await pathsFor(toastStep({ message: "x", tone: "loud" }))).toContain(`${stepPath}.tone`);
  });

  test("undo.actions steps get the same per-action checks as any chain", async () => {
    const unknownAction = await pathsFor(
      toastStep({ message: "x", undo: { actions: [{ action: "app.explode" }] } }),
    );
    expect(unknownAction).toContain(`${stepPath}.undo.actions.0.action`);

    const unknownModel = await pathsFor(
      toastStep({
        message: "x",
        undo: { actions: [{ action: "app.mutate", params: { model: "nope", op: "create" } }] },
      }),
    );
    expect(unknownModel).toContain(`${stepPath}.undo.actions.0.params.model`);

    const unknownQuery = await pathsFor(
      toastStep({
        message: "x",
        undo: { actions: [{ action: "app.refresh", params: { query: "nope" } }] },
      }),
    );
    expect(unknownQuery).toContain(`${stepPath}.undo.actions.0.params.query`);

    const unknownPage = await pathsFor(
      toastStep({
        message: "x",
        undo: { actions: [{ action: "app.navigate", params: { page: "nope" } }] },
      }),
    );
    expect(unknownPage).toContain(`${stepPath}.undo.actions.0.params.page`);
  });

  test("undo requires an actions chain", async () => {
    const paths = await pathsFor(toastStep({ message: "x", undo: { label: "Undo" } }));
    expect(paths).toContain(`${stepPath}.undo.actions`);
  });

  test("an undo chain nested in a Table row action keeps its $row sentinels valid", async () => {
    // The fixture's delete row action restores the row from `$row` in its undo chain.
    const table = (definition.pages.main.elements as Elements).table!;
    const chain = (table.props.rowActions as { actions: { action: string }[] }[])[0]!.actions;
    expect(chain.map((step) => step.action)).toEqual(["app.mutate", "ui.toast"]);
    expect(await issuesFor(definition)).toEqual([]);
  });
});

describe("Chips as a Table filter source", () => {
  test("a Chips id roots /ui/<id>/value like Select", async () => {
    const issues = await issuesFor(
      edit((elements) => {
        elements.filters!.children = ["search", "ownerFilter"];
        delete elements.statusChips;
      }),
    );
    expect(issues.map((issue) => issue.path)).toContain(`${el("table")}.props.filters.status`);
  });

  test("filters take an array meaning 'one of', and reject nested objects", async () => {
    expect(
      await issuesFor(withProps("table", { filters: { status: ["pending", "failed"] } })),
    ).toEqual([]);
    expect(await issuesFor(withProps("table", { filters: { status: [] } }))).toEqual([]);
    const paths = await pathsFor(withProps("table", { filters: { status: [{ value: "a" }] } }));
    expect(paths.some((path) => path.startsWith(`${el("table")}.props.filters.status`))).toBe(true);
  });

  test("array filters are still checked against the bound model's columns", async () => {
    const paths = await pathsFor(withProps("table", { filters: { stage: ["a"] } }));
    expect(paths).toContain(`${el("table")}.props.filters.stage`);
  });
});

describe("Drawer footer actions", () => {
  test("chains are validated like Table rowActions", async () => {
    const paths = await pathsFor(
      withProps("drawer", {
        actions: [
          {
            label: "Archive",
            actions: [
              { action: "app.mutate", params: { model: "ghost", op: "update", rowId: "x" } },
            ],
          },
        ],
      }),
    );
    expect(paths).toContain(`${el("drawer")}.props.actions.0.actions.0.params.model`);
  });

  test("navigation inside a footer chain is checked against the target page", async () => {
    const paths = await pathsFor(
      withProps("drawer", {
        actions: [{ label: "Go", actions: [{ action: "app.navigate", params: { page: "nope" } }] }],
      }),
    );
    expect(paths).toContain(`${el("drawer")}.props.actions.0.actions.0.params.page`);
  });

  test("placement is a Table-only field and label is required", async () => {
    const placement = await pathsFor(
      withProps("drawer", { actions: [{ label: "Go", placement: "menu", actions: [] }] }),
    );
    expect(placement).toContain(`${el("drawer")}.props.actions.0.placement`);
    const label = await pathsFor(withProps("drawer", { actions: [{ actions: [] }] }));
    expect(label).toContain(`${el("drawer")}.props.actions.0.label`);
  });

  test("app.mutate rowId accepts a $state binding (the open record's route param)", async () => {
    // Already used by the fixture's Drawer; an object that is not a binding still fails.
    const paths = await pathsFor(
      withProps("drawer", {
        actions: [
          {
            label: "Delete",
            variant: "destructive-outline",
            actions: [
              { action: "app.mutate", params: { model: "order", op: "delete", rowId: { id: 1 } } },
            ],
          },
        ],
      }),
    );
    expect(paths).toContain(`${el("drawer")}.props.actions.0.actions.0.params.rowId`);
  });
});
