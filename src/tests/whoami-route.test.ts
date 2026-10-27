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
import { ensureRbacSeedsSynced, setUserRoles } from "../be/rbac-roles";
import { type IdentityActor, mintToken, revokeToken } from "../be/users";
import { handleCore } from "../http/core";
import { handleUsers } from "../http/users";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-whoami-route.sqlite";
const API_KEY = "example-test-api-key";
const ACTOR: IdentityActor = { kind: "operator", id: "op:test" };

interface WhoamiBody {
  kind: "operator" | "user";
  user: { id: string; name: string; status: string } | null;
  grants?: { grantsAll: boolean; verbs: string[]; roles: string[] };
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
    ensureRbacSeedsSynced({ quiet: true });
    server = createTestServer();
    port = await listenOnFreePort(server);
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
    expect(body.grants?.grantsAll).toBe(true);
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

  test("requester token reports its role and verbs, without grantsAll", async () => {
    const user = await createUser({ name: "Requester User", email: "req@example.com" });
    await setUserRoles(user.id, ["requester"], null);
    const { plaintext } = await mintToken(user.id, "rest", ACTOR);

    const body = (await (await whoami(plaintext)).json()) as WhoamiBody;
    expect(body.grants?.grantsAll).toBe(false);
    expect(body.grants?.roles).toEqual(["requester"]);
    expect(body.grants?.verbs).toContain("task.create.own");
    expect(body.grants?.verbs).not.toContain("config.write.any");
  });

  test("a new user holds admin by default: grantsAll", async () => {
    const user = await createUser({ name: "Default Admin" });
    const { plaintext } = await mintToken(user.id, "rest", ACTOR);

    const body = (await (await whoami(plaintext)).json()) as WhoamiBody;
    expect(body.grants?.grantsAll).toBe(true);
    expect(body.grants?.roles).toEqual(["admin"]);
  });

  test("RBAC_ENABLED=false reports grantsAll for a viewer", async () => {
    const user = await createUser({ name: "Viewer User" });
    await setUserRoles(user.id, ["viewer"], null);
    const { plaintext } = await mintToken(user.id, "rest", ACTOR);
    const previous = process.env.RBAC_ENABLED;
    process.env.RBAC_ENABLED = "false";
    try {
      const body = (await (await whoami(plaintext)).json()) as WhoamiBody;
      expect(body.grants?.grantsAll).toBe(true);
      expect(body.grants?.roles).toEqual(["viewer"]);
    } finally {
      if (previous === undefined) delete process.env.RBAC_ENABLED;
      else process.env.RBAC_ENABLED = previous;
    }
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
