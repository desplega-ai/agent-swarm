import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, initDb } from "../be/db";
import { handleMeetings } from "../http/meetings";
import { getPathSegments, parseQueryParams } from "../http/utils";
import type { Meeting, MeetingDetail } from "../types";

const TEST_DB_PATH = "./test-meetings-http.sqlite";
const TEST_PORT = 13061;
const baseUrl = `http://localhost:${TEST_PORT}`;

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const handled = await handleMeetings(req, res, pathSegments, queryParams, myAgentId);
    if (!handled) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });
}

function hdr(agentId: string) {
  return { "Content-Type": "application/json", "X-Agent-ID": agentId };
}

describe("Meetings HTTP API", () => {
  let server: Server;
  const creator = crypto.randomUUID();
  const alice = crypto.randomUUID();
  const bob = crypto.randomUUID();

  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {}
    initDb(TEST_DB_PATH);
    server = createTestServer();
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("GET /api/meetings/templates lists built-in templates (before {id} match)", async () => {
    const res = await fetch(`${baseUrl}/api/meetings/templates`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { templates: { key: string }[] };
    expect(body.templates.map((t) => t.key)).toContain("debate");
  });

  test("full lifecycle: create → contribute (gate blocks) → contribute → conclude", async () => {
    // Create from the "decision" template (agenda seeded from template).
    const createRes = await fetch(`${baseUrl}/api/meetings`, {
      method: "POST",
      headers: hdr(creator),
      body: JSON.stringify({
        title: "Ship?",
        template: "decision",
        participants: [alice, bob],
      }),
    });
    expect(createRes.status).toBe(201);
    const meeting = (await createRes.json()) as Meeting;
    expect(meeting.status).toBe("open");
    expect(meeting.agenda.length).toBeGreaterThan(0);

    // Alice contributes.
    const c1 = await fetch(`${baseUrl}/api/meetings/${meeting.id}/contributions`, {
      method: "POST",
      headers: hdr(alice),
      body: JSON.stringify({ content: "ship it" }),
    });
    expect(c1.status).toBe(201);

    // Conclude now → 409 (bob hasn't spoken).
    const early = await fetch(`${baseUrl}/api/meetings/${meeting.id}/conclude`, {
      method: "POST",
      headers: hdr(creator),
      body: JSON.stringify({ conclusion: "ship" }),
    });
    expect(early.status).toBe(409);

    // Bob contributes.
    await fetch(`${baseUrl}/api/meetings/${meeting.id}/contributions`, {
      method: "POST",
      headers: hdr(bob),
      body: JSON.stringify({ content: "agreed" }),
    });

    // Conclude → 200.
    const done = await fetch(`${baseUrl}/api/meetings/${meeting.id}/conclude`, {
      method: "POST",
      headers: hdr(creator),
      body: JSON.stringify({ conclusion: "Decision: ship Monday." }),
    });
    expect(done.status).toBe(200);
    const detail = (await done.json()) as MeetingDetail;
    expect(detail.status).toBe("concluded");
    expect(detail.fullyAttended).toBe(true);

    // GET detail reflects the conclusion.
    const getRes = await fetch(`${baseUrl}/api/meetings/${meeting.id}`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as MeetingDetail;
    expect(fetched.conclusion).toBe("Decision: ship Monday.");
    expect(fetched.contributions).toHaveLength(2);
  });

  test("POST /api/meetings requires X-Agent-ID", async () => {
    const res = await fetch(`${baseUrl}/api/meetings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", agenda: "y", participants: ["p"] }),
    });
    expect(res.status).toBe(400);
  });

  test("GET /api/meetings/{id} returns 404 for unknown id", async () => {
    const res = await fetch(`${baseUrl}/api/meetings/${"0".repeat(32)}`);
    expect(res.status).toBe(404);
  });

  test("GET /api/meetings lists and filters by status", async () => {
    const res = await fetch(`${baseUrl}/api/meetings?status=concluded`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meetings: Meeting[] };
    expect(body.meetings.every((m) => m.status === "concluded")).toBe(true);
  });
});
