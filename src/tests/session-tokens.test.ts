/**
 * Tests for the session-token lifecycle:
 *   - mintSessionToken / revokeSessionToken / resolveBySessionToken (DB layer)
 *   - resolveHttpRequestAuth with aseph_ bearer (auth middleware)
 *   - POST /api/sessions/tokens and DELETE /api/sessions/tokens/:id (HTTP layer)
 *
 * Uses the same in-memory SQLite + real HTTP server pattern as http-users.test.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, getDbClient, initDb } from "../be/db";
import { mintSessionToken, resolveBySessionToken, revokeSessionToken } from "../be/users";
import { resolveHttpRequestAuth } from "../http/auth";
import { handleCore } from "../http/core";
import { handleMcp } from "../http/mcp";
import { handleSessions } from "../http/sessions";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const API_KEY = "test-session-token-key";

function createTestServer(apiKey: string): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const handled = await handleCore(req, res, myAgentId, apiKey);
    if (handled) return;
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const ok = await handleSessions(req, res, pathSegments, queryParams);
    if (!ok) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
}

let server: Server;
let port: number;

beforeAll(async () => {
  initDb(":memory:");
  server = createTestServer(API_KEY);
  port = await listenOnFreePort(server);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

beforeEach(async () => {
  await getDbClient().run("DELETE FROM session_tokens");
});

// ─── DB-layer unit tests ──────────────────────────────────────────────────────

describe("mintSessionToken / resolveBySessionToken / revokeSessionToken", () => {
  test("mints a token that resolves to its principal", async () => {
    const { tokenId, plaintext } = await mintSessionToken("agent-1", "task-1", 60_000);
    expect(plaintext).toMatch(/^aseph_/);
    expect(tokenId).toBeTruthy();

    const principal = await resolveBySessionToken(plaintext);
    expect(principal).toMatchObject({ agentId: "agent-1", taskId: "task-1" });
  });

  test("returns null for an unknown token", async () => {
    expect(await resolveBySessionToken("aseph_nonexistent")).toBeNull();
  });

  test("returns null for a revoked token", async () => {
    const { tokenId, plaintext } = await mintSessionToken("agent-2", "task-2", 60_000);
    await revokeSessionToken(tokenId);
    expect(await resolveBySessionToken(plaintext)).toBeNull();
  });

  test("returns null for an expired token", async () => {
    const { plaintext } = await mintSessionToken("agent-3", "task-3", -1);
    expect(await resolveBySessionToken(plaintext)).toBeNull();
  });

  test("returns null for a non-aseph_ bearer", async () => {
    expect(await resolveBySessionToken("aswt_shouldnotmatch")).toBeNull();
    expect(await resolveBySessionToken("some-random-token")).toBeNull();
  });

  test("revokeSessionToken is idempotent", async () => {
    const { tokenId, plaintext } = await mintSessionToken("agent-4", "task-4", 60_000);
    await revokeSessionToken(tokenId);
    await expect(revokeSessionToken(tokenId)).resolves.toBeUndefined();
    expect(await resolveBySessionToken(plaintext)).toBeNull();
  });
});

// ─── Auth middleware tests ────────────────────────────────────────────────────

describe("resolveHttpRequestAuth with aseph_ token", () => {
  test("resolves a valid aseph_ token to kind:agent", async () => {
    const { plaintext } = await mintSessionToken("agent-5", "task-5", 60_000);
    const req = { headers: { authorization: `Bearer ${plaintext}` } } as IncomingMessage;
    const auth = await resolveHttpRequestAuth(req, API_KEY);
    expect(auth).toMatchObject({ kind: "agent", agentId: "agent-5", taskId: "task-5" });
  });

  test("returns null for a revoked aseph_ token", async () => {
    const { tokenId, plaintext } = await mintSessionToken("agent-6", "task-6", 60_000);
    await revokeSessionToken(tokenId);
    const req = { headers: { authorization: `Bearer ${plaintext}` } } as IncomingMessage;
    expect(await resolveHttpRequestAuth(req, API_KEY)).toBeNull();
  });

  test("aseph_ token resolves as kind:agent even when a different API key is configured", async () => {
    const { plaintext } = await mintSessionToken("agent-7", "task-7", 60_000);
    const req = { headers: { authorization: `Bearer ${plaintext}` } } as IncomingMessage;
    // The configured operator key is different, so the bearer does not hit the
    // operator-key branch and falls through to the aseph_ resolution.
    const auth = await resolveHttpRequestAuth(req, "some-other-operator-key");
    expect(auth?.kind).toBe("agent");
    if (auth?.kind === "agent") {
      expect(auth.agentId).toBe("agent-7");
      expect(auth.taskId).toBe("task-7");
    }
  });
});

// ─── HTTP endpoint tests ──────────────────────────────────────────────────────

describe("POST /api/sessions/tokens", () => {
  test("mints a token and returns plaintext + tokenId", async () => {
    const res = await fetch(`http://localhost:${port}/api/sessions/tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ agentId: "ag-1", taskId: "tk-1", ttlMs: 60_000 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokenId: string; plaintext: string };
    expect(body.plaintext).toMatch(/^aseph_/);
    expect(body.tokenId).toBeTruthy();
    // Verify the token actually resolves.
    const principal = await resolveBySessionToken(body.plaintext);
    expect(principal).toMatchObject({ agentId: "ag-1", taskId: "tk-1" });
  });

  test("returns 401 without auth", async () => {
    const res = await fetch(`http://localhost:${port}/api/sessions/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "ag-1", taskId: "tk-1", ttlMs: 60_000 }),
    });
    expect(res.status).toBe(401);
  });

  test("returns 400 when ttlMs exceeds the maximum", async () => {
    const tooLong = 8 * 24 * 60 * 60 * 1000; // 8 days
    const res = await fetch(`http://localhost:${port}/api/sessions/tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ agentId: "ag-1", taskId: "tk-1", ttlMs: tooLong }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/sessions/tokens/:tokenId", () => {
  test("revokes a token so it can no longer be resolved", async () => {
    const { tokenId, plaintext } = await mintSessionToken("ag-2", "tk-2", 60_000);

    const res = await fetch(`http://localhost:${port}/api/sessions/tokens/${tokenId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(204);

    expect(await resolveBySessionToken(plaintext)).toBeNull();
  });

  test("returns 401 without auth", async () => {
    const { tokenId } = await mintSessionToken("ag-3", "tk-3", 60_000);
    const res = await fetch(`http://localhost:${port}/api/sessions/tokens/${tokenId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });
});

// ─── /mcp identity enforcement tests ─────────────────────────────────────────

describe("/mcp aseph_ token identity enforcement", () => {
  let mcpServer: import("node:http").Server;
  let mcpPort: number;

  beforeAll(async () => {
    mcpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      const myAgentId = req.headers["x-agent-id"] as string | undefined;
      const handled = await handleCore(req, res, myAgentId, API_KEY);
      if (handled) return;
      const didHandle = await handleMcp(req, res, {});
      if (!didHandle) {
        res.writeHead(404);
        res.end("Not Found");
      }
    });
    mcpPort = await listenOnFreePort(mcpServer);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
  });

  test("rejects with 403 when X-Agent-ID does not match the token's bound agentId", async () => {
    const { plaintext } = await mintSessionToken("mcp-agent-A", "mcp-task-A", 60_000);
    const res = await fetch(`http://localhost:${mcpPort}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${plaintext}`,
        "Content-Type": "application/json",
        "X-Agent-ID": "mcp-agent-B",
        "X-Source-Task-Id": "mcp-task-A",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} }),
    });
    expect(res.status).toBe(403);
  });

  test("rejects with 403 when X-Source-Task-Id does not match the token's bound taskId", async () => {
    const { plaintext } = await mintSessionToken("mcp-agent-C", "mcp-task-C", 60_000);
    const res = await fetch(`http://localhost:${mcpPort}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${plaintext}`,
        "Content-Type": "application/json",
        "X-Agent-ID": "mcp-agent-C",
        "X-Source-Task-Id": "mcp-task-D",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} }),
    });
    expect(res.status).toBe(403);
  });

  test("rejects with 403 when X-Agent-ID header is missing", async () => {
    const { plaintext } = await mintSessionToken("mcp-agent-E", "mcp-task-E", 60_000);
    const res = await fetch(`http://localhost:${mcpPort}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${plaintext}`,
        "Content-Type": "application/json",
        "X-Source-Task-Id": "mcp-task-E",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} }),
    });
    expect(res.status).toBe(403);
  });

  test("rejects with 403 when X-Source-Task-Id header is missing", async () => {
    const { plaintext } = await mintSessionToken("mcp-agent-F", "mcp-task-F", 60_000);
    const res = await fetch(`http://localhost:${mcpPort}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${plaintext}`,
        "Content-Type": "application/json",
        "X-Agent-ID": "mcp-agent-F",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} }),
    });
    expect(res.status).toBe(403);
  });
});
