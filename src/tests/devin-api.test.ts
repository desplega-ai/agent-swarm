/**
 * Unit tests for the Devin REST API client (`src/providers/devin-api.ts`).
 *
 * A minimal `node:http` mock server returns canned JSON responses based on the
 * request path and method. The test sets `DEVIN_API_BASE_URL` so the client
 * hits the mock instead of the real Devin API.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as devinApi from "../providers/devin-api";

const TEST_PORT = 13050;
const TEST_BASE_URL = `http://localhost:${TEST_PORT}`;
const ORG_ID = "org-test-123";
const API_KEY = "cog_test_key";

// Canned responses -----------------------------------------------------------
const SESSION_RESPONSE = {
  session_id: "ses-abc-123",
  url: "https://app.devin.ai/sessions/ses-abc-123",
  status: "new",
  created_at: 1700000000,
  updated_at: 1700000000,
};

const PLAYBOOK_RESPONSE = {
  playbook_id: "pb-xyz-789",
  title: "test playbook",
  body: "do the thing",
};

// ---------------------------------------------------------------------------
// Mock HTTP server
// ---------------------------------------------------------------------------

let server: Server;

/** Last request metadata captured by the mock, for assertion purposes. */
let lastRequest: {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
} | null = null;

/** Override the response for the next request (one-shot). */
let nextResponse: { status: number; body: string } | null = null;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

function handler(req: IncomingMessage, res: ServerResponse): void {
  void (async () => {
    const body = await readBody(req);
    lastRequest = {
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: req.headers as Record<string, string | string[] | undefined>,
      body,
    };

    // One-shot override
    if (nextResponse) {
      const nr = nextResponse;
      nextResponse = null;
      res.writeHead(nr.status, { "Content-Type": "application/json" });
      res.end(nr.body);
      return;
    }

    const url = req.url ?? "";
    const method = req.method ?? "GET";

    // POST /v3/organizations/:orgId/sessions
    if (method === "POST" && url.match(/\/v3\/organizations\/[^/]+\/sessions$/)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(SESSION_RESPONSE));
      return;
    }

    // GET /v3/organizations/:orgId/sessions/:sessionId
    if (method === "GET" && url.match(/\/v3\/organizations\/[^/]+\/sessions\/[^/]+$/)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(SESSION_RESPONSE));
      return;
    }

    // POST /v3/organizations/:orgId/sessions/:sessionId/messages
    if (method === "POST" && url.match(/\/v3\/organizations\/[^/]+\/sessions\/[^/]+\/messages$/)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /v3/organizations/:orgId/sessions/:sessionId/archive
    if (method === "POST" && url.match(/\/v3\/organizations\/[^/]+\/sessions\/[^/]+\/archive$/)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /v3/organizations/:orgId/sessions/:sessionId/messages
    if (method === "GET" && url.match(/\/v3\/organizations\/[^/]+\/sessions\/[^/]+\/messages/)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          items: [
            { event_id: "msg-001", source: "user", message: "hello", created_at: 1700000001 },
            { event_id: "msg-002", source: "devin", message: "hi there", created_at: 1700000002 },
          ],
          end_cursor: "cursor-abc",
          has_next_page: false,
          total: 2,
        }),
      );
      return;
    }

    // POST /v3/organizations/:orgId/playbooks
    if (method === "POST" && url.match(/\/v3\/organizations\/[^/]+\/playbooks$/)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(PLAYBOOK_RESPONSE));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  })();
}

beforeAll(async () => {
  process.env.DEVIN_API_BASE_URL = TEST_BASE_URL;

  await new Promise<void>((resolve) => {
    server = createServer(handler);
    server.listen(TEST_PORT, () => resolve());
  });
});

