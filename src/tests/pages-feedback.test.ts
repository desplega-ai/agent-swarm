/**
 * Page feedback overlay: `?__swarm-feedback` on `/p/:id` injects the overlay
 * scripts, and `POST /api/pages/:id/feedback` turns the collected element
 * comments into one task for the lead.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { feedbackOverlayScripts, isPageFeedbackRequested } from "../artifact-sdk/feedback-overlay";
import { closeDb, createAgent, getTaskById, initDb } from "../be/db";
import { handlePages } from "../http/pages";
import { handlePagesPublic } from "../http/pages-public";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-pages-feedback.sqlite";
let BASE = "";

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handlePagesPublic(req, res, pathSegments, queryParams)) return;
    if (await handlePages(req, res, pathSegments, queryParams, myAgentId)) return;
    res.writeHead(404);
    res.end("not found");
  });
}

async function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("page feedback", () => {
  let server: Server;
  const ownerId = crypto.randomUUID();
  const leadId = crypto.randomUUID();
  const ownerHeaders = { "Content-Type": "application/json", "X-Agent-ID": ownerId };
  let pageId = "";
  let otherPageId = "";

  async function createPublicPage(slug: string): Promise<string> {
    const res = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        slug,
        title: `Feedback ${slug}`,
        contentType: "text/html",
        authMode: "public",
        body: "<!doctype html><html><head><title>X</title></head><body><h1>Hello</h1></body></html>",
      }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  function sendFeedback(id: string, body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${BASE}/api/pages/${id}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  const comments = [
    {
      selector: "body > h1",
      tagName: "h1",
      text: "Hello",
      comment: "Make the heading say Welcome.\nAnd make it bigger.",
    },
  ];

  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
    server = createTestServer();
    BASE = `http://localhost:${await listenOnFreePort(server)}`;
    pageId = await createPublicPage("feedback-main");
    otherPageId = await createPublicPage("feedback-other");
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    await removeDbFiles();
  });

  test("isPageFeedbackRequested reads presence, and 0/false switch it off", () => {
    expect(isPageFeedbackRequested(new URLSearchParams(""))).toBe(false);
    expect(isPageFeedbackRequested(new URLSearchParams("__swarm-feedback"))).toBe(true);
    expect(isPageFeedbackRequested(new URLSearchParams("__swarm-feedback=1"))).toBe(true);
    expect(isPageFeedbackRequested(new URLSearchParams("__swarm-feedback=0"))).toBe(false);
    expect(isPageFeedbackRequested(new URLSearchParams("__swarm-feedback=FALSE"))).toBe(false);
  });

  test("overlay scripts are valid JavaScript", () => {
    const scripts = [
      ...feedbackOverlayScripts("abc").matchAll(/<script>([\s\S]*?)<\/script>/g),
    ].map((m) => m[1]!);
    expect(scripts).toHaveLength(2);
    // Compile only. A syntax error in the string-embedded overlay throws here.
    for (const source of scripts) expect(() => new Function(source)).not.toThrow();
  });

  test("/p/:id injects the overlay only when ?__swarm-feedback is on", async () => {
    const plain = await (await fetch(`${BASE}/p/${pageId}`)).text();
    expect(plain).not.toContain("__swarmFeedback");

    const off = await (await fetch(`${BASE}/p/${pageId}?__swarm-feedback=0`)).text();
    expect(off).not.toContain("__swarmFeedback");

    const res = await fetch(`${BASE}/p/${pageId}?__swarm-feedback`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`window.__swarmFeedback = {"pageId":"${pageId}"};`);
    expect(html).toContain("swarm-feedback-root");
    // The agent-authored body and the SDK are still served.
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("class SwarmSDK");
  });

  test("with no lead, the feedback task lands unassigned", async () => {
    const res = await sendFeedback(pageId, { comments });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { taskId: string; status: string; agentId: string | null };
    expect(body.agentId).toBeNull();
    expect(body.status).toBe("unassigned");
  });

  test("creates one lead task with the page context and every comment", async () => {
    await createAgent({ id: leadId, name: "feedback-lead", isLead: true, status: "idle" });
    const res = await sendFeedback(
      pageId,
      { pageUrl: `${BASE}/p/${pageId}?tab=2`, note: "Overall: too dense.", comments },
      { "X-Page-Id": pageId },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      taskId: string;
      agentId: string | null;
      task_url: string;
    };
    expect(body.agentId).toBe(leadId);
    expect(body.task_url).toEndWith(`/tasks/${body.taskId}`);

    const task = await getTaskById(body.taskId);
    expect(task?.agentId).toBe(leadId);
    expect(task?.tags).toContain("page-feedback");
    expect(task?.taskType).toBe("page-feedback");
    expect(task?.task).toContain(`"Feedback feedback-main" (id ${pageId}`);
    expect(task?.task).toContain(`owner agent ${ownerId}`);
    expect(task?.task).toContain(`Viewed at: ${BASE}/p/${pageId}?tab=2`);
    expect(task?.task).toContain("Overall: too dense.");
    expect(task?.task).toContain("1. Element: `body > h1` (<h1>)");
    expect(task?.task).toContain('Excerpt: "Hello"');
    // Multi-line comments stay indented under their list item.
    expect(task?.task).toContain("Comment: Make the heading say Welcome.\n   And make it bigger.");
  });

  test("a page session for another page is refused", async () => {
    const res = await sendFeedback(pageId, { comments }, { "X-Page-Id": otherPageId });
    expect(res.status).toBe(403);
  });

  test("unknown page is 404, empty or blank comments are 400", async () => {
    expect((await sendFeedback("f".repeat(32), { comments })).status).toBe(404);
    expect((await sendFeedback(pageId, { comments: [] })).status).toBe(400);
    expect(
      (await sendFeedback(pageId, { comments: [{ selector: "body", comment: "   " }] })).status,
    ).toBe(400);
  });
});
