import { describe, expect, test } from "bun:test";
import { parseAppDefinition } from "../apps/definition";

/**
 * The "PRs" admin app picked rows with a persisted `selected` switch column
 * (one server write per click, shared by every viewer). The migration swaps it
 * for the Table's `selectable` client-side selection. The patch is an RFC 7396
 * merge patch where a page element is atomic (it replaces whole), which is how
 * `app-patch` applies it; this test replays that and validates the result.
 */
const before = await Bun.file(
  new URL("./fixtures/prs-app-definition.json.txt", import.meta.url),
).json();
const patch = await Bun.file(
  new URL("./fixtures/prs-selection-migration.patch.json.txt", import.meta.url),
).json();

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `pages.<p>.elements.<e>` replaces whole; everything else merges, `null` deletes. */
function applyMergePatch(target: unknown, patchValue: unknown, path: string[] = []): unknown {
  const atomicElement = path.length === 4 && path[0] === "pages" && path[2] === "elements";
  if (!isObject(patchValue) || atomicElement) return patchValue;
  const out: Json = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patchValue)) {
    if (value === null) delete out[key];
    else out[key] = applyMergePatch(out[key], value, [...path, key]);
  }
  return out;
}

/**
 * `parseAppDefinition` checks `scriptId`s against the scripts table. The page
 * is what is under test, so swap the script-backed source and actions for
 * stand-ins of the same names; the page references them by name only.
 */
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

const after = applyMergePatch(before, patch.definition) as typeof before;
const elements = after.pages.main.elements as Record<string, { props: Json }>;
const table = elements.prTable!.props as {
  columns: { key: string }[];
  bulkActions: { label: string; actions: { params: { name: string } }[] }[];
};

describe("PRs app selection migration", () => {
  test("the current definition and the migrated one both validate", async () => {
    for (const definition of [before, after]) {
      const parsed = await parseAppDefinition(withoutScripts(definition));
      if (!parsed.success) console.error(parsed.issues);
      expect(parsed.success).toBe(true);
    }
  });

  test("the switch column and the toolbar's selected-row buttons are gone", () => {
    expect(table.columns.map((column) => column.key)).not.toContain("selected");
    expect(elements.mqBtn).toBeUndefined();
    expect(elements.reviewBtn).toBeUndefined();
    expect((elements.toolbar as unknown as { children: string[] }).children.sort()).toEqual([
      "mqPreviewBtn",
      "reviewPreviewBtn",
      "search",
    ]);
  });

  test("selection is client state keyed by prKey, with the two bulk actions", () => {
    expect(table).toMatchObject({ id: "prTable", rowId: "prKey", selectable: true });
    expect(table.bulkActions.map((action) => action.actions[0]!.params.name)).toEqual([
      "enqueue",
      "askReview",
    ]);
  });

  test("the model keeps its `selected` column, so no migration directive is needed", () => {
    expect(Object.keys(after.models.pr.columns)).toContain("selected");
    expect(after.models).toEqual(before.models);
  });

  test("the patch only touches page elements", () => {
    expect(Object.keys(patch.definition)).toEqual(["pages"]);
    expect(Object.keys(patch.definition.pages)).toEqual(["main"]);
    expect(Object.keys(patch.definition.pages.main)).toEqual(["elements"]);
  });
});
