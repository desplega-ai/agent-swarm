import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createAriaHqRepository } from "../ariahq/repository";
import { setSlackSurfaceVerifierForTests } from "../ariahq/services/slack-surface-verifier";
import { closeDb, createAgent, createUser, getDb, getScheduledTaskById, initDb } from "../be/db";
import { upsertScriptConnection } from "../be/script-connections";
import { upsertScriptByName } from "../be/scripts/db";
import { SEED_SCRIPTS } from "../be/seed-scripts";
import { createDevFlowRepository } from "../devflow/repository";
import { handleAriaHq } from "../http/ariahq";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { extractScriptSignature } from "../scripts-runtime/extract-signature";
import type { User } from "../types";
import { setRequestAuth } from "../utils/request-auth-context";

const TEST_DB_PATH = "./test-ariahq-http.sqlite";

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

function makeServer(users: Map<string, User>): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const userId = req.headers["x-test-user-id"] as string | undefined;
    const user = userId ? users.get(userId) : undefined;
    setRequestAuth(req, user ? { kind: "user", userId: user.id, user } : null);
    const handled = await handleAriaHq(
      req,
      res,
      getPathSegments(req.url ?? ""),
      parseQueryParams(req.url ?? ""),
    );
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

describe("AriaHQ HTTP API", () => {
  let server: Server;
  let baseUrl: string;
  let author: User;
  let other: User;
  let orgA: string;
  let orgB: string;

  beforeEach(async () => {
    await removeTestDb();
    initDb(TEST_DB_PATH);
    setSlackSurfaceVerifierForTests(async () => ({
      status: "pending",
      errorMessage: "Slack bot credentials are not configured",
    }));
    const devflow = createDevFlowRepository(getDb());
    author = createUser({ name: "Author", email: "aria-author@example.com" });
    other = createUser({ name: "Other", email: "aria-other@example.com" });
    orgA = devflow.createOrganization({ name: "A", slug: "aria-http-a" }).id;
    orgB = devflow.createOrganization({ name: "B", slug: "aria-http-b" }).id;
    devflow.addMembership({ organizationId: orgA, userId: author.id, role: "admin" });
    devflow.addMembership({ organizationId: orgB, userId: other.id, role: "admin" });
    server = makeServer(
      new Map([
        [author.id, author],
        [other.id, other],
      ]),
    );
    baseUrl = await listen(server);
  });

  afterEach(async () => {
    setSlackSurfaceVerifierForTests(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    await removeTestDb();
  });

  function headers(userId: string, organizationId: string): HeadersInit {
    return {
      "content-type": "application/json",
      "x-test-user-id": userId,
      "x-devflow-organization-id": organizationId,
    };
  }

  test("creates tenant-scoped engine drafts without publishing executable authority", async () => {
    const response = await fetch(`${baseUrl}/api/ariahq/v1/engine-drafts`, {
      method: "POST",
      headers: headers(author.id, orgA),
      body: JSON.stringify({
        name: "Renewal Engine",
        brief: "Assess renewal risk and require approval before CRM writes.",
      }),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { draft: { id: string; status: string } };
    expect(body.draft.status).toBe("running");

    const foreign = await fetch(`${baseUrl}/api/ariahq/v1/engine-drafts`, {
      headers: headers(other.id, orgB),
    });
    expect(await foreign.json()).toMatchObject({ drafts: [] });
    expect(createAriaHqRepository(getDb()).listEngineVersions(orgA)).toEqual([]);
  });

  test("ingests and searches source-backed knowledge inside the selected organization", async () => {
    const ingest = await fetch(`${baseUrl}/api/ariahq/v1/knowledge/records`, {
      method: "POST",
      headers: headers(author.id, orgA),
      body: JSON.stringify({
        kind: "canonical_fact",
        sourceKind: "crm",
        sourceRef: "hubspot:deal:1",
        sourceRevision: "7",
        audience: "internal",
        title: "Renewal owner",
        content: "The Rentvine renewal owner is Jesse.",
        verificationStatus: "verified",
        effectiveAt: "2026-08-11T12:00:00.000Z",
        metadata: {},
      }),
    });
    expect(ingest.status).toBe(201);

    const search = await fetch(`${baseUrl}/api/ariahq/v1/knowledge/search`, {
      method: "POST",
      headers: headers(author.id, orgA),
      body: JSON.stringify({ question: "Who is the Rentvine renewal owner?" }),
    });
    expect(search.status).toBe(200);
    expect(await search.json()).toMatchObject({
      bundle: { evidence: [{ verificationStatus: "verified" }] },
    });

    const foreignSearch = await fetch(`${baseUrl}/api/ariahq/v1/knowledge/search`, {
      method: "POST",
      headers: headers(other.id, orgB),
      body: JSON.stringify({ question: "Who is the Rentvine renewal owner?" }),
    });
    expect(await foreignSearch.json()).toMatchObject({ bundle: { evidence: [] } });
  });

  test("administers Slack surfaces and exposes only tenant-scoped intakes", async () => {
    const response = await fetch(`${baseUrl}/api/ariahq/v1/slack-surfaces`, {
      method: "POST",
      headers: headers(author.id, orgA),
      body: JSON.stringify({
        name: "Rentvine support",
        workspaceId: "T-RENTVINE",
        channelId: "C-SUPPORT",
        audience: "client",
        clientKey: "rentvine",
        captureMode: "mention_only",
        pmOwnerId: author.id,
      }),
    });
    expect(response.status).toBe(201);
    const configured = (await response.json()) as { surfaces: Array<{ id: string }> };
    expect(configured).toMatchObject({
      surfaces: [{ clientKey: "rentvine", verificationStatus: "pending", isActive: false }],
    });

    setSlackSurfaceVerifierForTests(async () => ({ status: "verified" }));
    const verified = await fetch(
      `${baseUrl}/api/ariahq/v1/slack-surfaces/${configured.surfaces[0]?.id}/verify`,
      { method: "POST", headers: headers(author.id, orgA), body: "{}" },
    );
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({
      surfaces: [{ verificationStatus: "verified", isActive: true }],
    });

    const foreign = await fetch(`${baseUrl}/api/ariahq/v1/slack-surfaces`, {
      headers: headers(other.id, orgB),
    });
    expect(await foreign.json()).toMatchObject({ surfaces: [] });
  });

  test("provisions a tenant-bound knowledge source with a durable script schedule", async () => {
    const runner = createAgent({ name: "Knowledge Runner", isLead: false, status: "idle" });
    const sourceScript = SEED_SCRIPTS.find((script) => script.name === "ariahq-knowledge-sync");
    if (!sourceScript) throw new Error("AriaHQ sync seed script is missing");
    await upsertScriptByName({
      name: sourceScript.name,
      scope: "global",
      scopeId: null,
      source: sourceScript.source,
      description: sourceScript.description,
      intent: sourceScript.intent,
      signatureJson: JSON.stringify(extractScriptSignature(sourceScript.source)),
      fsMode: "none",
      agentId: null,
      isScratch: false,
      typeChecked: true,
    });
    await upsertScriptConnection({
      slug: "drive",
      kind: "openapi",
      baseUrl: "https://drive.example",
      openapiSpecJson: JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Drive", version: "1" },
        servers: [{ url: "https://drive.example" }],
        paths: {
          "/files": {
            get: {
              operationId: "listFiles",
              responses: { "200": { description: "ok" } },
            },
          },
        },
      }),
    });

    const response = await fetch(`${baseUrl}/api/ariahq/v1/knowledge-sources`, {
      method: "POST",
      headers: headers(author.id, orgA),
      body: JSON.stringify({
        key: "company-drive",
        name: "Company Drive",
        sourceKind: "google_drive",
        audience: "internal",
        adapter: "openapi",
        connectionSlug: "drive",
        runAsAgentId: runner.id,
        syncConfig: {
          listOperation: "listFiles",
          recordsPath: "files",
          fieldMap: {
            sourceRef: "id",
            sourceRevision: "version",
            title: "name",
            content: "text",
            effectiveAt: "modifiedTime",
          },
        },
        schedule: { intervalMs: 300000, timezone: "UTC" },
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      source: { id: string; scheduleId: string; organizationId: string };
      schedule: { id: string; targetAgentId: string; scriptArgs: { sourceId: string } };
    };
    expect(body.source.organizationId).toBe(orgA);
    expect(body.schedule).toMatchObject({
      id: body.source.scheduleId,
      targetAgentId: runner.id,
      scriptArgs: { sourceId: body.source.id },
    });
    expect(getScheduledTaskById(body.source.scheduleId)?.scriptName).toBe("ariahq-knowledge-sync");

    const foreign = await fetch(`${baseUrl}/api/ariahq/v1/knowledge-sources`, {
      headers: headers(other.id, orgB),
    });
    expect(await foreign.json()).toEqual({ sources: [] });
  });

  test("accepts push evidence only with the source's one-time webhook secret", async () => {
    const runner = createAgent({ name: "Webhook Runner", isLead: false, status: "idle" });
    const created = await fetch(`${baseUrl}/api/ariahq/v1/knowledge-sources`, {
      method: "POST",
      headers: headers(author.id, orgA),
      body: JSON.stringify({
        key: "calls",
        name: "Call recordings",
        sourceKind: "call_recording",
        audience: "internal",
        adapter: "webhook",
        runAsAgentId: runner.id,
        syncConfig: {},
      }),
    });
    expect(created.status).toBe(201);
    const provisioned = (await created.json()) as {
      source: { id: string };
      webhookSecret: string;
    };
    expect(provisioned.webhookSecret.length).toBeGreaterThan(30);

    const payload = {
      records: [
        {
          sourceRef: "call:123",
          sourceRevision: "1",
          title: "Discovery call",
          content: "The customer needs a September launch.",
          effectiveAt: "2026-08-11T15:00:00.000Z",
          metadata: { account: "Rentvine" },
        },
      ],
    };
    const denied = await fetch(
      `${baseUrl}/api/ariahq/v1/knowledge-sources/${provisioned.source.id}/webhook`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-ariahq-webhook-secret": "wrong" },
        body: JSON.stringify(payload),
      },
    );
    expect(denied.status).toBe(403);

    const accepted = await fetch(
      `${baseUrl}/api/ariahq/v1/knowledge-sources/${provisioned.source.id}/webhook`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ariahq-webhook-secret": provisioned.webhookSecret,
        },
        body: JSON.stringify(payload),
      },
    );
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      run: { status: "completed", recordsCreated: 1 },
    });
    expect(
      createAriaHqRepository(getDb()).searchKnowledge({
        organizationId: orgA,
        audience: "internal",
        query: "September launch",
        limit: 10,
      }),
    ).toHaveLength(1);
  });
});
