import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  getKv,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import type { InstallExtensionArgs as ExtensionInstallBody } from "../be/extensions/db";
import { installExtension, listExtensionRuns } from "../be/extensions/db";
import { getExtensionBridgeToken, resolveBridgeCallOrigin } from "../extensions/dispatcher";
import { enableExtension, stopExtensionRuntime } from "../extensions/lifecycle";
import { registerStoreProgressTool } from "../tools/store-progress";
import {
  createToolRegistrar,
  markExtensionRequestOrigin,
  markScriptSdkRequestOrigin,
  swarmToolOutputSchema,
  toolOk,
} from "../tools/utils";
import { loadBundleFixture } from "./fixtures/extensions/load";

const TEST_DB_PATH = "./test-extensions-tool-call.sqlite";

type RegisteredTool = {
  handler: (argsOrExtra: unknown, extra?: unknown) => Promise<CallToolResult>;
};

function registeredTool(server: McpServer, name: string): RegisteredTool {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool "${name}" was not registered`);
  return tool;
}

function meta(agentId: string) {
  return {
    sessionId: crypto.randomUUID(),
    requestInfo: { headers: { "x-agent-id": agentId } },
  };
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(TEST_DB_PATH + suffix)
      .delete()
      .catch(() => {});
  }
}

async function enableFixture(name: string, config?: Record<string, unknown>) {
  const bundle: ExtensionInstallBody = { ...(await loadBundleFixture(name)), config };
  const installed = await installExtension(bundle);
  return await enableExtension(installed.extension.id);
}

async function createProgressTarget() {
  const agent = await createAgent({
    name: `tool-hook-worker-${crypto.randomUUID()}`,
    isLead: false,
    status: "busy",
    capabilities: [],
  });
  const task = await createTaskExtended("tool hook progress target", {
    agentId: agent.id,
    source: "mcp",
  });
  await startTask(task.id);
  return { agent, task };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out while waiting for a tool hook");
    await Bun.sleep(20);
  }
}

describe("extension tool-call hooks", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    await stopExtensionRuntime();
    closeDb();
    await removeDbFiles();
  });

  beforeEach(async () => {
    await stopExtensionRuntime();
    const client = getDbClient();
    await client.run("DELETE FROM agent_tasks");
    await client.run("DELETE FROM extensions");
    await client.run("DELETE FROM kv_entries");
  });

  test("valid modified arguments reach the real store-progress tool", async () => {
    const extension = await enableFixture("rewrite-progress-prefix", { prefix: "reviewed: " });
    const { agent, task } = await createProgressTarget();
    const server = new McpServer({ name: "tool-hook-rewrite", version: "1.0.0" });
    registerStoreProgressTool(server);

    const result = await registeredTool(server, "store-progress").handler(
      { taskId: task.id, progress: "ready" },
      meta(agent.id),
    );

    expect(result.isError).toBe(false);
    expect((await getTaskById(task.id))?.progress).toBe("reviewed: ready");
    expect(await listExtensionRuns(extension.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "pre.tool.call", action: "modify" }),
      ]),
    );
  });

  test("invalid modified arguments fail open and create an error run", async () => {
    const extension = await enableFixture("rewrite-progress-prefix", {
      prefix: "unused: ",
      invalid: true,
    });
    const { agent, task } = await createProgressTarget();
    const server = new McpServer({ name: "tool-hook-invalid", version: "1.0.0" });
    registerStoreProgressTool(server);
    const warning = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await registeredTool(server, "store-progress").handler(
        { taskId: task.id, progress: "original" },
        meta(agent.id),
      );

      expect(result.isError).toBe(false);
      expect((await getTaskById(task.id))?.progress).toBe("original");
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("Ignored invalid arguments from pre.tool.call"),
      );
      expect(await listExtensionRuns(extension.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "pre.tool.call", action: "error" }),
        ]),
      );
    } finally {
      warning.mockRestore();
    }
  });

  test("a compliant call dispatches post.tool.call after finalization", async () => {
    const extension = await enableFixture("no-exclamation-marks");
    const server = new McpServer({ name: "tool-hook-post", version: "1.0.0" });
    let callbackFinished = false;
    createToolRegistrar(server)(
      "store-progress",
      {
        inputSchema: z.object({ progress: z.string() }),
        outputSchema: swarmToolOutputSchema(),
      },
      async () => {
        await Bun.sleep(5);
        callbackFinished = true;
        return toolOk("Progress accepted.");
      },
    );

    const result = await registeredTool(server, "store-progress").handler(
      { progress: "done." },
      meta(crypto.randomUUID()),
    );
    expect(result.isError).toBe(false);
    expect(callbackFinished).toBe(true);

    await waitFor(async () =>
      (await listExtensionRuns(extension.id)).some((run) => run.event === "post.tool.call"),
    );
    const postRun = (await listExtensionRuns(extension.id)).find(
      (run) => run.event === "post.tool.call",
    );
    expect(postRun).toMatchObject({ action: "continue" });
    expect(postRun?.durationMs).toBeNumber();
    const state = await getKv(
      `task:agent:${extension.agentId}`,
      "ext:no-exclamation-marks:last-post",
    );
    expect(state).not.toBeNull();
    const postPayload = state?.value as {
      tool: string;
      args: unknown;
      result: unknown;
      durationMs: number;
    };
    expect(typeof postPayload.durationMs).toBe("number");
    expect(postPayload.durationMs).toBeGreaterThanOrEqual(5);
    expect(postPayload).toMatchObject({
      tool: "store-progress",
      args: { progress: "done." },
      result: { ok: true, message: "Progress accepted." },
    });
  });

  test("script SDK and extension origins bypass both hooks", async () => {
    const extension = await enableFixture("no-exclamation-marks");
    const server = new McpServer({ name: "tool-hook-origin", version: "1.0.0" });
    createToolRegistrar(server)(
      "store-progress",
      {
        inputSchema: z.object({ progress: z.string() }),
        outputSchema: swarmToolOutputSchema(),
      },
      async () => toolOk("Progress accepted."),
    );
    const tool = registeredTool(server, "store-progress");

    const scriptResult = await tool.handler(
      { progress: "script!" },
      markScriptSdkRequestOrigin(meta(crypto.randomUUID())),
    );
    const extensionResult = await tool.handler(
      { progress: "extension!" },
      markExtensionRequestOrigin(meta(extension.agentId!)),
    );

    expect(scriptResult.isError).toBe(false);
    expect(extensionResult.isError).toBe(false);
    await Bun.sleep(20);
    expect(await listExtensionRuns(extension.id)).toEqual([]);
  });

  test("the bridge grants the extension origin only with the per-process token", async () => {
    const extension = await enableFixture("no-exclamation-marks");
    const agentId = extension.agentId!;
    // A caller-controlled agent header alone must not claim the extension origin.
    expect(resolveBridgeCallOrigin(agentId, undefined)).toBe("script-sdk");
    expect(resolveBridgeCallOrigin(agentId, "forged")).toBe("script-sdk");
    expect(resolveBridgeCallOrigin(crypto.randomUUID(), getExtensionBridgeToken())).toBe(
      "script-sdk",
    );
    expect(resolveBridgeCallOrigin(agentId, getExtensionBridgeToken())).toBe("extension");
  });

  test("the no-input branch ignores modified arguments and still runs post hooks", async () => {
    const rewritingExtension = await enableFixture("rewrite-progress-prefix", {
      prefix: "ignored",
      tool: "no-input",
    });
    const observingExtension = await enableFixture("no-exclamation-marks");
    const server = new McpServer({ name: "tool-hook-no-input", version: "1.0.0" });
    let callbackCalls = 0;
    createToolRegistrar(server)("no-input", { outputSchema: swarmToolOutputSchema() }, async () => {
      callbackCalls += 1;
      return toolOk("No input accepted.");
    });
    const warning = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await registeredTool(server, "no-input").handler(meta(crypto.randomUUID()));

      expect(result.isError).toBe(false);
      expect(callbackCalls).toBe(1);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(
          'tool "no-input" from extension "rewrite-progress-prefix" because the tool has no input schema',
        ),
      );
      expect(await listExtensionRuns(rewritingExtension.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "pre.tool.call", action: "error" }),
        ]),
      );
      await waitFor(async () =>
        (await listExtensionRuns(observingExtension.id)).some(
          (run) => run.event === "post.tool.call" && run.action === "continue",
        ),
      );
    } finally {
      warning.mockRestore();
    }
  });
});
