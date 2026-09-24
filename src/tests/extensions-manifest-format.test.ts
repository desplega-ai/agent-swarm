import { describe, expect, test } from "bun:test";
import { parseManifestText, parseStructuredText } from "../extensions/manifest-format";
import { ExtensionManifestSchema } from "../types";

const YAML_MANIFEST = `# yaml-language-server: $schema=../manifest.schema.json
name: digest
description: Digest
version: 1.2.0
runtime: api
assets:
  hooks: hooks.ts
  scripts:
    - name: digest-collect
      file: scripts/collect.ts
      description: Collect
  schedules:
    - name: digest-daily
      script: digest-collect
      cronExpression: "0 9 * * *"
      timezone: UTC
      args:
        hours: 24
`;

const JSON_MANIFEST = JSON.stringify({
  name: "digest",
  description: "Digest",
  version: "1.2.0",
  runtime: "api",
  assets: {
    hooks: "hooks.ts",
    scripts: [{ name: "digest-collect", file: "scripts/collect.ts", description: "Collect" }],
    schedules: [
      {
        name: "digest-daily",
        script: "digest-collect",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        args: { hours: 24 },
      },
    ],
  },
});

function base() {
  return JSON.parse(JSON_MANIFEST) as {
    assets: {
      scripts: Array<Record<string, unknown>>;
      schedules: Array<Record<string, unknown>>;
    } & Record<string, unknown>;
  } & Record<string, unknown>;
}

function issues(manifest: unknown): string[] {
  const parsed = ExtensionManifestSchema.safeParse(manifest);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

describe("extension manifest format", () => {
  test("YAML and JSON manifests with the same content parse to the same object", () => {
    const fromYaml = parseManifestText("manifest.yaml", YAML_MANIFEST);
    const fromJson = parseManifestText("manifest.json", JSON_MANIFEST);
    expect(fromYaml).toEqual(fromJson);
    expect(parseManifestText("manifest.yml", YAML_MANIFEST)).toEqual(fromJson);
  });

  test("a JSON manifest may carry $schema", () => {
    const manifest = { $schema: "../manifest.schema.json", ...base() };
    expect(issues(manifest)).toEqual([]);
  });

  test("asset names must start with the extension name", () => {
    const manifest = base();
    manifest.assets.scripts[0]!.name = "collect";
    manifest.assets.schedules[0]!.script = "collect";
    expect(issues(manifest)).toContain('script name must start with "digest-"');
  });

  test("a schedule must call a declared script", () => {
    const manifest = base();
    manifest.assets.schedules[0]!.script = "digest-missing";
    expect(issues(manifest)).toContain(
      'schedule script "digest-missing" is not declared in assets.scripts',
    );
  });

  test("a schedule needs exactly one of cronExpression and intervalMs", () => {
    const both = base();
    both.assets.schedules[0]!.intervalMs = 60_000;
    expect(issues(both)).toContain("schedule needs exactly one of cronExpression or intervalMs");

    const neither = base();
    delete neither.assets.schedules[0]!.cronExpression;
    expect(issues(neither)).toContain("schedule needs exactly one of cronExpression or intervalMs");
  });

  test("unsafe file paths and unknown keys are rejected", () => {
    const unsafe = base();
    unsafe.assets.scripts[0]!.file = "../collect.ts";
    expect(issues(unsafe).length).toBeGreaterThan(0);

    const unknownKey = base();
    unknownKey.assets.scripts[0]!.source = "export default 1";
    expect(issues(unknownKey).length).toBeGreaterThan(0);
  });

  test("duplicate asset names are rejected", () => {
    const manifest = base();
    manifest.assets.scripts.push({ ...manifest.assets.scripts[0] });
    expect(issues(manifest)).toContain('duplicate script name "digest-collect"');
  });

  test("a manifest stored before assets shipped still parses", () => {
    expect(
      issues({
        name: "legacy",
        description: "Stored by an inline install",
        version: "1.0.0",
        runtime: "api",
        assets: { hooks: "hooks.ts", skills: [], workflows: [], schedules: [] },
      }),
    ).toEqual([]);
  });

  test("errors name the file", () => {
    expect(() => parseManifestText("digest/manifest.yaml", "name: [")).toThrow(
      "digest/manifest.yaml: cannot parse",
    );
    expect(() => parseManifestText("digest/manifest.json", "{}")).toThrow(
      "digest/manifest.json: invalid extension manifest",
    );
    expect(() => parseStructuredText("manifest.toml", "")).toThrow("unsupported format");
  });
});
