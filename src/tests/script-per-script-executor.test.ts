import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import { createAgent, initDb } from "../be/db";
import { getScriptById, insertScript, upsertScriptByName } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { runSavedScriptAsAgent } from "../be/scripts/run-saved";
import { runScript } from "../scripts-runtime/loader";
import { ScriptExecutorNameSchema, ScriptRecordSchema } from "../types";

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

  test("explicit executor: 'native' overrides SCRIPT_EXECUTOR=quickjs", async () => {
    process.env.SCRIPT_EXECUTOR = "quickjs";
    const out = await runScript({
      source: RUNTIME_PROBE_SOURCE,
      agentId: "00000000-0000-0000-0000-000000000001",
      executor: "native",
      egressSecrets: [],
    });
    expect(out.exitCode).toBe(0);
    expect(out.error).toBeUndefined();
    expect(out.result).toEqual({ hasProcess: true });
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

    process.env.SCRIPT_EXECUTOR = "quickjs";
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
  });
});
