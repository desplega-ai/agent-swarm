import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { type AriaHqRepository, createAriaHqRepository } from "../ariahq/repository";
import { createClientIntakeService } from "../ariahq/services/client-intake";
import { createKnowledgeService } from "../ariahq/services/knowledge-service";
import { handleAriaInternalSlackQuestion, handleAriaSlackIngress } from "../ariahq/slack";
import { closeDb, createUser, getDb, initDb } from "../be/db";
import { createDevFlowRepository, type DevFlowRepository } from "../devflow/repository";

const TEST_DB_PATH = "./test-ariahq-client-slack.sqlite";

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("AriaHQ client Slack boundary", () => {
  let aria: AriaHqRepository;
  let devflow: DevFlowRepository;
  let organizationId: string;
  let pmId: string;

  beforeAll(async () => {
    await removeTestDb();
    initDb(TEST_DB_PATH);
    aria = createAriaHqRepository(getDb());
    devflow = createDevFlowRepository(getDb());
    pmId = createUser({ name: "Client PM", email: "client-pm@example.com" }).id;
    organizationId = devflow.createOrganization({ name: "Rebar", slug: "slack-rebar" }).id;
    devflow.addMembership({ organizationId, userId: pmId, role: "pm" });
    const rentvine = aria.createSlackSurface({
      organizationId,
      name: "Rentvine support",
      workspaceId: "T-RENTVINE",
      channelId: "C-SUPPORT",
      audience: "client",
      clientKey: "rentvine",
      captureMode: "mention_only",
      pmOwnerId: pmId,
      createdByUserId: pmId,
    });
    aria.setSlackSurfaceVerification(organizationId, rentvine.id, { status: "verified" }, pmId);
    const acme = aria.createSlackSurface({
      organizationId,
      name: "Acme issues",
      workspaceId: "T-ACME",
      channelId: "C-ISSUES",
      audience: "client",
      clientKey: "acme",
      captureMode: "designated_channel",
      pmOwnerId: pmId,
      createdByUserId: pmId,
    });
    aria.setSlackSurfaceVerification(organizationId, acme.id, { status: "verified" }, pmId);
  });

  afterAll(async () => {
    closeDb();
    await removeTestDb();
  });

  function ingress(input: {
    workspaceId: string;
    channelId: string;
    messageTs: string;
    text: string;
    externalUserId?: string;
  }) {
    return handleAriaSlackIngress(
      { aria, intake: createClientIntakeService({ aria, devflow }) },
      {
        ...input,
        externalUserId: input.externalUserId ?? "U-CLIENT",
        botUserId: "U-ARIA",
      },
    );
  }

  test("a recognized mention-only client surface never falls through generic routing", () => {
    const result = ingress({
      workspaceId: "T-RENTVINE",
      channelId: "C-SUPPORT",
      messageTs: "171.001",
      text: "This is ordinary client conversation.",
    });

    expect(result).toEqual({ recognized: true, handled: false });
  });

  test("a mention creates one client-scoped DevFlow intake and evidence record", () => {
    const result = ingress({
      workspaceId: "T-RENTVINE",
      channelId: "C-SUPPORT",
      messageTs: "171.002",
      text: "<@U-ARIA> Bulk reassignment fails for more than 100 properties.",
    });

    expect(result.recognized).toBe(true);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("Captured as DF-");
    const intake = result.intake!;
    const item = devflow.getWorkItem(organizationId, intake.workItemId)!;
    expect(item.pmOwnerId).toBe(pmId);
    expect(item.createdVia).toBe("slack");
    expect(item.sourceMetadata.clientKey).toBe("rentvine");
    expect(
      aria.searchKnowledge({
        organizationId,
        query: "bulk reassignment",
        audience: "client",
        clientKey: "rentvine",
      }),
    ).toHaveLength(1);
    expect(
      aria.searchKnowledge({
        organizationId,
        query: "bulk reassignment",
        audience: "client",
        clientKey: "acme",
      }),
    ).toEqual([]);
    expect(devflow.listAuditEvents(organizationId, item.id)[0]?.action).toBe(
      "ariahq.client_intake.captured",
    );
  });

  test("duplicate Slack delivery reuses the intake and work item", () => {
    const first = ingress({
      workspaceId: "T-RENTVINE",
      channelId: "C-SUPPORT",
      messageTs: "171.002",
      text: "<@U-ARIA> Bulk reassignment fails for more than 100 properties.",
    });
    const second = ingress({
      workspaceId: "T-RENTVINE",
      channelId: "C-SUPPORT",
      messageTs: "171.002",
      text: "<@U-ARIA> Bulk reassignment fails for more than 100 properties.",
    });

    expect(second.intake?.id).toBe(first.intake?.id);
    expect(aria.listClientIntakes(organizationId)).toHaveLength(1);
  });

  test("designated client channels capture without a mention", () => {
    const result = ingress({
      workspaceId: "T-ACME",
      channelId: "C-ISSUES",
      messageTs: "172.001",
      text: "The dashboard is blank after login.",
      externalUserId: "U-ACME",
    });

    expect(result.handled).toBe(true);
    expect(result.intake?.clientStatus).toBe("captured");
  });

  test("security-sensitive reports are marked and use a protected response", () => {
    const result = ingress({
      workspaceId: "T-ACME",
      channelId: "C-ISSUES",
      messageTs: "172.002",
      text: "I found an exposed API key and possible security vulnerability.",
      externalUserId: "U-ACME",
    });
    const item = devflow.getWorkItem(organizationId, result.intake!.workItemId)!;

    expect(item.isSecuritySensitive).toBe(true);
    expect(result.reply).toContain("protected review");
    expect(result.reply).not.toContain("API key");
  });

  test("unknown and internal surfaces remain available to normal Slack routing", () => {
    expect(
      ingress({
        workspaceId: "T-UNKNOWN",
        channelId: "C-UNKNOWN",
        messageTs: "173.001",
        text: "<@U-ARIA> Hello",
      }),
    ).toEqual({ recognized: false, handled: false });
  });

  test("a verified internal surface dispatches a tenant-scoped sourced answer to its thread", () => {
    const internal = aria.createSlackSurface({
      organizationId,
      name: "Rebar internal",
      workspaceId: "T-REBAR",
      channelId: "C-INTERNAL",
      audience: "internal",
      captureMode: "mention_only",
      pmOwnerId: pmId,
      createdByUserId: pmId,
    });
    aria.setSlackSurfaceVerification(organizationId, internal.id, { status: "verified" }, pmId);
    aria.ingestKnowledge({
      organizationId,
      kind: "canonical_fact",
      sourceKind: "crm",
      sourceRef: "deal:1",
      sourceRevision: "1",
      audience: "internal",
      title: "Launch date",
      content: "The Rentvine launch date is September 15.",
      verificationStatus: "verified",
      effectiveAt: "2026-08-11T12:00:00.000Z",
      metadata: {},
      createdByUserId: pmId,
    });

    const result = handleAriaInternalSlackQuestion(
      {
        aria,
        devflow,
        knowledge: createKnowledgeService({ repo: aria }),
      },
      {
        workspaceId: "T-REBAR",
        channelId: "C-INTERNAL",
        messageTs: "174.001",
        externalUserId: "U-PM",
        requestedByUserId: pmId,
        text: "<@U-ARIA> What is the Rentvine launch date?",
        botUserId: "U-ARIA",
      },
    );

    expect(result).toMatchObject({ recognized: true, handled: true });
    expect(result.taskId).toBeDefined();
    expect(result.reply).toContain("sourced answer");
  });
});
