import { describe, expect, test } from "bun:test";
import { applyAppDefinitionPatch, parseAppDefinition } from "../apps/definition";

/**
 * The "PRs" admin app's table is mostly NONE / NO pills. This patch adopts the
 * Table's built-in column filters (`filterable`, per-column `filter`, pills,
 * `clearState`) and `muted` values on top of the row-selection migration. It is
 * an RFC 7396 merge patch where a page element is atomic (replaces whole),
 * which is how `app-patch` applies it; this test replays both patches in order
 * and validates the result.
 */
const fixtures = new URL("./fixtures/", import.meta.url);
const before = await Bun.file(new URL("prs-app-definition.json.txt", fixtures)).json();
const selectionPatch = await Bun.file(
  new URL("prs-selection-migration.patch.json.txt", fixtures),
).json();
const patch = await Bun.file(new URL("prs-filters-migration.patch.json.txt", fixtures)).json();

type Json = Record<string, unknown>;
/** `parseAppDefinition` checks `scriptId`s against the scripts table; the page is what is under test. */
function withoutScripts(definition: typeof before) {
  const copy = structuredClone(definition);
  const model = copy.models.pr;
  delete model.sources;
  for (const column of Object.values(model.columns) as Json[]) delete column.source;
  for (const name of Object.keys(copy.actions)) {
    copy.actions[name] = { kind: "task", prompt: name };
  }
  return copy;
}

const selection = applyAppDefinitionPatch(before, selectionPatch.definition);
if (!selection.success) throw new Error(JSON.stringify(selection.issues));
const selected = selection.definition as typeof before;
const filtered = applyAppDefinitionPatch(selected, patch.definition);
if (!filtered.success) throw new Error(JSON.stringify(filtered.issues));
const after = filtered.definition as typeof before;
const elements = selected.pages.main.elements as Record<
  string,
  { props: Json; children: string[] }
>;
type Column = { key: string; kind?: string; filter?: string; muted?: string[]; width?: number };
const tableOf = (definition: typeof before) =>
  (definition.pages.main.elements as unknown as Record<string, { props: Json }>).prTable!.props as {
    id: string;
    selectable: boolean;
    filterable: boolean;
    clearState: string[];
    columns: Column[];
    bulkActions: { actions: { params: { name: string } }[] }[];
  };
const table = tableOf(after);
const column = (key: string) => table.columns.find((c) => c.key === key)!;

describe("PRs app selection and filters migrations", () => {
  test("the selection migration and the filters migration, replayed in order, validate", async () => {
    for (const definition of [before, selected, after]) {
      const parsed = await parseAppDefinition(withoutScripts(definition));
      if (!parsed.success) console.error(parsed.issues);
      expect(parsed.success).toBe(true);
    }
  });

  test("the table keeps its selection and gains filters", () => {
    const selectedTable = tableOf(selected);
    expect(selectedTable.columns.map((column) => column.key)).not.toContain("selected");
    expect(elements.mqBtn).toBeUndefined();
    expect(elements.reviewBtn).toBeUndefined();
    expect(elements.toolbar!.children.toSorted()).toEqual([
      "mqPreviewBtn",
      "reviewPreviewBtn",
      "search",
    ]);
    expect(selectedTable).toMatchObject({ id: "prTable", rowId: "prKey", selectable: true });
    expect(selectedTable.bulkActions.map((action) => action.actions[0]!.params.name)).toEqual([
      "enqueue",
      "askReview",
    ]);
    expect(Object.keys(selected.models.pr.columns)).toContain("selected");
    expect(selected.models).toEqual(before.models);
    expect(table).toMatchObject({ id: "prTable", selectable: true, filterable: true });
    expect(table.bulkActions).toHaveLength(2);
    expect(selectedTable.filterable).toBeUndefined();
    // Reapplying selection must remove filter properties by replacing the table whole.
    expect(applyAppDefinitionPatch(after, selectionPatch.definition)).toEqual({
      success: true,
      definition: selected,
    });
  });

  test("the all-NONE columns mute their empty values", () => {
    expect(column("ci").muted).toEqual(["none"]);
    expect(column("queue").muted).toEqual(["no"]);
    expect(column("jev").muted).toEqual(["none"]);
    expect(column("lead").muted).toEqual(["none"]);
    expect(column("mergeState").muted).toBeUndefined();
  });

  test("author filters as a list and the PR column as text, because both lack a pill kind", () => {
    expect(column("author").filter).toBe("values");
    expect(column("number").filter).toBe("text");
  });

  test("Clear filters also resets the search box that feeds the table", () => {
    expect(table.clearState).toEqual(["/ui/prSearch/value"]);
  });

  test("selection touches page elements and filters restate only the table", () => {
    expect(Object.keys(selectionPatch.definition)).toEqual(["pages"]);
    expect(Object.keys(selectionPatch.definition.pages)).toEqual(["main"]);
    expect(Object.keys(selectionPatch.definition.pages.main)).toEqual(["elements"]);
    expect(Object.keys(patch.definition)).toEqual(["pages"]);
    expect(Object.keys(patch.definition.pages.main.elements)).toEqual(["prTable"]);
  });
});
