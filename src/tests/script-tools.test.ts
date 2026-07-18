/**
 * Extension system, Layer 3: script-backed tools.
 *
 * Covers:
 * - script_tools DB layer: create/get/list/enable/delete + unique toolName.
 * - registerDynamicScriptTools(): enabled rows become registered MCP tools on
 *   a real createServer() instance; disabled rows and rows whose backing
 *   script is missing are skipped.
 * - runGlobalScriptByName(): executes a real catalog script and surfaces its
 *   return value; throws on script failure.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, initDb } from "../be/db";
import {
  createScriptTool,
  deleteScriptTool,
  getScriptToolByName,
  listScriptTools,
  setScriptToolEnabled,
} from "../be/script-tools-db";
import { upsertScriptByName } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { runGlobalScriptByName } from "../be/scripts/run-global";
import { createServer } from "../server";

const TEST_DB_PATH = "./test-script-tools.sqlite";
const API_KEY = "test-script-tools-key-1234567890";

const noOpEmbeddingProvider = {
  name: "test/noop-script-tools-embedding",
  dimensions: 1,
  async embed() {
    return null;
  },
  async embedBatch(texts: string[]) {
    return texts.map(() => null);
  },
};

let savedEnv: NodeJS.ProcessEnv;
let agentId: string;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function getRegisteredToolNames(server: ReturnType<typeof createServer>): Set<string> {
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
    ._registeredTools;
  return new Set(Object.keys(tools));
}

beforeAll(async () => {
  savedEnv = { ...process.env };
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  delete process.env.API_KEY;
  setScriptEmbeddingProviderForTests(noOpEmbeddingProvider);
  const agent = createAgent({ name: "script-tools-test-agent", isLead: true, status: "idle" });
  agentId = agent.id;

  await upsertScriptByName({
    name: "tool-echo",
    scope: "global",
    source: `export default async function run(args: Record<string, unknown>) { return { echoed: args }; }`,
    description: "echo test script",
    intent: "script-tools test fixture",
    signatureJson: JSON.stringify({ args: { type: "object" }, result: { type: "object" } }),
    agentId,
    typeChecked: true,
  });
  await upsertScriptByName({
    name: "tool-throws",
    scope: "global",
    source: `export default async function run() { throw new Error("nope"); }`,
    description: "always-fails test script",
    intent: "script-tools test fixture",
    signatureJson: JSON.stringify({ args: { type: "object" }, result: { type: "object" } }),
    agentId,
    typeChecked: true,
  });
});

afterAll(async () => {
  setScriptEmbeddingProviderForTests(null);
  closeDb();
  await removeDbFiles();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("script_tools DB layer", () => {
  test("create, get, list, toggle, delete", () => {
    const tool = createScriptTool({
      toolName: "db-layer-tool",
      scriptName: "tool-echo",
      description: "d",
      createdByAgentId: agentId,
    });
    expect(tool.enabled).toBe(true);
    expect(getScriptToolByName("db-layer-tool")?.scriptName).toBe("tool-echo");
    expect(listScriptTools().some((t) => t.toolName === "db-layer-tool")).toBe(true);

    expect(setScriptToolEnabled("db-layer-tool", false)).toBe(true);
    expect(getScriptToolByName("db-layer-tool")?.enabled).toBe(false);
    expect(listScriptTools({ enabledOnly: true }).some((t) => t.toolName === "db-layer-tool")).toBe(
      false,
    );

    expect(deleteScriptTool("db-layer-tool")).toBe(true);
    expect(getScriptToolByName("db-layer-tool")).toBeNull();
  });

  test("toolName is unique", () => {
    createScriptTool({ toolName: "unique-tool", scriptName: "tool-echo", description: "d" });
    expect(() =>
      createScriptTool({ toolName: "unique-tool", scriptName: "tool-echo", description: "d" }),
    ).toThrow();
    deleteScriptTool("unique-tool");
  });
});

describe("registerDynamicScriptTools via createServer", () => {
  test("enabled tools register; disabled and script-missing rows are skipped", () => {
    createScriptTool({ toolName: "dyn-enabled", scriptName: "tool-echo", description: "d" });
    createScriptTool({
      toolName: "dyn-disabled",
      scriptName: "tool-echo",
      description: "d",
      enabled: false,
    });
    createScriptTool({ toolName: "dyn-orphan", scriptName: "no-such-script", description: "d" });

    const server = createServer();
    const names = getRegisteredToolNames(server);
    expect(names.has("dyn-enabled")).toBe(true);
    expect(names.has("dyn-disabled")).toBe(false);
    expect(names.has("dyn-orphan")).toBe(false);
    expect(names.has("script-tools")).toBe(true);

    deleteScriptTool("dyn-enabled");
    deleteScriptTool("dyn-disabled");
    deleteScriptTool("dyn-orphan");
  });
});

describe("runGlobalScriptByName", () => {
  test("returns the script result", async () => {
    const { result } = await runGlobalScriptByName({
      scriptName: "tool-echo",
      args: { x: 1 },
      agentId,
    });
    expect(result).toMatchObject({ echoed: { x: 1 } });
  }, 30_000);

  test("throws on failing script and missing script", async () => {
    await expect(
      runGlobalScriptByName({ scriptName: "tool-throws", args: {}, agentId }),
    ).rejects.toThrow("nope");
    await expect(
      runGlobalScriptByName({ scriptName: "does-not-exist", args: {}, agentId }),
    ).rejects.toThrow("not found");
  }, 30_000);
});
