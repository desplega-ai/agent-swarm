import { describe, expect, test } from "bun:test";
import { validateBundle } from "../be/extensions/validate";
import { loadBundleFixture } from "./fixtures/extensions/load";

describe("extension bundle validation", () => {
  test.each(["../escape.ts", "/abs.ts"])("rejects unsafe hooks path %s", async (path) => {
    const bundle = await loadBundleFixture("minimal");
    bundle.manifest.assets.hooks = path;
    const result = await validateBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.join("\n")).toContain("relative POSIX file path");
  });

  test("reports each unsafe file key", async () => {
    const bundle = await loadBundleFixture("minimal");
    bundle.files["../escape.ts"] = "";
    bundle.files["nested/../escape.ts"] = "";
    const result = await validateBundle(bundle);
    expect(result).toEqual({
      ok: false,
      diagnostics: [
        'Unsafe bundle file path: "../escape.ts"',
        'Unsafe bundle file path: "nested/../escape.ts"',
      ],
    });
  });
  test("accepts the minimal API extension", async () => {
    const bundle = await loadBundleFixture("minimal");
    expect(await validateBundle(bundle)).toEqual({ ok: true, manifest: bundle.manifest });
  });

  test("accepts zod and stdlib imports", async () => {
    const bundle = await loadBundleFixture("minimal");
    bundle.files["hooks.ts"] = `import { table } from "stdlib";
import type { SwarmExtension } from "swarm-extension";
import { z } from "zod";
export const config = z.object({ label: z.string() });
const extension: SwarmExtension = () => { void table([{ ok: true }]); };
export default extension;
`;
    expect(await validateBundle(bundle)).toEqual({ ok: true, manifest: bundle.manifest });
  });

  test("infers typed config from the extension manifest", async () => {
    const bundle = await loadBundleFixture("minimal");
    bundle.files["hooks.ts"] = `import type { SwarmExtension } from "swarm-extension";
import { z } from "zod";
export const config = z.object({ channelId: z.string(), agentId: z.string() });
const manifest = {
  name: "minimal",
  description: "Minimal extension",
  version: "1.0.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
  config,
} as const;
const extension: SwarmExtension<typeof manifest> = (api) => {
  api.on("pre.slack.route", (_event, ctx) => {
    const channelId: string = ctx.config.channelId;
    // @ts-expect-error channelId is inferred as a string.
    const invalid: number = ctx.config.channelId;
    void channelId;
    void invalid;
  });
};
export default extension;
`;
    expect(await validateBundle(bundle)).toEqual({ ok: true, manifest: bundle.manifest });
  });

  test("bare SwarmExtension uses API context", async () => {
    const valid = await loadBundleFixture("minimal");
    valid.files["hooks.ts"] = `import type { SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("post.task.created", (_event, ctx) => { void ctx.swarm; });
};
export default extension;
`;
    expect(await validateBundle(valid)).toEqual({ ok: true, manifest: valid.manifest });

    const invalid = await loadBundleFixture("minimal");
    invalid.files["hooks.ts"] = `import type { SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("post.task.created", (_event, ctx) => { void ctx.worker; });
};
export default extension;
`;
    const result = await validateBundle(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.join("\n")).toContain("worker");
  });

  test("explicit worker extensions keep worker context typing", async () => {
    const bundle = await loadBundleFixture("minimal");
    bundle.files["hooks.ts"] = `import type { SwarmExtension } from "swarm-extension";
type WorkerManifest = {
  name: "worker";
  description: "worker";
  version: "1.0.0";
  runtime: "worker";
  assets: { hooks: "hooks.ts" };
};
const workerExtension: SwarmExtension<WorkerManifest> = (api) => {
  api.on("post.task.created", (_event, ctx) => { const id: string = ctx.worker.agentId; void id; });
};
const extension: SwarmExtension = () => { void workerExtension; };
export default extension;
`;
    expect(await validateBundle(bundle)).toEqual({ ok: true, manifest: bundle.manifest });
  });

  test("rejects forbidden bare and relative imports", async () => {
    const badImport = await validateBundle(await loadBundleFixture("bad-import"));
    expect(badImport.ok).toBe(false);
    if (!badImport.ok) expect(badImport.diagnostics.join("\n")).toContain("node:fs");

    const relative = await loadBundleFixture("minimal");
    relative.files["hooks.ts"] = `import "./helper";\n${relative.files["hooks.ts"]}`;
    const relativeResult = await validateBundle(relative);
    expect(relativeResult.ok).toBe(false);
    if (!relativeResult.ok) {
      expect(relativeResult.diagnostics.join("\n")).toContain("Relative imports are not allowed");
    }
  });

  test("rejects computed imports, require, and import-equals", async () => {
    const cases = [
      ['const name = "zod"; void import(name);', "Computed import()"],
      ['const name = "zod"; void require(name);', "Computed require()"],
      ['import fs = require("node:fs"); void fs;', "node:fs"],
    ] as const;

    for (const [prefix, diagnostic] of cases) {
      const bundle = await loadBundleFixture("minimal");
      bundle.files["hooks.ts"] = `${prefix}\n${bundle.files["hooks.ts"]}`;
      const result = await validateBundle(bundle);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics.join("\n")).toContain(diagnostic);
    }
  });

  test("rejects worker runtime and reserved assets", async () => {
    const worker = await validateBundle(await loadBundleFixture("worker-runtime"));
    expect(worker.ok).toBe(false);
    if (!worker.ok) expect(worker.diagnostics).toContain('runtime "worker" is not supported in v1');

    const reserved = await validateBundle(await loadBundleFixture("reserved-assets"));
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) expect(reserved.diagnostics).toContain("assets.skills is not supported yet");

    const workflows = await loadBundleFixture("minimal");
    workflows.manifest.assets.workflows = ["flow.json"];
    const workflowsResult = await validateBundle(workflows);
    expect(workflowsResult).toEqual({
      ok: false,
      diagnostics: ["assets.workflows is not supported yet"],
    });
  });

  test("accepts declared scripts and schedules", async () => {
    const bundle = await loadBundleFixture("with-assets");
    expect(Object.keys(bundle.files).sort()).toEqual(["hooks.ts", "scripts/echo.ts"]);
    expect(await validateBundle(bundle)).toEqual({ ok: true, manifest: bundle.manifest });

    const cron = await loadBundleFixture("with-assets");
    cron.manifest.assets.schedules = [
      {
        name: "with-assets-daily",
        script: "with-assets-echo",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
    ];
    expect((await validateBundle(cron)).ok).toBe(true);
  });

  test("rejects a referenced script file missing from files", async () => {
    const bundle = await loadBundleFixture("with-assets");
    delete bundle.files["scripts/echo.ts"];
    expect(await validateBundle(bundle)).toEqual({
      ok: false,
      diagnostics: ['Referenced file "scripts/echo.ts" is missing from files'],
    });
  });

  test("rejects asset names without the extension prefix", async () => {
    const bundle = await loadBundleFixture("with-assets");
    bundle.manifest.assets.scripts = [
      { name: "echo", file: "scripts/echo.ts", description: "Echo the configured label" },
    ];
    bundle.manifest.assets.schedules = [{ name: "hourly", script: "echo", intervalMs: 3_600_000 }];
    const result = await validateBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const diagnostics = result.diagnostics.join("\n");
      expect(diagnostics).toContain(
        'assets.scripts.0.name: script name must start with "with-assets-"',
      );
      expect(diagnostics).toContain(
        'assets.schedules.0.name: schedule name must start with "with-assets-"',
      );
    }
  });

  test("rejects schedules for undeclared scripts and without exactly one trigger", async () => {
    const cases = [
      [
        { name: "with-assets-orphan", script: "with-assets-missing", intervalMs: 60_000 },
        'schedule script "with-assets-missing" is not declared in assets.scripts',
      ],
      [
        { name: "with-assets-none", script: "with-assets-echo" },
        "schedule needs exactly one of cronExpression or intervalMs",
      ],
      [
        {
          name: "with-assets-both",
          script: "with-assets-echo",
          cronExpression: "0 9 * * *",
          intervalMs: 60_000,
        },
        "schedule needs exactly one of cronExpression or intervalMs",
      ],
    ] as const;
    for (const [schedule, diagnostic] of cases) {
      const bundle = await loadBundleFixture("with-assets");
      bundle.manifest.assets.schedules = [schedule];
      const result = await validateBundle(bundle);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics.join("\n")).toContain(diagnostic);
    }
  });

  test("rejects extra files and a missing hooks file", async () => {
    const extra = await loadBundleFixture("minimal");
    extra.files["helper.ts"] = "export const helper = true;";
    const extraResult = await validateBundle(extra);
    expect(extraResult).toEqual({
      ok: false,
      diagnostics: ["Files not referenced by the manifest are not allowed: helper.ts"],
    });

    const missing = await loadBundleFixture("minimal");
    missing.manifest.assets.hooks = "missing.ts";
    const missingResult = await validateBundle(missing);
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.diagnostics.join("\n")).toContain("missing.ts");
  });

  test("rejects an invalid modify result", async () => {
    const result = await validateBundle(await loadBundleFixture("bad-return-shape"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.join("\n")).toContain("agentId");
    }
  });

  test("rejects derived task fields in a modify result", async () => {
    const bundle = await loadBundleFixture("minimal");
    bundle.files["hooks.ts"] = `import type { SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", () => ({ action: "modify", data: { status: "draft" } }));
};
export default extension;
`;
    const result = await validateBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.join("\n")).toContain("status");
  });

  test("rejects a non-Zod config export", async () => {
    const bundle = await loadBundleFixture("minimal");
    bundle.files["hooks.ts"] = `${bundle.files["hooks.ts"]}\nexport const config = {};\n`;
    const result = await validateBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics.join("\n")).toContain("not assignable to type 'false'");
  });
});
