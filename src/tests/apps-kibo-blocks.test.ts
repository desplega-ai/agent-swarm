import { describe, expect, test } from "bun:test";
import { parseAppDefinition } from "../apps/definition";

const definition = await Bun.file(
  new URL("./fixtures/kibo-blocks-definition.json.txt", import.meta.url),
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

describe("Kanban / Calendar / ContributionGraph blocks", () => {
  test("the example app with all three blocks passes page validation", async () => {
    const parsed = await parseAppDefinition(definition);
    if (!parsed.success) console.error(parsed.issues);
    expect(parsed.success).toBe(true);
  });

  test("field props are cross-checked against the bound query's model", async () => {
    expect(await issuesFor(withProps("board", { columnField: "stag" }))).toContainEqual({
      path: "pages.main.elements.board.props.columnField",
      message: 'unknown or hidden column "stag" on model "deal"',
    });
    expect(await issuesFor(withProps("board", { cardFields: [{ key: "ownr" }] }))).toContainEqual({
      path: "pages.main.elements.board.props.cardFields.0.key",
      message: 'unknown or hidden column "ownr" on model "deal"',
    });
    expect(await issuesFor(withProps("closeCalendar", { endField: "endDate" }))).toContainEqual({
      path: "pages.main.elements.closeCalendar.props.endField",
      message: 'unknown or hidden column "endDate" on model "deal"',
    });
    expect(await issuesFor(withProps("activity", { countField: "amount" }))).toContainEqual({
      path: "pages.main.elements.activity.props.countField",
      message: 'unknown or hidden column "amount" on model "deal"',
    });
  });

  test("action-chain props are validated like Form onSubmit", async () => {
    const unknownModel = await issuesFor(
      withProps("board", {
        onMove: [{ action: "app.mutate", params: { model: "nope", op: "update" } }],
      }),
    );
    expect(
      unknownModel.some((i) => i.path.startsWith("pages.main.elements.board.props.onMove")),
    ).toBe(true);

    const badRowField = await issuesFor(
      withProps("closeCalendar", {
        onSelect: [
          { action: "app.navigate", params: { page: "main", params: { deal: { $row: "nope" } } } },
        ],
      }),
    );
    expect(
      badRowField.some((i) =>
        i.path.startsWith("pages.main.elements.closeCalendar.props.onSelect"),
      ),
    ).toBe(true);
  });

  test("required props are enforced by the generated catalog", async () => {
    const copy = structuredClone(definition);
    delete (copy.pages.main.elements as Elements).board!.props.columnField;
    expect((await issuesFor(copy)).some((i) => i.path.includes("board.props"))).toBe(true);
  });
});
