import { describe, expect, test } from "bun:test";
import type { Addon } from "../be/seed/addons";
import { assertAddonReferences } from "../be/seed/registry";

function addonWithSkills(skillNames: string[]): Addon {
  return {
    name: "registry-fixture",
    description: "Fixture add-on for registry validation.",
    docsPath: "docs/registry-fixture.mdx",
    workflows: [],
    schedules: [],
    skillNames,
    scriptNames: [],
    configKeys: [],
  };
}

describe("add-on registry", () => {
  test("rejects an add-on skill that is absent from the parsed built-in catalog", () => {
    expect(() => assertAddonReferences([addonWithSkills(["not-a-built-in-skill"])])).toThrow(
      'Add-on "registry-fixture" references unknown seeded skill "not-a-built-in-skill"',
    );
  });
});
