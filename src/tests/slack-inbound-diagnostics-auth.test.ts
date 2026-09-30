/**
 * GET /api/slack/inbound/diagnostics is operator-only. `auth.apiKey` admits
 * user `aswt_` tokens and verb-less GETs pass RBAC admission, so the handler
 * gates on the principal kind. Runs the real handleCore auth path.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createUser, initDb } from "../be/db";
import { ensureRbacSeedsSynced } from "../be/rbac-roles";
import { type IdentityActor, mintToken } from "../be/users";
import { handleCore } from "../http/core";
import { handleSlackInbound } from "../http/slack-inbound";
import { getPathSegments } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-slack-inbound-diagnostics-auth.sqlite";
const API_KEY = "example-test-api-key";
const ACTOR: IdentityActor = { kind: "operator", id: "op:test" };
const PATH = "/api/slack/inbound/diagnostics";

let server: Server;
let port = 0;
let savedRbac: string | undefined;

async function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // File does not exist.
    }
  }
}

async function get(bearer: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://localhost:${port}${PATH}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  savedRbac = process.env.RBAC_ENABLED;
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  ensureRbacSeedsSynced({ quiet: true });
  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (await handleCore(req, res, undefined, API_KEY)) return;
    if (await handleSlackInbound(req, res, getPathSegments(req.url || ""))) return;
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });
  port = await listenOnFreePort(server);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles();
  if (savedRbac === undefined) delete process.env.RBAC_ENABLED;
  else process.env.RBAC_ENABLED = savedRbac;
});

describe("GET /api/slack/inbound/diagnostics authorization", () => {
  test("operator key reads diagnostics", async () => {
    const res = await get(API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("receipts.counts");
  });

  test("active user token is refused with 403 whether RBAC admission is on or off", async () => {
    const user = await createUser({ name: "Diagnostics User" });
    const { plaintext } = await mintToken(user.id, "diagnostics", ACTOR);

    for (const flag of ["true", "false"]) {
      process.env.RBAC_ENABLED = flag;
      const res = await get(plaintext);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Operator access required" });
    }
  });

  test("unknown bearer is refused with 401", async () => {
    const res = await get("aswt_not-a-real-token");
    expect(res.status).toBe(401);
  });
});