afterAll(() => {
  server.close();
  delete process.env.DEVIN_API_BASE_URL;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("devin-api: createSession", () => {
  test("success — returns DevinSessionResponse", async () => {
    const result = await devinApi.createSession(ORG_ID, API_KEY, {
      prompt: "hello devin",
    });

    expect(result.session_id).toBe("ses-abc-123");
    expect(result.url).toBe("https://app.devin.ai/sessions/ses-abc-123");
    expect(result.status).toBe("new");
  });

  test("4xx error — throws with status and body", async () => {
    nextResponse = {
      status: 422,
      body: JSON.stringify({ error: "invalid prompt" }),
    };

    await expect(devinApi.createSession(ORG_ID, API_KEY, { prompt: "" })).rejects.toThrow(
      /HTTP 422/,
    );
  });

  test("auth header carries Bearer token", async () => {
    lastRequest = null;
    await devinApi.createSession(ORG_ID, API_KEY, { prompt: "check headers" });

    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  test("URL includes org ID", async () => {
    lastRequest = null;
    await devinApi.createSession(ORG_ID, API_KEY, { prompt: "check url" });

    expect(lastRequest!.url).toContain(`/v3/organizations/${ORG_ID}/sessions`);
  });
});

describe("devin-api: getSession", () => {
  test("success — returns session data", async () => {
    const result = await devinApi.getSession(ORG_ID, API_KEY, "ses-abc-123");
    expect(result.session_id).toBe("ses-abc-123");
    expect(result.status).toBe("new");
  });

  test("URL includes session ID", async () => {
    lastRequest = null;
    await devinApi.getSession(ORG_ID, API_KEY, "ses-poll-test");
    expect(lastRequest!.url).toContain("/ses-poll-test");
    expect(lastRequest!.method).toBe("GET");
  });
});

describe("devin-api: sendMessage", () => {
  test("success — does not throw", async () => {
    await expect(
      devinApi.sendMessage(ORG_ID, API_KEY, "ses-abc-123", "approve"),
    ).resolves.toBeUndefined();
  });

  test("sends message in JSON body", async () => {
    lastRequest = null;
    await devinApi.sendMessage(ORG_ID, API_KEY, "ses-abc-123", "my message");

    const body = JSON.parse(lastRequest!.body);
    expect(body.message).toBe("my message");
  });
});

describe("devin-api: archiveSession", () => {
  test("success — does not throw", async () => {
    await expect(devinApi.archiveSession(ORG_ID, API_KEY, "ses-abc-123")).resolves.toBeUndefined();
  });

  test("URL includes /archive", async () => {
    lastRequest = null;
    await devinApi.archiveSession(ORG_ID, API_KEY, "ses-archive-test");
    expect(lastRequest!.url).toContain("/ses-archive-test/archive");
    expect(lastRequest!.method).toBe("POST");
  });
});

describe("devin-api: getSessionMessages", () => {
  test("success — returns messages with cursor info", async () => {
    const result = await devinApi.getSessionMessages(ORG_ID, API_KEY, "ses-abc-123");
    expect(result.items).toHaveLength(2);
    expect(result.items[0].event_id).toBe("msg-001");
    expect(result.items[1].source).toBe("devin");
    expect(result.end_cursor).toBe("cursor-abc");
    expect(result.has_next_page).toBe(false);
  });

  test("URL includes session ID and default pagination", async () => {
    lastRequest = null;
    await devinApi.getSessionMessages(ORG_ID, API_KEY, "ses-msg-test");
    expect(lastRequest!.method).toBe("GET");
    expect(lastRequest!.url).toContain("/ses-msg-test/messages");
    expect(lastRequest!.url).toContain("first=200");
  });

  test("passes cursor via after param", async () => {
    lastRequest = null;
    await devinApi.getSessionMessages(ORG_ID, API_KEY, "ses-abc-123", "cursor-prev");
    expect(lastRequest!.url).toContain("after=cursor-prev");
  });

  test("4xx error — throws with status", async () => {
    nextResponse = { status: 404, body: JSON.stringify({ error: "session not found" }) };
    await expect(devinApi.getSessionMessages(ORG_ID, API_KEY, "ses-missing")).rejects.toThrow(
      /HTTP 404/,
    );
  });
});

describe("devin-api: createPlaybook", () => {
  test("success — returns DevinPlaybookResponse", async () => {
    const result = await devinApi.createPlaybook(ORG_ID, API_KEY, {
      title: "test playbook",
      body: "do the thing",
    });
    expect(result.playbook_id).toBe("pb-xyz-789");
    expect(result.title).toBe("test playbook");
  });

  test("sends title and body in JSON body", async () => {
    lastRequest = null;
    await devinApi.createPlaybook(ORG_ID, API_KEY, {
      title: "my pb",
      body: "instructions here",
    });
    const body = JSON.parse(lastRequest!.body);
    expect(body.title).toBe("my pb");
    expect(body.body).toBe("instructions here");
  });
});

describe("devin-api: error handling", () => {
  test("5xx response throws with status", async () => {
    nextResponse = {
      status: 500,
      body: JSON.stringify({ error: "internal server error" }),
    };

    await expect(devinApi.getSession(ORG_ID, API_KEY, "ses-abc-123")).rejects.toThrow(/HTTP 500/);
  });

  test("5xx includes response body in error message", async () => {
    nextResponse = {
      status: 503,
      body: JSON.stringify({ error: "service unavailable" }),
    };

    try {
      await devinApi.createSession(ORG_ID, API_KEY, { prompt: "test" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("service unavailable");
      expect((err as Error).message).toContain("503");
    }
  });

  test("error message includes the operation label", async () => {
    nextResponse = { status: 400, body: "bad request" };

    try {
      await devinApi.archiveSession(ORG_ID, API_KEY, "ses-test");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("archiveSession");
    }
  });
});

describe("devin-api: base URL override", () => {
  test("DEVIN_API_BASE_URL is respected (requests reach mock server)", async () => {
    // The fact that all the above tests work at all proves the base URL
    // override is working — but let's be explicit about it.
    lastRequest = null;
    await devinApi.getSession(ORG_ID, API_KEY, "ses-url-test");
    // The request reached our mock server on TEST_PORT, which only happens
    // if the base URL was overridden from the default https://api.devin.ai.
    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.url).toBe(`/v3/organizations/${ORG_ID}/sessions/ses-url-test`);
  });
});
