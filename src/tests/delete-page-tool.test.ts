import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  closeDb,
  createAgent,
  createPage,
  createPageVersion,
  createUser,
  getDb,
  getPage,
  getPageVersions,
  initDb,
  listUserFavorites,
  setUserFavorite,
  upsertKv,
} from "../be/db";
import { registerDeletePageTool } from "../tools/delete-page";

const TEST_DB_PATH = "./test-delete-page-tool.sqlite";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
};

function buildServer() {
  const server = new McpServer({ name: "delete-page-test", version: "1.0.0" });
  registerDeletePageTool(server);
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools["delete-page"];
  if (!tool) throw new Error("delete-page tool not registered");
  return tool;
}

function callDeletePage(args: Record<string, unknown>, callerAgentId?: string) {
  const tool = buildServer();
  return tool.handler(args, {
    sessionId: "test-session",
    requestInfo: callerAgentId ? { headers: { "x-agent-id": callerAgentId } } : { headers: {} },
  });
}

function makePage(agentId: string, slug: string, title = slug) {
  return createPage({
    agentId,
    slug,
    title,
    contentType: "text/html",
    authMode: "public",
    body: `<h1>${title}</h1>`,
  });
}

let ownerId: string;
let otherAgentId: string;
let leadId: string;

describe("delete-page MCP tool", () => {
  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    ownerId = createAgent({ name: "delete-page-owner", isLead: false, status: "idle" }).id;
    otherAgentId = createAgent({
      name: "delete-page-other",
      isLead: false,
      status: "idle",
    }).id;
    leadId = createAgent({ name: "delete-page-lead", isLead: true, status: "idle" }).id;
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("owner can delete by pageId and receives deleted page metadata", async () => {
    const page = makePage(ownerId, "owner-id-delete", "Owner Delete");

    const result = await callDeletePage({ pageId: page.id }, ownerId);
    const sc = result.structuredContent as {
      success: boolean;
      deletedPage?: { id: string; slug: string; title: string };
    };

    expect(sc.success).toBe(true);
    expect(sc.deletedPage).toEqual({
      id: page.id,
      slug: "owner-id-delete",
      title: "Owner Delete",
    });
    expect(getPage(page.id)).toBeNull();
  });

  test("slug deletes only from the caller's page namespace", async () => {
    const ownerPage = makePage(ownerId, "shared-slug", "Owner Shared Slug");
    const otherPage = makePage(otherAgentId, "shared-slug", "Other Shared Slug");

    const result = await callDeletePage({ slug: "shared-slug" }, ownerId);
    const sc = result.structuredContent as { success: boolean; deletedPage?: { id: string } };

    expect(sc.success).toBe(true);
    expect(sc.deletedPage?.id).toBe(ownerPage.id);
    expect(getPage(ownerPage.id)).toBeNull();
    expect(getPage(otherPage.id)).not.toBeNull();
  });

  test("lead can delete another agent's page by pageId", async () => {
    const page = makePage(ownerId, "lead-delete", "Lead Delete");

    const result = await callDeletePage({ pageId: page.id }, leadId);
    const sc = result.structuredContent as { success: boolean };

    expect(sc.success).toBe(true);
    expect(getPage(page.id)).toBeNull();
  });

  test("non-owner non-lead gets a clear permission error and page remains", async () => {
    const page = makePage(ownerId, "deny-delete", "Deny Delete");

    const result = await callDeletePage({ pageId: page.id }, otherAgentId);
    const sc = result.structuredContent as { success: boolean; message: string };

    expect(sc.success).toBe(false);
    expect(sc.message).toBe("Only the lead or page owner can delete pages.");
    expect(getPage(page.id)).not.toBeNull();
  });

  test("delete cascades versions and removes page-scoped KV and favorites", async () => {
    const page = makePage(ownerId, "cascade-delete", "Cascade Delete");
    createPageVersion({
      pageId: page.id,
      version: 1,
      snapshot: {
        title: page.title,
        description: page.description,
        contentType: page.contentType,
        authMode: page.authMode,
        body: page.body,
        needsCredentials: page.needsCredentials,
      },
      changedByAgentId: ownerId,
    });
    upsertKv({
      namespace: `task:page:${page.id}`,
      key: "state",
      value: { ok: true },
      valueType: "json",
    });
    const user = createUser({ name: "Delete Page Favorite User" });
    setUserFavorite({
      userId: user.id,
      itemType: "page",
      itemId: page.id,
      favorite: true,
    });

    const result = await callDeletePage({ pageId: page.id }, ownerId);
    const sc = result.structuredContent as { success: boolean };

    expect(sc.success).toBe(true);
    expect(getPageVersions(page.id)).toHaveLength(0);
    expect(
      getDb()
        .prepare<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM kv_entries WHERE namespace = ?",
        )
        .get(`task:page:${page.id}`)?.n,
    ).toBe(0);
    expect(listUserFavorites({ userId: user.id, itemType: "page" })).toHaveLength(0);
  });

  test("missing selector or missing agent id returns success false", async () => {
    const noSelector = await callDeletePage({}, ownerId);
    expect((noSelector.structuredContent as { success: boolean; message: string }).success).toBe(
      false,
    );
    expect((noSelector.structuredContent as { message: string }).message).toBe(
      "Either pageId or slug must be provided.",
    );

    const noAgent = await callDeletePage({ pageId: "missing" });
    expect((noAgent.structuredContent as { success: boolean; message: string }).success).toBe(
      false,
    );
    expect((noAgent.structuredContent as { message: string }).message).toContain("Agent ID");
  });
});
