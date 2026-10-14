import { describe, expect, test } from "bun:test";
import { parseAppDefinition } from "../apps/definition";

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).json();

const definition = await fixture("catalog-inputs-definition.json.txt");

type Element = { type: string; props: Record<string, unknown>; [key: string]: unknown };
type Elements = Record<string, Element>;

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

const el = (id: string) => `pages.main.elements.${id}`;

describe("searchable and multi Select", () => {
  test("an app filtering a Table by a multi Select and a searchable Select passes validation", async () => {
    const issues = await issuesFor(definition);
    if (issues.length > 0) console.error(issues);
    expect(issues).toEqual([]);
  });

  test("backward compatibility: a Select with only the original props stays valid", async () => {
    const copy = structuredClone(definition);
    (copy.pages.main.elements as Elements).ownerSelect!.props = {
      id: "ownerSelect",
      label: "Owner",
      placeholder: "Anyone",
      clearable: true,
      options: ["Ana Ruiz", { value: "Lena Park", label: "Lena" }],
    };
    expect(await issuesFor(copy)).toEqual([]);
  });

  test("option icons come from the curated set", async () => {
    const paths = (
      await issuesFor(withProps("statusSelect", { options: [{ value: "a", icon: "nope" }] }))
    ).map((issue) => issue.path);
    expect(paths.some((path) => path.startsWith(`${el("statusSelect")}.props.options.0`))).toBe(
      true,
    );
  });

  test("searchable and multiple must be booleans", async () => {
    for (const prop of ["searchable", "multiple"]) {
      const paths = (await issuesFor(withProps("ownerSelect", { [prop]: "yes" }))).map(
        (issue) => issue.path,
      );
      expect(paths).toContain(`${el("ownerSelect")}.props.${prop}`);
    }
  });

  test("a Table filter bound to an undeclared Select id is rejected", async () => {
    const copy = structuredClone(definition);
    const elements = copy.pages.main.elements as Elements;
    delete elements.statusSelect;
    elements.filters!.children = ["search", "ownerSelect"];
    const paths = (await issuesFor(copy)).map((issue) => issue.path);
    expect(paths).toContain(`${el("table")}.props.filters.status`);
  });
});
