import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import { Readable } from "node:stream";
import { createAgent, getScriptRun, initDb, listScriptRuns } from "../be/db";
import { getScriptById, insertScript, upsertScriptByName } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { runSavedScriptAsAgent } from "../be/scripts/run-saved";
import { typecheckScript } from "../be/scripts/typecheck";
import { handleScripts } from "../http/scripts";
import {
  isExecutorAllowedByDeployment,
  resolveScriptExecutor,
} from "../scripts-runtime/executors/registry";
import { runScript } from "../scripts-runtime/loader";
import { type ScheduledTask, ScriptExecutorNameSchema, ScriptRecordSchema } from "../types";
import { SwarmScriptExecutor } from "../workflows/executors/swarm-script";

process.env.TMPDIR ??= os.tmpdir().replaceAll("\\", "/");
process.env.API_KEY ??= "test-per-script-executor-api-key";
process.env.MCP_BASE_URL ??= "http://127.0.0.1:19999";

const RUNTIME_PROBE_SOURCE =
  'export default async () => ({ hasProcess: typeof (globalThis as { process?: unknown }).process !== "undefined" });';

const savedScriptExecutorEnv = process.env.SCRIPT_EXECUTOR;

afterEach(() => {
  if (savedScriptExecutorEnv === undefined) {
    delete process.env.SCRIPT_EXECUTOR;
  } else {
    process.env.SCRIPT_EXECUTOR = savedScriptExecutorEnv;
  }
});

describe("per-script executor schema (#2013)", () => {
  test("ScriptExecutorNameSchema accepts native and quickjs and rejects invalid names", () => {
    expect(ScriptExecutorNameSchema.safeParse("native").success).toBe(true);
    expect(ScriptExecutorNameSchema.safeParse("quickjs").success).toBe(true);
    expect(ScriptExecutorNameSchema.safeParse("e2b").success).toBe(false);
    expect(ScriptExecutorNameSchema.safeParse("").success).toBe(false);
  });

  test("ScriptRecordSchema defaults executor to null and accepts explicit executor", () => {
    const base = {
      id: "00000000-0000-0000-0000-000000000001",
      name: "demo",
      scope: "agent" as const,
      scopeId: "00000000-0000-0000-0000-000000000002",
      source: RUNTIME_PROBE_SOURCE,
      description: "",
      intent: "",
      signatureJson: "{}",
      argsJsonSchema: null,
      contentHash: "abc",
      version: 1,
      isScratch: false,
      typeChecked: true,
      fsMode: "none" as const,
      createdByAgentId: null,
      createdAt: "2026-10-26T00:00:00.000Z",
      updatedAt: "2026-10-26T00:00:00.000Z",
    };

    expect(ScriptRecordSchema.parse(base).executor).toBeNull();
    expect(ScriptRecordSchema.parse({ ...base, executor: "quickjs" }).executor).toBe("quickjs");
    expect(ScriptRecordSchema.parse({ ...base, executor: "native" }).executor).toBe("native");
  });
});

describe("runScript per-script executor precedence (#2013)", () => {
  test("explicit executor: 'quickjs' overrides SCRIPT_EXECUTOR=native", async () => {
    process.env.SCRIPT_EXECUTOR = "native";
    const out = await runScript({
      source: RUNTIME_PROBE_SOURCE,
      agentId: "00000000-0000-0000-0000-000000000001",
      executor: "quickjs",
      egressSecrets: [],
    });
    expect(out.exitCode).toBe(0);
    expect(out.error).toBeUndefined();
    expect(out.result).toEqual({ hasProcess: false });
  });

  test("explicit executor: 'native' is denied when deployment SCRIPT_EXECUTOR=quickjs", async () => {
    process.env.SCRIPT_EXECUTOR = "quickjs";
    expect(isExecutorAllowedByDeployment("native")).toBe(false);
    expect(isExecutorAllowedByDeployment("quickjs")).toBe(true);
    expect(isExecutorAllowedByDeployment(null)).toBe(true);
    expect(() => resolveScriptExecutor("native")).toThrow(
      'Executor "native" is not permitted when deployment SCRIPT_EXECUTOR="quickjs"',
    );

    let canaryHits = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        canaryHits += 1;
        return new Response("reached");
      },
    });
    try {
      const out = await runScript({
        source: `export default async () => { await fetch("http://127.0.0.1:${server.port}/canary"); return { ok: true }; };`,
        agentId: "00000000-0000-0000-0000-000000000001",
        executor: "native",
        egressSecrets: [],
      });
      expect(out.exitCode).toBe(1);
      expect(out.error).toBe("executor_error");
      expect(out.stderr).toContain(
        'Executor "native" is not permitted when deployment SCRIPT_EXECUTOR="quickjs"',
      );
      expect(canaryHits).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("null or omitted executor falls back to SCRIPT_EXECUTOR", async () => {
    process.env.SCRIPT_EXECUTOR = "quickjs";
    const quickjsDefault = await runScript({
      source: RUNTIME_PROBE_SOURCE,
      agentId: "00000000-0000-0000-0000-000000000001",
      executor: null,
      egressSecrets: [],
    });
    expect(quickjsDefault.exitCode).toBe(0);
    expect(quickjsDefault.result).toEqual({ hasProcess: false });
  });

  test("null or omitted executor falls back to native when SCRIPT_EXECUTOR is unset", async () => {
    delete process.env.SCRIPT_EXECUTOR;
    const nativeDefault = await runScript({
      source: RUNTIME_PROBE_SOURCE,
      agentId: "00000000-0000-0000-0000-000000000001",
      executor: null,
      egressSecrets: [],
    });
    expect(nativeDefault.exitCode).toBe(0);
    expect(nativeDefault.result).toEqual({ hasProcess: true });
  }, 15_000);
});

