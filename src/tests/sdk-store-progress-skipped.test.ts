import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { handleCore } from "../http/core";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { SwarmConfig } from "../scripts-runtime/swarm-config";
import { createSwarmSdk } from "../scripts-runtime/swarm-sdk";

// ctx.swarm.task_storeProgress({ status: "skipped" }) must end the task as
// skipped through the real HTTP route, keeping the reason, like the MCP tool.

const TEST_DB_PATH = "./test-sdk-store-progress-skipped.sqlite";
const API_KEY = "example-test-sdk-store-progress-skipped-key-1234567890";

let agentId: string;
let httpServer: ReturnType<typeof Bun.serve>;
let savedApiKey: string | undefined;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Run one request through the real core + tasks handlers. */
async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const body = await request.text();
  const req = Readable.from(body ? [Buffer.from(body)] : []) as IncomingMessage;
  req.method = request.method;
  req.url = url.pathname + url.search;
  req.headers = Object.fromEntries(request.headers.entries());

  let status = 200;
  let text = "";
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) text += String(chunk);
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;

  const requestAgentId = req.headers["x-agent-id"] as string | undefined;
  if (!(await handleCore(req, res, requestAgentId, API_KEY))) {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    if (!(await handleTasks(req, res, pathSegments, queryParams, requestAgentId))) {
      return new Response("Not Found", { status: 404 });
    }
  }
  return new Response(text, { status, headers: { "Content-Type": "application/json" } });
}

function sdk() {
  return createSwarmSdk(
    new SwarmConfig({
      system: {
        apiKey: { value: API_KEY, isSecret: true },
        agentId: { value: agentId, isSecret: false },
        mcpBaseUrl: { value: `http://127.0.0.1:${httpServer.port}`, isSecret: false },
      },
      user: {},
    }),
  );
}

async function startedTask(text: string) {
  const row = await createTaskExtended(text, { agentId, source: "mcp" });
  await startTask(row.id);
  return row;
}

beforeAll(async () => {
  savedApiKey = process.env.AGENT_SWARM_API_KEY;
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  agentId = (await createAgent({ name: "sdk-skip-worker", isLead: false, status: "idle" })).id;
  httpServer = Bun.serve({ port: 0, fetch: handle });
});

afterAll(async () => {
  httpServer.stop(true);
  closeDb();
  await removeDbFiles();
  if (savedApiKey === undefined) delete process.env.AGENT_SWARM_API_KEY;
  else process.env.AGENT_SWARM_API_KEY = savedApiKey;
});

describe("ctx.swarm.task_storeProgress status skipped", () => {
  test("skips the task, keeps the reason, and creates no follow-up", async () => {
    const task = await startedTask("thread chatter");
    await sdk().task_storeProgress({
      taskId: task.id,
      status: "skipped",
      failureReason: "Addressed to\n another agent.",
    });

    const after = await getTaskById(task.id);
    expect(after?.status).toBe("skipped");
    expect(after?.failureReason).toBe("Addressed to another agent.");
    expect(after?.output).toBeFalsy();
    const followUps = await getDbClient().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM agent_tasks WHERE parentTaskId = ?",
      [task.id],
    );
    expect(followUps?.n).toBe(0);
  });

  test("takes the reason from output when failureReason is absent", async () => {
    const task = await startedTask("thread chatter");
    await sdk().task_storeProgress({ taskId: task.id, status: "skipped", output: "Not mine." });
    const after = await getTaskById(task.id);
    expect(after?.status).toBe("skipped");
    expect(after?.failureReason).toBe("Not mine.");
    expect(after?.output).toBeFalsy();
  });

  test("refuses a skip with no reason and leaves the task running", async () => {
    const task = await startedTask("thread chatter");
    const result = (await sdk().task_storeProgress({ taskId: task.id, status: "skipped" })) as {
      success: boolean;
      status: number;
      data: { error?: string };
    };
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.data.error).toContain("needs a one-line reason");
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
  });
});
