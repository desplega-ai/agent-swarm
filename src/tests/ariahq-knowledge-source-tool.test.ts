import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createAriaHqRepository } from "../ariahq/repository";
import { closeDb, createAgent, createUser, getDb, initDb } from "../be/db";
import { createDevFlowRepository } from "../devflow/repository";
import { registerAriaKnowledgeSourceTool } from "../tools/ariahq-knowledge-source";

const TEST_DB_PATH = "./test-ariahq-knowledge-source-tool.sqlite";

type RegisteredTool = {
  handler: (
    args: unknown,
    extra: unknown,
  ) => Promise<{
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }>;
};

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("ariahq-knowledge-source MCP tool", () => {
  let sourceId: string;
  let runnerId: string;
  let otherAgentId: string;
  let handler: RegisteredTool["handler"];

  beforeAll(async () => {
    await removeTestDb();
    initDb(TEST_DB_PATH);
    const devflow = createDevFlowRepository(getDb());
    const aria = createAriaHqRepository(getDb());
    const userId = createUser({ name: "Source Owner", email: "source-owner@example.com" }).id;
    const organizationId = devflow.createOrganization({ name: "Rebar", slug: "source-tool" }).id;
    devflow.addMembership({ organizationId, userId, role: "admin" });
    runnerId = createAgent({ name: "Bound Runner", isLead: false, status: "idle" }).id;
    otherAgentId = createAgent({ name: "Other Runner", isLead: false, status: "idle" }).id;
    sourceId = aria.createKnowledgeSource({
      organizationId,
      key: "drive",
      name: "Drive",
      sourceKind: "google_drive",
      audience: "internal",
      adapter: "openapi",
      connectionSlug: "google-drive",
      runAsAgentId: runnerId,
      syncConfig: { listOperation: "listFiles", recordsPath: "files" },
      createdByUserId: userId,
    }).id;

    const server = new McpServer({ name: "aria-source-test", version: "1.0.0" });
    registerAriaKnowledgeSourceTool(server);
    const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
      ._registeredTools;
    const tool = tools["ariahq-knowledge-source"];
    if (!tool) throw new Error("AriaHQ knowledge source tool was not registered");
    handler = tool.handler;
  });

  afterAll(async () => {
    closeDb();
    await removeTestDb();
  });

  function meta(agentId: string) {
    return {
      sessionId: "aria-source-tool-test",
      requestInfo: { headers: { "x-agent-id": agentId } },
    };
  }

  test("only the source-bound agent can begin a sync", async () => {
    const denied = await handler({ action: "begin", sourceId }, meta(otherAgentId));
    expect(denied.isError).toBe(true);

    const begun = await handler({ action: "begin", sourceId }, meta(runnerId));
    expect(begun.isError).toBe(false);
    expect(begun.structuredContent).toMatchObject({
      success: true,
      source: {
        id: sourceId,
        connectionSlug: "google-drive",
        syncConfig: { listOperation: "listFiles" },
      },
      run: { status: "running" },
    });
  });

  test("commit ingests normalized evidence and preserves idempotency", async () => {
    const begun = await handler({ action: "begin", sourceId }, meta(runnerId));
    const run = begun.structuredContent?.run as { id: string };
    const committed = await handler(
      {
        action: "commit",
        sourceId,
        runId: run.id,
        nextCursor: "next-page",
        records: [
          {
            sourceRef: "file:1",
            sourceRevision: "2",
            title: "Operating plan",
            content: "The operating plan owner is Jamie.",
            effectiveAt: "2026-08-11T14:00:00.000Z",
            metadata: {},
          },
        ],
      },
      meta(runnerId),
    );
    expect(committed.isError).toBe(false);
    expect(committed.structuredContent).toMatchObject({
      run: { status: "completed", recordsCreated: 1 },
    });
  });
});