describe("scripts DB & runSavedScriptAsAgent executor persistence (#2013)", () => {
  let agentId: string;

  beforeAll(async () => {
    initDb(":memory:");
    setScriptEmbeddingProviderForTests({
      name: "test/noop",
      dimensions: 1,
      async embed() {
        return null;
      },
      async embedBatch(texts) {
        return texts.map(() => null);
      },
    });
    const agent = await createAgent({ name: "exec-select-worker", isLead: false, status: "idle" });
    agentId = agent.id;
  });

  test("insertScript and upsertScriptByName persist executor and runSavedScriptAsAgent uses it", async () => {
    const inserted = await insertScript({
      name: `exec-probe-${crypto.randomUUID().slice(0, 8)}`,
      scope: "agent",
      scopeId: agentId,
      source: RUNTIME_PROBE_SOURCE,
      description: "probe",
      intent: "test",
      signatureJson: "{}",
      executor: "quickjs",
      agentId,
      typeChecked: true,
    });
    expect(inserted.executor).toBe("quickjs");
    expect((await getScriptById(inserted.id))?.executor).toBe("quickjs");

    process.env.SCRIPT_EXECUTOR = "native";
    const quickjsOut = await runSavedScriptAsAgent(
      { script: inserted, input: null, agentId },
      {
        buildCredentials: async () => ({
          egressSecrets: [],
          failedBindings: [],
          userConfig: {},
        }),
      },
    );
    expect(quickjsOut.exitCode).toBe(0);
    expect(quickjsOut.result).toEqual({ hasProcess: false });

    // Metadata-only upsert changing executor from "quickjs" to "native"
    const updated = await upsertScriptByName({
      name: inserted.name,
      scope: "agent",
      scopeId: agentId,
      source: RUNTIME_PROBE_SOURCE,
      description: "probe",
      intent: "test",
      signatureJson: "{}",
      executor: "native",
      agentId,
      typeChecked: true,
    });
    expect(updated.contentDeduped).toBe(true);
    expect(updated.script.executor).toBe("native");

    process.env.SCRIPT_EXECUTOR = "native";
    const nativeOut = await runSavedScriptAsAgent(
      { script: updated.script, input: null, agentId },
      {
        buildCredentials: async () => ({
          egressSecrets: [],
          failedBindings: [],
          userConfig: {},
        }),
      },
    );
    expect(nativeOut.exitCode).toBe(0);
    expect(nativeOut.result).toEqual({ hasProcess: true });

    // Under operator ceiling SCRIPT_EXECUTOR=quickjs, saved native script is denied
    process.env.SCRIPT_EXECUTOR = "quickjs";
    const deniedOut = await runSavedScriptAsAgent(
      { script: updated.script, input: null, agentId },
      {
        buildCredentials: async () => ({
          egressSecrets: [],
          failedBindings: [],
          userConfig: {},
        }),
      },
    );
    expect(deniedOut.exitCode).toBe(1);
    expect(deniedOut.error).toBe("executor_error");
    expect(deniedOut.stderr).toContain(
      'Executor "native" is not permitted when deployment SCRIPT_EXECUTOR="quickjs"',
    );
  });

  test("HTTP /api/scripts/upsert, /api/scripts/run, and GET /api/scripts enforce ceiling and expose executor", async () => {
    async function invokeScriptsHttp(opts: {
      method: string;
      pathSegments: string[];
      queryParams?: URLSearchParams;
      body?: unknown;
      agentId?: string;
    }): Promise<{ status: number; body: unknown }> {
      const payload = opts.body !== undefined ? JSON.stringify(opts.body) : "";
      const req = Object.assign(Readable.from(payload ? [Buffer.from(payload)] : []), {
        method: opts.method,
        url: `/${opts.pathSegments.join("/")}`,
        headers: {
          "content-type": "application/json",
          ...(opts.agentId ? { "x-agent-id": opts.agentId } : {}),
        },
      }) as unknown as IncomingMessage;

      let status = 200;
      const chunks: Buffer[] = [];
      const res = {
        writeHead(code: number) {
          status = code;
          return this;
        },
        setHeader() {
          return this;
        },
        end(chunk?: string | Buffer) {
          if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          return this;
        },
      } as unknown as ServerResponse;

      await handleScripts(
        req,
        res,
        opts.pathSegments,
        opts.queryParams ?? new URLSearchParams(),
        opts.agentId,
      );
      const text = Buffer.concat(chunks).toString("utf8");
      return { status, body: text ? JSON.parse(text) : null };
    }

    process.env.SCRIPT_EXECUTOR = "quickjs";

    const upsertDenied = await invokeScriptsHttp({
      method: "POST",
      pathSegments: ["api", "scripts", "upsert"],
      agentId,
      body: {
        name: "escape-attempt",
        scope: "agent",
        source: RUNTIME_PROBE_SOURCE,
        executor: "native",
      },
    });
    expect(upsertDenied.status).toBe(400);
    expect((upsertDenied.body as { error?: string }).error).toContain(
      'Executor "native" is not permitted when deployment SCRIPT_EXECUTOR="quickjs"',
    );

    const runDenied = await invokeScriptsHttp({
      method: "POST",
      pathSegments: ["api", "scripts", "run"],
      agentId,
      body: {
        source: RUNTIME_PROBE_SOURCE,
        executor: "native",
      },
    });
    expect(runDenied.status).toBe(400);
    expect((runDenied.body as { error?: string }).error).toContain(
      'Executor "native" is not permitted when deployment SCRIPT_EXECUTOR="quickjs"',
    );

    const listRes = await invokeScriptsHttp({
      method: "GET",
      pathSegments: ["api", "scripts"],
      queryParams: new URLSearchParams("scope=agent"),
    });
    expect(listRes.status).toBe(200);
    const listed = (listRes.body as { scripts: Array<{ executor: string | null }> }).scripts;
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.some((s) => s.executor === "native" || s.executor === "quickjs")).toBe(true);
  });

  test("workflow SwarmScriptExecutor and scheduler dispatchScheduleTarget forward script.executor", async () => {
    process.env.SCRIPT_EXECUTOR = "native";
    const globalQuickjs = await insertScript({
      name: `global-qjs-${crypto.randomUUID().slice(0, 8)}`,
      scope: "global",
      scopeId: null,
      source: RUNTIME_PROBE_SOURCE,
      description: "global quickjs script",
      intent: "test",
      signatureJson: "{}",
      executor: "quickjs",
      agentId,
      typeChecked: true,
    });

    const wfExecutor = new SwarmScriptExecutor({
      db: {
        getWorkflow: async () => null,
      } as never,
      eventBus: { emit: () => {} } as never,
    });
    const wfResult = await wfExecutor.run({
      config: { scriptName: globalQuickjs.name, scope: "global", fsMode: "none" },
      context: { agentId },
      meta: {
        runId: crypto.randomUUID(),
        stepId: crypto.randomUUID(),
        nodeId: "n1",
        workflowId: crypto.randomUUID(),
      },
    });
    expect(wfResult.status).toBe("success");
    if (wfResult.status === "success") {
      expect(wfResult.output.result).toEqual({ hasProcess: false });
    }

    const { executeScheduleScript } = await import("../scheduler/scheduler");
    const schedule: ScheduledTask = {
      id: crypto.randomUUID(),
      name: `sched-${globalQuickjs.name}`,
      taskTemplate: "",
      targetType: "script",
      scriptName: globalQuickjs.name,
      scriptArgs: {},
      tags: [],
      priority: 50,
      enabled: true,
      scheduleType: "recurring",
      consecutiveErrors: 0,
      createdByAgentId: agentId,
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    };
    await executeScheduleScript(schedule);
    const runs = await listScriptRuns({ limit: 10 });
    const matchedRun = runs.find((r) => r.scriptName === globalQuickjs.name);
    expect(matchedRun?.status).toBe("completed");
    const fullRun = matchedRun ? await getScriptRun(matchedRun.id) : null;
    expect(fullRun?.output).toEqual({ hasProcess: false });
  });

  test("typecheckScript accepts executor on ctx.swarm.script_upsert and ctx.swarm.script_run", async () => {
    const valid = await typecheckScript(
      `import type { ScriptContext } from "swarm-sdk";
      export default async (_args: unknown, ctx: ScriptContext) => {
        await ctx.swarm.script_upsert({ name: "demo", source: "export default async () => 1;", executor: "quickjs" });
        await ctx.swarm.script_run({ name: "demo", executor: "quickjs" });
        return { ok: true };
      };`,
      { agentId },
    );
    expect(valid.ok).toBe(true);

    const invalid = await typecheckScript(
      `import type { ScriptContext } from "swarm-sdk";
      export default async (_args: unknown, ctx: ScriptContext) => {
        await ctx.swarm.script_run({ name: "demo", executor: "e2b" });
        return { ok: true };
      };`,
      { agentId },
    );
    expect(invalid.ok).toBe(false);
  });
});
