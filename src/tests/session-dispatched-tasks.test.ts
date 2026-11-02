import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { closeDb, createTaskExtended, createUser, initDb } from "../be/db";
import { setSessionShares } from "../be/session-shares";
import { handleSessions } from "../http/sessions";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { setRequestAuth } from "../utils/request-auth-context";

type ChainTask = { id: string; dispatchedByTaskId?: string };

/** The chain of GET /api/sessions/{taskId}; `asUser` reads as that dashboard user. */
async function chain(taskId: string, asUser?: string): Promise<ChainTask[]> {
  const url = `/api/sessions/${taskId}`;
  const req = Readable.from([]) as Readable & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = "GET";
  req.url = url;
  req.headers = asUser ? { "x-swarm-user-id": asUser } : {};
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
  return (JSON.parse(chunks.join("")) as { chain: ChainTask[] }).chain;
}

async function chainIds(taskId: string, asUser?: string): Promise<string[]> {
  return (await chain(taskId, asUser)).map((t) => t.id);
}

const ids: Record<string, string> = {};
let owner: { id: string };
let viewer: { id: string };

beforeAll(async () => {
  initDb(":memory:");
  owner = await createUser({ name: "Owner" });
  viewer = await createUser({ name: "Viewer" });
  const task = async (name: string, opts: { parent?: string; by?: string }) => {
    const created = await createTaskExtended(name, {
      source: "mcp",
      requestedByUserId: owner.id,
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
  // The viewer may read session B, not session A.
  await setSessionShares(
    { id: ids.otherRoot, requestedByUserId: owner.id },
    { everyone: "none", users: [{ userId: viewer.id, access: "read" }] },
    owner.id,
  );
});

afterAll(() => closeDb());

describe("GET /api/sessions/{id}: tasks the chain dispatched", () => {
  test("a turn's chain holds the continuation it dispatched", async () => {
    const chain = await chainIds(ids.turn2);
    // Creation times can tie within a millisecond here, so compare as a set.
    expect(chain.toSorted()).toEqual([ids.turn2, ids.research2, ids.coder2].toSorted());
  });

  test("a viewer with access to both sessions sees a cross-session dispatch", async () => {
    const both = [ids.otherRoot, ids.crossSession].toSorted();
    expect((await chainIds(ids.otherRoot)).toSorted()).toEqual(both);
    expect((await chainIds(ids.otherRoot, owner.id)).toSorted()).toEqual(both);
  });

  test("a viewer without access to the other session does not see it", async () => {
    expect(await chainIds(ids.otherRoot, viewer.id)).toEqual([ids.otherRoot]);
  });

  test("a worker's scoped chain holds its continuation, not the dispatcher", async () => {
    const scoped = await chain(ids.research1);
    const continuation = scoped.find((t) => t.id === ids.research2);
    expect(continuation?.dispatchedByTaskId).toBe(ids.turn2);
    expect(scoped.map((t) => t.id)).not.toContain(ids.turn2);
  });

  test("the root's chain lists every task once", async () => {
    const chain = await chainIds(ids.turn1);
    expect(new Set(chain).size).toBe(chain.length);
    expect(chain).toHaveLength(6);
  });
});
