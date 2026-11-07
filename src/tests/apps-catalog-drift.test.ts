import { describe, expect, test } from "bun:test";
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
