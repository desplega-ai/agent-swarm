import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";

const postMessage = mock(async (_args: Record<string, unknown>) => ({ ts: "1700000000.000100" }));
const conversationsInfo = mock(async (_args: { channel: string }) => ({
  channel: { is_ext_shared: false },
}));
mock.module("../slack/app", () => ({
  getSlackApp: () => ({
    client: { chat: { postMessage }, conversations: { info: conversationsInfo } },
  }),
}));

import {
  closeDb,
  createAgent,
  getApprovalRequestById,
  initDb,
  listApprovalRequests,
} from "../be/db";
import { handleApprovalRequests } from "../http/approval-requests";
import { resetExternalChannelStateForTesting } from "../slack/external-channel";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-approval-requests-notifications.sqlite";

let server: Server;
let baseUrl = "";
let leadId = "";
let workerId = "";

function postRequest(body: Record<string, unknown>, agentId: string | null): Promise<Response> {
  return fetch(`${baseUrl}/api/approval-requests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(agentId ? { "X-Agent-ID": agentId } : {}),
    },
    body: JSON.stringify({
      title: "Ship it?",
      questions: [{ id: "q1", type: "approval", label: "Approve the deploy?" }],
      approvers: { policy: "any" },
      ...body,
    }),
  });
}

async function createRequest(body: Record<string, unknown>, agentId = leadId): Promise<string> {
  const res = await postRequest(body, agentId);
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
    leadId = (await createAgent({ name: "notify-lead", isLead: true, status: "idle" })).id;
    workerId = (await createAgent({ name: "notify-worker", isLead: false, status: "idle" })).id;
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
    conversationsInfo.mockClear();
    resetExternalChannelStateForTesting();
    delete process.env.SLACK_BLOCK_EXTERNAL_CHANNELS;
  });

  test("posts one Slack card and stores its messageTs", async () => {
    const id = await createRequest({
      title: "Ship <!channel> & go?",
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
    expect(blocks).toContain("Approval Required: Ship &lt;!channel&gt; &amp; go?");
    expect(blocks).not.toContain("<!channel>");
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

  test("refuses Slack notifications from a non-lead caller and creates nothing", async () => {
    for (const agentId of [workerId, null]) {
      const before = (await listApprovalRequests()).length;
      const res = await postRequest(
        { notifications: [{ channel: "slack", target: "C123" }] },
        agentId,
      );

      expect(res.status).toBe(403);
      expect((await listApprovalRequests()).length).toBe(before);
    }
    expect(postMessage).not.toHaveBeenCalled();
  });

  test("lets a non-lead caller create a request without Slack notifications", async () => {
    await createRequest(
      { notifications: [{ channel: "email", target: "ops@example.com" }] },
      workerId,
    );
  });

  test("skips a channel shared with another org when the external-channel block is on", async () => {
    process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "true";
    conversationsInfo.mockImplementationOnce(async () => ({ channel: { is_ext_shared: true } }));

    const id = await createRequest({ notifications: [{ channel: "slack", target: "CEXT" }] });
    await waitFor(async () => conversationsInfo.mock.calls.length > 0);
    await Bun.sleep(50);

    expect(conversationsInfo).toHaveBeenCalledWith({ channel: "CEXT" });
    expect(postMessage).not.toHaveBeenCalled();
    expect((await getApprovalRequestById(id))?.notificationChannels).toEqual([
      { channel: "slack", target: "CEXT" },
    ]);
  });
});
