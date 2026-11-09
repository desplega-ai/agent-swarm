import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb, resetDbForTests } from "../db/client.ts";
import { createRun, getRun } from "../db/queries.ts";
import { parseToolUses } from "../judge/session-log-parse.ts";
import {
  installApiExtension,
  loadApiExtension,
  resolveApiConfigFromEnv,
  toolCoverage,
} from "./api-extension.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "api-extension-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const manifest = {
  name: "demo",
  description: "d",
  version: "1.0.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
};

describe("loadApiExtension", () => {
  test("reads the hooks file a manifest names and merges plan config over the bundle's", async () => {
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(dir, "hooks.ts"), "export default () => {}");
    const loaded = await loadApiExtension({ path: dir, config: { mode: "enforce" } });
    expect(loaded.payload.files).toEqual({ "hooks.ts": "export default () => {}" });
    expect(loaded.payload.config).toEqual({ mode: "enforce" });
    const other = await loadApiExtension({ path: dir, config: { mode: "log" } });
    expect(other.sha256).not.toBe(loaded.sha256);
  });

  test("an install-payload.json in the directory is used as is", async () => {
    await writeFile(
      join(dir, "install-payload.json"),
      JSON.stringify({ manifest, files: { "hooks.ts": "x" }, config: { a: 1, mode: "log" } }),
    );
    const loaded = await loadApiExtension({ path: dir, config: { mode: "enforce" } });
    expect(loaded.payload.config).toEqual({ a: 1, mode: "enforce" });
    expect(loaded.payload.files["hooks.ts"]).toBe("x");
  });

  test("a bundle with no name fails before any sandbox", async () => {
    await writeFile(join(dir, "p.json"), JSON.stringify({ manifest: {}, files: {} }));
    await expect(loadApiExtension({ path: join(dir, "p.json") })).rejects.toThrow("manifest");
  });

  describe("a bundle cannot reach files outside itself", () => {
    let outside: string;
    let bundle: string;
    beforeEach(async () => {
      outside = await mkdtemp(join(tmpdir(), "api-extension-outside-"));
      await writeFile(join(outside, "secret.txt"), "TOP-SECRET");
      bundle = join(dir, "bundle");
      await mkdir(bundle);
    });
    afterEach(async () => {
      await rm(outside, { recursive: true, force: true });
    });
    const withAssets = (assets: unknown) =>
      writeFile(join(bundle, "manifest.json"), JSON.stringify({ ...manifest, assets }));

    test("rejects a traversal or absolute hooks path", async () => {
      for (const hooks of ["../x.ts", `${outside}/secret.txt`, "a/../../x.ts", "a\\b.ts", ""]) {
        await withAssets({ hooks });
        await expect(loadApiExtension({ path: bundle })).rejects.toThrow("unsafe bundle path");
      }
    });

    test("rejects an unsafe script path and a non-string one", async () => {
      await writeFile(join(bundle, "hooks.ts"), "x");
      await withAssets({ hooks: "hooks.ts", scripts: [{ file: "../secret.txt" }] });
      await expect(loadApiExtension({ path: bundle })).rejects.toThrow("unsafe bundle path");
      await withAssets({ hooks: "hooks.ts", scripts: [{ file: 5 }] });
      await expect(loadApiExtension({ path: bundle })).rejects.toThrow("unsafe bundle path");
    });

    test("rejects a symlinked hooks file, even one that points inside the bundle", async () => {
      await withAssets({ hooks: "hooks.ts" });
      await symlink(join(outside, "secret.txt"), join(bundle, "hooks.ts"));
      await expect(loadApiExtension({ path: bundle })).rejects.toThrow("symlink");
      await rm(join(bundle, "hooks.ts"));
      await writeFile(join(bundle, "real.ts"), "x");
      await symlink(join(bundle, "real.ts"), join(bundle, "hooks.ts"));
      await expect(loadApiExtension({ path: bundle })).rejects.toThrow("symlink");
    });

    test("rejects a file under a symlinked directory", async () => {
      await symlink(outside, join(bundle, "lib"));
      await withAssets({ hooks: "hooks.ts", scripts: [{ file: "lib/secret.txt" }] });
      await writeFile(join(bundle, "hooks.ts"), "x");
      await expect(loadApiExtension({ path: bundle })).rejects.toThrow("symlink");
    });

    test("rejects a symlinked manifest.json and install-payload.json", async () => {
      await symlink(join(outside, "secret.txt"), join(bundle, "manifest.json"));
      await expect(loadApiExtension({ path: bundle })).rejects.toThrow("symlink");
      await rm(join(bundle, "manifest.json"));
      await writeFile(join(outside, "p.json"), JSON.stringify({ manifest, files: {} }));
      await symlink(join(outside, "p.json"), join(bundle, "install-payload.json"));
      await expect(loadApiExtension({ path: bundle })).rejects.toThrow("symlink");
    });

    test("a missing hooks file is an error, not a skip", async () => {
      await withAssets({ hooks: "hooks.ts" });
      await expect(loadApiExtension({ path: bundle })).rejects.toThrow("not found");
    });

    test("a bundle reached through a symlinked root still loads", async () => {
      await withAssets({ hooks: "hooks.ts" });
      await writeFile(join(bundle, "hooks.ts"), "ok");
      await symlink(bundle, join(dir, "link"));
      const loaded = await loadApiExtension({ path: join(dir, "link") });
      expect(loaded.payload.files).toEqual({ "hooks.ts": "ok" });
    });
  });
});

