import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createUser, getDb, initDb } from "../be/db";
import { fingerprintApiKey } from "../be/users";
import { handleCore } from "../http/core";
import { handleUsers } from "../http/users";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-user-token-routes.sqlite";
const API_KEY = "test-user-token-key";
const ORIGINAL_API_KEY = process.env.AGENT_SWARM_API_KEY;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function listen(server: Server): Promise<number> {
  const port = 15174;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

function createTestServer(apiKey: string): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const handled = await handleCore(req, res, myAgentId, apiKey);
    if (handled) return;
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const ok = await handleUsers(req, res, pathSegments, queryParams);
    if (!ok) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
}

let server: Server;
let port: number;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  server = createTestServer(API_KEY);
  port = await listen(server);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
  if (ORIGINAL_API_KEY === undefined) {
    delete process.env.AGENT_SWARM_API_KEY;
  } else {
    process.env.AGENT_SWARM_API_KEY = ORIGINAL_API_KEY;
  }
});

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM user_identity_events");
  db.run("DELETE FROM user_tokens");
  db.run("DELETE FROM users");
});

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  return fetch(url(path), { ...init, headers });
}

type TokenSummary = {
  id: string;
  userId: string;
  label: string | null;
  tokenPreview: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

describe("operator MCP token routes", () => {
  test("POST mints an aswt_ plaintext once and persists only hash + preview", async () => {
    const user = createUser({ name: "Token User", email: "token@example.com" });

    const response = await authedFetch(`/api/users/${user.id}/mcp-tokens`, {
      method: "POST",
      body: JSON.stringify({ label: "laptop" }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      plaintext: string;
      token: TokenSummary;
      user: { id: string; tokens: TokenSummary[]; recentEvents: Array<{ eventType: string }> };
    };
    expect(body.plaintext.startsWith("aswt_")).toBe(true);
    expect(body.token.label).toBe("laptop");
    expect(body.token.tokenPreview).toBe(body.plaintext.slice(-4));
    expect(body.token.userId).toBe(user.id);
    expect(body.user.tokens).toContainEqual(body.token);
    expect(body.user.recentEvents.map((event) => event.eventType)).toContain("token_minted");

    const stored = getDb()
      .prepare<{ tokenHash: string; tokenPreview: string }, string>(
        "SELECT tokenHash, tokenPreview FROM user_tokens WHERE id = ?",
      )
      .get(body.token.id);
    expect(stored).toBeTruthy();
    expect(stored!.tokenHash).not.toBe(body.plaintext);
    expect(stored!.tokenHash).toHaveLength(64);
    expect(stored!.tokenPreview).toBe(body.plaintext.slice(-4));

    const reread = await authedFetch(`/api/users/${user.id}`);
    const rereadBody = (await reread.json()) as {
      user: { tokens: TokenSummary[]; recentEvents: Array<{ eventType: string }> };
    };
    expect(JSON.stringify(rereadBody)).not.toContain(body.plaintext);
    expect(rereadBody.user.tokens[0]!.tokenPreview).toBe(body.plaintext.slice(-4));
  });

  test("DELETE revokes a token and records token_revoked", async () => {
    const user = createUser({ name: "Revoked User" });
    const mintResponse = await authedFetch(`/api/users/${user.id}/mcp-tokens`, {
      method: "POST",
      body: JSON.stringify({ label: null }),
    });
    const minted = (await mintResponse.json()) as { token: TokenSummary };

    const revokeResponse = await authedFetch(
      `/api/users/${user.id}/mcp-tokens/${minted.token.id}`,
      { method: "DELETE" },
    );

    expect(revokeResponse.status).toBe(200);
    const body = (await revokeResponse.json()) as {
      user: { tokens: TokenSummary[]; recentEvents: Array<{ eventType: string }> };
    };
    expect(body.user.tokens[0]!.id).toBe(minted.token.id);
    expect(body.user.tokens[0]!.revokedAt).toBeTruthy();
    expect(body.user.recentEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["token_minted", "token_revoked"]),
    );
  });

  test("POST and DELETE reject without the swarm key", async () => {
    const user = createUser({ name: "Auth User" });

    const post = await fetch(url(`/api/users/${user.id}/mcp-tokens`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "missing-auth" }),
    });
    expect(post.status).toBe(401);

    const deleteResponse = await fetch(url(`/api/users/${user.id}/mcp-tokens/unknown`), {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(401);
  });

  test("DELETE unknown token returns 404", async () => {
    const user = createUser({ name: "Unknown Token User" });
    const response = await authedFetch(`/api/users/${user.id}/mcp-tokens/not-a-token`, {
      method: "DELETE",
    });
    expect(response.status).toBe(404);
  });

  test("POST unknown user returns 404", async () => {
    const response = await authedFetch("/api/users/not-a-user/mcp-tokens", {
      method: "POST",
      body: JSON.stringify({ label: "nope" }),
    });
    expect(response.status).toBe(404);
  });

  test("operator events are tagged with the API-key fingerprint", async () => {
    const user = createUser({ name: "Actor User" });
    const response = await authedFetch(`/api/users/${user.id}/mcp-tokens`, {
      method: "POST",
      body: JSON.stringify({ label: "actor" }),
    });
    expect(response.status).toBe(200);

    const row = getDb()
      .prepare<{ actor: string }, string>(
        "SELECT actor FROM user_identity_events WHERE userId = ? AND eventType = 'token_minted'",
      )
      .get(user.id);
    expect(row?.actor).toBe(`operator:${fingerprintApiKey(API_KEY)}`);
  });
});
