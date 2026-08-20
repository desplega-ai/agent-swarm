/**
 * GET /api/whoami — bearer → principal resolution (DES-771).
 *
 * The embedded dashboard authenticates with a per-user `aswt_` token and asks
 * this endpoint which user it is acting as (the server forces requester/audit
 * attribution from the token, see user-token-rest-auth.test.ts). The operator
 * key resolves to `kind: "operator"` with no bound user; inactive tokens are
 * rejected by the transport-level auth (401), never mapped to a user.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createUser, initDb, updateUser } from "../be/db";
import { type IdentityActor, mintToken, revokeToken } from "../be/users";
import { handleCore } from "../http/core";
import { handleUsers } from "../http/users";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-whoami-route.sqlite";
const API_KEY = "test-api-key";
const ACTOR: IdentityActor = { kind: "operator", id: "op:test" };

interface WhoamiBody {
  kind: "operator" | "user";
  user: { id: string; name: string; status: string } | null;
}

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;

    if (await handleCore(req, res, myAgentId, API_KEY)) return;
    if (await handleUsers(req, res, pathSegments, queryParams)) return;

    res.writeHead(404);
    res.end("Not Found");
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

function cleanupDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("GET /api/whoami", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    cleanupDb();
    initDb(TEST_DB_PATH);
    server = createTestServer();
    port = await listen(server);
  });

  afterAll(() => {
    server.close();
    closeDb();
    cleanupDb();
  });

  const whoami = (bearer?: string) =>
    fetch(`http://localhost:${port}/api/whoami`, {
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    });

  test("operator key resolves to kind=operator with no user", async () => {
    const res = await whoami(API_KEY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WhoamiBody;
    expect(body.kind).toBe("operator");
    expect(body.user).toBeNull();
  });

  test("active user token resolves to its bound user", async () => {
    const user = await createUser({ name: "Whoami User", email: "whoami@example.com" });
    const { plaintext } = await mintToken(user.id, "rest", ACTOR);

    const res = await whoami(plaintext);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WhoamiBody;
    expect(body.kind).toBe("user");
    expect(body.user?.id).toBe(user.id);
    expect(body.user?.name).toBe("Whoami User");
  });

  test("revoked token is rejected at auth (401)", async () => {
    const user = await createUser({ name: "Revoked User" });
    const { plaintext, tokenId } = await mintToken(user.id, "rest", ACTOR);
    await revokeToken(tokenId, ACTOR);

    const res = await whoami(plaintext);
    expect(res.status).toBe(401);
  });

  test("suspended user's token is rejected at auth (401)", async () => {
    const user = await createUser({ name: "Suspended User" });
    const { plaintext } = await mintToken(user.id, "rest", ACTOR);
    await updateUser(user.id, { status: "suspended" });

    const res = await whoami(plaintext);
    expect(res.status).toBe(401);
  });

  test("missing bearer is rejected (401)", async () => {
    const res = await whoami();
    expect(res.status).toBe(401);
  });
});
