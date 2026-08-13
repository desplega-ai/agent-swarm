import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { type AriaHqRepository, createAriaHqRepository } from "../ariahq/repository";
import { closeDb, createAgent, createUser, getDb, initDb } from "../be/db";
import { createDevFlowRepository } from "../devflow/repository";

const TEST_DB_PATH = "./test-ariahq-knowledge-sources.sqlite";

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("AriaHQ production knowledge sources", () => {
  let aria: AriaHqRepository;
  let organizationId: string;
  let otherOrganizationId: string;
  let userId: string;
  let agentId: string;

  beforeAll(async () => {
    await removeTestDb();
    initDb(TEST_DB_PATH);
    aria = createAriaHqRepository(getDb());
    const devflow = createDevFlowRepository(getDb());
    userId = createUser({ name: "Knowledge Admin", email: "knowledge-admin@example.com" }).id;
    organizationId = devflow.createOrganization({ name: "Rebar", slug: "sources-rebar" }).id;
    otherOrganizationId = devflow.createOrganization({ name: "Other", slug: "sources-other" }).id;
    devflow.addMembership({ organizationId, userId, role: "admin" });
    agentId = createAgent({ name: "Aria Source Runner", isLead: false, status: "idle" }).id;
  });

  afterAll(async () => {
    closeDb();
    await removeTestDb();
  });

  test("source definitions are tenant-scoped and client sources fail closed without a client key", () => {
    expect(() =>
      aria.createKnowledgeSource({
        organizationId,
        key: "rentvine-drive",
        name: "Rentvine Drive",
        sourceKind: "google_drive",
        audience: "client",
        runAsAgentId: agentId,
        adapter: "openapi",
        connectionSlug: "google-drive",
        syncConfig: {},
        createdByUserId: userId,
      }),
    ).toThrow(/client key/i);

    const source = aria.createKnowledgeSource({
      organizationId,
      key: "internal-drive",
      name: "Internal Google Drive",
      sourceKind: "google_drive",
      audience: "internal",
      runAsAgentId: agentId,
      adapter: "openapi",
      connectionSlug: "google-drive",
      syncConfig: {
        listOperation: "listFiles",
        listArgs: { query: { pageSize: 100 } },
        recordsPath: "files",
        fieldMap: {
          sourceRef: "record.id",
          sourceRevision: "record.modifiedTime",
          title: "record.name",
          content: "detail.text",
          sourceUrl: "record.webViewLink",
          effectiveAt: "record.modifiedTime",
        },
      },
      createdByUserId: userId,
    });

    expect(aria.getKnowledgeSource(organizationId, source.id)?.key).toBe("internal-drive");
    expect(aria.getKnowledgeSource(otherOrganizationId, source.id)).toBeNull();
    expect(aria.listKnowledgeSources(otherOrganizationId)).toEqual([]);
  });

  test("a sync run atomically ingests an idempotent batch and advances its durable cursor", () => {
    const source = aria.createKnowledgeSource({
      organizationId,
      key: "crm-deals",
      name: "CRM Deals",
      sourceKind: "crm",
      audience: "internal",
      runAsAgentId: agentId,
      adapter: "openapi",
      connectionSlug: "hubspot",
      syncConfig: {
        listOperation: "searchDeals",
        recordsPath: "results",
        cursor: { responsePath: "paging.next.after", requestPath: "body.after" },
        fieldMap: {
          sourceRef: "record.id",
          sourceRevision: "record.updatedAt",
          title: "record.properties.dealname",
          content: "record.properties.notes_last_contacted",
          effectiveAt: "record.updatedAt",
        },
      },
      createdByUserId: userId,
    });
    const run = aria.beginKnowledgeSync(source.id, agentId);

    const completed = aria.completeKnowledgeSync({
      sourceId: source.id,
      runId: run.id,
      agentId,
      nextCursor: "page-2",
      records: [
        {
          sourceRef: "deal:77",
          sourceRevision: "9",
          title: "Rentvine renewal",
          content: "Renewal owner is Jesse.",
          effectiveAt: "2026-08-11T12:00:00.000Z",
          metadata: { dealId: "77" },
        },
      ],
    });

    expect(completed.status).toBe("completed");
    expect(completed.recordsCreated).toBe(1);
    expect(aria.getKnowledgeSource(organizationId, source.id)?.cursor).toBe("page-2");
    expect(
      aria.searchKnowledge({
        organizationId,
        query: "renewal owner Jesse",
        audience: "internal",
      }),
    ).toHaveLength(1);

    const replay = aria.completeKnowledgeSync({
      sourceId: source.id,
      runId: run.id,
      agentId,
      nextCursor: "page-2",
      records: [],
    });
    expect(replay.id).toBe(completed.id);
    expect(
      getDb()
        .prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM ariahq_knowledge_records")
        .get()?.count,
    ).toBe(1);
  });

  test("the source runner identity is enforced and failed runs retain their diagnostic", () => {
    const source = aria.createKnowledgeSource({
      organizationId,
      key: "calls",
      name: "Call recordings",
      sourceKind: "call_recording",
      audience: "internal",
      runAsAgentId: agentId,
      adapter: "webhook",
      webhookSecretHash: "test-only-webhook-secret-hash",
      syncConfig: {},
      createdByUserId: userId,
    });

    expect(() => aria.beginKnowledgeSync(source.id, crypto.randomUUID())).toThrow(/runner/i);
    const run = aria.beginKnowledgeSync(source.id, agentId);
    const failed = aria.failKnowledgeSync(source.id, run.id, agentId, "provider timeout");
    expect(failed.status).toBe("failed");
    expect(failed.errorMessage).toBe("provider timeout");
    expect(aria.getKnowledgeSource(organizationId, source.id)?.lastSyncStatus).toBe("failed");
  });
});
