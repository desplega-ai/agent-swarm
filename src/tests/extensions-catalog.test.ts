import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateBundle } from "../be/extensions/validate";
import { getCatalogEntry, getExtensionCatalog } from "../extensions/catalog";
import { buildExtensionCatalog } from "../extensions/catalog-build";
import { ExtensionManifestSchema } from "../types";

const tempDirs: string[] = [];

async function templatesDir(layout: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ext-catalog-"));
  tempDirs.push(root);
  for (const [path, content] of Object.entries(layout)) {
    await Bun.write(join(root, path), content);
  }
  return root;
}

const MANIFEST = (name: string) =>
  JSON.stringify({
    name,
    description: "d",
    version: "1.0.0",
    runtime: "api",
    assets: { hooks: "hooks.ts" },
  });

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("predefined extension catalog", () => {
  test("every bundled entry passes the manifest schema and bundle validation", async () => {
    const catalog = getExtensionCatalog();
    expect(Object.keys(catalog).sort()).toEqual([
      "notify-on-complete",
      "require-ticket-ref",
      "require-verification-note",
      "task-digest",
    ]);
    for (const [name, entry] of Object.entries(catalog)) {
      expect(entry.manifest.name).toBe(name);
      expect(ExtensionManifestSchema.safeParse(entry.manifest).success).toBe(true);
      const result = await validateBundle({ manifest: entry.manifest, files: entry.files });
      expect(result).toMatchObject({ ok: true });
    }
    expect(getCatalogEntry("task-digest")?.manifestFile).toBe("manifest.yaml");
    expect(getCatalogEntry("toString")).toBeNull();
  });

  test("the generator reads YAML and JSON templates and their referenced files", async () => {
    const dir = await templatesDir({
      "alpha/manifest.json": MANIFEST("alpha"),
      "alpha/hooks.ts": "export default () => {};",
      "alpha/README.md": "# alpha",
      "beta/manifest.yml": [
        "name: beta",
        "description: d",
        "version: 1.0.0",
        "runtime: api",
        "assets:",
        "  hooks: hooks.ts",
        "  scripts:",
        "    - { name: beta-run, file: scripts/run.ts, description: Run }",
      ].join("\n"),
      "beta/hooks.ts": "export default () => {};",
      "beta/scripts/run.ts": "export default async () => 1;",
      "beta/unreferenced.txt": "ignored",
    });
    const catalog = await buildExtensionCatalog(dir);
    expect(Object.keys(catalog)).toEqual(["alpha", "beta"]);
    expect(catalog.alpha).toMatchObject({ manifestFile: "manifest.json", readme: "# alpha" });
    expect(catalog.beta?.readme).toBeNull();
    expect(Object.keys(catalog.beta?.files ?? {})).toEqual(["hooks.ts", "scripts/run.ts"]);
  });

  test("two manifest files in one directory fail", async () => {
    const dir = await templatesDir({
      "alpha/manifest.json": MANIFEST("alpha"),
      "alpha/manifest.yaml": "name: alpha",
      "alpha/hooks.ts": "",
    });
    await expect(buildExtensionCatalog(dir)).rejects.toThrow(
      "alpha: expected exactly one of manifest.yaml, manifest.yml, manifest.json, found manifest.json, manifest.yaml",
    );
  });

  test("a manifest name that differs from its directory fails", async () => {
    const dir = await templatesDir({
      "alpha/manifest.json": MANIFEST("beta"),
      "alpha/hooks.ts": "",
    });
    await expect(buildExtensionCatalog(dir)).rejects.toThrow(
      'manifest name "beta" must equal the directory name',
    );
  });

  test("a missing referenced file fails", async () => {
    const dir = await templatesDir({ "alpha/manifest.json": MANIFEST("alpha") });
    await expect(buildExtensionCatalog(dir)).rejects.toThrow(
      'referenced file "hooks.ts" does not exist',
    );
  });
});
