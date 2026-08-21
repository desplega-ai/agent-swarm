import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { type CreateTaskOptions, closeDb, createTaskExtended, getDbClient, initDb } from "../be/db";
import { handleMcpBridge } from "../http/mcp-bridge";
import { getPathSegments } from "../http/utils";

const TEST_DB_PATH = "./test-create-task-validation.sqlite";

let server: Server;
let baseUrl: string;

async function taskCount(): Promise<number> {
  return (await getDbClient().get<{ c: number }>("SELECT COUNT(*) AS c FROM agent_tasks"))!.c;
}

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const pathSegments = getPathSegments(req.url || "");
    const ok = await handleMcpBridge(req, res, pathSegments, undefined, myAgentId);
    if (!ok) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.close();
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB_PATH + suffix);
    } catch {
      // ignore
    }
  }
});

describe("scripts-bridge input validation", () => {
  // REGRESSION TEST for the 2026-08-18 incident: an inline script POSTed
  // priority: "high" to /api/mcp-bridge; the bridge invoked the send-task
  // handler without parsing args, the TEXT value landed in the INTEGER
  // priority column, and response validation then 500'd every task listing.
  test("raw priority:'high' through the bridge returns 400 and writes no row", async () => {
    const before = await taskCount();
    const res = await fetch(`${baseUrl}/api/mcp-bridge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-agent-id": "test-agent" },
      body: JSON.stringify({
        tool: "send-task",
        args: { task: "incident regression probe", priority: "high" },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Invalid arguments for tool 'send-task'");
    expect(await taskCount()).toBe(before);
  });
});

describe("createTaskExtended input validation", () => {
  test("string priority throws and writes no row", async () => {
    const before = await taskCount();
    await expect(
      createTaskExtended("bad priority", {
        priority: "high",
      } as unknown as CreateTaskOptions),
    ).rejects.toThrow();
    expect(await taskCount()).toBe(before);
  });

  test("priority 101 throws", async () => {
    await expect(createTaskExtended("too high", { priority: 101 })).rejects.toThrow();
  });

  test("priority -1 throws", async () => {
    await expect(createTaskExtended("too low", { priority: -1 })).rejects.toThrow();
  });

  test("non-integer priority throws", async () => {
    await expect(createTaskExtended("fractional", { priority: 49.5 })).rejects.toThrow();
  });

  test("absent priority defaults to 50", async () => {
    const t = await createTaskExtended("default priority");
    expect(t.priority).toBe(50);
  });

  test("explicit priority 0 stays 0", async () => {
    const t = await createTaskExtended("zero priority", { priority: 0 });
    expect(t.priority).toBe(0);
  });

  test("unknown keys are stripped and the task is still created", async () => {
    const t = await createTaskExtended("extra keys", {
      priority: 10,
      nonsense: true,
    } as unknown as CreateTaskOptions);
    expect(t.priority).toBe(10);
  });

  test("empty task throws", async () => {
    await expect(createTaskExtended("")).rejects.toThrow();
  });

  test("valid full options pass through unchanged", async () => {
    const t = await createTaskExtended("full options", {
      priority: 90,
      tags: ["urgent"],
      taskType: "bug",
      status: "backlog",
      source: "api",
    });
    expect(t.priority).toBe(90);
    expect(t.status).toBe("backlog");
    expect(t.tags).toEqual(["urgent"]);
  });
});
