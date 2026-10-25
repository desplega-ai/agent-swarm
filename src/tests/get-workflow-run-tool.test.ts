import { afterAll, beforeAll, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  initDb,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import { registerGetWorkflowRunTool } from "../tools/workflows/get-workflow-run";

const dbPath = `./test-get-workflow-run-tool-${process.pid}.sqlite`;

type ToolResult = {
  isError?: boolean;
  structuredContent: {
    message: string;
    run?: Record<string, unknown>;
    steps?: Array<Record<string, unknown>>;
  };
};
let handler: (args: unknown, extra: unknown) => Promise<ToolResult>;
let runId: string;

async function removeDb() {
  for (const suffix of ["", "-wal", "-shm"]) await unlink(dbPath + suffix).catch(() => undefined);
}

beforeAll(async () => {
  await removeDb();
  initDb(dbPath);
  const workflow = await createWorkflow({
    name: "get-workflow-run-tool",
    definition: { nodes: [{ id: "poll", type: "notify", config: { template: "x" } }] },
  });
  runId = crypto.randomUUID();
  await createWorkflowRun({ id: runId, workflowId: workflow.id });
  const context = { poll: { attempts: 2 }, blob: "x".repeat(2_000) };
  for (let i = 0; i < 2; i++) {
    const step = await createWorkflowRunStep({
      id: crypto.randomUUID(),
      runId,
      nodeId: "poll",
      nodeType: "notify",
      input: { ...context, iteration: i },
    });
    await updateWorkflowRunStep(step.id, {
      status: "completed",
      output: { iteration: i },
      retryCount: i,
      finishedAt: new Date().toISOString(),
    });
  }
  await updateWorkflowRun(runId, { status: "completed", context });

  const server = new McpServer({ name: "get-workflow-run-tool", version: "1.0.0" });
  registerGetWorkflowRunTool(server);
  handler = (server as unknown as { _registeredTools: Record<string, { handler: typeof handler }> })
    ._registeredTools["get-workflow-run"]!.handler;
});

afterAll(async () => {
  closeDb();
  await removeDb();
});

const extra = { sessionId: "get-workflow-run-tool", requestInfo: { headers: {} } };

test("defaults to the full run with context and step inputs", async () => {
  const result = await handler({ id: runId }, extra);
  expect(result.isError).not.toBe(true);
  const { run, steps } = result.structuredContent;
  expect(run?.context).toBeDefined();
  expect(steps).toHaveLength(2);
  for (const step of steps!) expect(step.input).toBeDefined();
});

test("fields=slim drops context and step inputs, keeps outputs and retry fields", async () => {
  const result = await handler({ id: runId, fields: "slim" }, extra);
  expect(result.isError).not.toBe(true);
  const { run, steps } = result.structuredContent;
  expect(run?.status).toBe("completed");
  expect(run?.context).toBeUndefined();
  expect(steps).toHaveLength(2);
  for (const step of steps!) {
    expect(step.input).toBeUndefined();
    expect(step.output).toBeDefined();
    expect(typeof step.retryCount).toBe("number");
  }
});

test("fields=slim reports a missing run as an error", async () => {
  const result = await handler({ id: crypto.randomUUID(), fields: "slim" }, extra);
  expect(result.isError).toBe(true);
});
