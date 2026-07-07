/**
 * RBAC characterization tests — Slack-surface + Kapso + channel MCP tool gates
 * (DES-445, Phase 1).
 *
 * Pins TODAY'S exact authorization behavior (soft-failure shape + message
 * strings) at the inline `isLead` gates in slack-post, slack-start-thread,
 * slack-read, slack-upload-file, delete-channel and (un)register-kapso-number,
 * so the Phase-4 migration to `can()` can prove behavior parity. MUST pass
 * both before and after the refactor.
 *
 * slack-delete / slack-update lead gates are already characterized by
 * src/tests/slack-delete.test.ts:91 and src/tests/slack-update.test.ts:94 —
 * not duplicated here.
 *
 * Allow-path caveat: these tools have external side effects (Slack/Kapso).
 * Per the plan, lead allow-cases assert only that the result is NOT the
 * authorization denial (downstream "Slack not configured." etc. is fine).
 * delete-channel is pure-DB, so its allow case asserts full success.
 *
 * Pattern: src/tests/update-profile-auth.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, createChannel, getChannelById, initDb } from "../be/db";
import { registerDeleteChannelTool } from "../tools/delete-channel";
import {
  registerRegisterKapsoNumberTool,
  registerUnregisterKapsoNumberTool,
} from "../tools/register-kapso-number";
import { registerSlackPostTool } from "../tools/slack-post";
import { registerSlackReadTool } from "../tools/slack-read";
import { registerSlackStartThreadTool } from "../tools/slack-start-thread";
import { registerSlackUploadFileTool } from "../tools/slack-upload-file";

const TEST_DB_PATH = "./test-rbac-charact-slack.sqlite";

const LEAD_ID = "aaaa2000-0000-4000-8000-000000000001";
const WORKER_ID = "bbbb2000-0000-4000-8000-000000000002";

type Structured = {
  yourAgentId?: string;
  success: boolean;
  message: string;
  [key: string]: unknown;
};

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent: Structured;
};

let server: McpServer;
let savedKapsoApiKey: string | undefined;

async function callTool(
  name: string,
  callerAgentId: string | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // biome-ignore lint/complexity/noBannedTypes: accessing internal MCP SDK type for test
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })
    ._registeredTools;
  const handler = tools[name]?.handler;
  if (!handler) throw new Error(`Tool not registered: ${name}`);

  const extra = {
    sessionId: "test-session",
    requestInfo: {
      headers: {
        "x-agent-id": callerAgentId ?? "",
      },
    },
  };

  return (await handler(args, extra)) as ToolResult;
}

async function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // File doesn't exist
    }
  }
}

beforeAll(async () => {
  await removeDbFiles();
  closeDb();
  initDb(TEST_DB_PATH);

  // Ensure the lead allow-path for register-kapso-number never talks to the
  // real Kapso API, even on machines with KAPSO_API_KEY in the environment.
  savedKapsoApiKey = process.env.KAPSO_API_KEY;
  delete process.env.KAPSO_API_KEY;

  createAgent({ id: LEAD_ID, name: "Charact Lead", isLead: true, status: "idle" });
  createAgent({ id: WORKER_ID, name: "Charact Worker", isLead: false, status: "idle" });

  server = new McpServer({ name: "test-rbac-charact-slack", version: "1.0.0" });
  registerSlackPostTool(server);
  registerSlackStartThreadTool(server);
  registerSlackReadTool(server);
  registerSlackUploadFileTool(server);
  registerDeleteChannelTool(server);
  registerRegisterKapsoNumberTool(server);
  registerUnregisterKapsoNumberTool(server);
});

afterAll(async () => {
  if (savedKapsoApiKey !== undefined) {
    process.env.KAPSO_API_KEY = savedKapsoApiKey;
  } else {
    delete process.env.KAPSO_API_KEY;
  }
  closeDb();
  await removeDbFiles();
});

describe("slack tool gates (characterization)", () => {
  // slack-post.ts:51 — direct channel post requires lead
  test("worker cannot post directly to a Slack channel", async () => {
    const result = await callTool("slack-post", WORKER_ID, {
      channelId: "C0CHARACT01",
      message: "hi",
    });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Posting to Slack channels requires lead privileges.",
    );
  });

  test("lead slack-post is not blocked by the lead gate", async () => {
    const result = await callTool("slack-post", LEAD_ID, {
      channelId: "C0CHARACT01",
      message: "hi",
    });

    // External side effect (Slack) — assert only NOT-the-authz-denial.
    // In the test env this proceeds past the gate and fails downstream
    // ("Slack not configured.").
    expect(result.structuredContent.message).not.toContain("requires lead privileges");
  });

  // slack-start-thread.ts:46 — starting a thread requires lead
  test("worker cannot start a Slack thread", async () => {
    const result = await callTool("slack-start-thread", WORKER_ID, {
      channelId: "C0CHARACT01",
      message: "hi",
    });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Posting to Slack channels requires lead privileges.",
    );
  });

  test("lead slack-start-thread is not blocked by the lead gate", async () => {
    const result = await callTool("slack-start-thread", LEAD_ID, {
      channelId: "C0CHARACT01",
      message: "hi",
    });

    expect(result.structuredContent.message).not.toContain("requires lead privileges");
  });

  // slack-read.ts:146 — direct channel read requires lead
  test("worker cannot read a Slack channel directly", async () => {
    const result = await callTool("slack-read", WORKER_ID, {
      channelId: "C0CHARACT01",
    });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Direct channel access requires lead privileges.",
    );
    expect(result.structuredContent.messages).toEqual([]);
  });

  test("lead slack-read is not blocked by the lead gate", async () => {
    const result = await callTool("slack-read", LEAD_ID, {
      channelId: "C0CHARACT01",
    });

    expect(result.structuredContent.message).not.toContain("requires lead privileges");
  });

  // slack-upload-file.ts:219 — direct channel upload requires lead
  test("worker cannot upload a file directly to a Slack channel", async () => {
    const result = await callTool("slack-upload-file", WORKER_ID, {
      channelId: "C0CHARACT01",
      content: Buffer.from("hello").toString("base64"),
      filename: "charact.txt",
    });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Direct channel access requires lead privileges.",
    );
  });

  test("lead slack-upload-file is not blocked by the lead gate", async () => {
    const result = await callTool("slack-upload-file", LEAD_ID, {
      channelId: "C0CHARACT01",
      content: Buffer.from("hello").toString("base64"),
      filename: "charact.txt",
    });

    expect(result.structuredContent.message).not.toContain("requires lead privileges");
  });
});

describe("delete-channel gate (characterization)", () => {
  // delete-channel.ts:48 — lead only (pure DB, allow asserts full success)
  test("worker cannot delete a channel", async () => {
    const channel = createChannel("charact-delete-deny");

    const result = await callTool("delete-channel", WORKER_ID, { channelId: channel.id });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Not authorized. Only the lead agent can delete channels.",
    );
    // DB not mutated
    expect(getChannelById(channel.id)).not.toBeNull();
  });

  test("lead can delete a channel", async () => {
    const channel = createChannel("charact-delete-allow");

    const result = await callTool("delete-channel", LEAD_ID, { channelId: channel.id });

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.message).toBe('Deleted channel "charact-delete-allow".');
    expect(getChannelById(channel.id)).toBeNull();
  });
});

describe("kapso number gates (characterization)", () => {
  // register-kapso-number.ts:71 — lead only
  test("worker cannot register a Kapso number", async () => {
    const result = await callTool("register-kapso-number", WORKER_ID, {
      phoneNumberId: "charact-phone-1",
    });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Permission denied. Only the lead can register a Kapso number.",
    );
  });

  test("lead register-kapso-number is not blocked by the lead gate", async () => {
    // KAPSO_API_KEY is unset (see beforeAll) so no provider webhook call happens.
    const result = await callTool("register-kapso-number", LEAD_ID, {
      phoneNumberId: "charact-phone-2",
    });

    expect(result.structuredContent.message).not.toContain("Permission denied");
  });

  // register-kapso-number.ts:174 — lead only (unregister)
  test("worker cannot unregister a Kapso number", async () => {
    const result = await callTool("unregister-kapso-number", WORKER_ID, {
      phoneNumberId: "charact-phone-2",
    });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Permission denied. Only the lead can unregister a Kapso number.",
    );
  });

  test("lead unregister-kapso-number is not blocked by the lead gate", async () => {
    const result = await callTool("unregister-kapso-number", LEAD_ID, {
      phoneNumberId: "charact-phone-2",
    });

    expect(result.structuredContent.message).not.toContain("Permission denied");
  });
});
