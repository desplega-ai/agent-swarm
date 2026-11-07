import { describe, expect, test } from "bun:test";
import { parseAppDefinition } from "../apps/definition";

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

const selected = applyMergePatch(before, selectionPatch.definition) as typeof before;
const after = applyMergePatch(selected, patch.definition) as typeof before;
type Column = { key: string; kind?: string; filter?: string; muted?: string[]; width?: number };
const tableOf = (definition: typeof before) =>
  (definition.pages.main.elements as unknown as Record<string, { props: Json }>).prTable!.props as {
    id: string;
    selectable: boolean;
    filterable: boolean;
    clearState: string[];
    columns: Column[];
    bulkActions: unknown[];
  };
const table = tableOf(after);
const column = (key: string) => table.columns.find((c) => c.key === key)!;

describe("PRs app column filters and muted values", () => {
  test("the selection migration and the filters migration, replayed in order, validate", async () => {
    const parsed = await parseAppDefinition(withoutScripts(after));
    if (!parsed.success) console.error(parsed.issues);
    expect(parsed.success).toBe(true);
  });

  test("the table keeps its selection and gains filters", () => {
    expect(table).toMatchObject({ id: "prTable", selectable: true, filterable: true });
    expect(table.bulkActions).toHaveLength(2);
    expect(tableOf(selected).filterable).toBeUndefined();
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

  test("the patch restates the table element only", () => {
    expect(Object.keys(patch.definition)).toEqual(["pages"]);
    expect(Object.keys(patch.definition.pages.main.elements)).toEqual(["prTable"]);
  });
});