describe("resolveApiConfigFromEnv", () => {
  test("copies set variables and names every missing one", () => {
    expect(resolveApiConfigFromEnv({ path: "p", configFromEnv: ["A"] }, { A: "1" })).toEqual({
      A: "1",
    });
    expect(() =>
      resolveApiConfigFromEnv({ path: "p", configFromEnv: ["A", "B", "C"] }, { A: "1", C: " " }),
    ).toThrow("B, C not set");
  });
});

describe("installApiExtension", () => {
  test("seeds credentials as non-exported secrets, installs, then enables", async () => {
    const calls: { method: string; url: string; body: any }[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      url: string,
      init: RequestInit,
    ) => {
      calls.push({
        method: init.method ?? "GET",
        url,
        body: init.body ? JSON.parse(`${init.body}`) : null,
      });
      const extension = { id: "ext-1", agentId: "agent-9", version: 1, enabled: true };
      return new Response(JSON.stringify({ extension }), { status: 200 });
    }) as unknown as typeof fetch);
    try {
      const installed = await installApiExtension({
        apiUrl: "http://api",
        swarmKey: "k",
        loaded: { payload: { manifest, files: {} }, sha256: "abc" },
        configRows: { CLOUDFLARE_API_KEY: "secret", CLOUDFLARE_ACCOUNT_ID: "acct" },
      });
      expect(installed).toEqual({
        id: "ext-1",
        agentId: "agent-9",
        name: "demo",
        version: 1,
        sha256: "abc",
      });
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        "PUT http://api/api/config",
        "PUT http://api/api/config",
        "POST http://api/api/extensions/install",
        "POST http://api/api/extensions/ext-1/enable",
      ]);
      expect(calls[0]?.body).toMatchObject({
        scope: "global",
        key: "CLOUDFLARE_API_KEY",
        isSecret: true,
        exportToEnv: false,
      });
      expect(calls[1]?.body).toMatchObject({ key: "CLOUDFLARE_ACCOUNT_ID", isSecret: false });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("a failed call reports status and path, never the request body", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch,
    );
    try {
      const err = await installApiExtension({
        apiUrl: "http://api",
        swarmKey: "k",
        loaded: { payload: { manifest, files: {} }, sha256: "abc" },
        configRows: { CLOUDFLARE_API_KEY: "sekret-value" },
      }).then(
        () => new Error("expected a failure"),
        (e: Error) => e,
      );
      expect(err.message).toContain("PUT /api/config -> 400");
      expect(err.message).not.toContain("sekret-value");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("toolCoverage", () => {
  const run = (subject: string, action = "continue", event = "pre.tool.call") => ({
    event,
    action,
    subject,
    durationMs: 1,
    message: null,
    agentId: null,
    createdAt: "t",
  });

  test("counts gated vs all calls per tool, MCP prefix or not", () => {
    const cov = toolCoverage(
      [
        run("tool send-task"),
        run("tool get-tasks", "block"),
        run("task x", "continue", "post.task.created"),
      ],
      ["mcp__agent-swarm__send-task", "mcp__agent-swarm__get-tasks", "bash", "bash", "read"],
    );
    expect(cov.gatedCalls).toBe(2);
    expect(cov.allCalls).toBe(5);
    expect(cov.coverage).toBeCloseTo(0.4);
    expect(cov.byTool["send-task"]).toEqual({ all: 1, gated: 1 });
    expect(cov.byTool.bash).toEqual({ all: 2, gated: 0 });
    expect(cov.gatedActions).toEqual({ continue: 1, block: 1 });
  });

  test("one codex call logged as started then completed is 100% covered, not 50%", () => {
    const line = (type: string) => ({
      id: crypto.randomUUID(),
      taskId: "t",
      sessionId: "s",
      iteration: 0,
      cli: "codex",
      lineNumber: 0,
      createdAt: "t",
      content: JSON.stringify({
        type,
        item: { type: "mcp_tool_call", id: "item_0", server: "x", tool: "send-task" },
      }),
    });
    const names = parseToolUses([line("item.started"), line("item.completed")]).map(
      (t) => t.toolName,
    );
    expect(toolCoverage([run("tool send-task")], names).coverage).toBe(1);
  });

  test("coverage ignores hook runs for calls the logs never show", () => {
    const cov = toolCoverage(
      [run("tool get-tasks"), run("tool get-tasks"), run("tool get-tasks")],
      ["mcp__agent-swarm__get-tasks", "read"],
    );
    expect(cov.gatedCalls).toBe(3);
    expect(cov.coverage).toBeCloseTo(0.5);
  });

  test("no tool calls gives null coverage", () => {
    expect(toolCoverage([], []).coverage).toBeNull();
  });
});

describe("run persistence", () => {
  test("the api extension plan round-trips on the run row and is absent by default", async () => {
    resetDbForTests();
    const saved = { ...process.env };
    delete process.env.EVALS_DB_SYNC_URL;
    delete process.env.EVALS_DB_AUTH_TOKEN;
    process.env.EVALS_DB_PATH = ":memory:";
    try {
      await initDb();
      const db = getDb();
      const base = { scenarioIds: ["s"], configIds: ["c"], attemptsPerCell: 1, concurrency: 1 };
      await createRun(db, { id: "r1", ...base });
      await createRun(db, {
        id: "r2",
        ...base,
        apiExtension: { path: "/x", config: { mode: "enforce" }, configFromEnv: ["K"] },
      });
      expect((await getRun(db, "r1"))?.apiExtension).toBeNull();
      expect((await getRun(db, "r2"))?.apiExtension).toEqual({
        path: "/x",
        config: { mode: "enforce" },
        configFromEnv: ["K"],
      });
    } finally {
      resetDbForTests();
      process.env = saved;
    }
  });
});
