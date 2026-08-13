import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { type AriaHqRepository, createAriaHqRepository } from "../ariahq/repository";
import { closeDb, createUser, createWorkflow, getDb, initDb } from "../be/db";
import { createDevFlowRepository, type DevFlowRepository } from "../devflow/repository";

const TEST_DB_PATH = "./test-ariahq-repository.sqlite";

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("AriaHQ repository", () => {
  let aria: AriaHqRepository;
  let devflow: DevFlowRepository;
  let orgAId: string;
  let orgBId: string;
  let pmAId: string;
  let itemAId: string;

  beforeAll(async () => {
    await removeTestDb();
    initDb(TEST_DB_PATH);
    aria = createAriaHqRepository(getDb());
    devflow = createDevFlowRepository(getDb());
    pmAId = createUser({ name: "Aria PM A", email: "aria-pm-a@example.com" }).id;
    const pmBId = createUser({ name: "Aria PM B", email: "aria-pm-b@example.com" }).id;
    orgAId = devflow.createOrganization({ name: "Rebar A", slug: "aria-rebar-a" }).id;
    orgBId = devflow.createOrganization({ name: "Rebar B", slug: "aria-rebar-b" }).id;
    devflow.addMembership({ organizationId: orgAId, userId: pmAId, role: "pm" });
    devflow.addMembership({ organizationId: orgBId, userId: pmBId, role: "pm" });
    itemAId = devflow.createWorkItem({
      organizationId: orgAId,
      title: "Client issue",
      description: "A client-reported failure",
      createdVia: "slack",
      pmOwnerId: pmAId,
    }).id;
  });

  afterAll(async () => {
    closeDb();
    await removeTestDb();
  });

  test("engine drafts and immutable versions are organization isolated", () => {
    const draft = aria.createEngineDraft({
      organizationId: orgAId,
      name: "Renewal Engine",
      brief: "Monitor renewal risk and ask an account owner before CRM writes.",
      createdByUserId: pmAId,
    });
    const ready = aria.updateEngineDraft(orgAId, draft.id, {
      status: "ready",
      proposedContract: {
        engineKey: "renewal-engine",
        name: "Renewal Engine",
        objective: "Resolve material renewal risk before the renewal date.",
        caseType: "renewal",
        triggers: ["manual"],
        stages: [
          {
            id: "assess",
            name: "Assess risk",
            kind: "agent",
            objective: "Assess renewal risk from current evidence.",
            requiredEvidence: ["renewal_date"],
            tools: [],
          },
        ],
        knowledgePolicy: {
          allowedSources: ["crm"],
          requiredEvidence: ["renewal_date"],
          conflictPolicy: "escalate",
        },
        actions: [],
        completionCriteria: ["Risk disposition recorded"],
        openQuestions: [],
      },
    });

    const workflow = createWorkflow({
      name: "Renewal Engine v1",
      definition: {
        nodes: [{ id: "assess", type: "agent-task", config: { template: "Assess risk" } }],
        onNodeFailure: "fail",
      },
    });
    const version = aria.createEngineVersion({
      organizationId: orgAId,
      draftId: ready.id,
      contract: ready.proposedContract!,
      workflowId: workflow.id,
      publishedByUserId: pmAId,
    });

    expect(version.version).toBe(1);
    expect(aria.getEngineDraft(orgBId, draft.id)).toBeNull();
    expect(aria.listEngineVersions(orgAId, "renewal-engine")).toHaveLength(1);
    expect(aria.listEngineVersions(orgBId, "renewal-engine")).toEqual([]);
    expect(() =>
      aria.createEngineVersion({
        organizationId: orgAId,
        draftId: ready.id,
        contract: ready.proposedContract!,
        workflowId: crypto.randomUUID(),
        publishedByUserId: pmAId,
      }),
    ).toThrow();
  });

  test("knowledge ingestion is revision-idempotent and client searches fail closed", () => {
    const source = {
      organizationId: orgAId,
      kind: "source_evidence" as const,
      sourceKind: "slack" as const,
      sourceRef: "slack:C-CLIENT:171.001",
      sourceRevision: "171.001",
      sourceUrl: "https://example.slack.com/archives/C-CLIENT/p171001",
      audience: "client" as const,
      clientKey: "rentvine",
      title: "Bulk reassignment failure",
      content: "Bulk reassignment fails after selecting more than 100 properties.",
      verificationStatus: "raw" as const,
      effectiveAt: "2026-08-11T12:00:00.000Z",
      metadata: { channelId: "C-CLIENT" },
    };
    const first = aria.ingestKnowledge(source);
    const second = aria.ingestKnowledge(source);

    expect(second.id).toBe(first.id);
    expect(
      aria.searchKnowledge({
        organizationId: orgAId,
        query: "bulk reassignment",
        audience: "client",
        clientKey: "rentvine",
        now: "2026-08-11T13:00:00.000Z",
      }),
    ).toHaveLength(1);
    expect(
      aria.searchKnowledge({
        organizationId: orgAId,
        query: "bulk reassignment",
        audience: "client",
        clientKey: "another-client",
        now: "2026-08-11T13:00:00.000Z",
      }),
    ).toEqual([]);
    expect(
      aria.searchKnowledge({
        organizationId: orgBId,
        query: "bulk reassignment",
        audience: "internal",
        now: "2026-08-11T13:00:00.000Z",
      }),
    ).toEqual([]);
  });

  test("expired derived insights are excluded while internal evidence stays searchable", () => {
    aria.ingestKnowledge({
      organizationId: orgAId,
      kind: "derived_insight",
      sourceKind: "ariahq",
      sourceRef: "insight:renewal-risk:rentvine",
      sourceRevision: "1",
      audience: "internal",
      title: "Renewal risk",
      content: "Rentvine renewal risk is elevated.",
      verificationStatus: "raw",
      effectiveAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-10T00:00:00.000Z",
      metadata: {},
    });
    aria.ingestKnowledge({
      organizationId: orgAId,
      kind: "canonical_fact",
      sourceKind: "crm",
      sourceRef: "hubspot:company:rentvine",
      sourceRevision: "42",
      audience: "internal",
      title: "Renewal owner",
      content: "The Rentvine renewal owner is Jesse.",
      verificationStatus: "verified",
      effectiveAt: "2026-08-11T00:00:00.000Z",
      metadata: {},
    });

    expect(
      aria.searchKnowledge({
        organizationId: orgAId,
        query: "renewal risk",
        audience: "internal",
        now: "2026-08-11T13:00:00.000Z",
      }),
    ).toEqual([]);
    expect(
      aria.searchKnowledge({
        organizationId: orgAId,
        query: "renewal owner",
        audience: "internal",
        now: "2026-08-11T13:00:00.000Z",
      })[0]?.record.kind,
    ).toBe("canonical_fact");
  });

  test("Slack surfaces are unique and client intake is idempotent per message", () => {
    const surface = aria.createSlackSurface({
      organizationId: orgAId,
      name: "Rentvine product feedback",
      workspaceId: "T-RENTVINE",
      channelId: "C-PRODUCT",
      audience: "client",
      clientKey: "rentvine",
      captureMode: "mention_only",
      pmOwnerId: pmAId,
      createdByUserId: pmAId,
    });
    expect(aria.findSlackSurface("T-RENTVINE", "C-PRODUCT")).toBeNull();
    aria.setSlackSurfaceVerification(orgAId, surface.id, { status: "verified" }, pmAId);
    expect(aria.findSlackSurface("T-RENTVINE", "C-PRODUCT")?.id).toBe(surface.id);
    expect(() =>
      aria.createSlackSurface({
        organizationId: orgBId,
        name: "Collision",
        workspaceId: "T-RENTVINE",
        channelId: "C-PRODUCT",
        audience: "internal",
        captureMode: "mention_only",
        pmOwnerId: pmAId,
        createdByUserId: pmAId,
      }),
    ).toThrow();

    const intake = aria.createClientIntake({
      organizationId: orgAId,
      slackSurfaceId: surface.id,
      workItemId: itemAId,
      messageTs: "171.001",
      threadTs: "171.001",
      externalUserId: "U-CLIENT",
      clientStatus: "captured",
      publicSummary: "Captured for Rebar triage.",
    });

    expect(aria.getClientIntakeByMessage(surface.id, "171.001")?.id).toBe(intake.id);
    expect(() =>
      aria.createClientIntake({
        organizationId: orgAId,
        slackSurfaceId: surface.id,
        workItemId: itemAId,
        messageTs: "171.001",
        threadTs: "171.001",
        externalUserId: "U-CLIENT",
        clientStatus: "captured",
        publicSummary: "Duplicate",
      }),
    ).toThrow();
  });
});
