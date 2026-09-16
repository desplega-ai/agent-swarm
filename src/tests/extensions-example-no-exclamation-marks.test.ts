import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { closeDb, createAgent, createTaskExtended, getTaskById, initDb, startTask } from "../be/db";
import { installExtension } from "../be/extensions/db";
import { enableExtension, stopExtensionRuntime } from "../extensions/lifecycle";
import { registerStoreProgressTool } from "../tools/store-progress";
import { loadBundleFixture } from "./fixtures/extensions/load";

const TEST_DB_PATH = "./test-extensions-example-no-exclamation-marks.sqlite";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
};

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(TEST_DB_PATH + suffix)
      .delete()
      .catch(() => {});
  }
}

describe("no-exclamation-marks extension example", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    await stopExtensionRuntime();
    closeDb();
    await removeDbFiles();
  });

  test("rejects emphatic progress and accepts compliant progress", async () => {
    const installed = await installExtension(await loadBundleFixture("no-exclamation-marks"));
    await enableExtension(installed.extension.id);
    const agent = await createAgent({
      name: "no-exclamation-example-worker",
      isLead: false,
      status: "busy",
      capabilities: [],
    });
    const task = await createTaskExtended("no exclamation example", {
      agentId: agent.id,
      source: "mcp",
    });
    await startTask(task.id);

    const server = new McpServer({ name: "no-exclamation-example", version: "1.0.0" });
    registerStoreProgressTool(server);
    const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
      ._registeredTools;
    const tool = tools["store-progress"];
    if (!tool) throw new Error("store-progress was not registered");
    const meta = {
      sessionId: crypto.randomUUID(),
      requestInfo: { headers: { "x-agent-id": agent.id } },
    };

    const blocked = await tool.handler({ taskId: task.id, progress: "done!" }, meta);
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked)).toContain("Progress text must not contain exclamation marks.");
    expect(JSON.stringify(blocked)).toContain("no-exclamation-marks");
    expect((await getTaskById(task.id))?.progress).toBeUndefined();

    const accepted = await tool.handler({ taskId: task.id, progress: "done." }, meta);
    expect(accepted.isError).toBe(false);
    expect((await getTaskById(task.id))?.progress).toBe("done.");
  });
});
