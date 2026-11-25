import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { swarmCatalogSpec } from "../../apps/ui/src/lib/json-render/catalog";
import catalog from "../apps/catalog.generated.json";

// `src/apps/catalog.generated.json` is what the API server validates app pages
// against. It is generated from the dashboard catalog; a prop added to the
// catalog without regenerating it is rejected by the server as unknown.
// Regenerate with `cd apps/ui && bun run generate:catalog-schema`.

const toSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-7" });
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("generated app catalog matches the dashboard catalog", () => {
  test("component and action names", () => {
    expect(catalog.componentTypes).toEqual(Object.keys(swarmCatalogSpec.components));
    expect(catalog.actionTypes).toEqual(Object.keys(swarmCatalogSpec.actions));
  });

  for (const [name, def] of Object.entries(swarmCatalogSpec.components)) {
    test(`component ${name}: props and description`, () => {
      const generated = (catalog.components as Record<string, any>)[name];
      expect(generated?.description).toBe(def.description);
      expect(generated?.props).toEqual(plain(toSchema(def.props)));
    });
  }

  for (const [name, def] of Object.entries(swarmCatalogSpec.actions)) {
    test(`action ${name}: params and description`, () => {
      const generated = (catalog.actions as Record<string, any>)[name];
      expect(generated?.description).toBe(def.description);
      expect(generated?.params).toEqual(plain(toSchema(def.params)));
    });
  }
});

// `app-catalog { topic: "expressions" }` serves this reference. Every `$state`
// root the validator accepts must appear in it, so a new root fails here
// until it is documented.
describe("expressions reference covers every validator state root", () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");
  const validator = read("../apps/page-validator.ts");
  const start = validator.indexOf("function validateStateRef(");
  const body = validator.slice(start, validator.indexOf("\nconst COMPARISON_KEYS", start));
  const reference = read("../apps/expressions-reference.md");

  const roots = new Set<string>();
  // String literals: "/route/params", "/presence/count", ...
  for (const [, literal] of body.matchAll(/"(\/[a-z][a-z/]*)"/g)) roots.add(literal!);
  // Regex roots: /^\/app\/ ... and alternations /^\/(queries|forms|...)\/
  for (const [, root] of body.matchAll(/\/\^\\\/([a-z]+)\\\//g)) roots.add(`/${root}/`);
  for (const [, group] of body.matchAll(/\/\^\\\/\(([a-z|]+)\)/g)) {
    for (const root of group!.split("|")) roots.add(`/${root}/`);
  }

  test("the scan finds the known roots (control)", () => {
    for (const known of ["/app/", "/local/", "/route/params", "/user/", "/queries/", "/ui/"]) {
      expect(roots).toContain(known);
    }
  });

  for (const root of roots) {
    test(`documents ${root}`, () => {
      expect(reference).toContain(`\`${root}`);
    });
  }

  for (const term of ["$param", "$template", "$item", "$index", "$row", "everyMs", "watch"]) {
    test(`documents ${term}`, () => {
      expect(reference).toContain(term);
    });
  }
});
