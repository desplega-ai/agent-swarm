import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";

const postMessage = mock(async (_args: Record<string, unknown>) => ({ ts: "1700000000.000100" }));
mock.module("../slack/app", () => ({
  getSlackApp: () => ({ client: { chat: { postMessage } } }),
}));

import { closeDb, getApprovalRequestById, initDb } from "../be/db";
import { handleApprovalRequests } from "../http/approval-requests";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-approval-requests-notifications.sqlite";

let server: Server;
let baseUrl = "";

async function createRequest(body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${baseUrl}/api/approval-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Ship it?",
      questions: [{ id: "q1", type: "approval", label: "Approve the deploy?" }],
      approvers: { policy: "any" },
      ...body,
    }),
  });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { approvalRequest: { id: string } };
  return json.approvalRequest.id;
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await Bun.sleep(10);
  }
}

describe("POST /api/approval-requests notifications", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {}
    initDb(TEST_DB_PATH);
    server = createHttpServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const handled = await handleApprovalRequests(
        req,
        res,
        url.pathname.split("/").filter(Boolean),
        url.searchParams,
      );
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
    baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
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

  beforeEach(() => {
    postMessage.mockClear();
  });

  test("posts one Slack card and stores its messageTs", async () => {
    const id = await createRequest({
      timeoutSeconds: 3600,
      notifications: [{ channel: "slack", target: "C123" }],
    });

    await waitFor(async () => {
      const row = await getApprovalRequestById(id);
      const channels = row?.notificationChannels as Array<{ messageTs?: string }> | null;
      return Boolean(channels?.[0]?.messageTs);
    });

    expect(postMessage).toHaveBeenCalledTimes(1);
    const args = postMessage.mock.calls[0]![0];
    expect(args.channel).toBe("C123");
    expect(args.text).toContain(`/approval-requests/${id}`);
    const blocks = JSON.stringify(args.blocks);
    expect(blocks).toContain("Approval Required: Ship it?");
    expect(blocks).toContain("Approve the deploy?");
    expect(blocks).toContain("Review & Respond");
    expect(blocks).toContain("times out if not responded");

    const row = await getApprovalRequestById(id);
    expect(row?.notificationChannels).toEqual([
      { channel: "slack", target: "C123", messageTs: "1700000000.000100" },
    ]);
  });

  test("posts nothing without notifications", async () => {
    const id = await createRequest({});
    await Bun.sleep(50);

    expect(postMessage).not.toHaveBeenCalled();
    expect((await getApprovalRequestById(id))?.notificationChannels).toBeNull();
  });

  test("skips email targets without posting", async () => {
    const id = await createRequest({
      notifications: [{ channel: "email", target: "ops@example.com" }],
    });
    await Bun.sleep(50);

    expect(postMessage).not.toHaveBeenCalled();
    expect((await getApprovalRequestById(id))?.notificationChannels).toEqual([
      { channel: "email", target: "ops@example.com" },
    ]);
  });
});
