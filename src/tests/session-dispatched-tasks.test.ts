import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { closeDb, createTaskExtended, initDb } from "../be/db";
import { handleSessions } from "../http/sessions";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { setRequestAuth } from "../utils/request-auth-context";

async function chainIds(taskId: string): Promise<string[]> {
  const url = `/api/sessions/${taskId}`;
  const req = Readable.from([]) as Readable & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = "GET";
  req.url = url;
  req.headers = {};
  setRequestAuth(req as never, { kind: "operator", fingerprint: "op:test" });
  let status = 200;
  const chunks: string[] = [];
  const res = {
    setHeader: () => {},
    writeHead: (code: number) => {
      status = code;
    },
    end: (chunk?: string) => {
      if (chunk) chunks.push(chunk);
    },
  };
  const handled = await handleSessions(
    req as never,
    res as never,
    getPathSegments(url),
    parseQueryParams(url),
  );
  expect(handled).toBe(true);
  expect(status).toBe(200);
  return (JSON.parse(chunks.join("")) as { chain: { id: string }[] }).chain.map((t) => t.id);
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  initDb(":memory:");
  const task = async (name: string, opts: { parent?: string; by?: string }) => {
    const created = await createTaskExtended(name, {
      source: "mcp",
      parentTaskId: opts.parent ? ids[opts.parent] : undefined,
      dispatchedByTaskId: opts.by ? ids[opts.by] : undefined,
    });
    ids[name] = created.id;
  };
  // Session A: the second turn continues the researcher's first task and
  // sends a coder.
  await task("turn1", {});
  await task("research1", { parent: "turn1", by: "turn1" });
  await task("turn2", { parent: "turn1" });
  await task("research2", { parent: "research1", by: "turn2" });
  await task("coder2", { parent: "turn2", by: "turn2" });
  // Session B continues session A's researcher task.
  await task("otherRoot", {});
  await task("crossSession", { parent: "research1", by: "otherRoot" });
});

afterAll(() => closeDb());

describe("GET /api/sessions/{id}: tasks the chain dispatched", () => {
  test("a turn's chain holds the continuation it dispatched", async () => {
    const chain = await chainIds(ids.turn2);
    // Creation times can tie within a millisecond here, so compare as a set.
    expect(chain.toSorted()).toEqual([ids.turn2, ids.research2, ids.coder2].toSorted());
  });

  test("a dispatched task in another session stays out", async () => {
    expect(await chainIds(ids.otherRoot)).toEqual([ids.otherRoot]);
  });

  test("the root's chain lists every task once", async () => {
    const chain = await chainIds(ids.turn1);
    expect(new Set(chain).size).toBe(chain.length);
    expect(chain).toHaveLength(6);
  });
});
